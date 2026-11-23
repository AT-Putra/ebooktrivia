// US-015: the production senders of the alert relay (src/alert-relay-senders.ts), as worker_rw on a real database. E-mail goes through the
// SMTP settings the Owner saved (to Mailpit here, read back through its API); WhatsApp goes through the pool, so it needs a working
// number: without one nothing is sent and the pool says so. The relay's own behaviour (digests, limits) is alert-relay.int.test.ts's.
import { randomBytes } from "node:crypto";
import { createSecretOpener, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { alertRelayFromEnv, createAlertSenders } from "../src/alert-relay-senders.ts";
import { MailAccessError } from "../src/delivery/ports.ts";
import { PoolSendError } from "../src/delivery/pool-sender.ts";
import { createLogger } from "../src/log.ts";
import { first, sql } from "./support/db.ts";
import { retireSessions } from "./support/delivery.ts";

const workerSql = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
const log = createLogger({ level: "silent", role: "worker" });
const keys = generateScopeKeyPair();
const opener = createSecretOpener({ messaging: keys.privateKey });
const dev = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: true };
const SMTP_PORT = Number(process.env["MAILPIT_SMTP_PORT"] ?? "51025");
const MAILPIT_API = process.env["MAILPIT_API"] ?? "http://127.0.0.1:58025";
const signal = (): AbortSignal => AbortSignal.timeout(10_000);

beforeEach(async () => {
  await sql`DELETE FROM smtp_settings`;
  await retireSessions();
});
afterAll(async () => {
  await sql`DELETE FROM smtp_settings`;
  await retireSessions();
  await workerSql.end({ timeout: 5 });
});

describe("the alert relay's e-mail sender", () => {
  it("sends the alert text as plain text and as an escaped <pre> block through the saved SMTP settings", async () => {
    await sql`INSERT INTO smtp_settings (host, port, security, from_address, from_name) VALUES ('127.0.0.1', ${SMTP_PORT}, 'starttls', 'alerts@example.test', 'Trivia Arena')`;
    const to = `alert-${randomBytes(6).toString("hex")}@example.test`;
    const text = '[critical] backup <failed> & "late"\nsecond line';
    await createAlertSenders({ sql: workerSql, log, opener, dev }).email({ to, subject: "2 alerts", text }, signal());

    const search = (await (await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages: { ID: string }[] };
    expect(search.messages).toHaveLength(1);
    const detail = (await (await fetch(`${MAILPIT_API}/api/v1/message/${search.messages[0]?.ID ?? ""}`)).json()) as { Subject: string; Text: string; HTML: string; From: { Address: string } };
    expect(detail.From.Address).toBe("alerts@example.test");
    expect(detail.Subject).toBe("2 alerts");
    // SMTP carries CRLF line ends.
    const lf = (value: string): string => value.replaceAll("\r\n", "\n");
    expect(lf(detail.Text).trim()).toBe(text);
    // HTML-special characters of an alert's message reach the Owner's mail client as text, not as markup.
    expect(lf(detail.HTML)).toContain('<pre style="font-family:monospace">[critical] backup &lt;failed&gt; &amp; "late"\nsecond line</pre>');
    expect(detail.HTML).not.toContain("<failed>");
  });

  it("fails with the access code when the Owner has saved no SMTP settings (the relay logs it and tries the other channel)", async () => {
    const failure: unknown = await createAlertSenders({ sql: workerSql, log, opener, dev })
      .email({ to: "owner@example.test", subject: "s", text: "t" }, signal())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MailAccessError);
    expect(failure).toMatchObject({ code: "smtp_not_configured" });
  });
});

describe("the alert relay's WhatsApp sender", () => {
  it("refuses a number that is not an Indonesian mobile number, before the pool is asked", async () => {
    const senders = createAlertSenders({ sql: workerSql, log, opener, dev });
    for (const to of ["+14155550123", "081234567890", "+62211234567", "owner@example.test", ""]) {
      await expect(senders.whatsapp({ to, text: "t" }, signal()), to).rejects.toThrow("the alert WhatsApp number is not an Indonesian mobile number");
    }
  });

  it("sends through the pool: with no working number the pool refuses (nothing sent) instead of the alert going around the pool's rules", async () => {
    const sends = async () => first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM waha_sends`).n;
    const before = await sends();
    const failure: unknown = await createAlertSenders({ sql: workerSql, log, opener, dev })
      .whatsapp({ to: "+6281234567890", text: "[critical] backup failed" }, signal())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PoolSendError);
    expect(failure).toMatchObject({ code: "no_number" });
    expect(await sends()).toBe(before);
  });
});

describe("alertRelayFromEnv", () => {
  it("is off without the messaging private key, and with it makes senders of the worker's pool", () => {
    expect(alertRelayFromEnv({}, dev)).toBeUndefined();
    const port = alertRelayFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: keys.privateKey.toString("base64url") }, dev);
    expect(port).toBeDefined();
    const senders = port?.senders(workerSql, log);
    expect(typeof senders?.email).toBe("function");
    expect(typeof senders?.whatsapp).toBe("function");
  });

  it("stops the worker on a key that does not parse (a misconfigured key must not silently turn the relay off)", () => {
    expect(() => alertRelayFromEnv({ SECRETS_MESSAGING_PRIVATE_KEY: "not-a-key" }, dev)).toThrow();
  });
});
