// Message and postback templates (spec AC-A10, AC-T2, AC-T7; plan M2.3 endpoint binding, M7.1).
//
// Syntax: `{name}` where name is [A-Za-z0-9_.:-]+, and `{secret:name}` (postbacks only). Any
// such token that is not allowed in the template's context fails closed (TemplateError).
// Leftover braces that are not tokens fail closed too (code malformed_token), so a value is
// never silently dropped:
//   - postback, whatsapp, email_subject: any "{" or "}" outside a token is rejected;
//   - email_html: CSS blocks such as `a { color: red }` stay literal, but near-miss tokens are
//     rejected: one word in braces with spaces (`{ nama }`), or "{" + a known variable name or
//     "secret:" that is not closed (`{nama`).
//
// Contexts and encoding of values:
//   whatsapp       plain text. Free-text values ({nama}, {judul_ebook}) lose control, bidi and
//                  zero-width characters, have whitespace collapsed to one space (no line
//                  injection), lose the WhatsApp markup characters * _ ~ ` and any line-leading
//                  markup (quote ">", bullets "- " / "* ", numbered "1. "), and get "." between
//                  letters/digits replaced by U+2024 (one dot leader, looks the same) so a
//                  buyer-supplied name such as "evil.example" is not auto-linked. System values
//                  ({order_id}, {kode_otp}, {link_trivia}) are validated and inserted unchanged.
//   email_html     free-text values are cleaned and dot-neutralised as above (not the
//                  WhatsApp-only markup steps); every value is HTML-escaped (& < > " ').
//                  Variables are allowed only in text content. Inside a tag, an attribute value,
//                  a comment or a <script>/<style> block the template is rejected
//                  (unsafe_html_context), with one exception: {link_trivia} as the entire quoted
//                  value of an href attribute (`href="{link_trivia}"`).
//   email_subject  values cleaned; the whole rendered subject has no CR/LF or other controls.
//   postback URL   values strictly percent-encoded (RFC 3986 unreserved kept). Variables may not
//                  appear in the scheme or authority, which must be static text whose host
//                  (hostname plus any non-default port, as URL.host gives it) equals the adnet's
//                  endpoint host. `{secret:name}` needs https and resolves only through the
//                  injected resolver; the resolved secret must be a conversions-scope secret
//                  bound to the same adnet AND host (including the port), checked again here.
//                  No path segment may be "." or ".." as the URL parser reads it (%2e is a dot;
//                  tab / newline are dropped; "\" separates like "/"): the parser would drop or
//                  pop it, so a clickid of ".." could change the static path. A value that forms
//                  one fails with invalid_value, a static one in the template with invalid_url.
// {link_trivia} must be an https URL on the play origin the caller passes (linkOrigin). A
// template that uses it needs a value: renderMessage throws missing_value otherwise, so the
// worker needs a link-free WhatsApp template for a buyer-first reply with reply.withoutLink
// (delivery-machine.ts claimBuyerFirst).
// Redacted renders (previews, logs) never call the resolver: `{secret:name}` becomes
// `[secret:name]`, and {kode_otp} / {link_trivia} (a login code and a login link) become
// `[kode_otp]` / `[link_trivia]`.
//
// {sapaan} (greeting.ts) is a system value: the caller renders it at send time and passes it in; only the greetings
// greeting.ts can produce are accepted.
//
// {cs_whatsapp} and {cs_email} (cs-contact.ts) are system values too: the Owner's customer-service number in the local format with
// dashes ("0812-3456-7890") and address, inserted unchanged (a copyable address must keep its dots and underscores) after a check of
// their shape. An empty string is a valid value (nothing is set: the variable renders empty); a missing value is still an error.
//
// Choices (WhatsApp only): `[[Halo|Hai]]` is replaced at render time by ONE of its options, drawn with `options.random` (default:
// the operating system's CSPRNG), before anything else is parsed, so an option can never add a variable or a brace. A choice has 2
// to 5 options of plain text (no `{`, `}` or nested `[[`), `[[` and `]]` must balance, and the template's length limit applies to
// the expansion with the LONGEST option (longestChoiceExpansion). E-mail (subject and HTML) refuses `[[` and `]]` altogether: an
// option is free text, and in HTML it could close an attribute or a tag, which no single scan of the template could rule out for
// every combination of options.
import { randomInt } from "node:crypto";
import { CS_LOCAL_PHONE, isCsEmail } from "./cs-contact.ts";
import { SAPAAN_VALUES } from "./greeting.ts";

export const MESSAGE_VARIABLES = ["nama", "judul_ebook", "order_id", "link_trivia", "kode_otp", "sapaan", "cs_whatsapp", "cs_email"] as const;
export type MessageVariable = (typeof MESSAGE_VARIABLES)[number];
export type MessageValues = Readonly<Partial<Record<MessageVariable, string>>>;
export type MessageChannel = "whatsapp" | "email_html" | "email_subject";

export interface MessageRenderOptions {
  /** Expected origin of {link_trivia}, e.g. "https://play.example.id". Required to render it. */
  readonly linkOrigin?: string;
  /** Uniform in [0, 1): picks the option of each `[[a|b]]` choice (WhatsApp). Default: the operating system's CSPRNG. A test passes its own. */
  readonly random?: () => number;
}

/** Login material: never written to previews or logs. */
export const SENSITIVE_MESSAGE_VARIABLES: readonly MessageVariable[] = ["kode_otp", "link_trivia"];

export const POSTBACK_MACROS = ["clickid", "txid", "payout", "status", "sub_id", "pub"] as const;
export type PostbackMacro = (typeof POSTBACK_MACROS)[number];
/** Required macros fail closed when missing; sub_id and pub render empty when absent. */
export type PostbackValues = Readonly<
  Record<"clickid" | "txid" | "payout" | "status", string> & Partial<Record<"sub_id" | "pub", string>>
>;

export interface PostbackBinding {
  /** adnets.id */
  readonly adnetId: string;
  /** adnets.endpoint_host (lowercase): hostname, plus ":port" when the port is not the default. */
  readonly host: string;
}

export interface ResolvedSecret {
  readonly value: string;
  readonly scope: string;
  readonly adnetId: string | null;
  readonly boundHost: string | null;
}

/** Looks up `{secret:name}`; returns undefined when no such bound secret exists. */
export type SecretResolver = (request: {
  readonly name: string;
  readonly adnetId: string;
  /** URL.host of the template: hostname plus any non-default port. */
  readonly host: string;
}) => ResolvedSecret | undefined;

export type TemplateErrorCode =
  | "unknown_variable"
  | "malformed_token"
  | "missing_value"
  | "invalid_value"
  | "secret_not_allowed"
  | "unsafe_html_context"
  | "invalid_url"
  | "host_mismatch"
  | "insecure_scheme"
  | "secret_unresolved"
  | "secret_binding"
  | "invalid_choice";

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  constructor(code: TemplateErrorCode, message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

type Token =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "secret"; readonly name: string };

type BraceRule = "strict" | "near_miss";

const TOKEN = /\{([A-Za-z0-9_.:-]+)\}/g;
/** Same rule as settings_secrets_name_check. */
const SECRET_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const SECRET_PREFIX = "secret:";
const NEAR_MISS = new RegExp(
  `\\{\\s*[A-Za-z0-9_.:-]+\\s*\\}|\\{\\s*(?:${MESSAGE_VARIABLES.join("|")}|secret:)`,
);

/** Static text between tokens: leftover or near-miss braces fail closed. */
function checkStaticText(text: string, braces: BraceRule): void {
  if (braces === "strict" ? /[{}]/.test(text) : NEAR_MISS.test(text)) {
    throw new TemplateError("malformed_token", "the template has braces that are not a valid {variable}");
  }
}

/** The token for `{body}`: a secret, an allowed variable, or an error. */
function tokenFor(body: string, allowed: readonly string[], allowSecrets: boolean): Token {
  if (body.startsWith(SECRET_PREFIX)) {
    const name = body.slice(SECRET_PREFIX.length);
    if (!allowSecrets) throw new TemplateError("secret_not_allowed", `{secret:...} is not allowed here`);
    if (!SECRET_NAME.test(name)) throw new TemplateError("unknown_variable", `invalid secret name {${body}}`);
    return { kind: "secret", name };
  }
  if (allowed.includes(body)) return { kind: "var", name: body };
  throw new TemplateError("unknown_variable", `unknown variable {${body}}`);
}

function parse(template: string, allowed: readonly string[], allowSecrets: boolean, braces: BraceRule): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  const pushText = (text: string): void => {
    checkStaticText(text, braces);
    tokens.push({ kind: "text", text });
  };
  for (const match of template.matchAll(TOKEN)) {
    if (match.index > last) pushText(template.slice(last, match.index));
    last = match.index + match[0].length;
    tokens.push(tokenFor(match[1] ?? "", allowed, allowSecrets));
  }
  if (last < template.length) pushText(template.slice(last));
  return tokens;
}

// ---------------------------------------------------------------- text cleaning

const isLineBreakOrControl = (cp: number): boolean =>
  cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;

/** Invisible format characters: bidi controls, zero-width, word joiners, BOM, soft hyphen. */
const isInvisible = (cp: number): boolean =>
  cp === 0x00ad ||
  cp === 0x061c ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff;

/** Controls and line breaks become spaces, invisible characters go, whitespace collapses. */
function cleanText(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isLineBreakOrControl(cp)) out += " ";
    else if (!isInvisible(cp)) out += ch;
  }
  return out.replace(/\s+/gu, " ").trim();
}

const WA_MARKUP = /[*_~`]/g;
/** WhatsApp line-start markup: quote, bullet list, numbered list. */
const WA_LINE_LEADING = /^(?:>+\s*|[-*]\s+|[0-9]+\.\s+)+/u;
const LINKABLE_DOT = /(?<=[\p{L}\p{N}])[.\u{FF0E}\u{3002}\u{FF61}](?=[\p{L}\p{N}])/gu;

const neutralizeDots = (value: string): string => value.replace(LINKABLE_DOT, "\u{2024}");

function neutralizeWhatsApp(value: string): string {
  return neutralizeDots(cleanText(value.replace(WA_MARKUP, "")).replace(WA_LINE_LEADING, ""));
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The five characters that matter in HTML text and in a quoted attribute: & < > " '. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

// ---------------------------------------------------------------- email_html scanner
//
// A small HTML tokenizer (after the WHATWG tokenizer states) over the template's static text,
// which is the only thing that decides structure: inserted values are HTML-escaped. It also
// finds the variable tokens, so braces inside <style> and comments stay literal CSS / text.
//   - Rejected outright: <script>, <svg>, <math>, <![CDATA[, and elements whose content is not
//     plain text, that embed other documents, or that change how the parser treats <title> /
//     <style> (template, iframe, object, embed, noscript, xmp, plaintext, noembed, noframes,
//     select, frameset, frame, col, colgroup). col / colgroup: when a client parses the body as
//     a fragment (parseFragment, default <template> context), a leading <col> switches to the
//     "in column group" mode, which ignores <title>, <textarea> and <style>, so their content
//     becomes markup. Table elements stay allowed (layout): the table modes hand those three to
//     the "in body" / "in head" rules, so the tokenizer still switches (template-html.test.ts
//     fuzzes them under document, fragment and <body>-fragment parsing).
//   - A variable is allowed only in text (data or <title>/<textarea> RCDATA), never right after
//     a "<" of the template, plus {link_trivia} as the entire quoted value of an href attribute.
//   - Comments end at "-->" or "--!>"; "<!-->" and "<!--->" are empty comments. "<!...>",
//     "<?...>" and "</" + non-letter are bogus comments up to ">".
//   - A quote opens an attribute value only after "=" (whitespace allowed in between); a quote
//     elsewhere in a tag is part of an attribute name.
//   - <style> content is raw text up to "</style" + whitespace, "/" or ">": CSS braces are fine,
//     a message variable or secret there is rejected.

const FORBIDDEN_HTML =
  /<\/?\s*(?:script|svg|math|template|iframe|object|embed|noscript|xmp|plaintext|noembed|noframes|select|frameset|frame|col|colgroup)|<!\[CDATA\[/i;
const RCDATA_TAGS = ["title", "textarea"];
const TOKEN_AT = /\{([A-Za-z0-9_.:-]+)\}/y;
/** Braces are literal in CSS and comments, but a message variable or a secret is not allowed. */
const VARIABLE_IN_RAW = new RegExp(`\\{\\s*(?:${MESSAGE_VARIABLES.join("|")}|secret:)`);

const isAsciiLetter = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c);
const isSpace = (c: string): boolean => /^[\t\n\f\r ]$/.test(c);

type TagState = "name" | "beforeAttr" | "attrName" | "afterAttrName" | "beforeValue" | "quoted" | "unquoted" | "afterQuoted";

interface OpenTag {
  readonly closing: boolean;
  name: string;
  state: TagState;
  attr: string;
  quote: string;
  empty: boolean;
}

const unsafeHtml = (what: string): TemplateError =>
  new TemplateError("unsafe_html_context", `${what} is only allowed in HTML text (or as href="{link_trivia}")`);

/** Index just past the end of a comment whose "<!--" ends at `from`. */
function commentEnd(template: string, from: number): number {
  if (template[from] === ">") return from + 1; // <!-->
  if (template.startsWith("->", from)) return from + 2; // <!--->
  const ends = [
    [template.indexOf("-->", from), 3],
    [template.indexOf("--!>", from), 4],
  ].filter(([at]) => (at ?? -1) >= 0);
  return ends.length === 0 ? template.length : Math.min(...ends.map(([at, len]) => (at ?? 0) + (len ?? 0)));
}

/** Index of the "</name" that ends raw text / RCDATA, or the template length. */
function rawTextEnd(template: string, from: number, name: string): number {
  const at = template.slice(from).search(new RegExp(`</${name}[\\t\\n\\f\\r />]`, "i"));
  return at < 0 ? template.length : from + at;
}

function scanEmailHtml(template: string): Token[] {
  if (FORBIDDEN_HTML.test(template)) {
    throw new TemplateError("unsafe_html_context", "script, svg, math, col, CDATA and embedding elements are not allowed");
  }
  const tokens: Token[] = [];
  let text = "";
  const flush = (): void => {
    if (text === "") return;
    checkStaticText(text, "near_miss");
    tokens.push({ kind: "text", text });
    text = "";
  };
  const pushRaw = (raw: string): void => {
    if (VARIABLE_IN_RAW.test(raw)) throw unsafeHtml("a variable inside CSS, a comment or a declaration");
    flush();
    tokens.push({ kind: "text", text: raw });
  };
  let tag: OpenTag | null = null;
  let rcdataUntil = -1;
  let i = 0;
  while (i < template.length) {
    TOKEN_AT.lastIndex = i;
    const match = TOKEN_AT.exec(template);
    if (match !== null) {
      const token = tokenFor(match[1] ?? "", MESSAGE_VARIABLES, false);
      const name = token.kind === "text" ? "" : token.name;
      const end = i + match[0].length;
      if (tag === null) {
        if (template[i - 1] === "<") throw unsafeHtml(`{${name}} after "<"`);
      } else {
        const wholeHref =
          !tag.closing &&
          tag.state === "quoted" &&
          tag.attr === "href" &&
          tag.empty &&
          name === "link_trivia" &&
          template[end] === tag.quote;
        if (!wholeHref) throw unsafeHtml(`{${name}} inside a tag`);
        tag.empty = false;
      }
      flush();
      tokens.push(token);
      i = end;
      continue;
    }
    const c = template[i] ?? "";
    if (tag === null) {
      if (c === "<" && i >= rcdataUntil) {
        const next = template[i + 1];
        if (template.startsWith("<!--", i)) {
          const end = commentEnd(template, i + 4);
          pushRaw(template.slice(i, end));
          i = end;
          continue;
        }
        if (next === "!" || next === "?" || (next === "/" && !isAsciiLetter(template[i + 2]) && template[i + 2] !== ">")) {
          const close = template.indexOf(">", i + 1);
          const end = close < 0 ? template.length : close + 1;
          pushRaw(template.slice(i, end));
          i = end;
          continue;
        }
        if (next === "/" && template[i + 2] === ">") {
          text += "</>";
          i += 3;
          continue;
        }
        if (isAsciiLetter(next) || next === "/") {
          const closing = next === "/";
          tag = { closing, name: "", state: "name", attr: "", quote: "", empty: false };
          text += closing ? "</" : "<";
          i += closing ? 2 : 1;
          continue;
        }
      }
      text += c;
      i++;
      continue;
    }
    text += c;
    i++;
    let closed = false;
    switch (tag.state) {
      case "name":
        if (isSpace(c) || c === "/") tag.state = "beforeAttr";
        else if (c === ">") closed = true;
        else tag.name += c.toLowerCase();
        break;
      case "beforeAttr":
        if (c === ">") closed = true;
        else if (!isSpace(c) && c !== "/") {
          tag.state = "attrName";
          tag.attr = c.toLowerCase();
        }
        break;
      case "attrName":
        if (isSpace(c)) tag.state = "afterAttrName";
        else if (c === "/") tag.state = "beforeAttr";
        else if (c === "=") tag.state = "beforeValue";
        else if (c === ">") closed = true;
        else tag.attr += c.toLowerCase();
        break;
      case "afterAttrName":
        if (c === "/") tag.state = "beforeAttr";
        else if (c === "=") tag.state = "beforeValue";
        else if (c === ">") closed = true;
        else if (!isSpace(c)) {
          tag.state = "attrName";
          tag.attr = c.toLowerCase();
        }
        break;
      case "beforeValue":
        if (c === '"' || c === "'") {
          tag.state = "quoted";
          tag.quote = c;
          tag.empty = true;
        } else if (c === ">") closed = true;
        else if (!isSpace(c)) tag.state = "unquoted";
        break;
      case "quoted":
        if (c === tag.quote) tag.state = "afterQuoted";
        else tag.empty = false;
        break;
      case "unquoted":
        if (isSpace(c)) tag.state = "beforeAttr";
        else if (c === ">") closed = true;
        break;
      case "afterQuoted":
        if (isSpace(c) || c === "/") tag.state = "beforeAttr";
        else if (c === ">") closed = true;
        else {
          tag.state = "attrName";
          tag.attr = c.toLowerCase();
        }
        break;
    }
    if (!closed) continue;
    const opened = tag.closing ? null : tag.name;
    tag = null;
    if (opened === "style") {
      const end = rawTextEnd(template, i, "style");
      pushRaw(template.slice(i, end));
      i = end;
    } else if (opened !== null && RCDATA_TAGS.includes(opened)) {
      rcdataUntil = rawTextEnd(template, i, opened);
    }
  }
  if (tag !== null) throw unsafeHtml("an unterminated tag");
  flush();
  return tokens;
}

// ---------------------------------------------------------------- choices

export const CHOICE_MIN_OPTIONS = 2;
export const CHOICE_MAX_OPTIONS = 5;

export type ChoicePart = { readonly kind: "text"; readonly text: string } | { readonly kind: "choice"; readonly options: readonly string[] };

const invalidChoice = (why: string): TemplateError => new TemplateError("invalid_choice", why);

/** Uniform in [0, 1) from the operating system's CSPRNG (47 bits: exact in a double). */
const csprng = (): number => randomInt(2 ** 47) / 2 ** 47;

/** True when the text holds `[[` or `]]` (e-mail templates refuse both). */
const hasChoiceMarker = (template: string): boolean => template.includes("[[") || template.includes("]]");

/** Splits a template into plain text and `[[a|b|c]]` choices; throws invalid_choice for any that breaks the rules in the header. */
export function parseChoices(template: string): ChoicePart[] {
  const parts: ChoicePart[] = [];
  const pushText = (text: string): void => {
    if (text.includes("]]")) throw invalidChoice("a ]] has no [[ before it");
    if (text !== "") parts.push({ kind: "text", text });
  };
  let at = 0;
  for (;;) {
    const open = template.indexOf("[[", at);
    if (open < 0) break;
    pushText(template.slice(at, open));
    const close = template.indexOf("]]", open + 2);
    if (close < 0) throw invalidChoice("a [[ is never closed with ]]");
    const inner = template.slice(open + 2, close);
    if (inner.includes("[[")) throw invalidChoice("[[...]] choices cannot be nested");
    if (/[{}]/.test(inner)) throw invalidChoice("the options of a [[...]] choice are plain text: no { or } (no variable) inside");
    const options = inner.split("|");
    if (options.length < CHOICE_MIN_OPTIONS || options.length > CHOICE_MAX_OPTIONS) {
      throw invalidChoice(`a [[...]] choice needs ${String(CHOICE_MIN_OPTIONS)} to ${String(CHOICE_MAX_OPTIONS)} options separated by |`);
    }
    if (options.some((option) => option.trim() === "")) throw invalidChoice("an option of a [[...]] choice is empty");
    parts.push({ kind: "choice", options });
    at = close + 2;
  }
  pushText(template.slice(at));
  return parts;
}

/** The template with each choice replaced by one option (uniform, `random` or the CSPRNG). */
export function expandChoices(template: string, random: () => number = csprng): string {
  return parseChoices(template)
    .map((part) => (part.kind === "text" ? part.text : (part.options[Math.min(part.options.length - 1, Math.floor(random() * part.options.length))] ?? "")))
    .join("");
}

/** The template with each choice replaced by its longest option: the text a length limit is checked on. */
export function longestChoiceExpansion(template: string): string {
  const length = (text: string): number => Array.from(text).length;
  return parseChoices(template)
    .map((part) => (part.kind === "text" ? part.text : part.options.reduce((longest, option) => (length(option) > length(longest) ? option : longest))))
    .join("");
}

// ---------------------------------------------------------------- message templates

const OTP_CODE = /^[0-9]{6}$/;
const ORDER_ID = /^[0-9A-Za-z-]{1,64}$/;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function triviaLink(value: string, options: MessageRenderOptions): string {
  const url = parseUrl(value);
  if (url?.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TemplateError("invalid_value", "link_trivia must be an https URL without credentials");
  }
  const expected = options.linkOrigin === undefined ? null : parseUrl(options.linkOrigin);
  if (expected?.protocol !== "https:") {
    throw new TemplateError("invalid_value", "an https linkOrigin is required to render link_trivia");
  }
  if (url.origin !== expected.origin) throw new TemplateError("invalid_value", "link_trivia is not on the play origin");
  return url.href;
}

/** Validates a system value; returns the text to insert before channel encoding. */
function systemValue(name: MessageVariable, value: string, options: MessageRenderOptions): string | undefined {
  if (name === "kode_otp") {
    if (!OTP_CODE.test(value)) throw new TemplateError("invalid_value", "kode_otp must be 6 digits");
    return value;
  }
  if (name === "order_id") {
    if (!ORDER_ID.test(value)) throw new TemplateError("invalid_value", "order_id has invalid characters");
    return value;
  }
  if (name === "link_trivia") return triviaLink(value, options);
  if (name === "sapaan") {
    if (!SAPAAN_VALUES.includes(value)) throw new TemplateError("invalid_value", "sapaan is not one of the greetings");
    return value;
  }
  if (name === "cs_whatsapp") {
    if (value !== "" && !CS_LOCAL_PHONE.test(value)) throw new TemplateError("invalid_value", "cs_whatsapp is not a local phone number with dashes");
    return value;
  }
  if (name === "cs_email") {
    if (value !== "" && !isCsEmail(value)) throw new TemplateError("invalid_value", "cs_email is not an e-mail address");
    return value;
  }
  return undefined;
}

function encodeMessageValue(
  name: MessageVariable,
  raw: string,
  channel: MessageChannel,
  options: MessageRenderOptions,
): string {
  const system = systemValue(name, raw, options);
  if (channel === "whatsapp") return system ?? neutralizeWhatsApp(raw);
  if (channel === "email_html") return escapeHtml(system ?? neutralizeDots(cleanText(raw)));
  return system ?? cleanText(raw);
}

function renderMessageTokens(
  template: string,
  channel: MessageChannel,
  values: MessageValues,
  options: MessageRenderOptions,
  redact: boolean,
): string {
  let source = template;
  if (channel === "whatsapp") source = expandChoices(template, options.random);
  else if (hasChoiceMarker(template)) throw new TemplateError("invalid_choice", "[[...]] choices are only for WhatsApp templates, not e-mail");
  const tokens = channel === "email_html" ? scanEmailHtml(source) : parse(source, MESSAGE_VARIABLES, false, "strict");
  let out = "";
  for (const token of tokens) {
    if (token.kind === "text") {
      out += token.text;
      continue;
    }
    const name = token.name as MessageVariable;
    if (redact && SENSITIVE_MESSAGE_VARIABLES.includes(name)) {
      out += `[${name}]`;
      continue;
    }
    const raw = values[name];
    if (raw === undefined) throw new TemplateError("missing_value", `no value for {${name}}`);
    out += encodeMessageValue(name, raw, channel, options);
  }
  return channel === "email_subject" ? cleanText(out) : out;
}

/** Renders a WA / email template for sending. */
export function renderMessage(
  template: string,
  channel: MessageChannel,
  values: MessageValues,
  options: MessageRenderOptions = {},
): string {
  return renderMessageTokens(template, channel, values, options, false);
}

/** Preview / log render: {kode_otp} and {link_trivia} are shown as [kode_otp] / [link_trivia]. */
export function renderMessageRedacted(
  template: string,
  channel: MessageChannel,
  values: MessageValues,
  options: MessageRenderOptions = {},
): string {
  return renderMessageTokens(template, channel, values, options, true);
}

// ---------------------------------------------------------------- postback URL templates

const REQUIRED_MACROS: readonly PostbackMacro[] = ["clickid", "txid", "payout", "status"];
/** Scheme + authority must be static text: no token before the end of the host. */
const STATIC_ORIGIN = /^(https?:\/\/[^/?#{}\s]+)(?:[/?#]|$)/i;
/** A "." or ".." path segment as the URL parser reads it ("%2e" is a dot, any case). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** True when the URL's path has a segment the URL parser would drop or pop. */
function hasDotSegment(url: string): boolean {
  // Like the URL parser: tab / CR / LF are removed anywhere and C0 controls / spaces at the end
  // (the start is the static "http(s)://"); for http(s) "\" separates segments like "/".
  let clean = url.replace(/[\t\n\r]/g, "");
  while (clean.charCodeAt(clean.length - 1) <= 0x20) clean = clean.slice(0, -1);
  // Drop scheme + authority, then everything from the first "?" or "#".
  const path = clean.replace(/^[a-z][a-z0-9+.-]*:[/\\]*[^/\\?#]*/i, "").replace(/[?#][\s\S]*/, "");
  return path.split(/[/\\]/).some((segment) => DOT_SEGMENT.test(segment));
}

function percentEncode(value: string): string {
  try {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
    );
  } catch {
    throw new TemplateError("invalid_value", "value is not valid Unicode");
  }
}

function checkOrigin(template: string, binding: PostbackBinding, hasSecrets: boolean): URL {
  const origin = STATIC_ORIGIN.exec(template)?.[1];
  const url = origin === undefined ? null : parseUrl(origin);
  if (url === null) throw new TemplateError("invalid_url", "the template must start with a static http(s)://host");
  if (url.username !== "" || url.password !== "") {
    throw new TemplateError("invalid_url", "credentials in the URL are not allowed");
  }
  // URL.host = hostname plus the port when it is not the scheme default.
  if (url.host !== binding.host.toLowerCase()) {
    throw new TemplateError("host_mismatch", "template host or port differs from the adnet endpoint host");
  }
  if (hasSecrets && url.protocol !== "https:") {
    throw new TemplateError("insecure_scheme", "{secret:...} requires an https URL");
  }
  return url;
}

function renderPostback(
  template: string,
  values: PostbackValues,
  binding: PostbackBinding,
  resolve: SecretResolver | null,
): string {
  const tokens = parse(template, POSTBACK_MACROS, true, "strict");
  const host = checkOrigin(
    template,
    binding,
    tokens.some((t) => t.kind === "secret"),
  ).host;
  // Every token as "x" (which never forms a dot): a dot segment left is static text.
  if (hasDotSegment(tokens.map((t) => (t.kind === "text" ? t.text : "x")).join(""))) {
    throw new TemplateError("invalid_url", 'the template path has a "." or ".." segment');
  }
  let out = "";
  for (const token of tokens) {
    if (token.kind === "text") {
      out += token.text;
    } else if (token.kind === "var") {
      const name = token.name as PostbackMacro;
      const raw = values[name];
      if (raw === undefined && REQUIRED_MACROS.includes(name)) {
        throw new TemplateError("missing_value", `no value for {${name}}`);
      }
      out += percentEncode(raw ?? "");
    } else if (resolve === null) {
      out += `[secret:${token.name}]`;
    } else {
      const secret = resolve({ name: token.name, adnetId: binding.adnetId, host });
      if (secret === undefined) throw new TemplateError("secret_unresolved", `no bound secret {secret:${token.name}}`);
      if (secret.scope !== "conversions" || secret.adnetId !== binding.adnetId || secret.boundHost !== host) {
        throw new TemplateError("secret_binding", `secret {secret:${token.name}} is not bound to this adnet and host`);
      }
      out += percentEncode(secret.value);
    }
  }
  if (hasDotSegment(out)) {
    throw new TemplateError("invalid_value", 'a value forms a "." or ".." path segment, which would change the path');
  }
  if (resolve === null) return out;
  // Defence in depth: values are encoded, so the host cannot have changed.
  const final = new URL(out);
  if (final.host !== host) throw new TemplateError("host_mismatch", "rendered host differs");
  return final.href;
}

/** Renders an S2S postback URL for sending. */
export function renderPostbackUrl(
  template: string,
  values: PostbackValues,
  binding: PostbackBinding,
  resolve: SecretResolver,
): string {
  return renderPostback(template, values, binding, resolve);
}

/** Log / preview render: same checks, `{secret:name}` shown as `[secret:name]`, no resolver. */
export function renderPostbackUrlRedacted(template: string, values: PostbackValues, binding: PostbackBinding): string {
  return renderPostback(template, values, binding, null);
}

/** Secret names a postback template references (to load only those). Validates the syntax. */
export function postbackSecretNames(template: string): string[] {
  const names = parse(template, POSTBACK_MACROS, true, "strict").flatMap((t) => (t.kind === "secret" ? [t.name] : []));
  return [...new Set(names)];
}
