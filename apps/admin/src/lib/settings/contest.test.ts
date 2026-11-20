// The deadline-extension form (US-028): the outage start and end are WIB dates and times, start <=
// end <= now, the start within the last trivia.extension_max_minutes; the reason is 10-500
// characters without contact data.
import { describe, expect, it } from "vitest";
import { parseExtension, wibLocal } from "./contest.ts";
import { InvalidInput } from "./fields.ts";

const NOW = new Date("2027-07-10T05:00:00.000Z"); // 12:00 WIB
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ outageStartedAt: "2027-07-10T11:30", outageEndedAt: "2027-07-10T11:50", reason: "Server mati setengah jam.", ...fields })) f.set(k, v);
  return f;
};
const refused = (fields: Record<string, string>, max = 60): string => {
  try {
    parseExtension(form(fields), max, NOW);
  } catch (e) {
    if (e instanceof InvalidInput) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("parseExtension", () => {
  it("reads the outage start and end as WIB and the trimmed reason", () => {
    expect(parseExtension(form({ reason: "  Server mati setengah jam.  " }), 60, NOW)).toEqual({
      outageStartedAt: new Date("2027-07-10T04:30:00.000Z"),
      outageEndedAt: new Date("2027-07-10T04:50:00.000Z"),
      reason: "Server mati setengah jam.",
    });
    expect(parseExtension(form({ outageEndedAt: "2027-07-10T11:30" }), 60, NOW).outageEndedAt).toEqual(new Date("2027-07-10T04:30:00.000Z"));
    expect(wibLocal(new Date("2027-07-10T04:30:00.000Z"))).toBe("2027-07-10T11:30");
  });

  it.each([
    ["no outage start", { outageStartedAt: "" }, /outage started/],
    ["a malformed outage start", { outageStartedAt: "10/07/2027 11:30" }, /outage started/],
    ["an impossible date", { outageStartedAt: "2027-02-30T11:30" }, /outage started/],
    ["an outage in the future", { outageStartedAt: "2027-07-10T12:01", outageEndedAt: "2027-07-10T12:02" }, /last 60 minutes/],
    ["no outage end", { outageEndedAt: "" }, /outage ended/],
    ["a malformed outage end", { outageEndedAt: "11:50" }, /outage ended/],
    ["an end before the start", { outageEndedAt: "2027-07-10T11:29" }, /end after it started/],
    ["an end in the future", { outageEndedAt: "2027-07-10T12:01" }, /end after it started/],
    ["an outage longer than the setting allows", { outageStartedAt: "2027-07-10T10:59" }, /last 60 minutes/],
    ["a short reason", { reason: "mati" }, /10 to 500/],
    ["a reason with a phone number", { reason: "Pemain 0812 3456 7890 melapor" }, /personal data/],
  ])("refuses %s", (_what, fields, message) => {
    expect(refused(fields)).toMatch(message);
  });

  it("follows the setting", () => {
    expect(parseExtension(form({ outageStartedAt: "2027-07-10T10:30" }), 120, NOW).outageStartedAt).toEqual(new Date("2027-07-10T03:30:00.000Z"));
  });
});
