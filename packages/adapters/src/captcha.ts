// Captcha behind one port (plan M3, US-012): Cap is the primary provider, ALTCHA the fallback. The
// public app gates checkout and OTP requests with CaptchaVerifier.verify(); a malformed, unknown,
// replayed, expired or failing submission is `false`, never an exception.
//
// Single use is enforced here through ReplayStore (an atomic "first time" mark; Valkey SET NX PX in
// production), not left to the libraries: Cap reads a token and deletes it in two separate awaits,
// so two concurrent validations against async storage hooks both succeed, and altcha-lib's
// verifySolution has no replay check at all.

import { createHash, createHmac, randomInt } from "node:crypto";
import Cap from "@cap.js/server";
import { type Challenge, type ChallengeParameters, createChallenge, type Solution, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { assertSecretKey } from "@ebooktrivia/core";
import { isRecord } from "./http.ts";

const MAX_TOKEN_LENGTH = 8192;
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------------------------
// Replay store

/** Single-use marks. markUsed() resolves true only the first time `key` is marked within `ttlMs`; it must be atomic. */
export interface ReplayStore {
  markUsed(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * In-process ReplayStore for tests and dev. Expired keys are evicted; at most `maxEntries` live keys
 * are held, and when full it refuses new keys (fails closed) instead of forgetting a live one.
 */
export function createMemoryReplayStore(options: { readonly maxEntries?: number; readonly now?: () => number } = {}): ReplayStore {
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? (() => Date.now());
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  const expiries = new Map<string, number>();
  return {
    markUsed(key, ttlMs) {
      if (key === "" || !Number.isInteger(ttlMs) || ttlMs < 1) return Promise.reject(new RangeError("replay key must be non-empty and ttlMs a positive integer"));
      const t = now();
      const expiry = expiries.get(key);
      if (expiry !== undefined && expiry > t) return Promise.resolve(false);
      expiries.delete(key);
      if (expiries.size >= maxEntries) {
        for (const [k, e] of expiries) if (e <= t) expiries.delete(k);
      }
      if (expiries.size >= maxEntries) return Promise.resolve(false);
      expiries.set(key, t + ttlMs);
      return Promise.resolve(true);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cap (primary)

/** Lifetime of a redeemed Cap token; fixed by @cap.js/server 4.0.5 redeemChallenge(). */
export const CAP_TOKEN_TTL_MS = 20 * 60 * 1000;

// Formats minted by @cap.js/server 4.0.5: challenge token = 25 random bytes in hex, redeemed token =
// "<8 random bytes hex>:<15 random bytes hex>".
const CAP_CHALLENGE_TOKEN = /^[0-9a-f]{50}$/;
const CAP_TOKEN = /^[0-9a-f]{16}:[0-9a-f]{30}$/;

// new Cap() registers a process "beforeExit" handler and once-only SIGINT/SIGTERM/SIGQUIT handlers that
// call process.exit() after its cleanup. The app owns its shutdown, so they are removed again.
const CAP_PROCESS_EVENTS = ["beforeExit", "SIGINT", "SIGTERM", "SIGQUIT"] as const;

export interface CapProviderConfig {
  /** Where Cap keeps challenges and redeemed tokens; omitted = this process's memory (M6 plugs Valkey). */
  readonly storage?: Cap.StorageHooks | undefined;
  readonly replay: ReplayStore;
  /** Defaults are Cap's own: 50 sub-challenges of 32-character salts, 4 hex digits of difficulty, 10 minutes. */
  readonly challengeCount?: number;
  readonly challengeSize?: number;
  readonly challengeDifficulty?: number;
  readonly challengeTtlMs?: number;
}

export interface CapChallenge {
  readonly challenge: { readonly c: number; readonly s: number; readonly d: number };
  readonly token: string;
  readonly expires: number;
}

export type CapRedeemResult = { readonly success: true; readonly token: string; readonly expires: number } | { readonly success: false };

export interface CapProvider {
  /** For the API route the widget fetches a challenge from. */
  challenge(): Promise<CapChallenge>;
  /** For the API route the widget posts `{ token, solutions }` to; a challenge redeems once. */
  redeem(solution: unknown): Promise<CapRedeemResult>;
  /** True once per redeemed token. */
  verify(token: string): Promise<boolean>;
}

const REDEEM_FAILED: CapRedeemResult = { success: false };

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function constructCap(config: Partial<Cap.CapConfig>): Cap {
  const before = CAP_PROCESS_EVENTS.map((event) => new Set(process.listeners(event)));
  const cap = new Cap(config);
  CAP_PROCESS_EVENTS.forEach((event, i) => {
    for (const listener of process.listeners(event)) if (before[i]?.has(listener) !== true) process.removeListener(event, listener);
  });
  return cap;
}

export function createCapProvider(config: CapProviderConfig): CapProvider {
  const challengeConfig = {
    challengeCount: positiveInteger(config.challengeCount ?? 50, "challengeCount"),
    challengeSize: positiveInteger(config.challengeSize ?? 32, "challengeSize"),
    challengeDifficulty: positiveInteger(config.challengeDifficulty ?? 4, "challengeDifficulty"),
    expiresMs: positiveInteger(config.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS, "challengeTtlMs"),
  };
  const cap = constructCap({ noFSState: true, ...(config.storage === undefined ? {} : { storage: config.storage }) });
  const isSolutions = (value: unknown): value is number[] =>
    Array.isArray(value) && value.length === challengeConfig.challengeCount && value.every((s) => typeof s === "number");

  return {
    async challenge() {
      const { challenge, token, expires } = await cap.createChallenge(challengeConfig);
      if (token === undefined) throw new Error("Cap did not store the challenge");
      return { challenge, token, expires };
    },
    async redeem(solution) {
      try {
        if (!isRecord(solution)) return REDEEM_FAILED;
        const { token, solutions } = solution;
        if (typeof token !== "string" || !CAP_CHALLENGE_TOKEN.test(token) || !isSolutions(solutions)) return REDEEM_FAILED;
        // The proof of work is checked first, so only solved challenges take a replay slot (security
        // review US-012 C1: marking first let junk redeems fill the store and lock out real users).
        // Cap reads then deletes the challenge, so concurrent redeems can each mint a token; the mark
        // lets exactly one of them be returned.
        const result = await cap.redeemChallenge({ token, solutions });
        if (!result.success || result.token === undefined || result.expires === undefined) return REDEEM_FAILED;
        if (!(await config.replay.markUsed(`cap:challenge:${sha256Hex(token)}`, challengeConfig.expiresMs))) return REDEEM_FAILED;
        return { success: true, token: result.token, expires: result.expires };
      } catch {
        return REDEEM_FAILED;
      }
    },
    async verify(token) {
      try {
        if (typeof token !== "string" || !CAP_TOKEN.test(token)) return false;
        const { success } = await cap.validateToken(token, { keepToken: false });
        return success && (await config.replay.markUsed(`cap:token:${sha256Hex(token)}`, CAP_TOKEN_TTL_MS));
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// ALTCHA (fallback)

const ALTCHA_ALGORITHM = "PBKDF2/SHA-256";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface AltchaProviderConfig {
  /** HMAC key, at least 32 bytes (decode it with decodeSecretKey from @ebooktrivia/core). */
  readonly key: Uint8Array;
  readonly replay: ReplayStore;
  /** PBKDF2-SHA-256 iterations per attempt. Default 5_000. */
  readonly cost?: number;
  /** The counter the client must find is drawn from [ceil(maxCounter / 2), maxCounter]. Default 10_000. */
  readonly maxCounter?: number;
  /** Challenge lifetime. Default 10 minutes, 1 second to 1 hour. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface AltchaProvider {
  /** The signed challenge the widget fetches (JSON). */
  challenge(): Promise<Challenge>;
  /** True once per solved challenge; `payload` is the widget's base64 JSON `{ challenge, solution }`. */
  verify(payload: string): Promise<boolean>;
}

interface AltchaPayload {
  readonly challenge: { readonly parameters: ChallengeParameters; readonly signature: string };
  readonly solution: Solution;
  readonly nonce: string;
  readonly expiresAtMs: number;
}

/** Shape check only; the signature check in verifySolution covers every parameter's value. */
function parseAltchaPayload(payload: string): AltchaPayload | undefined {
  if (payload.length > MAX_TOKEN_LENGTH || !BASE64.test(payload)) return undefined;
  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  if (!isRecord(decoded) || !isRecord(decoded.challenge) || !isRecord(decoded.solution)) return undefined;
  const { parameters, signature } = decoded.challenge;
  if (!isRecord(parameters) || typeof signature !== "string" || typeof parameters.nonce !== "string") return undefined;
  if (typeof parameters.expiresAt !== "number" || !Number.isInteger(parameters.expiresAt)) return undefined;
  return {
    challenge: { parameters: parameters as unknown as ChallengeParameters, signature },
    solution: decoded.solution as unknown as Solution,
    nonce: parameters.nonce,
    expiresAtMs: parameters.expiresAt * 1000,
  };
}

export function createAltchaProvider(config: AltchaProviderConfig): AltchaProvider {
  assertSecretKey(config.key, "ALTCHA key");
  const cost = positiveInteger(config.cost ?? 5_000, "cost");
  const maxCounter = config.maxCounter ?? 10_000;
  if (!Number.isInteger(maxCounter) || maxCounter < 2 || maxCounter > 0xffffffff) throw new RangeError("maxCounter must be an integer from 2 to 2^32 - 1");
  const ttlMs = config.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) throw new RangeError("ttlMs must be 1000..3600000");
  const now = config.now ?? (() => Date.now());
  // Separate secrets for the challenge signature and the derived-key signature, both from one key.
  const subkey = (label: string): string => createHmac("sha256", config.key).update(`ebooktrivia/altcha/v1/${label}`).digest("hex");
  const hmacSignatureSecret = subkey("challenge");
  const hmacKeySignatureSecret = subkey("derived-key");

  return {
    challenge: () =>
      createChallenge({
        algorithm: ALTCHA_ALGORITHM,
        cost,
        counter: randomInt(Math.ceil(maxCounter / 2), maxCounter + 1),
        deriveKey,
        expiresAt: Math.floor((now() + ttlMs) / 1000),
        hmacSignatureSecret,
        hmacKeySignatureSecret,
      }),
    async verify(payload) {
      try {
        if (typeof payload !== "string") return false;
        const parsed = parseAltchaPayload(payload);
        if (parsed === undefined) return false;
        // altcha-lib skips its expiry check when expiresAt is absent and reads the wall clock; this
        // check requires an expiry and uses the injected clock.
        const t = now();
        if (t >= parsed.expiresAtMs) return false;
        const result = await verifySolution({ challenge: parsed.challenge, solution: parsed.solution, deriveKey, hmacSignatureSecret, hmacKeySignatureSecret });
        return result.verified && (await config.replay.markUsed(`altcha:${parsed.nonce}`, Math.ceil(parsed.expiresAtMs - t)));
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The port the public app uses

export type CaptchaProviderName = "cap" | "altcha";

/** What the client submits with checkout or an OTP request. */
export interface CaptchaSubmission {
  readonly provider: CaptchaProviderName;
  readonly token: string;
}

export interface CaptchaVerifier {
  /** True only for a well-formed submission whose configured provider verifies it; fails closed otherwise. */
  verify(submission: unknown): Promise<boolean>;
}

export function createCaptchaVerifier(providers: {
  readonly cap?: Pick<CapProvider, "verify"> | undefined;
  readonly altcha?: Pick<AltchaProvider, "verify"> | undefined;
}): CaptchaVerifier {
  return {
    async verify(submission) {
      try {
        if (!isRecord(submission)) return false;
        const { provider, token } = submission;
        if (typeof token !== "string" || token === "" || token.length > MAX_TOKEN_LENGTH) return false;
        const target = provider === "cap" ? providers.cap : provider === "altcha" ? providers.altcha : undefined;
        return target !== undefined && (await target.verify(token));
      } catch {
        return false;
      }
    },
  };
}
