// US-012 criterion 4 (SMTP): a real round trip through nodemailer to the dev Mailpit
// (SMTP 127.0.0.1:51025, API 127.0.0.1:58025; override with MAILPIT_SMTP_PORT / MAILPIT_API).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sendMail } from "../src/smtp.ts";

const SMTP_PORT = Number(process.env["MAILPIT_SMTP_PORT"] ?? "51025");
const API = process.env["MAILPIT_API"] ?? "http://127.0.0.1:58025";

describe("SMTP via Mailpit", () => {
  it("delivers text, HTML and a PDF attachment", async () => {
    const tag = randomBytes(6).toString("hex");
    const pdf = Buffer.from(`%PDF-1.7\n% ${tag}\n%%EOF\n`);
    const sent = await sendMail(
      { host: "localhost", port: SMTP_PORT, devAllowPlaintext: true, resolver: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]) },
      {
        from: "Trivia Arena <noreply@example.id>",
        to: "budi@example.com",
        subject: `Ebook kamu ${tag}`,
        text: "Terima kasih",
        html: "<p>Terima kasih</p>",
        attachments: [{ filename: "ebook.pdf", content: pdf, contentType: "application/pdf" }],
      },
    );
    expect(sent.accepted).toEqual(["budi@example.com"]);
    const search = (await (await fetch(`${API}/api/v1/search?query=${encodeURIComponent(tag)}`)).json()) as {
      messages: { ID: string; Subject: string; To: { Address: string }[]; Attachments: number }[];
    };
    expect(search.messages).toHaveLength(1);
    const found = search.messages[0];
    expect(found).toMatchObject({ Subject: `Ebook kamu ${tag}`, To: [{ Address: "budi@example.com" }], Attachments: 1 });
  });

  // Security review US-012 M2: against Mailpit the comma list reached all three addresses and the
  // CRLF form reached ONLY the injected Bcc. Both must be refused before anything is sent.
  it.each([
    ["comma list", "budi@example.com, extra1@evil.test, extra2@evil.test"],
    ["CRLF Bcc injection", "budi@example.com\r\nBcc: inj-to@evil.test"],
  ])("refuses a %s recipient and sends nothing", async (_name, to) => {
    const tag = randomBytes(6).toString("hex");
    const config = { host: "localhost", port: SMTP_PORT, devAllowPlaintext: true, resolver: () => Promise.resolve([{ address: "127.0.0.1", family: 4 as const }]) };
    await expect(sendMail(config, { from: "noreply@example.id", to, subject: `inject ${tag}`, text: "x" })).rejects.toThrow(RangeError);
    const search = (await (await fetch(`${API}/api/v1/search?query=${encodeURIComponent(tag)}`)).json()) as { messages: unknown[] };
    expect(search.messages).toHaveLength(0);
  });
});
