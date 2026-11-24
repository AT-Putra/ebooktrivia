import { describe, expect, it } from "vitest";
import {
  CHOICE_MAX_OPTIONS,
  CHOICE_MIN_OPTIONS,
  expandChoices,
  longestChoiceExpansion,
  parseChoices,
  renderMessage,
  renderMessageRedacted,
  renderPostbackUrl,
  type SecretResolver,
  TemplateError,
  type TemplateErrorCode,
} from "./template.ts";

const values = { nama: "Budi Santoso", judul_ebook: "Belajar Node.js", order_id: "K7M2Q9XR", kode_otp: "042917" };

function codeOf(fn: () => unknown): TemplateErrorCode | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TemplateError) return error.code;
    throw error;
  }
  return undefined;
}

/** A random source that answers the given draws in order (then 0). */
const draw = (...answers: number[]) => {
  let i = 0;
  return () => answers[i++] ?? 0;
};

describe("{sapaan}: a system value that can only be one of the greetings", () => {
  it("renders a greeting in a WhatsApp template and refuses any other value (a buyer cannot supply it)", () => {
    expect(renderMessage("{sapaan} {nama}, pesanan Anda siap.", "whatsapp", { sapaan: "Selamat sore", nama: "Budi" })).toBe("Selamat sore Budi, pesanan Anda siap.");
    for (const greeting of ["Selamat pagi", "Selamat siang", "Selamat sore", "Selamat malam", "Halo", "Hai"]) {
      expect(renderMessage("{sapaan}!", "whatsapp", { sapaan: greeting })).toBe(`${greeting}!`);
    }
    expect(codeOf(() => renderMessage("{sapaan}", "whatsapp", { sapaan: "Selamat pagi\nhttps://evil.example" }))).toBe("invalid_value");
    expect(codeOf(() => renderMessage("{sapaan}", "whatsapp", { sapaan: "selamat pagi" }))).toBe("invalid_value");
    expect(codeOf(() => renderMessage("{sapaan}", "whatsapp", {}))).toBe("missing_value");
  });

  it("is a known variable everywhere, so a near-miss of it fails closed in an HTML template too", () => {
    expect(codeOf(() => renderMessage("<p>{ sapaan }</p>", "email_html", values))).toBe("malformed_token");
    expect(codeOf(() => renderMessage("<p>{sapaan</p>", "email_html", values))).toBe("malformed_token");
  });
});

describe("[[a|b]] choices (WhatsApp)", () => {
  it("replaces each choice by one option, drawn with the random source: the first option at 0, the last just below 1, one draw per choice", () => {
    expect(renderMessage("[[Halo|Hai]] {nama}", "whatsapp", values, { random: () => 0 })).toBe("Halo Budi Santoso");
    expect(renderMessage("[[Halo|Hai]] {nama}", "whatsapp", values, { random: () => 0.999999 })).toBe("Hai Budi Santoso");
    expect(renderMessage("[[a|b|c]] dan [[x|y]]", "whatsapp", values, { random: draw(0.5, 0.9) })).toBe("b dan y");
    // A draw of exactly 1 (a broken source) never runs off the list.
    expect(renderMessage("[[a|b]]", "whatsapp", values, { random: () => 1 })).toBe("b");
    // Five options is the most.
    expect(renderMessage("[[1|2|3|4|5]]", "whatsapp", values, { random: () => 0.99 })).toBe("5");
  });

  it("uses the operating system's random source by default and reaches every option, uniformly enough", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      const out = renderMessage("[[a|b|c]]", "whatsapp", values);
      seen.set(out, (seen.get(out) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual(["a", "b", "c"]);
    for (const count of seen.values()) expect(count).toBeGreaterThan(130);
  });

  it("is drawn BEFORE the variables are read: an option never adds a variable, and a buyer's value is never read as a choice", () => {
    expect(renderMessage("Halo {nama}", "whatsapp", { ...values, nama: "[[x|y]]" }, { random: () => 0 })).toBe("Halo [[x|y]]");
    expect(codeOf(() => renderMessage("[[{nama}|b]]", "whatsapp", values))).toBe("invalid_choice");
  });

  it("is the same in a redacted render (a preview draws one pick too)", () => {
    expect(renderMessageRedacted("[[Halo|Hai]] {nama}, kode {kode_otp}", "whatsapp", values, { random: () => 0.9 })).toBe("Hai Budi Santoso, kode [kode_otp]");
  });

  it("refuses what is not a well-formed choice, with invalid_choice: unbalanced, nested, too few or too many options, an empty option, a brace inside", () => {
    const bad = ["[[a|b", "a|b]]", "[[a|b]] dan ]]", "[[a|[[b|c]]]]", "[[a]]", "[[]]", "[[a|b|c|d|e|f]]", "[[a||b]]", "[[a| ]]", "[[|a]]", "[[a|b}]]", "[[a|{nama}]]"];
    for (const template of bad) expect(codeOf(() => renderMessage(template, "whatsapp", values, { random: () => 0 })), template).toBe("invalid_choice");
  });

  it("parses into text and choice parts, and finds the longest expansion for a length limit", () => {
    expect(parseChoices("Halo [[a|bb]], [[x|y|zzz]]!")).toEqual([
      { kind: "text", text: "Halo " },
      { kind: "choice", options: ["a", "bb"] },
      { kind: "text", text: ", " },
      { kind: "choice", options: ["x", "y", "zzz"] },
      { kind: "text", text: "!" },
    ]);
    expect(parseChoices("tanpa pilihan")).toEqual([{ kind: "text", text: "tanpa pilihan" }]);
    expect(longestChoiceExpansion("Halo [[a|bb]], [[x|y|zzz]]!")).toBe("Halo bb, zzz!");
    expect(longestChoiceExpansion("[[ab|cd]]")).toBe("ab");
    // Longest by characters, not by UTF-16 units: a pair of emoji (two code points) is shorter than three letters.
    expect(longestChoiceExpansion("[[\u{1F600}\u{1F600}|abc]]")).toBe("abc");
    expect(expandChoices("[[a|b]]-[[c|d]]", draw(0, 0.9))).toBe("a-d");
    expect(CHOICE_MIN_OPTIONS).toBe(2);
    expect(CHOICE_MAX_OPTIONS).toBe(5);
  });

  it("is refused in e-mail (subject and HTML), whole: it is free text that could break out of a tag, and no single scan covers every combination", () => {
    expect(codeOf(() => renderMessage("<p>[[Halo|Hai]] {nama}</p>", "email_html", values))).toBe("invalid_choice");
    expect(codeOf(() => renderMessage("[[Halo|Hai]] {nama}", "email_subject", values))).toBe("invalid_choice");
    expect(codeOf(() => renderMessage("<p>a ]] b</p>", "email_html", values))).toBe("invalid_choice");
    expect(codeOf(() => renderMessage('<a href="x[[a|b" onclick="y]]">z</a>', "email_html", values))).toBe("invalid_choice");
    // Single brackets (an Outlook conditional comment) are not choices.
    expect(renderMessage("<!--[if mso]><p>x</p><![endif]--><p>{nama}</p>", "email_html", values)).toContain("Budi Santoso");
  });

  it("does not touch postback URLs", () => {
    const resolve: SecretResolver = () => undefined;
    expect(renderPostbackUrl("https://track.example/p?x=[[a|b]]&c={clickid}&t={txid}&p={payout}&s={status}", { clickid: "c", txid: "t", payout: "1", status: "ok" }, { adnetId: "a", host: "track.example" }, resolve)).toBe(
      "https://track.example/p?x=[[a|b]]&c=c&t=t&p=1&s=ok",
    );
  });
});
