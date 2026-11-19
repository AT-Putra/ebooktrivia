// Admin account CLI, run on the VM by the operator (plan M5a.1: Owner bootstrap + Owner recovery).
// Every action is written to audit_log as actor "cli", in the same transaction as the change.
//
//   node apps/admin/src/cli/admin.ts bootstrap-owner --email <e-mail> --name <display name>
//       Creates the first Owner (refused once an Owner exists). No TOTP yet: the first sign-in
//       forces enrollment.
//   node apps/admin/src/cli/admin.ts recover --email <e-mail>
//       Lost authenticator and recovery codes, a hard lock, an expired setup: turns TOTP off and
//       removes the secret and every recovery code, revokes every session, clears the login
//       lockout and ALWAYS sets a new password (prompted), so whoever knew the old one cannot
//       enroll an authenticator of their own. The next sign-in forces TOTP setup within 72 h.
//
// Passwords are never arguments (they would show in `ps` and shell history): they are prompted
// for without echo on a terminal, or read as the first line of stdin. Environment: NODE_ENV,
// ADMIN_ORIGIN, ADMIN_AUTH_SECRETS, DATABASE_URL_ADMIN (the admin app's /etc/ebooktrivia/admin.env).
// Exit status: 0 done, 1 usage or configuration error, 2 refused.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { bootstrapOwner, recoverAdminUser } from "../lib/admin-users.ts";
import { runMutation } from "../lib/audit.ts";
import { createRuntime } from "../lib/auth/runtime.ts";

const USAGE = `usage:
  admin.ts bootstrap-owner --email <e-mail> --name <display name>
  admin.ts recover --email <e-mail>
passwords are read from the terminal (no echo) or the first line of stdin`;

class UsageError extends Error {}

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) {
      data += String(chunk);
      if (data.includes("\n")) break;
    }
    return (data.split(/\r?\n/)[0] ?? "").trimEnd();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      stdin.setRawMode(false);
      stdin.off("data", onData);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value);
          return;
        }
        // Ctrl-C / Ctrl-D: give the terminal back and stop (stdin must not keep the process alive).
        if (ch === "\u0003" || ch === "\u0004") {
          done();
          reject(new UsageError("cancelled"));
          return;
        }
        // Backspace: DEL (most terminals) or BS (^H).
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function newPassword(): Promise<string> {
  const first = await readSecret("New password: ");
  if (process.stdin.isTTY && (await readSecret("Repeat: ")) !== first) throw new UsageError("the passwords differ");
  return first;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { email: { type: "string" }, name: { type: "string" } },
    strict: true,
  });
  if (command !== "bootstrap-owner" && command !== "recover") throw new UsageError(USAGE);
  if (values.email === undefined) throw new UsageError(USAGE);
  const email = values.email;
  const rt = await createRuntime(process.env, 2);
  const scope = { actor: { kind: "cli" as const }, requestId: `cli-${randomBytes(8).toString("hex")}`, ip: null };
  try {
    if (command === "bootstrap-owner") {
      if (values.name === undefined) throw new UsageError(USAGE);
      const displayName = values.name;
      const password = await newPassword();
      const result = await runMutation(scope, () => bootstrapOwner(rt.sql, { email, displayName, password }));
      switch (result.kind) {
        case "created":
          process.stdout.write(`owner created: ${result.userId}\n`);
          return 0;
        case "owner_exists":
          process.stderr.write("refused: an Owner already exists (use recover for a lost login)\n");
          return 2;
        case "email_taken":
          process.stderr.write("refused: an admin with that e-mail exists\n");
          return 2;
        case "invalid":
          process.stderr.write(`refused: invalid ${result.field}${result.field === "password" ? " (12 to 128 characters)" : ""}\n`);
          return 2;
      }
    }
    const password = await newPassword();
    const result = await runMutation(scope, () => recoverAdminUser(rt.sql, email, password));
    switch (result.kind) {
      case "recovered":
        process.stdout.write(`recovered ${result.userId}: TOTP off, ${String(result.sessionsRevoked)} session(s) revoked, new password set, TOTP setup due within 72 h\n`);
        return 0;
      case "not_found":
        process.stderr.write("refused: no admin with that e-mail\n");
        return 2;
      case "invalid_password":
        process.stderr.write("refused: invalid password (12 to 128 characters)\n");
        return 2;
    }
  } finally {
    await rt.sql.end({ timeout: 5 });
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Configuration and usage problems only: never print an error object (it may quote input).
    const message = error instanceof UsageError || (error instanceof Error && /Config|LoginRole/.test(error.name)) ? error.message : "failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
);
