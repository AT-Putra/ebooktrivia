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
});

function harness(read: () => Promise<typeof CONTACT>) {
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
  it("reads once and answers from memory until the short time to live passes, then reads again (a change the Owner saves shows up)", async () => {
    const read = vi.fn(() => Promise.resolve(CONTACT));
    const { cache, advance } = harness(read);
    expect(await cache.get()).toEqual(CONTACT);
    expect(await cache.get()).toEqual(CONTACT);
    expect(read).toHaveBeenCalledTimes(1);
    advance(READ_TTL_MS - 1);
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    advance(2);
    await cache.get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("serves requests that arrive during a read with that one read", async () => {
    let release: (value: typeof CONTACT) => void = () => undefined;
    const read = vi.fn(() => new Promise<typeof CONTACT>((resolve) => (release = resolve)));
    const { cache } = harness(read);
    const first = cache.get();
    const second = cache.get();
    release(CONTACT);
    expect(await Promise.all([first, second])).toEqual([CONTACT, CONTACT]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers no contact (no block) when the read fails, logs a code, and does not hammer a database that is down", async () => {
    const read = vi.fn(() => Promise.reject(new Error("the database is down")));
    const { cache, onFailure, advance } = harness(read);
    expect(await cache.get()).toEqual(NO_CS_CONTACT);
    expect(onFailure).toHaveBeenCalledWith("read_failed", expect.any(Error));
    await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    advance(FAILURE_TTL_MS + 1);
    await cache.get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps showing the last good contact while a later read fails, and picks the next good one up", async () => {
    let fail = false;
    const read = vi.fn(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve(CONTACT)));
    const { cache, advance, onFailure } = harness(read);
    await cache.get();
    fail = true;
    advance(READ_TTL_MS + 1);
    expect(await cache.get()).toEqual(CONTACT);
    expect(onFailure).toHaveBeenCalledTimes(1);
    fail = false;
    advance(FAILURE_TTL_MS + 1);
    expect(await cache.get()).toEqual(CONTACT);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up on a read that takes too long, with the timeout code, and renders without the block", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(() => new Promise<typeof CONTACT>(() => undefined));
      const { cache, onFailure } = harness(read);
      const answer = cache.get();
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
      expect(await answer).toEqual(NO_CS_CONTACT);
      expect(onFailure).toHaveBeenCalledWith("read_timeout", expect.any(Error));
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
