// The customer-service (CS) contact in the worker's texts (messages.ts): the four fixed replies, and the read that never blocks a message.
import { NO_CS_CONTACT } from "@ebooktrivia/core";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Logger } from "../log.ts";
import { loadCsContactOrNone, replyText } from "./messages.ts";

describe("replyText with the customer-service contact", () => {
  const cs = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" };
  const LINE = "WhatsApp 0812-3456-7890 atau email cs@contoh.id (Senin–Jumat 09\u202400–17\u202400 WIB)";

  it("mismatch and generic keep their old text and add one sentence with the CS line", () => {
    expect(replyText("mismatch", cs)).toBe(`${replyText("mismatch")} Jika Anda pembeli pesanan ini, hubungi CS kami di ${LINE} dengan menyebut kode pesanan.`);
    expect(replyText("generic", cs)).toBe(`${replyText("generic")} Butuh bantuan? Hubungi CS kami di ${LINE}.`);
  });

  it("not_available and needs_help say CS where they said the organiser", () => {
    expect(replyText("not_available", cs)).toBe(`Pesanan ini tidak dapat kami proses lewat chat. Silakan hubungi CS kami di ${LINE}.`);
    expect(replyText("needs_help", cs)).toBe(`Ebook belum bisa kami kirim lewat WhatsApp. Silakan cek email Anda atau hubungi CS kami di ${LINE}.`);
  });

  it("names only what is set, and the hours after it", () => {
    expect(replyText("generic", { whatsapp: cs.whatsapp, email: null, hours: null })).toMatch(/Hubungi CS kami di WhatsApp 0812-3456-7890\.$/);
    expect(replyText("generic", { whatsapp: null, email: cs.email, hours: "Setiap hari" })).toMatch(/Hubungi CS kami di email cs@contoh\.id \(Setiap hari\)\.$/);
  });

  it("is exactly the old text when no number and no address is set (hours alone are no contact), and the two replies that never change do not", () => {
    for (const kind of ["mismatch", "generic", "not_available", "needs_help"] as const) {
      expect(replyText(kind, { whatsapp: null, email: null, hours: null })).toBe(replyText(kind));
      expect(replyText(kind, { whatsapp: null, email: null, hours: "Setiap hari" })).toBe(replyText(kind));
    }
    for (const kind of ["already_sent", "not_paid"] as const) expect(replyText(kind, cs)).toBe(replyText(kind));
  });

  it("the neutral texts still say nothing about the order's state, with the line, and the line has no link", () => {
    for (const kind of ["mismatch", "generic"] as const) {
      const text = replyText(kind, cs);
      expect(text).not.toMatch(/sudah (atau sedang )?kami kirim|sedang kami kirim|belum|dibayar|pembayaran|dikembalikan|gagal/i);
      expect(text).not.toMatch(/https?:|wa\.me|mailto:/i);
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it("makes no link out of the hours in a reply (www.contoh.id), while the address stays copyable", () => {
    const text = replyText("generic", { whatsapp: null, email: "cs@contoh.id", hours: "Info: www.contoh.id" });
    expect(text).toContain("email cs@contoh.id (Info: www\u2024contoh\u2024id).");
    expect(text.replace("cs@contoh.id", "")).not.toMatch(/[A-Za-z0-9]\.[A-Za-z0-9]/);
  });

  it("puts a value with replacement patterns in it ($&, $1) in the text as it is", () => {
    expect(replyText("generic", { whatsapp: null, email: "cs$&x@contoh.id", hours: "Jam $1" })).toContain("email cs$&x@contoh.id (Jam $1).");
  });
});

describe("loadCsContactOrNone", () => {
  const recorder = () => {
    const warnings: unknown[][] = [];
    return { logger: { warn: (...args: unknown[]) => warnings.push(args) } as unknown as Logger, warnings };
  };
  /** A database that answers the one query with `result` (or fails with it, when it is an error). */
  const db = (result: unknown): postgres.Sql => (() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))) as unknown as postgres.Sql;

  it("reads the three fields, and drops a value the table's checks would have refused", async () => {
    const { logger } = recorder();
    expect(await loadCsContactOrNone(db([{ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Setiap hari" }]), logger)).toEqual({ whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Setiap hari" });
    expect(await loadCsContactOrNone(db([{ whatsapp: "0812", email: "no address", hours: "a\nb" }]), logger)).toEqual(NO_CS_CONTACT);
    expect(await loadCsContactOrNone(db([]), logger)).toEqual(NO_CS_CONTACT);
  });

  it("answers no contact and logs a code, never the error text, when the read fails", async () => {
    const { logger, warnings } = recorder();
    expect(await loadCsContactOrNone(db(new Error("password authentication failed for user x")), logger)).toEqual(NO_CS_CONTACT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toEqual({ code: "cs_contact_read_failed", errorType: "Error" });
    expect(JSON.stringify(warnings)).not.toContain("password");
  });
});
