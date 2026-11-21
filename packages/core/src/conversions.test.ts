import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONVERSION_STATUSES } from "./conversion-machine.ts";
import {
  CAPI_HOSTS,
  capiSecretName,
  CONVERSION_EXCERPT_MAX,
  moSinks,
  postbackPayout,
  postbackStatus,
  REDACTED_SECRET,
  redactSecretValues,
  REVERSAL_SKIPPED,
  reversalVerdict,
} from "./conversions.ts";
import { renderPostbackUrl } from "./template.ts";

describe("capiSecretName", () => {
  it("names a Meta token by pixel id and a TikTok token by lowercase pixel code", () => {
    expect(capiSecretName("meta", "1234567890123")).toBe("capi.meta.1234567890123");
    expect(capiSecretName("tiktok", "C3ABCDEFGH0123456")).toBe("capi.tiktok.c3abcdefgh0123456");
  });

  it("refuses an id that is not a pixel id of that platform (it would not pass the DB check either)", () => {
    expect(() => capiSecretName("meta", "12345")).toThrow(RangeError);
    expect(() => capiSecretName("meta", "C3ABCDEFGH0123456")).toThrow(RangeError);
    expect(() => capiSecretName("tiktok", "c3abcdefgh0123456")).toThrow(RangeError);
    expect(() => capiSecretName("tiktok", "1234567890123")).toThrow(RangeError);
  });

  it("only the two platforms' own API hosts exist", () => {
    expect(CAPI_HOSTS).toEqual({ meta: "graph.facebook.com", tiktok: "business-api.tiktok.com" });
  });
});

describe("moSinks (AC-T3, AC-T8)", () => {
  const pixels = { meta: "1234567890123", tiktok: "C3ABCDEFGH0123456", gtag: "AW-123456" };

  it("an attributed order with an MO template gets S2S, and a CAPI row per pixel; Google never", () => {
    expect(moSinks({ adnetId: "a", clickid: "c", adnetHasMoTemplate: true, pixels })).toEqual(["s2s", "meta", "tiktok"]);
  });

  it("an adnet without an MO template, or an organic order, gets no S2S row", () => {
    expect(moSinks({ adnetId: "a", clickid: "c", adnetHasMoTemplate: false, pixels })).toEqual(["meta", "tiktok"]);
    expect(moSinks({ adnetId: null, clickid: null, adnetHasMoTemplate: true, pixels })).toEqual(["meta", "tiktok"]);
    expect(moSinks({ adnetId: "a", clickid: "", adnetHasMoTemplate: true, pixels: {} })).toEqual([]);
    expect(moSinks({ adnetId: "a", clickid: null, adnetHasMoTemplate: true, pixels: null })).toEqual([]);
  });

  it("a pixel that is not a non-empty string is no pixel", () => {
    expect(moSinks({ adnetId: null, clickid: null, adnetHasMoTemplate: false, pixels: { meta: "", tiktok: 5 } })).toEqual([]);
    expect(moSinks({ adnetId: null, clickid: null, adnetHasMoTemplate: false, pixels: ["meta"] })).toEqual([]);
  });
});

describe("S2S values", () => {
  it("names the event: pending at MO, approved at MT, reversed at a reversal", () => {
    expect([postbackStatus("mo"), postbackStatus("mt"), postbackStatus("reversal")]).toEqual(["pending", "approved", "reversed"]);
  });

  it("MO earns nothing; MT and a reversal carry the adnet's fixed payout", () => {
    expect([postbackPayout("mo", 15_000), postbackPayout("mt", 15_000), postbackPayout("reversal", 15_000)]).toEqual(["0", "15000", "15000"]);
    expect(postbackPayout("mt", 0)).toBe("0");
  });

  it("refuses a payout that is not a non-negative whole number", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => postbackPayout("mt", bad)).toThrow(RangeError);
  });
});

describe("reversalVerdict (AC-T8: a reversal only for an MT that may have counted)", () => {
  const row = (status: (typeof CONVERSION_STATUSES)[number], maybeCounted = false) => ({ status, maybeCounted });

  it("sends after an MT the sink may have counted, whatever state the row is in now (the mark is sticky)", () => {
    expect(reversalVerdict(row("sent", true))).toBe("send");
    // A sent row is counted even before the mark existed.
    expect(reversalVerdict(row("sent"))).toBe("send");
    // An uncertain send, then an Owner re-fire (pending), then a refund that cancels it (failed): still reversed.
    expect(reversalVerdict(row("failed", true))).toBe("send");
    expect(reversalVerdict(row("pending", true))).toBe("send");
  });

  it("waits for an MT that is in flight, so a reversal never overtakes it", () => {
    expect(reversalVerdict(row("sending"))).toBe("wait");
    expect(reversalVerdict(row("sending", true))).toBe("wait");
  });

  it("skips when the MT never reached its sink: answered with an error every time, cancelled, never sent, or no MT row", () => {
    expect(reversalVerdict(row("failed"))).toBe("skip");
    expect(reversalVerdict(row("pending"))).toBe("skip");
    expect(reversalVerdict(undefined)).toBe("skip");
    expect(REVERSAL_SKIPPED).toMatch(/never reached/);
  });
});

describe("redactSecretValues (AC-T7)", () => {
  it("replaces a secret in the raw, URL-encoded and JSON-escaped forms a sink may echo", () => {
    const secret = 'p@ss w/"rd!';
    const echoed = `url=https://x/?k=${encodeURIComponent(secret).replace(/!/g, "%21")} body={"k":${JSON.stringify(secret)}} raw=${secret}`;
    const out = redactSecretValues(echoed, [secret]);
    expect(out).toBe(`url=https://x/?k=${REDACTED_SECRET} body={"k":"${REDACTED_SECRET}"} raw=${REDACTED_SECRET}`);
    expect(out).not.toContain("p@ss");
  });

  it("replaces every secret, the longer one first when one contains the other", () => {
    expect(redactSecretValues("a=abcdef b=abc", ["abc", "abcdef"])).toBe(`a=${REDACTED_SECRET} b=${REDACTED_SECRET}`);
  });

  it("also removes the start of a secret that a byte limit cut off at the end of the text", () => {
    expect(redactSecretValues("answer: k=abcdefgh", ["abcdefghijkl"])).toBe(`answer: k=${REDACTED_SECRET}`);
    expect(redactSecretValues("answer: abcdefghijkl, then abcd", ["abcdefghijkl"])).toBe(`answer: ${REDACTED_SECRET}, then ${REDACTED_SECRET}`);
    // Two characters of a secret are ordinary text; so is a tail that is not the start of the secret.
    expect(redactSecretValues("ends with ab", ["abcdefghijkl"])).toBe("ends with ab");
    expect(redactSecretValues("ends with xyz", ["abcdefghijkl"])).toBe("ends with xyz");
  });

  it("leaves a text without secrets, and an empty secret, alone", () => {
    expect(redactSecretValues("nothing to hide", ["zzz"])).toBe("nothing to hide");
    expect(redactSecretValues("nothing to hide", [""])).toBe("nothing to hide");
    expect(redactSecretValues("nothing to hide", [])).toBe("nothing to hide");
  });

  it("property: the URL a template renders never survives the redaction of its own secret", () => {
    const binding = { adnetId: "adnet-1", host: "track.example" };
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }).filter((s) => s.isWellFormed()), (suffix) => {
        const secret = `S3cr3t-${suffix}`;
        const url = renderPostbackUrl(
          "https://track.example/p?k={secret:api_key}&t={txid}&s={status}&a={payout}&c={clickid}",
          { clickid: "c1", txid: "T1", status: "approved", payout: "1" },
          binding,
          () => ({ value: secret, scope: "conversions", adnetId: "adnet-1", boundHost: "track.example" }),
        );
        expect(url).toContain("S3cr3t-");
        const out = redactSecretValues(`GET ${url} -> echoed ${JSON.stringify({ url })}`, [secret]);
        expect(out).not.toContain("S3cr3t");
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the log excerpt bound at 4 KB", () => {
    expect(CONVERSION_EXCERPT_MAX).toBe(4096);
  });
});
