// Pure validation of the settings forms (US-017). Expected values are written out independently of
// the implementation (dates in WIB = UTC+7, fees in basis points, vendor id formats).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endpointHostOf, parseAdnet, parseSecretName } from "./adnets.ts";
import { InvalidInput, wholeNumber } from "./fields.ts";
import { newLpKey, parsePixels, snippet } from "./landing-pages.ts";
import { bpsToPercent, MIDTRANS_METHODS, parseMethodsAndFees, parseServerKey, percentToBps } from "./midtrans.ts";
import { graceEndDay, lastSalesDay, salesWindow, wibDay } from "./programs.ts";
import { parseSecret } from "./secrets.ts";
import { parseSmtp } from "./smtp.ts";
import { isOpenerKey, maskPhone, parseTemplate, preview, templateEntry } from "./templates.ts";
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

  it("keeps only enabled methods, parses the fee of EVERY row (a switched-off method can have one), and requires one method", () => {
    const form = new FormData();
    form.set("method:other_qris", "on");
    form.set("flat:other_qris", "0");
    form.set("percent:other_qris", "0.7");
    form.set("method:bca_va", "on");
    form.set("flat:bca_va", "4.000");
    form.set("flat:gopay", "999");
    form.set("percent:shopeepay", "1.5");
    form.set("method:not_a_method", "on");
    const parsed = parseMethodsAndFees(form);
    expect(parsed.enabledMethods).toEqual(["other_qris", "bca_va"]);
    expect(Object.keys(parsed.fees).sort()).toEqual(MIDTRANS_METHODS.map((m) => m.code).sort());
    expect(parsed.fees.other_qris).toEqual({ flat_idr: 0, percent_bps: 70 });
    expect(parsed.fees.bca_va).toEqual({ flat_idr: 4000, percent_bps: 0 });
    // Not ticked, but the Owner typed a fee: it is parsed (and saved) all the same.
    expect(parsed.fees.gopay).toEqual({ flat_idr: 999, percent_bps: 0 });
    expect(parsed.fees.shopeepay).toEqual({ flat_idr: 0, percent_bps: 150 });
    expect(parsed.fees.kredivo).toEqual({ flat_idr: 0, percent_bps: 0 });
    // A malformed fee in an unticked row refuses the save too.
    const badRow = new FormData();
    badRow.set("method:gopay", "on");
    badRow.set("percent:kredivo", "abc");
    expect(() => parseMethodsAndFees(badRow)).toThrow(InvalidInput);
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

  it("a session is a new number (warm-up) unless 'Established number' is ticked", () => {
    expect(parseWahaSession(values, true).established).toBe(false);
    expect(parseWahaSession(values, true, false).established).toBe(false);
    expect(parseWahaSession(values, true, true).established).toBe(true);
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
    ["a login link in an opener (it carries no link)", "delivery_opener_1", "whatsapp", "Halo {nama} {link_trivia}", /cannot have/],
    ["an unknown variable", "delivery", "whatsapp", "Halo {name}", /does not exist/],
    ["a stray brace", "delivery", "whatsapp", "Halo {nama", /\{ or \}/],
    ["a variable in an attribute", "delivery", "email", '<p title="{nama}">x</p>', /HTML tag, attribute/],
    ["a variable in a script", "delivery", "email", "<script>var n='{nama}'</script>", /script/],
    ["the OTP template without the code", "otp", "whatsapp", "Masuk sekarang", /must contain \{kode_otp\}/],
  ])("refuses %s", (_what, key, channel, body, message) => {
    expect(refused(() => parseTemplate(key, channel as "whatsapp" | "email", { subject: "Subjek", body }))).toMatch(message);
  });

  it("{sapaan} is for openers only, and the e-mail and the other WhatsApp templates refuse it", () => {
    expect(parseTemplate("delivery_opener_4", "whatsapp", { subject: "", body: "{sapaan} {nama}, balas ya." }).body).toBe("{sapaan} {nama}, balas ya.");
    expect(parseTemplate("delivery_opener_12", "whatsapp", { subject: "", body: "{sapaan} {nama}" }).body).toBe("{sapaan} {nama}");
    expect(refused(() => parseTemplate("delivery", "whatsapp", { subject: "", body: "{sapaan} {nama}" }))).toMatch(/cannot have/);
    expect(refused(() => parseTemplate("otp", "whatsapp", { subject: "", body: "{sapaan} {kode_otp}" }))).toMatch(/cannot have/);
    expect(refused(() => parseTemplate("delivery", "email", { subject: "Ebook", body: "<p>{sapaan}</p>" }))).toMatch(/cannot have/);
  });

  it("only delivery_opener_N keys are openers, and an unknown key is refused", () => {
    expect(templateEntry("delivery_opener_1")?.variables).not.toContain("link_trivia");
    expect(templateEntry("delivery_opener_20")).toBeDefined();
    for (const key of ["delivery_opener_", "delivery_opener_0", "delivery_opener_01", "delivery_opener_x", "delivery_opener_1x", "xdelivery_opener_1", "delivery_openers", "nope"]) {
      expect(templateEntry(key), key).toBeUndefined();
      expect(isOpenerKey(key), key).toBe(false);
    }
    expect(refused(() => parseTemplate("delivery_opener_x", "whatsapp", { subject: "", body: "Halo" }))).toMatch(/Unknown template/);
  });

  it.each([
    ["a choice with two options", "[[Halo|Hai]] {nama}"],
    ["a choice with five options", "[[a|b|c|d|e]] {nama}"],
    ["two choices in one text", "[[Halo|Hai]] {nama}, [[cukup|tinggal]] balas ya."],
    ["an option with spaces and punctuation", "[[Halo, apa kabar?|Hai!]] {nama}"],
  ])("accepts %s in an opener and in the delivery text", (_what, body) => {
    expect(parseTemplate("delivery_opener_1", "whatsapp", { subject: "", body }).body).toBe(body);
    expect(parseTemplate("delivery", "whatsapp", { subject: "", body }).body).toBe(body);
  });

  it.each([
    ["a choice that is never closed", "[[Halo|Hai {nama}", /never closed/],
    ["a ]] without a [[", "Halo|Hai]] {nama}", /no \[\[ before it/],
    ["nested choices", "[[a|[[b|c]]]] {nama}", /nested/],
    ["a choice with one option", "[[Halo]] {nama}", /2 to 5 options/],
    ["an empty choice", "[[]] {nama}", /2 to 5 options/],
    ["a choice with six options", "[[a|b|c|d|e|f]] {nama}", /2 to 5 options/],
    ["an empty option", "[[Halo||Hai]] {nama}", /option .* is empty/],
    ["an option of only spaces", "[[Halo| ]] {nama}", /option .* is empty/],
    ["a variable inside an option", "[[Halo|{nama}]]", /no \{ or \}/],
    ["a brace inside an option", "[[Halo|Ha}i]] {nama}", /no \{ or \}/],
  ])("refuses %s, saying what is wrong", (_what, body, message) => {
    expect(refused(() => parseTemplate("delivery_opener_1", "whatsapp", { subject: "", body }))).toMatch(message);
  });

  it("refuses [[ ]] in an e-mail (subject and body), where an option could break out of a tag", () => {
    expect(refused(() => parseTemplate("delivery", "email", { subject: "Ebook", body: "<p>[[Halo|Hai]] {nama}</p>" }))).toMatch(/only for WhatsApp/);
    expect(refused(() => parseTemplate("delivery", "email", { subject: "[[a|b]] ebook", body: "<p>{nama}</p>" }))).toMatch(/only for WhatsApp/);
  });

  it("the length limit counts each choice at its LONGEST option", () => {
    const longOption = "x".repeat(2000);
    // 3 x 2000 characters when every choice takes its longest option: over 4000, although any single pick could be shorter.
    const body = `[[a|${longOption}]] [[b|${longOption}]] [[c|${longOption}]]`;
    expect(refused(() => parseTemplate("delivery_opener_1", "whatsapp", { subject: "", body }))).toMatch(/1 to 4,000 characters .*longest option/);
    // Exactly at the limit with the longest options is allowed.
    const fits = `[[a|${"y".repeat(1999)}]] [[b|${"y".repeat(1999)}]]`;
    expect(parseTemplate("delivery_opener_1", "whatsapp", { subject: "", body: fits }).body).toBe(fits);
    // A plain text over the limit is still refused.
    expect(refused(() => parseTemplate("delivery_opener_1", "whatsapp", { subject: "", body: "z".repeat(4001) }))).toMatch(/1 to 4,000 characters/);
  });

  it("previews one pick of each choice, says it is random, and explains {sapaan}; a text without either has no note", () => {
    const picks = new Set<string>();
    for (let i = 0; i < 60; i++) picks.add(preview("delivery_opener_1", "whatsapp", { subject: null, body: "[[Halo|Hai]] {nama}" }, "Budi").body);
    expect([...picks].sort()).toEqual(["Hai Budi", "Halo Budi"]);
    const withChoice = preview("delivery_opener_1", "whatsapp", { subject: null, body: "[[Halo|Hai]] {nama}" }, "Budi");
    expect(withChoice.note).toMatch(/picked at random/);
    const withGreeting = preview("delivery_opener_1", "whatsapp", { subject: null, body: "{sapaan} {nama}" }, "Budi");
    expect(withGreeting.body).toMatch(/^(Selamat pagi|Selamat siang|Selamat sore|Selamat malam|Halo|Hai) Budi$/);
    expect(withGreeting.note).toMatch(/\{sapaan\}.*Jakarta/);
    expect(preview("delivery_opener_1", "whatsapp", { subject: null, body: "[[a|b]] {sapaan}" }, "Budi").note).toMatch(/random.*Jakarta/);
    expect(preview("delivery", "whatsapp", { subject: null, body: "Halo {nama}" }, "Budi").note).toBeNull();
    expect(preview("delivery", "email", { subject: "S", body: "<p>{nama}</p>" }, "Budi").note).toBeNull();
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
