import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUYER_KEY_VERSION,
  buyerKey,
  type CheckoutDecision,
  decideCheckout,
  DEDUPE_WINDOW_MS,
  MAX_SNAP_ATTEMPTS,
  MIN_PAYMENT_WINDOW_MS,
  normalizeBuyerText,
  type OpenOrder,
  salesState,
  type SalesWindow,
  SNAP_URL_STALE_MS,
  snapExpiry,
} from "./checkout.ts";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const MIN = 60_000;

describe("salesState (AC-S8: refused when now > sales_end - buffer)", () => {
  const window: SalesWindow = {
    landingPageActive: true,
    productActive: true,
    programStatus: "published",
    salesStartAt: at(-24 * 60 * MIN),
    salesEndAt: at(60 * MIN),
    closeBufferMinutes: 30,
  };

  it("is open inside the window, up to and including sales_end - buffer", () => {
    expect(salesState(window, NOW)).toBe("open");
    expect(salesState(window, at(30 * MIN))).toBe("open");
    expect(salesState({ ...window, salesStartAt: NOW }, NOW)).toBe("open");
  });

  it("is closed one millisecond after sales_end - buffer, and after sales_end", () => {
    expect(salesState(window, at(30 * MIN + 1))).toBe("closed");
    expect(salesState(window, at(61 * MIN))).toBe("closed");
  });

  it("uses the configured buffer", () => {
    expect(salesState({ ...window, closeBufferMinutes: 5 }, at(50 * MIN))).toBe("open");
    expect(salesState({ ...window, closeBufferMinutes: 5 }, at(55 * MIN + 1))).toBe("closed");
  });

  it("is not_started before sales_start", () => {
    expect(salesState({ ...window, salesStartAt: at(1) }, NOW)).toBe("not_started");
  });

  it("is inactive for an inactive landing page or product, or a program that is not published", () => {
    expect(salesState({ ...window, landingPageActive: false }, NOW)).toBe("inactive");
    expect(salesState({ ...window, productActive: false }, NOW)).toBe("inactive");
    for (const status of ["draft", "awaiting_confirmation", "finalized"]) expect(salesState({ ...window, programStatus: status }, NOW)).toBe("inactive");
  });
});

describe("decideCheckout (dedupe, crash window, retry bound)", () => {
  const pendingWithUrl: OpenOrder = {
    status: "pending",
    attemptCount: 1,
    redirectUrl: "https://app.sandbox.midtrans.com/snap/v4/redirection/t",
    snapExpiresAt: at(23 * 60 * MIN),
    expiresAt: at(24 * 60 * MIN),
    createdAt: at(-5 * MIN),
    lastAttemptAt: at(-5 * MIN),
  };
  const decide = (order: Partial<OpenOrder> | undefined): CheckoutDecision => decideCheckout(order === undefined ? undefined : { ...pendingWithUrl, ...order }, NOW);

  it("creates a new order when there is none", () => {
    expect(decide(undefined)).toEqual({ kind: "new" });
  });

  it("dedupes a pending order with a stored URL inside the 30 minute window", () => {
    expect(decide({})).toEqual({ kind: "deduped" });
    expect(decide({ createdAt: at(-DEDUPE_WINDOW_MS + 1) })).toEqual({ kind: "deduped" });
  });

  it("creates a new order once the window has passed (30 minutes exactly is outside)", () => {
    expect(decide({ createdAt: at(-DEDUPE_WINDOW_MS) })).toEqual({ kind: "new" });
  });

  it("never returns a URL whose payment page would close within 5 minutes", () => {
    expect(decide({ snapExpiresAt: at(MIN_PAYMENT_WINDOW_MS) })).toEqual({ kind: "deduped" });
    expect(decide({ snapExpiresAt: at(MIN_PAYMENT_WINDOW_MS - 1) })).toEqual({ kind: "new" });
    expect(decide({ snapExpiresAt: null })).toEqual({ kind: "new" });
  });

  it("never reuses an order that expires within 5 minutes", () => {
    expect(decide({ expiresAt: at(MIN_PAYMENT_WINDOW_MS - 1) })).toEqual({ kind: "new" });
    expect(decide({ status: "snap_create_failed", redirectUrl: null, expiresAt: at(MIN_PAYMENT_WINDOW_MS - 1) })).toEqual({ kind: "new" });
  });

  it("reports a pending order without a URL as in flight for 60 s after its latest attempt", () => {
    expect(decide({ redirectUrl: null, lastAttemptAt: NOW })).toEqual({ kind: "in_flight" });
    expect(decide({ redirectUrl: null, lastAttemptAt: at(-SNAP_URL_STALE_MS + 1) })).toEqual({ kind: "in_flight" });
  });

  it("treats a pending order still without a URL after 60 s as snap_create_failed: retried with n + 1", () => {
    expect(decide({ redirectUrl: null, lastAttemptAt: at(-SNAP_URL_STALE_MS) })).toEqual({ kind: "retry", n: 2 });
    expect(decide({ redirectUrl: null, attemptCount: 0, lastAttemptAt: null })).toEqual({ kind: "retry", n: 1 });
  });

  it("retries a snap_create_failed order with n + 1, however recent its attempt", () => {
    expect(decide({ status: "snap_create_failed", redirectUrl: null, attemptCount: 3, lastAttemptAt: NOW })).toEqual({ kind: "retry", n: 4 });
  });

  it("stops an order after MAX_SNAP_ATTEMPTS attempts, and its buyer gets a new order (it never blocks them)", () => {
    expect(decide({ status: "snap_create_failed", redirectUrl: null, attemptCount: MAX_SNAP_ATTEMPTS - 1 })).toEqual({ kind: "retry", n: MAX_SNAP_ATTEMPTS });
    expect(decide({ status: "snap_create_failed", redirectUrl: null, attemptCount: MAX_SNAP_ATTEMPTS })).toEqual({ kind: "new" });
    expect(decide({ redirectUrl: null, attemptCount: MAX_SNAP_ATTEMPTS, lastAttemptAt: at(-2 * SNAP_URL_STALE_MS) })).toEqual({ kind: "new" });
  });
});

describe("snapExpiry (AC-S10: min(order expiry, sales_end))", () => {
  it("takes the order expiry when it comes first, less a minute of margin, in whole minutes", () => {
    expect(snapExpiry(NOW, at(24 * 60 * MIN), at(30 * 24 * 60 * MIN))).toEqual({ minutes: 24 * 60 - 1, expiresAt: at((24 * 60 - 1) * MIN) });
  });

  it("takes sales_end when it comes first", () => {
    expect(snapExpiry(NOW, at(24 * 60 * MIN), at(45 * MIN + 30_000))).toEqual({ minutes: 44, expiresAt: at(44 * MIN) });
  });

  it("is null when not even one whole minute is left", () => {
    expect(snapExpiry(NOW, at(2 * MIN), at(10 * MIN))).toEqual({ minutes: 1, expiresAt: at(MIN) });
    expect(snapExpiry(NOW, at(2 * MIN - 1), at(10 * MIN))).toBeNull();
    expect(snapExpiry(NOW, at(-MIN), at(10 * MIN))).toBeNull();
  });
});

describe("buyerKey (Owner decision D1: the same buyer is the same phone, name and e-mail)", () => {
  const buyer = { phone: "+6281234567890", name: "Budi Santoso", email: "budi@example.id" };

  it("normalises names and e-mails: NFC, whitespace collapsed, trimmed, lowercased", () => {
    expect(normalizeBuyerText("  Budi\u00a0\t SANTOSO \n")).toBe("budi santoso");
    expect(normalizeBuyerText("Jose\u0301")).toBe(normalizeBuyerText("Jos\u00e9"));
    expect(normalizeBuyerText(" Budi@Example.ID ")).toBe("budi@example.id");
  });

  it("is the SHA-256 of the versioned JSON tuple, equal for the same buyer up to case and whitespace", () => {
    const key = buyerKey(buyer);
    expect(key).toHaveLength(32);
    expect(key.toString("hex")).toBe(createHash("sha256").update(JSON.stringify([BUYER_KEY_VERSION, buyer.phone, "budi santoso", "budi@example.id"])).digest("hex"));
    expect(buyerKey({ ...buyer, name: " BUDI   santoso", email: "BUDI@example.ID" })).toEqual(key);
  });

  it("differs for another phone, name or e-mail, and cannot be forged by moving a separator between fields", () => {
    const key = buyerKey(buyer).toString("hex");
    for (const other of [{ ...buyer, phone: "+6281234567891" }, { ...buyer, name: "Budi Santosa" }, { ...buyer, email: "budi@example.com" }]) {
      expect(buyerKey(other).toString("hex"), JSON.stringify(other)).not.toBe(key);
    }
    expect(buyerKey({ phone: buyer.phone, name: "a|b", email: "c" }).toString("hex")).not.toBe(buyerKey({ phone: buyer.phone, name: "a", email: "b|c" }).toString("hex"));
    expect(buyerKey({ phone: buyer.phone, name: 'a","b', email: "c" }).toString("hex")).not.toBe(buyerKey({ phone: buyer.phone, name: "a", email: 'b","c' }).toString("hex"));
  });
});
