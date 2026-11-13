import { describe, expect, it } from "vitest";
import { alertFromGlitchtip, cleanText, readLimitedBody } from "./glitchtip.ts";

// Shape of a GlitchTip issue alert webhook (Slack-compatible attachments plus MS Teams sections).
const ISSUE = {
  alias: "GlitchTip",
  text: "GlitchTip Alert",
  attachments: [
    {
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      title_link: "https://glitchtip.example.com/ebooktrivia/issues/42",
      text: "apps/public/src/checkout.ts in handler",
      image_url: null,
      color: "#e52b50",
      fields: [
        { title: "Project", value: "public", short: true },
        { title: "Environment", value: "production", short: true },
      ],
    },
  ],
  sections: [{ activityTitle: "TypeError", activitySubtitle: "[View Issue](https://glitchtip.example.com/ebooktrivia/issues/42)" }],
};

describe("alertFromGlitchtip", () => {
  it("maps an issue alert to one alerts row", () => {
    expect(alertFromGlitchtip(ISSUE)).toEqual({
      kind: "glitchtip_webhook",
      severity: "warning",
      dedupeKey: "glitchtip:https://glitchtip.example.com/ebooktrivia/issues/42",
      message: "TypeError: Cannot read properties of undefined (reading 'id')",
      payload: {
        text: "GlitchTip Alert",
        attachments: [
          {
            title: "TypeError: Cannot read properties of undefined (reading 'id')",
            link: "https://glitchtip.example.com/ebooktrivia/issues/42",
            text: "apps/public/src/checkout.ts in handler",
            fields: [
              { title: "Project", value: "public" },
              { title: "Environment", value: "production" },
            ],
          },
        ],
      },
    });
  });

  it("keeps an unknown object as a generic alert, so no alert is lost", () => {
    const alert = alertFromGlitchtip({ something: "else" });
    expect(alert).toMatchObject({ kind: "glitchtip_webhook", severity: "warning", message: "GlitchTip alert", payload: { attachments: [] } });
    expect(alert?.dedupeKey).toMatch(/^glitchtip:[0-9a-f]{64}$/);
    expect(alertFromGlitchtip({ text: "The monitor shop is down" })?.message).toBe("The monitor shop is down");
    const unparsable = alertFromGlitchtip({ attachments: [{ title: "T", title_link: "http://[not-a-url" }] });
    expect(unparsable?.dedupeKey).toMatch(/^glitchtip:[0-9a-f]{64}$/);
  });

  it("refuses anything that is not a JSON object", () => {
    for (const body of [null, 1, "x", [], [ISSUE], true]) expect(alertFromGlitchtip(body)).toBeNull();
  });

  it("bounds and cleans every string (no control characters, no NUL for jsonb)", () => {
    const alert = alertFromGlitchtip({
      text: `a\u0000b\u0007c\nd${"x".repeat(5000)}`,
      attachments: Array.from({ length: 20 }, () => ({
        title: `t\u0000${"y".repeat(1000)}`,
        title_link: "javascript:alert(1)",
        text: 7,
        fields: Array.from({ length: 50 }, (_, i) => ({ title: i, value: { nested: true } })),
      })),
    });
    expect(alert).not.toBeNull();
    const json = JSON.stringify(alert);
    for (let i = 0; i < json.length; i++) expect(json.charCodeAt(i)).toBeGreaterThanOrEqual(0x20);
    expect(json).not.toContain("\\u0000");
    expect(alert?.message.length).toBeLessThanOrEqual(500);
    const payload = alert?.payload as { text: string; attachments: { link: string | null; fields: unknown[] }[] };
    expect(payload.text.startsWith("abc d")).toBe(true);
    expect(payload.text.length).toBeLessThanOrEqual(1000);
    expect(payload.attachments).toHaveLength(5);
    expect(payload.attachments[0]?.link).toBeNull();
    expect(payload.attachments[0]?.fields).toHaveLength(10);
    expect(alert?.dedupeKey).toMatch(/^glitchtip:[0-9a-f]{64}$/);
  });

  // Security review US-013 #7: alerts are relayed to WhatsApp / email; no PII in them.
  it("masks emails and phone-like digit runs in the message and the payload", () => {
    const alert = alertFromGlitchtip({
      text: "checkout failed for buyer@example.com",
      attachments: [
        {
          title: "Error: WAHA send to +6281234567890 failed",
          title_link: "https://glitchtip.example.com/issues/9",
          text: "user Jane.Doe@mail.example phone 6281234567890",
          fields: [{ title: "User", value: "buyer@example.com" }],
        },
      ],
    });
    const json = JSON.stringify(alert);
    expect(json).not.toMatch(/example\.com"|@mail|6281234567890/);
    expect(alert?.message).toBe("Error: WAHA send to [number] failed");
    expect(alert?.payload).toMatchObject({
      text: "checkout failed for [email]",
      attachments: [{ text: "user [email] phone [number]", fields: [{ title: "User", value: "[email]" }] }],
    });
  });

  it("cleanText drops control characters and lone surrogates, collapses whitespace and truncates", () => {
    expect(cleanText(" a\tb\r\nc\u007f\u0085d\uD800e ", 100)).toBe("a b cde");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("😀😀", 3)).toBe("😀");
  });
});

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

describe("readLimitedBody", () => {
  it("reads a body up to the limit", async () => {
    const body = await readLimitedBody(stream([new Uint8Array(10), new Uint8Array(6)]), 16);
    expect(body).toBeInstanceOf(Uint8Array);
    expect((body as Uint8Array).length).toBe(16);
    expect(await readLimitedBody(null, 16)).toEqual(new Uint8Array(0));
  });

  it("stops reading and cancels the stream once the limit is passed, whatever Content-Length said", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readLimitedBody(endless, 4096)).toBe("too_large");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(6);
  });
});
