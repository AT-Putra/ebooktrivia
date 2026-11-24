import { NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { describe, expect, it, vi } from "vitest";
import { createCsContactCache, csContactOf, FAILURE_TTL_MS, READ_TIMEOUT_MS, READ_TTL_MS } from "./contact.ts";

const CONTACT = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Setiap hari 08.00-20.00 WIB" };

describe("csContactOf (the row as the page uses it)", () => {
  it("keeps the three fields as they are, and no row is no contact", () => {
    expect(csContactOf(CONTACT)).toEqual(CONTACT);
    expect(csContactOf(undefined)).toEqual(NO_CS_CONTACT);
    expect(csContactOf({ whatsapp: null, email: null, hours: null })).toEqual(NO_CS_CONTACT);
  });

  it("drops a value the table's own checks would have refused, so a bad row can never put a dead link on a page", () => {
    expect(csContactOf({ whatsapp: "0812-3456-7890", email: "not an address", hours: "line one\nline two" })).toEqual(NO_CS_CONTACT);
    expect(csContactOf({ whatsapp: "+6281234567890", email: "not an address", hours: "" })).toEqual({ whatsapp: "+6281234567890", email: null, hours: null });
  });

  it("drops invisible characters in the hours and a non-ASCII address (the reviewer's probes)", () => {
    expect(csContactOf({ whatsapp: null, email: "cs\u202e@x.id", hours: "Senin\u2028Jumat" })).toEqual(NO_CS_CONTACT);
    expect(csContactOf({ whatsapp: null, email: "cs@x.id", hours: "abc\u202efed" })).toEqual({ whatsapp: null, email: "cs@x.id", hours: null });
  });
});

function harness(read: (signal: AbortSignal) => Promise<typeof CONTACT>) {
  let clock = 1_000_000;
  const onFailure = vi.fn();
  const cache = createCsContactCache({ read, onFailure, now: () => clock });
  return {
    cache,
    onFailure,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createCsContactCache (a cheap read that never breaks a page)", () => {
  it("reads once and answers from memory until the short time to live passes", async () => {
    const read = vi.fn(() => Promise.resolve(CONTACT));
    const { cache, advance } = harness(read);
    expect(await cache.get()).toEqual(CONTACT);
    expect(await cache.get()).toEqual(CONTACT);
    expect(read).toHaveBeenCalledTimes(1);
    advance(READ_TTL_MS - 1);
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("after the time to live serves the last answer AT ONCE and refreshes in the background: a change shows on the next request, and a request never waits for the refresh", async () => {
    let next = CONTACT;
    let release: () => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<typeof CONTACT>((resolve) => {
          release = () => {
            resolve(next);
          };
        }),
    );
    const { cache, advance } = harness(read);
    const first = cache.get();
    release();
    expect(await first).toEqual(CONTACT);
    advance(READ_TTL_MS + 1);
    next = { ...CONTACT, email: "baru@contoh.id" };
    // The refresh is under way (its read is not released yet) and the request is answered with what it had.
    expect(await cache.get()).toEqual(CONTACT);
    expect(await cache.get()).toEqual(CONTACT);
    expect(read).toHaveBeenCalledTimes(2);
    release();
    await cache.idle();
    expect((await cache.get()).email).toBe("baru@contoh.id");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("serves requests that arrive during the first read with that one read", async () => {
    let release: (value: typeof CONTACT) => void = () => undefined;
    const read = vi.fn(() => new Promise<typeof CONTACT>((resolve) => (release = resolve)));
    const { cache } = harness(read);
    const first = cache.get();
    const second = cache.get();
    release(CONTACT);
    expect(await Promise.all([first, second])).toEqual([CONTACT, CONTACT]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers no contact (no block) when the first read fails, logs a code, and does not hammer a database that is down", async () => {
    const read = vi.fn(() => Promise.reject(new Error("the database is down")));
    const { cache, onFailure, advance } = harness(read);
    expect(await cache.get()).toEqual(NO_CS_CONTACT);
    expect(onFailure).toHaveBeenCalledWith("read_failed", expect.any(Error));
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    advance(FAILURE_TTL_MS + 1);
    await cache.get();
    await cache.idle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps showing the last good contact while a later refresh fails, and picks the next good one up", async () => {
    let fail = false;
    const read = vi.fn(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve(CONTACT)));
    const { cache, advance, onFailure } = harness(read);
    await cache.get();
    fail = true;
    advance(READ_TTL_MS + 1);
    expect(await cache.get()).toEqual(CONTACT);
    await cache.idle();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(await cache.get()).toEqual(CONTACT);
    fail = false;
    advance(FAILURE_TTL_MS + 1);
    expect(await cache.get()).toEqual(CONTACT);
    await cache.idle();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up on a first read that takes too long, with the timeout code, and CANCELS it so it holds no connection", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const read = vi.fn((given: AbortSignal) => {
        signal = given;
        return new Promise<typeof CONTACT>(() => undefined);
      });
      const { cache, onFailure } = harness(read);
      const answer = cache.get();
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
      expect(await answer).toEqual(NO_CS_CONTACT);
      expect(onFailure).toHaveBeenCalledWith("read_timeout", expect.any(Error));
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a background refresh that stalls is cancelled too, and the page was never held for it", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let stall = false;
      const read = vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return stall ? new Promise<typeof CONTACT>(() => undefined) : Promise.resolve(CONTACT);
      });
      const { cache, advance, onFailure } = harness(read);
      await cache.get();
      stall = true;
      advance(READ_TTL_MS + 1);
      expect(await cache.get()).toEqual(CONTACT);
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
      await cache.idle();
      expect(signals).toHaveLength(2);
      expect(signals[1]?.aborted).toBe(true);
      expect(onFailure).toHaveBeenCalledWith("read_timeout", expect.any(Error));
      expect(await cache.get()).toEqual(CONTACT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear() forgets what is held", async () => {
    const read = vi.fn(() => Promise.resolve(CONTACT));
    const { cache } = harness(read);
    await cache.get();
    cache.clear();
    await cache.get();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
