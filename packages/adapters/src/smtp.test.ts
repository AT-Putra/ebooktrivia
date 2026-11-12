// SMTP adapter unit tests: address policy, recipient/header checks, and error classification
// against a real socket (a tiny fake SMTP server on 127.0.0.1). The Mailpit round trip is
// test/smtp.int.test.ts.
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifySmtpError, isPlainAddress, sendMail, SmtpError } from "./smtp.ts";

const message = { from: "noreply@example.id", to: "budi@example.com", subject: "s", text: "t" };
const resolver = (...addresses: string[]) => () => Promise.resolve(addresses.map((address) => ({ address, family: 4 as const })));
const mustNotResolve = () => Promise.reject(new Error("must not resolve"));

async function smtpError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SmtpError) return e.code;
    throw e;
  }
  throw new Error("expected an SmtpError");
}

describe("SMTP address policy", () => {
  it("refuses hosts that resolve to blocked addresses before connecting", async () => {
    for (const answer of ["127.0.0.1", "10.0.0.5", "169.254.169.254"]) {
      expect(await smtpError(sendMail({ host: "smtp.example.id", port: 587, resolver: resolver(answer) }, message))).toBe("blocked_address");
    }
    expect(await smtpError(sendMail({ host: "smtp.example.id", port: 587, resolver: resolver("93.184.216.34", "10.0.0.5") }, message))).toBe("blocked_address");
  });

  it("reports DNS failures and validates the port", async () => {
    expect(await smtpError(sendMail({ host: "x", port: 587, resolver: () => Promise.reject(new Error("NXDOMAIN")) }, message))).toBe("dns_failed");
    expect(await smtpError(sendMail({ host: "x", port: 587, resolver: resolver() }, message))).toBe("dns_failed");
    await expect(sendMail({ host: "x", port: 0, resolver: resolver("93.184.216.34") }, message)).rejects.toThrow(RangeError);
  });

  it("lets an allowlisted private SMTP host through the policy (then fails to connect)", async () => {
    const code = await smtpError(sendMail({ host: "smtp.internal", port: 2525, allowPrivate: true, timeoutMs: 300, resolver: resolver("10.255.255.1") }, message));
    expect(code).not.toBe("blocked_address");
  });
});

describe("M2: exactly one plain recipient, safe headers", () => {
  const config = { host: "smtp.example.id", port: 587, resolver: mustNotResolve };

  it.each([
    "budi@example.com, extra1@evil.test, extra2@evil.test",
    "budi@example.com\r\nBcc: inj-to@evil.test",
    "Budi <budi@example.com>",
    '"budi"@example.com',
    "budi@example.com;x@evil.test",
    "budi@@example.com",
    "budi@localhost",
    "",
    `${"a".repeat(65)}@example.com`,
  ])("refuses the recipient %j before connecting", async (to) => {
    await expect(sendMail(config, { ...message, to })).rejects.toThrow(RangeError);
  });

  it("refuses an unsafe sender, but accepts a plain display name", async () => {
    for (const from of ["noreply@example.id\r\nBcc: x@evil.test", "a@example.id, b@evil.test", 'Evil "Name" <noreply@example.id>', "Name\r\nBcc: x <noreply@example.id>", "Name <a@x.id, b@y.id>"]) {
      await expect(sendMail(config, { ...message, from })).rejects.toThrow(RangeError);
    }
    // A valid display-name form gets past validation (and then fails on DNS here).
    expect(await smtpError(sendMail({ ...config, resolver: () => Promise.reject(new Error("NXDOMAIN")) }, { ...message, from: "Trivia Arena <noreply@example.id>" }))).toBe("dns_failed");
  });

  it("refuses unsafe attachment filenames and content types", async () => {
    const attach = (filename: string, contentType = "application/pdf") => ({ ...message, attachments: [{ filename, content: new Uint8Array([1]), contentType }] });
    for (const filename of ['eb"ook.pdf', "ebook.pdf\r\nX: y", "../ebook.pdf", ".hidden", ""]) {
      await expect(sendMail(config, attach(filename))).rejects.toThrow(RangeError);
    }
    for (const contentType of ["application/pdf\r\nX: y", "pdf", 'application/pdf; name="x"', "text/html, text/plain"]) {
      await expect(sendMail(config, attach("ebook.pdf", contentType))).rejects.toThrow(RangeError);
    }
  });

  it("isPlainAddress accepts ordinary addresses only", () => {
    expect(["budi@example.com", "budi.santoso+tag@mail.example.co.id", "a_b-c@x.io"].every(isPlainAddress)).toBe(true);
    expect(["budi", "@example.com", "budi@", "a..b@example.com", ".a@example.com", "a@-x.com", "budi@example", `a@${"x".repeat(250)}.com`].some(isPlainAddress)).toBe(false);
  });
});

// --- M1: a real socket, so the errors are the ones nodemailer really produces ---------------------

type Behaviour = "hang_after_data" | "close_after_data" | "close_on_ehlo" | "reject_body_4xx" | "accept";

let server: Server | undefined;
afterEach(async () => {
  if (server === undefined) return;
  const s = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });
});

async function fakeSmtp(behaviour: Behaviour): Promise<number> {
  const sockets: Socket[] = [];
  server = createServer((socket) => {
    sockets.push(socket);
    let inData = false;
    let buffer = "";
    socket.on("error", () => undefined);
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      if (inData) {
        if (!buffer.includes("\r\n.\r\n")) return;
        buffer = "";
        inData = false;
        if (behaviour === "close_after_data") socket.destroy();
        if (behaviour === "reject_body_4xx") socket.write("451 4.3.0 try again later\r\n");
        if (behaviour === "accept") socket.write("250 2.0.0 queued\r\n");
        return; // hang_after_data: never answer the end of data
      }
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end).toUpperCase();
        buffer = buffer.slice(end + 2);
        if (line.startsWith("EHLO")) {
          if (behaviour === "close_on_ehlo") {
            socket.destroy();
            return;
          }
          socket.write("250-fake\r\n250 8BITMIME\r\n");
        } else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
        else if (line === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n"); // no PIPELINING advertised: the body follows this reply
          return;
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 what\r\n");
      }
    });
  });
  server.on("close", () => {
    for (const s of sockets) s.destroy();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const local = (port: number) => ({ host: "localhost", port, devAllowPlaintext: true, timeoutMs: 400, resolver: resolver("127.0.0.1") });

describe("M1: error stage from a real SMTP session", () => {
  it("a server that takes the body and then hangs is maybe_sent (never resend blindly)", async () => {
    expect(await smtpError(sendMail(local(await fakeSmtp("hang_after_data")), message))).toBe("maybe_sent");
  });

  it("a server that takes the body and then closes is maybe_sent", async () => {
    expect(await smtpError(sendMail(local(await fakeSmtp("close_after_data")), message))).toBe("maybe_sent");
  });

  it("a server that closes during EHLO is failed (nothing was sent)", async () => {
    expect(await smtpError(sendMail(local(await fakeSmtp("close_on_ehlo")), message))).toBe("failed");
  });

  it("a 4xx answer to the body is failed (the server said it did not take it)", async () => {
    expect(await smtpError(sendMail(local(await fakeSmtp("reject_body_4xx")), message))).toBe("failed");
  });

  it("a server that queues the message returns exactly the one accepted recipient", async () => {
    const attachments = [{ filename: "ebook.pdf", content: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" }];
    const sent = await sendMail(local(await fakeSmtp("accept")), { ...message, from: "Trivia Arena <noreply@example.id>", attachments });
    expect(sent).toMatchObject({ accepted: ["budi@example.com"], rejected: [] });
  });

  it("nothing listening is failed", async () => {
    const port = await fakeSmtp("close_on_ehlo");
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      s?.close(() => {
        resolve();
      });
    });
    expect(await smtpError(sendMail(local(port), message))).toBe("failed");
  });
});

describe("classifySmtpError", () => {
  const before = { dataWritten: false };
  const after = { dataWritten: true };
  it.each([
    [{ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }, after, "rejected"],
    [{ code: "EMESSAGE", responseCode: 554, command: "DATA" }, after, "rejected"],
    [{ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }, before, "rejected"],
    [{ code: "EENVELOPE", responseCode: 451, command: "RCPT TO" }, before, "failed"],
    [{ code: "EMESSAGE", responseCode: 451, command: "DATA" }, after, "failed"],
    [{ code: "ETIMEDOUT", command: "CONN" }, before, "failed"],
    [{ code: "ECONNECTION", command: "CONN" }, before, "failed"],
    [{ code: "ESOCKET", command: "CONN" }, before, "failed"],
    [{ code: "ETIMEDOUT", command: "CONN" }, after, "maybe_sent"],
    [{ code: "ECONNECTION", command: "CONN" }, after, "maybe_sent"],
    [{ code: "ESOCKET", command: "CONN" }, after, "maybe_sent"],
    [{ code: "ESOCKET", originalCode: "ECONNREFUSED", command: "CONN" }, after, "failed"],
    [{ code: "ETIMEDOUT", message: "Connection timeout", command: "CONN" }, after, "failed"],
    [{ code: "ETIMEDOUT", message: "Greeting never received", command: "CONN" }, after, "failed"],
    [{ code: "EDNS" }, after, "failed"],
    [{ code: "ETLS", command: "STARTTLS" }, after, "failed"],
    [new Error("boom"), after, "maybe_sent"],
    ["not an error", after, "maybe_sent"],
  ])("classifies %j at %j as %s", (error, stage, expected) => {
    expect(classifySmtpError(error, stage)).toBe(expected);
  });

  it("is conservative without a stage", () => {
    expect(classifySmtpError({ code: "ETIMEDOUT", command: "CONN" })).toBe("maybe_sent");
  });
});
