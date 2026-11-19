// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s steps) for tests that play the authenticator app:
// apps/admin integration tests and the admin e2e spec. Test code only.
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding, spaces ignored, case-insensitive). */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** The HOTP value for `counter` (RFC 4226), `digits` long. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

/** The code for a base32 secret at `at` (ms), `stepOffset` steps away (-1 / +1 stay valid). */
export function totp(secretBase32: string, stepOffset = 0, at = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(at / 30_000) + stepOffset);
}

/**
 * A code the server accepts now (this step or one either side) that `used` does not hold yet;
 * waits for the next step when all three are used. The admin console refuses a code it saw in
 * the last 2 minutes (replay protection), so tests signing in repeatedly need fresh ones.
 */
export async function freshTotp(secretBase32: string, used: Set<string>): Promise<string> {
  for (;;) {
    for (const offset of [0, 1, -1]) {
      const code = totp(secretBase32, offset);
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** A 6-digit code that no step within +-2 of now produces (a wrong code that is never valid). */
export function wrongTotp(secretBase32: string): string {
  const valid = new Set([-2, -1, 0, 1, 2].map((offset) => totp(secretBase32, offset)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, "0");
    if (!valid.has(code)) return code;
  }
}
