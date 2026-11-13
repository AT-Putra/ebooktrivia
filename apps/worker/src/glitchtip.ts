// GlitchTip alert webhook -> one alerts row (internal process). The body comes from GlitchTip
// (token + Caddy IP allowlist) but is still parsed defensively: only a bounded, cleaned subset is
// kept (no control characters: jsonb refuses NUL), and an unknown shape still becomes an alert,
// so no alert is lost. Every stored string has emails and phone-like numbers masked (maskPii),
// because alerts are relayed to WhatsApp / email.
import { createHash } from "node:crypto";
import { maskPii } from "./pii.ts";

export interface AlertRow {
  readonly kind: string;
  readonly severity: "info" | "warning" | "critical";
  readonly dedupeKey: string | null;
  readonly message: string;
  readonly payload: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWhitespace = (c: number): boolean => c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20;
const isControl = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f);

/**
 * Printable text only: whitespace runs become one space, other control characters (C0, DEL, C1)
 * and lone surrogates are dropped; trimmed and cut to `max` UTF-16 units without splitting a pair.
 */
export function cleanText(value: string, max: number): string {
  let out = "";
  let space = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (isWhitespace(c)) {
      space = out !== "";
      continue;
    }
    let char = value.charAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) continue;
      char = value.slice(i, i + 2);
      i++;
    } else if ((c >= 0xdc00 && c <= 0xdfff) || isControl(c)) {
      continue;
    }
    const piece = space ? ` ${char}` : char;
    if (out.length + piece.length > max) break;
    out += piece;
    space = false;
  }
  return out;
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = cleanText(maskPii(value), max);
  return cleaned === "" ? null : cleaned;
};

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 400) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? cleanText(url.href, 400) : null;
  } catch {
    return null;
  }
}

/** The alerts row for a webhook body, or null when the body is not a JSON object. */
export function alertFromGlitchtip(body: unknown): AlertRow | null {
  if (!isRecord(body)) return null;
  const attachments = (Array.isArray(body["attachments"]) ? body["attachments"] : [])
    .filter(isRecord)
    .slice(0, 5)
    .map((a) => ({
      title: text(a["title"], 300),
      link: httpUrl(a["title_link"]),
      text: text(a["text"], 1000),
      fields: (Array.isArray(a["fields"]) ? a["fields"] : [])
        .filter(isRecord)
        .slice(0, 10)
        .map((f) => ({ title: text(f["title"], 100), value: text(f["value"], 200) })),
    }));
  const summary = text(body["text"], 1000);
  const first = attachments[0];
  const message = cleanText(first?.title ?? summary ?? "GlitchTip alert", 500);
  const link = first?.link ?? null;
  return {
    kind: "glitchtip_webhook",
    severity: "warning",
    dedupeKey: link === null ? `glitchtip:${createHash("sha256").update(message).digest("hex")}` : `glitchtip:${link}`,
    message,
    payload: { text: summary, attachments },
  };
}

/**
 * Reads at most `limit` bytes, counting what actually arrives (Content-Length is not trusted).
 * Past the limit the stream is cancelled and "too_large" returned.
 */
export async function readLimitedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | "too_large"> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, total);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
}
