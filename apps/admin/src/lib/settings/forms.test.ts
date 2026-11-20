// Pure validation of the settings forms (US-017). Expected values are written out independently of
// the implementation (dates in WIB = UTC+7, fees in basis points, vendor id formats).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endpointHostOf, parseAdnet, parseSecretName } from "./adnets.ts";
import { InvalidInput, wholeNumber } from "./fields.ts";
import { newLpKey, parsePixels, snippet } from "./landing-pages.ts";
import { bpsToPercent, parseMethodsAndFees, parseServerKey, percentToBps } from "./midtrans.ts";
import { graceEndDay, lastSalesDay, salesWindow, wibDay } from "./programs.ts";
import { parseSecret } from "./secrets.ts";
import { parseSmtp } from "./smtp.ts";
import { maskPhone, parseTemplate, preview } from "./templates.ts";
import { parseWahaSession } from "./waha.ts";

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    throw error;
  }
  throw new Error("expected InvalidInput");
};

describe("program dates (WIB; sales_end_at = last sales day + 1 at 00:00 WIB)", () => {
  it("maps WIB calendar days to instants", () => {
    const w = salesWindow("2027-04-01", "2027-06-30");
    expect(w.salesStartAt.toISOString()).toBe("2027-03-31T17:00:00.000Z");
    expect(w.salesEndAt.toISOString()).toBe("2027-06-30T17:00:00.000Z");
    expect(wibDay(w.salesStartAt)).toBe("2027-04-01");
    expect(lastSalesDay(w.salesEndAt)).toBe("2027-06-30");
    // AC-Q5: grace 30 days after a 06-30 close ends 07-30.
    expect(graceEndDay(w.salesEndAt, 30)).toBe("2027-07-30");
  });

  it("allows a one-day window and refuses a last day before the first", () => {
    const w = salesWindow("2027-04-01", "2027-04-01");
    expect(w.salesEndAt.getTime() - w.salesStartAt.getTime()).toBe(86_400_000);
    expect(refused(() => salesWindow("2027-04-02", "2027-04-01"))).toMatch(/cannot be before/);
    for (const bad of ["2027-02-30", "27-04-01", "2027-4-1", "", "1999-01-01"]) expect(() => salesWindow(bad, "2027-04-01"), bad).toThrow(InvalidInput);
  });
});

describe("Midtrans fees (integers: whole rupiah + basis points)", () => {
  it.each([
    ["0.7", 70],
    ["0,7", 70],
    ["2.9", 290],
    ["0.05", 5],
    ["1", 100],
    ["100", 10_000],
    ["", 0],
  ])("%s %% is %i bp", (input, bps) => {
    expect(percentToBps(input)).toBe(bps);
    expect(percentToBps(bpsToPercent(bps))).toBe(bps);
  });

  it.each(["100.01", "0.001", "-1", "1e2", "abc", "0.7%"])("refuses %s", (input) => {
    expect(() => percentToBps(input)).toThrow(InvalidInput);
  });

  it("keeps only enabled methods and requires one", () => {
    const form = new FormData();
    form.set("method:other_qris", "on");
    form.set("flat:other_qris", "0");
    form.set("percent:other_qris", "0.7");
    form.set("method:bca_va", "on");
    form.set("flat:bca_va", "4.000");
    form.set("flat:gopay", "999");
    form.set("method:not_a_method", "on");
    expect(parseMethodsAndFees(form)).toEqual({ enabledMethods: ["other_qris", "bca_va"], fees: { other_qris: { flat_idr: 0, percent_bps: 70 }, bca_va: { flat_idr: 4000, percent_bps: 0 } } });
    expect(() => parseMethodsAndFees(new FormData())).toThrow(InvalidInput);
    const tooBig = new FormData();
    tooBig.set("method:gopay", "on");
    tooBig.set("flat:gopay", "10000001");
    expect(() => parseMethodsAndFees(tooBig)).toThrow(InvalidInput);
  });

  it("keeps sandbox and production keys apart by their prefix", () => {
    expect(parseServerKey("sandbox", "SB-Mid-server-abcdEFGH1234")).toBe("SB-Mid-server-abcdEFGH1234");
    expect(parseServerKey("production", "  Mid-server-abcdEFGH1234 ")).toBe("Mid-server-abcdEFGH1234");
    expect(() => parseServerKey("production", "SB-Mid-server-abcdEFGH1234")).toThrow(InvalidInput);
    expect(() => parseServerKey("sandbox", "Mid-server-abcdEFGH1234")).toThrow(InvalidInput);
    expect(() => parseServerKey("sandbox", "SB-Mid-server-abc\ndef12345")).toThrow(InvalidInput);
  });
});

describe("secrets", () => {
  it("trims, refuses empty, overlong and control characters", () => {
    expect(parseSecret("  key-123  ")).toBe("key-123");
    for (const bad of ["", "   ", "a\nb", "a\tb", "a\u0000b", "x".repeat(4097)]) expect(() => parseSecret(bad)).toThrow(InvalidInput);
  });

  it("secret names follow settings_secrets_name_check", () => {
    expect(parseSecretName("api_key")).toBe("api_key");
    expect(parseSecretName("token.v2")).toBe("token.v2");
    for (const bad of ["Api", "a-b", "a..b", "", ".a", "a b"]) expect(() => parseSecretName(bad), bad).toThrow(InvalidInput);
  });
});

describe("landing pages", () => {
  it("generates lp keys matching landing_pages_lp_key_check", () => {
    const keys = new Set(Array.from({ length: 200 }, newLpKey));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(/^lp_[0-9A-Za-z]{24}$/);
  });

  it("builds the snippet on the api origin", () => {
    expect(snippet("example.test", "lp_abc")).toBe('<script src="https://api.example.test/sdk/v1.js" data-lp="lp_abc" async></script>');
  });

  it("accepts vendor pixel ids and refuses anything that could break out of a script", () => {
    expect(parsePixels({ meta: "123456789012345", tiktok: "C4ABCDEFGHIJ12345678", gtag: "AW-123456789", gtag_label: "AbC-12_x" })).toEqual({
      meta: "123456789012345",
      tiktok: "C4ABCDEFGHIJ12345678",
      gtag: "AW-123456789",
      gtag_label: "AbC-12_x",
    });
    expect(parsePixels({ meta: "", tiktok: "", gtag: "", gtag_label: "" })).toEqual({ meta: null, tiktok: null, gtag: null, gtag_label: null });
    for (const meta of ["123'); alert(1);//", "12345", "<script>", "123456789012345 "])
      expect(() => parsePixels({ meta: `${meta}x`, tiktok: "", gtag: "", gtag_label: "" })).toThrow(InvalidInput);
    expect(() => parsePixels({ meta: "", tiktok: "c4lowercase123456789", gtag: "", gtag_label: "" })).toThrow(InvalidInput);
    expect(() => parsePixels({ meta: "", tiktok: "", gtag: "G-ABC", gtag_label: "label" })).toThrow(InvalidInput);
    expect(() => parsePixels({ meta: "", tiktok: "", gtag: "AW-123456789", gtag_label: "" })).toThrow(InvalidInput);
  });
});

describe("adnet templates and the endpoint host", () => {
  const base = { slug: "adnet-x", name: "Adnet X", clickidParam: "clickid", mo: "", mt: "", reversal: "", payout: "10.000" };
  const id = randomUUID();

  it("takes the endpoint host from the templates (URL.host form)", () => {
    const input = parseAdnet({ ...base, mt: "https://track.example.test:8443/pb?cid={clickid}&tx={txid}&k={secret:api_key}", mo: "https://track.example.test:8443/mo?cid={clickid}&tx={txid}&s={status}&p={payout}" }, true);
    expect(input.payoutIdr).toBe(10_000);
    expect(endpointHostOf(input, id)).toBe("track.example.test:8443");
    expect(endpointHostOf(parseAdnet(base, true), id)).toBeNull();
  });

  it.each([
    ["two hosts", { mo: "https://a.example.test/?c={clickid}&t={txid}&p={payout}&s={status}", mt: "https://b.example.test/?c={clickid}&t={txid}&p={payout}&s={status}" }, /same host/],
    ["a secret over http", { mt: "http://a.example.test/?c={clickid}&t={txid}&p={payout}&s={status}&k={secret:k}" }, /https/],
    ["an unknown macro", { mt: "https://a.example.test/?c={clickid}&t={txid}&p={payout}&s={status}&x={evil}" }, /unknown macro/],
    ["a macro in the host", { mt: "https://{clickid}.example.test/?t={txid}&p={payout}&s={status}" }, /not a valid URL|template/],
    ["a stray brace", { mt: "https://a.example.test/?c={clickid&t={txid}" }, /\{ or \}/],
    ["a blocked IP host", { mt: "https://169.254.169.254/?c={clickid}&t={txid}&p={payout}&s={status}" }, /never allowed/],
    ["a private IP host", { mt: "https://10.0.0.5/?c={clickid}&t={txid}&p={payout}&s={status}" }, /private network/],
  ])("refuses %s", (_what, templates, message) => {
    expect(refused(() => endpointHostOf(parseAdnet({ ...base, ...templates }, true), id))).toMatch(message);
  });

  it("checks the click id parameter and payout", () => {
    expect(() => parseAdnet({ ...base, clickidParam: "click id" }, true)).toThrow(InvalidInput);
    expect(() => parseAdnet({ ...base, payout: "-1" }, true)).toThrow(InvalidInput);
  });

  it.each(["clickid", "cid", "aff_click_id", "transaction_id", "tid", "sub.id-1", "swap_id", "shpclid", "ad_wave", "gwa", "hpid", "oauth", "username"])("accepts the click id parameter %s", (clickidParam) => {
    expect(parseAdnet({ ...base, clickidParam }, true).clickidParam).toBe(clickidParam);
  });

  // The tracking script stores for 30 days and sends (to the API and as {clickid} to the adnet) whatever
  // this parameter carries, so a name that invites personal data is refused (US-019 security review).
  it.each(["email", "EMAIL", "e-mail", "user_email", "no_hp", "no_wa", "phone_number", "whatsapp", "nama", "nama_lengkap", "full_name", "access_token", "otp", "kode_otp", "nik", "ktp", "card_number", "kartu", "password", "pwd", "secret", "client_secret", "session_id"])(
    "refuses the click id parameter %s, which is named like personal data",
    (clickidParam) => {
      expect(refused(() => parseAdnet({ ...base, clickidParam }, true))).toMatch(/personal-data word/);
    },
  );
});

describe("SMTP", () => {
  const values = { host: "smtp.example.test", port: "587", security: "starttls", username: "mailer", fromAddress: "noreply@example.test", fromName: "Toko Ebook" };

  it("parses a server", () => {
    expect(parseSmtp(values, false)).toEqual({ host: "smtp.example.test", port: 587, security: "starttls", username: "mailer", fromAddress: "noreply@example.test", fromName: "Toko Ebook", allowPrivateIp: false });
  });

  it.each([
    ["a sender with a display name", { fromAddress: "Toko <noreply@example.test>" }],
    ["two senders", { fromAddress: "a@example.test, b@example.test" }],
    ["a header in the sender name", { fromName: "Toko\r\nBcc: x@example.test" }],
    ["quotes in the sender name", { fromName: 'Toko "Ebook"' }],
    ["plain SMTP", { security: "none" }],
    ["a bad port", { port: "70000" }],
    ["a private host without the allowlist", { host: "192.168.1.10" }],
    ["TLS on a STARTTLS port", { security: "tls" }],
    ["STARTTLS on the TLS port", { port: "465" }],
  ])("refuses %s", (_what, change) => {
    expect(() => parseSmtp({ ...values, ...change }, false)).toThrow(InvalidInput);
  });
});

describe("WAHA sessions", () => {
  const values = { serverId: randomUUID(), sessionName: "default", phone: "0812 3456 7890", weight: "2", dailyCap: "150" };

  it("normalises the number and checks weight / cap / name", () => {
    expect(parseWahaSession(values, true)).toMatchObject({ sessionName: "default", phone: "+6281234567890", weight: 2, dailyCap: 150, active: true });
    expect(parseWahaSession({ ...values, phone: "" }, false).phone).toBeNull();
    for (const change of [{ sessionName: "../x" }, { sessionName: "a b" }, { phone: "021 555 1234" }, { weight: "0" }, { weight: "101" }, { dailyCap: "10001" }]) {
      expect(() => parseWahaSession({ ...values, ...change }, true), JSON.stringify(change)).toThrow(InvalidInput);
    }
  });
});

describe("message templates", () => {
  it("accepts the allowed variables per template", () => {
    expect(parseTemplate("delivery", "whatsapp", { subject: "", body: "Halo {nama}, {judul_ebook} {order_id} {link_trivia}" }).subject).toBeNull();
    expect(parseTemplate("delivery", "email", { subject: "Ebook {judul_ebook}", body: '<p>Halo {nama}</p><a href="{link_trivia}">Masuk</a>' })).toEqual({
      subject: "Ebook {judul_ebook}",
      body: '<p>Halo {nama}</p><a href="{link_trivia}">Masuk</a>',
    });
    expect(parseTemplate("otp", "whatsapp", { subject: "", body: "Kode: {kode_otp}" }).body).toBe("Kode: {kode_otp}");
  });

  it.each([
    ["a variable the key does not allow", "otp", "whatsapp", "Kode {kode_otp} untuk {nama}", /cannot have/],
    ["a login link in the no-link template", "delivery_without_link", "whatsapp", "Halo {nama} {link_trivia}", /cannot have/],
    ["an unknown variable", "delivery", "whatsapp", "Halo {name}", /does not exist/],
    ["a stray brace", "delivery", "whatsapp", "Halo {nama", /\{ or \}/],
    ["a variable in an attribute", "delivery", "email", '<p title="{nama}">x</p>', /HTML tag, attribute/],
    ["a variable in a script", "delivery", "email", "<script>var n='{nama}'</script>", /script/],
    ["the OTP template without the code", "otp", "whatsapp", "Masuk sekarang", /must contain \{kode_otp\}/],
  ])("refuses %s", (_what, key, channel, body, message) => {
    expect(refused(() => parseTemplate(key, channel as "whatsapp" | "email", { subject: "Subjek", body }))).toMatch(message);
  });

  it("previews with the sample name encoded: no HTML or script injection", () => {
    const evil = '<img src=x onerror=alert(1)>"</p><script>alert(2)</script>';
    const email = preview("delivery", "email", { subject: "Untuk {nama}", body: "<p>Halo {nama}</p>" }, evil);
    expect(email.body).not.toContain("<img");
    expect(email.body).not.toContain("<script>");
    expect(email.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.body).toContain(`content="default-src 'none'`);
    expect(email.subject).not.toMatch(/[\r\n]/);
    const wa = preview("delivery", "whatsapp", { subject: null, body: "Halo {nama} {link_trivia}" }, "*Bold* evil.example");
    expect(wa.body).not.toContain("*Bold*");
    expect(wa.body).not.toContain("evil.example");
    expect(wa.body).toContain("[link_trivia]");
  });

  it("never previews a real login code or link", () => {
    expect(preview("otp", "whatsapp", { subject: null, body: "Kode {kode_otp}" }, "").body).toBe("Kode [kode_otp]");
  });

  it("masks test numbers in the console", () => {
    expect(maskPhone("+6281234567890")).toBe("+62 812-****-7890");
  });
});

describe("whole numbers", () => {
  it("accepts digits only within the bounds", () => {
    expect(wholeNumber(" 42 ", "m", { min: 0, max: 100 })).toBe(42);
    for (const bad of ["4.2", "1e3", "0x10", "", "101", "-1"]) expect(() => wholeNumber(bad, "m", { min: 0, max: 100 }), bad).toThrow(InvalidInput);
  });
});
