// Captcha behind one port (plan M3, US-012): Cap is the primary provider, ALTCHA the fallback. The
// public app gates checkout and OTP requests with CaptchaVerifier.verify(); a malformed, unknown,
// replayed, expired or failing submission is `false`, never an exception. A store that cannot answer
// (the ReplayStore or Cap's storage hooks reject, e.g. Valkey is down) is no verdict on the token: it
// is thrown as CaptchaStoreUnavailable (US-020 security review P2-5), so the caller answers 503
// unavailable instead of telling the buyer their captcha failed.
//
// Single use is enforced here through ReplayStore (an atomic "first time" mark; Valkey SET NX PX in
// production), not left to the libraries: Cap's tokens are ours and stateless (below), and
// altcha-lib's verifySolution has no replay check at all.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import Cap from "@cap.js/server";
import { type Challenge, type ChallengeParameters, createChallenge, type Solution, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { assertSecretKey, isUuid } from "@ebooktrivia/core";
import { SDK_CAP } from "@ebooktrivia/core/sdk-contract";
import { isRecord } from "./http.ts";

const MAX_TOKEN_LENGTH = 8192;
/** Lifetime of a Cap or ALTCHA challenge unless configured otherwise. */
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Replay store

/** The ReplayStore or Cap's storage did not answer; `cause` is the store's error. */
export class CaptchaStoreUnavailable extends Error {
  constructor(cause: unknown) {
    super("the captcha store is unavailable", { cause });
    this.name = "CaptchaStoreUnavailable";
  }
}

/** A store call whose failure (rejection or synchronous throw) becomes CaptchaStoreUnavailable. */
function storeCall<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw error instanceof CaptchaStoreUnavailable ? error : new CaptchaStoreUnavailable(error);
    }
  };
}

const guardedReplay = (store: ReplayStore): ReplayStore => ({ markUsed: storeCall((key: string, ttlMs: number) => store.markUsed(key, ttlMs)) });

/** Rethrows a store failure; anything else is a refused submission. */
function refuseUnlessStoreDown<T>(error: unknown, refused: T): T {
  if (error instanceof CaptchaStoreUnavailable) throw error;
  return refused;
}

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
// Cap (primary), STATELESS (US-020, Owner decision 2026-11-20): a flood of challenge or redeem
// requests writes nothing anywhere, so it can neither fill Valkey nor stop checkouts.
//
//   - challenge(): the provider mints the challenge token itself (never Cap's createChallenge, which
//     stores it): hex(payload || HMAC-SHA256(challenge subkey, payload)), payload = version (1 byte)
//     || scope = the landing page id (16) || issuedAt ms (8, big endian) || expiresAt ms (8) || nonce
//     (16 random bytes) || c (2) || s (2) || d (1). The parameters are signed, so a client cannot lower
//     the difficulty. Cap's PRNG takes the salts and targets from the token STRING (`${token}${i}` and
//     `${token}${i}d`, in @cap.js/server 4.0.5 redeemChallenge and in the widget 0.1.62 alike); neither
//     checks its format or length, so the widget solves this token like Cap's own.
//   - redeem(): HMAC (constant time), version, scope, expiry; then Cap's own redeemChallenge checks the
//     proof of work, through storage hooks that hand it the verified parameters and store nothing
//     (read = the decoded token, every other hook a no-op; with them and noFSState it touches no other
//     state). The redeemed token is ours and deterministic: hex(payload || HMAC-SHA256(token subkey,
//     payload)), payload = version || scope || the challenge's nonce || expiresAt ms (the challenge's
//     expiry + CAP_TOKEN_GRACE_MS). Redeeming one challenge twice gives the same token, so nothing has
//     to remember a redeem.
//   - verify(): HMAC, version, scope, expiry, then ONE atomic single-use mark through the ReplayStore,
//     keyed by the base64url nonce, for the token's remaining life plus CAP_MARK_MARGIN_MS: the only
//     state Cap still has, and
//     only for a solved proof of work that passed the checkout's per-IP limit.
// The key is shared by every apps/public instance; its two subkeys are HMAC(key, label) as in ALTCHA.

const CAP_VERSION = 1;
const SCOPE_BYTES = 16;
const NONCE_BYTES = 16;
const MAC_BYTES = 32;
const CHALLENGE_PAYLOAD_BYTES = 1 + SCOPE_BYTES + 8 + 8 + NONCE_BYTES + 2 + 2 + 1;
const TOKEN_PAYLOAD_BYTES = 1 + SCOPE_BYTES + NONCE_BYTES + 8;

/** How much longer than its token a single-use mark lives (clock differences between instances; review P2-2). */
export const CAP_MARK_MARGIN_MS = 60_000;

/** A redeemed token is valid until its challenge's expiry plus this: at least this long after the redeem. */
export const CAP_TOKEN_GRACE_MS = SDK_CAP.tokenMinLifetimeMs;

// Token formats (lowercase hex): the challenge token 172 characters, the redeemed token 146.
export const CAP_CHALLENGE_TOKEN_LENGTH = (CHALLENGE_PAYLOAD_BYTES + MAC_BYTES) * 2;
export const CAP_TOKEN_LENGTH = (TOKEN_PAYLOAD_BYTES + MAC_BYTES) * 2;
const CAP_CHALLENGE_TOKEN = new RegExp(`^[0-9a-f]{${String(CAP_CHALLENGE_TOKEN_LENGTH)}}$`);
const CAP_TOKEN = new RegExp(`^[0-9a-f]{${String(CAP_TOKEN_LENGTH)}}$`);

// new Cap() registers a process "beforeExit" handler and once-only SIGINT/SIGTERM/SIGQUIT handlers that
// call process.exit() after its cleanup. The app owns its shutdown, so they are removed again.
const CAP_PROCESS_EVENTS = ["beforeExit", "SIGINT", "SIGTERM", "SIGQUIT"] as const;

export interface CapProviderConfig {
  /** The HMAC key (at least 32 bytes), the same in every instance. */
  readonly key: Uint8Array;
  /** What the challenges and tokens are bound to: the landing page's id (a lowercase UUID). */
  readonly scope: string;
  /** Single-use marks of redeemed tokens: markUsed(base64url nonce, remaining ms). */
  readonly replay: ReplayStore;
  /** Defaults are Cap's own: 50 sub-challenges of 32-character salts, 4 hex digits of difficulty, 10 minutes. */
  readonly challengeCount?: number;
  readonly challengeSize?: number;
  readonly challengeDifficulty?: number;
  readonly challengeTtlMs?: number;
  readonly now?: () => number;
}

export interface CapChallenge {
  readonly challenge: { readonly c: number; readonly s: number; readonly d: number };
  readonly token: string;
  readonly expires: number;
}

export type CapRedeemResult = { readonly success: true; readonly token: string; readonly expires: number } | { readonly success: false };

export interface CapProvider {
  /** For the API route the widget fetches a challenge from. Stores nothing. */
  challenge(): Promise<CapChallenge>;
  /** For the API route the widget posts `{ token, solutions }` to. Stores nothing; one challenge always redeems to the same token. */
  redeem(solution: unknown): Promise<CapRedeemResult>;
  /** True once per redeemed token. */
  verify(token: string): Promise<boolean>;
}

const REDEEM_FAILED: CapRedeemResult = { success: false };

function boundedInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer from 1 to ${String(max)}`);
  return value;
}

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

const subkey = (key: Uint8Array, label: string): Buffer => createHmac("sha256", key).update(`ebooktrivia/cap/v1/${label}`).digest();

/** payload || MAC, or undefined when the hex does not carry a MAC of `payloadBytes` that verifies under `key`. */
function opened(hex: string, payloadBytes: number, key: Buffer): Buffer | undefined {
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== payloadBytes + MAC_BYTES) return undefined;
  const payload = bytes.subarray(0, payloadBytes);
  const expected = createHmac("sha256", key).update(payload).digest();
  return timingSafeEqual(expected, bytes.subarray(payloadBytes)) ? payload : undefined;
}

const sealed = (payload: Buffer, key: Buffer): string => Buffer.concat([payload, createHmac("sha256", key).update(payload).digest()]).toString("hex");

const readTime = (payload: Buffer, offset: number): number => Number(payload.readBigUInt64BE(offset));

export function createCapProvider(config: CapProviderConfig): CapProvider {
  assertSecretKey(config.key, "Cap key");
  if (!isUuid(config.scope)) throw new RangeError("the Cap scope must be a lowercase UUID");
  const scope = Buffer.from(config.scope.replaceAll("-", ""), "hex");
  const params = {
    c: boundedInteger(config.challengeCount ?? 50, "challengeCount", 0xffff),
    s: boundedInteger(config.challengeSize ?? 32, "challengeSize", 0xffff),
    d: boundedInteger(config.challengeDifficulty ?? 4, "challengeDifficulty", 0xff),
  };
  const ttlMs = positiveInteger(config.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS, "challengeTtlMs");
  const now = config.now ?? (() => Date.now());
  const challengeKey = subkey(config.key, "challenge");
  const tokenKey = subkey(config.key, "token");
  const replay = guardedReplay(config.replay);

  /**
   * The verified parameters of a challenge token of this scope that has not expired and is at least as
   * hard, and lives no longer, than this provider's configuration, else undefined. The key is shared:
   * during a rolling deploy that raises the difficulty, a challenge signed under the weaker config is
   * refused instead of honoured (security review P2-1).
   */
  const challengeOf = (token: string): { c: number; s: number; d: number; expires: number; nonce: Buffer } | undefined => {
    if (!CAP_CHALLENGE_TOKEN.test(token)) return undefined;
    const payload = opened(token, CHALLENGE_PAYLOAD_BYTES, challengeKey);
    if (payload === undefined || payload.readUInt8(0) !== CAP_VERSION || !payload.subarray(1, 17).equals(scope)) return undefined;
    const issued = readTime(payload, 17);
    const expires = readTime(payload, 25);
    if (now() >= expires || expires - issued > ttlMs) return undefined;
    const signed = { c: payload.readUInt16BE(49), s: payload.readUInt16BE(51), d: payload.readUInt8(53) };
    if (signed.c < params.c || signed.s < params.s || signed.d < params.d) return undefined;
    return { ...signed, expires, nonce: Buffer.from(payload.subarray(33, 49)) };
  };

  // Cap only checks the proof of work: it reads the challenge from the verified token and stores nothing.
  const noop = (): Promise<void> => Promise.resolve();
  const cap = constructCap({
    noFSState: true,
    disableAutoCleanup: true,
    storage: {
      challenges: {
        store: () => Promise.reject(new Error("Cap challenges are minted by the provider, never stored")),
        read: (token) => {
          const challenge = challengeOf(token);
          return Promise.resolve(challenge === undefined ? null : { challenge: { c: challenge.c, s: challenge.s, d: challenge.d }, expires: challenge.expires });
        },
        delete: noop,
        deleteExpired: noop,
      },
      tokens: { store: noop, get: () => Promise.resolve(null), delete: noop, deleteExpired: noop },
    },
  });

  return {
    challenge() {
      const issued = now();
      const payload = Buffer.alloc(CHALLENGE_PAYLOAD_BYTES);
      payload.writeUInt8(CAP_VERSION, 0);
      scope.copy(payload, 1);
      payload.writeBigUInt64BE(BigInt(issued), 17);
      payload.writeBigUInt64BE(BigInt(issued + ttlMs), 25);
      randomBytes(NONCE_BYTES).copy(payload, 33);
      payload.writeUInt16BE(params.c, 49);
      payload.writeUInt16BE(params.s, 51);
      payload.writeUInt8(params.d, 53);
      return Promise.resolve({ challenge: { ...params }, token: sealed(payload, challengeKey), expires: issued + ttlMs });
    },
    async redeem(solution) {
      try {
        if (!isRecord(solution)) return REDEEM_FAILED;
        const { token, solutions } = solution;
        if (typeof token !== "string") return REDEEM_FAILED;
        const challenge = challengeOf(token);
        if (challenge === undefined) return REDEEM_FAILED;
        if (!Array.isArray(solutions) || solutions.length !== challenge.c || !solutions.every((s) => typeof s === "number")) return REDEEM_FAILED;
        const result = await cap.redeemChallenge({ token, solutions });
        if (!result.success) return REDEEM_FAILED;
        const expires = challenge.expires + CAP_TOKEN_GRACE_MS;
        const payload = Buffer.alloc(TOKEN_PAYLOAD_BYTES);
        payload.writeUInt8(CAP_VERSION, 0);
        scope.copy(payload, 1);
        challenge.nonce.copy(payload, 17);
        payload.writeBigUInt64BE(BigInt(expires), 33);
        return { success: true, token: sealed(payload, tokenKey), expires };
      } catch (error) {
        return refuseUnlessStoreDown(error, REDEEM_FAILED);
      }
    },
    async verify(token) {
      try {
        if (typeof token !== "string" || !CAP_TOKEN.test(token)) return false;
        const payload = opened(token, TOKEN_PAYLOAD_BYTES, tokenKey);
        if (payload === undefined || payload.readUInt8(0) !== CAP_VERSION || !payload.subarray(1, 17).equals(scope)) return false;
        const remaining = readTime(payload, 33) - now();
        if (remaining <= 0) return false;
        // The mark outlives the token by a minute, so a peer whose clock runs ahead cannot accept it again.
        return await replay.markUsed(payload.subarray(17, 33).toString("base64url"), Math.ceil(remaining) + CAP_MARK_MARGIN_MS);
      } catch (error) {
        return refuseUnlessStoreDown(error, false);
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
  const replay = guardedReplay(config.replay);
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
        return result.verified && (await replay.markUsed(`altcha:${parsed.nonce}`, Math.ceil(parsed.expiresAtMs - t)));
      } catch (error) {
        return refuseUnlessStoreDown(error, false);
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
      } catch (error) {
        return refuseUnlessStoreDown(error, false);
      }
    },
  };
}
