import { createHash, randomBytes } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type pg from "pg";
import * as z from "zod";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export async function migrateMagicLink(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS spike`);
  await pool.query(`CREATE TABLE IF NOT EXISTS spike.spike_magic_link (
    token_hash bytea PRIMARY KEY,
    user_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`);
}

/** Simulates delivery: persists only SHA-256(token), returns the raw token (the "link"). */
export async function issueMagicLink(pool: pg.Pool, userId: string, ttlSec = 900): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO spike.spike_magic_link (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(token), userId, ttlSec],
  );
  return token;
}

export const phoneMagicLink = (pool: pg.Pool) =>
  ({
    id: "phone-magic-link",
    endpoints: {
      consumePhoneMagicLink: createAuthEndpoint(
        "/phone-magic-link/consume",
        { method: "POST", body: z.object({ token: z.string().min(16).max(128) }) },
        async (ctx) => {
          // Atomic single-use gate: only the one UPDATE that flips consumed_at NULL -> now() gets a row back.
          const res = await pool.query<{ user_id: string }>(
            `UPDATE spike.spike_magic_link SET consumed_at = now()
             WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id`,
            [hashToken(ctx.body.token)],
          );
          const row = res.rows[0];
          if (!row) throw new APIError("UNAUTHORIZED", { message: "invalid or used link" });
          const user = await ctx.context.internalAdapter.findUserById(row.user_id);
          if (!user) throw new APIError("UNAUTHORIZED", { message: "invalid or used link" });
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ status: true, userId: user.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
