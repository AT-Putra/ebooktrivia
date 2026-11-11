import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type pg from "pg";

export const MAX_ATTEMPTS = 3;
export const OTP_TTL_SEC = 300;

/** Own OTP table: only HMAC-SHA256(pepper, phone:code) is persisted, never the code. */
export class OtpStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pepper: string,
  ) {}

  async migrate(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS spike`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS spike.spike_otp (
      phone text PRIMARY KEY,
      mac bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts int NOT NULL DEFAULT 0
    )`);
  }

  private mac(phone: string, code: string): Buffer {
    return createHmac("sha256", this.pepper).update(`${phone}:${code}`).digest();
  }

  /** Issues a fresh 6 digit code (replacing any previous one); returns the code for delivery only. */
  async issue(phone: string): Promise<string> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.pool.query(
      `INSERT INTO spike.spike_otp (phone, mac, expires_at, attempts)
       VALUES ($1, $2, now() + make_interval(secs => $3), 0)
       ON CONFLICT (phone) DO UPDATE SET mac = EXCLUDED.mac, expires_at = EXCLUDED.expires_at, attempts = 0`,
      [phone, this.mac(phone, code), OTP_TTL_SEC],
    );
    return code;
  }

  /** Counts the attempt atomically, compares in constant time, deletes on success (single use). */
  async verify(phone: string, code: string): Promise<boolean> {
    const res = await this.pool.query<{ mac: Buffer }>(
      `UPDATE spike.spike_otp SET attempts = attempts + 1
       WHERE phone = $1 AND expires_at > now() AND attempts < $2 RETURNING mac`,
      [phone, MAX_ATTEMPTS],
    );
    const row = res.rows[0];
    if (!row) return false;
    const expected = this.mac(phone, code);
    if (expected.length !== row.mac.length || !timingSafeEqual(expected, row.mac)) return false;
    const del = await this.pool.query(`DELETE FROM spike.spike_otp WHERE phone = $1 AND mac = $2 RETURNING phone`, [
      phone,
      row.mac,
    ]);
    return del.rowCount === 1;
  }
}
