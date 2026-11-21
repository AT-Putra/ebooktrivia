// US-030: the erasure of a data subject (packages/db sql/privacy.sql) waits while an OTP or login-link job of the subject is still
// live, i.e. below its consumer's claim cap. SQL cannot import these constants, so it mirrors them; this pins the copy equal, so a
// changed cap never leaves a dead job holding an erasure back (or a live one not holding it).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAGIC_LINK_RESEND_MAX_ATTEMPTS } from "./magic-link-resend.ts";
import { OTP_MAX_ATTEMPTS } from "./otp-send.ts";

const privacySql = readFileSync(new URL("../../../packages/db/sql/privacy.sql", import.meta.url), "utf8");

describe("the claim caps the erasure mirrors", () => {
  it.each([
    ["otp.send", OTP_MAX_ATTEMPTS],
    ["magic_link.resend", MAGIC_LINK_RESEND_MAX_ATTEMPTS],
  ])("%s: sql/privacy.sql uses the consumer's cap (%i)", (topic, cap) => {
    const found = [...privacySql.matchAll(new RegExp(`WHEN '${topic.replace(".", "\\.")}' THEN (\\d+)`, "g"))].map((m) => Number(m[1]));
    expect(found).toEqual([cap]);
  });
});
