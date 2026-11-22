// Loads a Valkey FUNCTION library for a test run (US-031), the way the worker does at start-up in production
// (apps/worker/src/valkey-functions.ts): `FUNCTION LOAD REPLACE` as a user allowed to (the dev ACL's `worker`; the
// `public` user may only FCALL). The integration tests and the e2e servers call it before they start, since no worker
// runs there. Raw RESP over one socket, so the test helpers need no Redis client. Test code only.
import { connect } from "node:net";

export interface ValkeyLogin {
  /** redis://host:port (no credentials in it). */
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

const encode = (args: readonly string[]): string => `*${String(args.length)}\r\n${args.map((a) => `$${String(Buffer.byteLength(a))}\r\n${a}\r\n`).join("")}`;

/** The first complete RESP reply in `buffer` (simple string, error, integer or bulk string) and what follows it. */
function nextReply(buffer: string): { readonly reply: string; readonly rest: string } | undefined {
  const end = buffer.indexOf("\r\n");
  if (end === -1) return undefined;
  const head = buffer.slice(0, end);
  if (head.startsWith("$")) {
    const size = Number(head.slice(1));
    if (size < 0) return { reply: "", rest: buffer.slice(end + 2) };
    const body = Buffer.from(buffer.slice(end + 2));
    if (body.byteLength < size + 2) return undefined;
    return { reply: body.subarray(0, size).toString(), rest: body.subarray(size + 2).toString() };
  }
  return { reply: head, rest: buffer.slice(end + 2) };
}

/** AUTH, then FUNCTION LOAD REPLACE `code`; answers the library name, throws Valkey's error otherwise. */
export function loadValkeyFunctions(login: ValkeyLogin, code: string, timeoutMs = 5000): Promise<string> {
  const { hostname, port } = new URL(login.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port === "" ? 6379 : port), hostname);
    const replies: string[] = [];
    let buffer = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => {
      fail(new Error("Valkey did not answer FUNCTION LOAD in time"));
    });
    socket.once("error", fail);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let next = nextReply(buffer); next !== undefined; next = nextReply(buffer)) {
        replies.push(next.reply);
        buffer = next.rest;
      }
      if (replies.length < 2) return;
      socket.end();
      const [auth, load] = replies as [string, string];
      if (auth !== "+OK") fail(new Error(`AUTH failed: ${auth.slice(0, 80)}`));
      else if (load.startsWith("-")) fail(new Error(`FUNCTION LOAD failed: ${load.slice(0, 200)}`));
      else resolve(load);
    });
    socket.write(encode(["AUTH", login.username, login.password]) + encode(["FUNCTION", "LOAD", "REPLACE", code]));
  });
}
