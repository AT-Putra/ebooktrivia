import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../env.ts";
import { leaseFloorMs, loadDeliveryConfig, PREFLIGHT_TIMEOUT_MS, READBACK_TIMEOUT_MS } from "./config.ts";

const dev = { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: false };
const payment = Buffer.from(generateScopeKeyPair().privateKey).toString("base64url");
const base = { DOMAIN: "ebooktrivia.example.id", SECRETS_PAYMENT_PRIVATE_KEY: payment };
const load = (env: Record<string, string | undefined> = {}) => loadDeliveryConfig({ ...base, ...env }, { dev });
const message = (env: Record<string, string | undefined>): string => {
  try {
    load(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return "";
};

describe("delivery config (worker.env)", () => {
  it("has defaults: the play and api origins from DOMAIN, /srv/data, a lease that covers the whole human-like sequence and a send", () => {
    expect(load()).toMatchObject({
      playOrigin: "https://play.ebooktrivia.example.id",
      apiOrigin: "https://api.ebooktrivia.example.id",
      dataDir: "/srv/data",
      leaseMs: 210_000,
      wahaTimeoutMs: 60_000,
      smtpTimeoutMs: 30_000,
      emailAttachMaxBytes: 15 * 1024 * 1024,
      emailLinkTtlSeconds: 72 * 3600,
      sessionPollIntervalMs: 30_000,
      dev,
    });
    expect(load().fileUrlKey).toHaveLength(32);
  });

  it("takes the optional settings", () => {
    expect(load({ WORKER_DATA_DIR: "/data", WORKER_DELIVERY_LEASE_MS: "200000", WORKER_WAHA_TIMEOUT_MS: "30000", WORKER_SMTP_TIMEOUT_MS: "5000", WORKER_EMAIL_ATTACH_MAX_BYTES: "1000", WORKER_SESSION_POLL_INTERVAL_MS: "5000" })).toMatchObject({
      dataDir: "/data",
      leaseMs: 200_000,
      wahaTimeoutMs: 30_000,
      smtpTimeoutMs: 5000,
      emailAttachMaxBytes: 1000,
      sessionPollIntervalMs: 5000,
    });
  });

  it("refuses a missing or malformed DOMAIN and a missing payment key, naming the variable only", () => {
    for (const domain of [undefined, "", "Example.id", "localhost", "example.id.", "exa mple.id"]) expect(message({ DOMAIN: domain }), String(domain)).toMatch(/DOMAIN/);
    expect(message({ SECRETS_PAYMENT_PRIVATE_KEY: undefined })).toMatch(/SECRETS_PAYMENT_PRIVATE_KEY/);
    expect(message({ SECRETS_PAYMENT_PRIVATE_KEY: undefined })).not.toContain(payment);
  });

  it("takes the shares of the new-contact budget a WhatsApp capping warning leaves (WORKER_WA_WARNING_FACTORS), refusing anything else", () => {
    expect(load().warningCapFactors).toEqual([0.5, 0.25]);
    expect(load({ WORKER_WA_WARNING_FACTORS: "0.8, 0.4" }).warningCapFactors).toEqual([0.8, 0.4]);
    expect(load({ WORKER_WA_WARNING_FACTORS: "1,0" }).warningCapFactors).toEqual([1, 0]);
    for (const bad of ["0.5", "0.5,0.25,0.1", "x,y", "1.5,0.5", "0.2,0.5", "-1,0", ""]) {
      if (bad === "") continue;
      expect(message({ WORKER_WA_WARNING_FACTORS: bad }), bad).toMatch(/WORKER_WA_WARNING_FACTORS/);
    }
  });

  it("refuses a lease that cannot cover the slot wait, the contact gap, the lookup, the pre-flight, the human-like pauses, the WAHA timeout, the read-back and a margin; the default grows with the timeout", () => {
    // 60 s request + 20 s slot + 60 s contact gap + 10 s check-exists lookup + 5 s file pre-flight + 34.5 s of pauses and presence calls (seen and its fallback, typing, paused,
    // offline) + 3 s read-back after a file send + 10 s margin = 202.5 s.
    expect(leaseFloorMs(60_000)).toBe(202_500);
    // Both budgets are short and fixed: the pre-flight's own (never WAHA's request timeout) and the read-back's (a presence-call budget).
    expect([PREFLIGHT_TIMEOUT_MS, READBACK_TIMEOUT_MS]).toEqual([5000, 3000]);
    expect(message({ WORKER_DELIVERY_LEASE_MS: "120000" })).toMatch(/WORKER_DELIVERY_LEASE_MS must be at least/);
    expect(message({ WORKER_DELIVERY_LEASE_MS: "202499", WORKER_WAHA_TIMEOUT_MS: "60000" })).toMatch(/WORKER_DELIVERY_LEASE_MS/);
    expect(message({ WORKER_DELIVERY_LEASE_MS: "202500", WORKER_WAHA_TIMEOUT_MS: "60000" })).toBe("");
    // The old floor (before the pre-flight and the read-back were counted) is no longer enough.
    expect(message({ WORKER_DELIVERY_LEASE_MS: "194500", WORKER_WAHA_TIMEOUT_MS: "60000" })).toMatch(/WORKER_DELIVERY_LEASE_MS/);
    expect(message({ WORKER_DELIVERY_LEASE_MS: "143500", WORKER_WAHA_TIMEOUT_MS: "1000" })).toBe("");
    expect(load({ WORKER_WAHA_TIMEOUT_MS: "100000" }).leaseMs).toBe(242_500);
    expect(load({ WORKER_WAHA_TIMEOUT_MS: "1000" }).leaseMs).toBe(210_000);
    expect(message({ WORKER_EMAIL_ATTACH_MAX_BYTES: "0" })).toMatch(/WORKER_EMAIL_ATTACH_MAX_BYTES/);
    expect(message({ WORKER_SESSION_POLL_INTERVAL_MS: "10" })).toMatch(/WORKER_SESSION_POLL_INTERVAL_MS/);
  });
});
