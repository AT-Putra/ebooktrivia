// The ZAP gate (zap-report.ts): any High fails, a FAIL rule fails, an IGNORE rule is left out, the rest warns; and
// the committed rules file parses (each IGNORE carries a reason).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatVerdict, judge, parseReport, parseRules, signedInUrls } from "./zap-report.ts";

const report = (alerts: { pluginid: string; riskcode: string; name?: string; count?: string }[]) => ({
  "@programName": "ZAP",
  "@version": "2.17.0",
  site: [{ "@name": "https://play.example.test", alerts: alerts.map((a) => ({ name: "rule", count: "1", instances: [{ uri: "https://play.example.test/login" }], ...a })) }],
});

describe("the ZAP gate", () => {
  it("fails on any High, and on a rule the rules file marks FAIL; warns on the rest", () => {
    const rules = parseRules("# comment\n10055\tWARN\t(CSP)\n10020\tFAIL\t(Anti-clickjacking Header)\n");
    const verdict = judge(parseReport(report([{ pluginid: "40012", riskcode: "3" }, { pluginid: "10020", riskcode: "2" }, { pluginid: "10055", riskcode: "2" }, { pluginid: "10096", riskcode: "0" }])), rules);
    expect(verdict.failures.map((a) => a.pluginId)).toEqual(["40012", "10020"]);
    expect(verdict.warnings.map((a) => a.pluginId)).toEqual(["10055", "10096"]);
    expect(verdict.byRisk).toEqual({ high: 1, medium: 2, low: 0, informational: 1 });
    expect(formatVerdict(verdict)).toMatch(/^ZAP: 1 high, 2 medium, 0 low, 1 informational \(0 ignored by the rules file\)\nFAIL {2}High {2}40012/);
  });

  it("leaves out an IGNORE rule below High, and passes a report with no High", () => {
    const rules = parseRules("10109\tIGNORE\t(Modern Web Application)\tinformational only\n");
    const verdict = judge(parseReport(report([{ pluginid: "10109", riskcode: "2" }, { pluginid: "10038", riskcode: "2" }])), rules);
    expect(verdict.failures).toEqual([]);
    expect(verdict.ignored.map((a) => a.pluginId)).toEqual(["10109"]);
    expect(verdict.warnings.map((a) => a.pluginId)).toEqual(["10038"]);
    expect(judge(parseReport({ site: [] }), rules).failures).toEqual([]);
  });

  it("never lets an IGNORE rule hide a High alert (security review L1)", () => {
    const rules = parseRules("10109\tIGNORE\t(Modern Web Application)\tinformational only\n");
    const verdict = judge(parseReport(report([{ pluginid: "10109", riskcode: "3" }])), rules);
    expect(verdict.failures.map((a) => a.pluginId)).toEqual(["10109"]);
    expect(verdict.ignored).toEqual([]);
    expect(verdict.byRisk.high).toBe(1);
  });

  it("proves an authenticated scan was signed in only by a page a signed-out crawl cannot reach (security review M2)", () => {
    const loginOnly = ["https://admin.example.test/", "https://admin.example.test/login", "https://admin.example.test/account", "https://admin.example.test/team?_rsc=1x2y"].join("\n");
    expect(signedInUrls("admin", "example.test", loginOnly)).toEqual([]);
    expect(signedInUrls("admin", "example.test", `${loginOnly}\nhttps://admin.example.test/team\nhttps://admin.example.test/reports/sales`)).toEqual([
      "https://admin.example.test/team",
      "https://admin.example.test/reports/sales",
    ]);
    expect(signedInUrls("admin", "example.test", "https://admin.example.test.evil/team\nhttps://adminXexample.test/team")).toEqual([]);
    const playSignedOut = ["https://play.example.test/", "https://play.example.test/login", "https://play.example.test/masuk", "https://play.example.test/legal/privacy", "https://play.example.test/robots.txt", "https://play.example.test/api/v1/play/auth/session", "https://play.example.test/cap/widget.js"].join("\n");
    expect(signedInUrls("play", "example.test", playSignedOut)).toEqual([]);
    expect(signedInUrls("play", "example.test", `${playSignedOut}\nGET https://play.example.test/kuis-sejarah 200\nhttps://play.example.test/kuis-sejarah/set/2`)).toEqual([
      "https://play.example.test/kuis-sejarah",
      "https://play.example.test/kuis-sejarah/set/2",
    ]);
    expect(signedInUrls("play", "example.test", "https://admin.example.test/team")).toEqual([]);
  });

  it("refuses what is not a report or a rules file, rather than passing it", () => {
    expect(() => parseReport({})).toThrow(/no site list/);
    expect(() => parseReport(null)).toThrow(/no site list/);
    expect(() => parseReport(report([{ pluginid: "x", riskcode: "3" }]))).toThrow(/plugin id or risk/);
    expect(() => parseReport(report([{ pluginid: "1", riskcode: "4" }]))).toThrow(/plugin id or risk/);
    expect(() => parseRules("10109 IGNORE")).toThrow(/bad line/);
    expect(() => parseRules("10109\tSKIP\t(x)")).toThrow(/bad line/);
  });

  it("reads the committed rules file: every IGNORE has a reason", () => {
    const text = readFileSync(new URL("../staging/zap/rules.tsv", import.meta.url), "utf8");
    const rules = parseRules(text);
    expect(rules.size).toBeGreaterThan(0);
    for (const line of text.split(/\r?\n/).filter((l) => /^\d+\tIGNORE\t/.test(l))) {
      expect(line.split("\t")[3]?.trim().length ?? 0, line).toBeGreaterThan(20);
    }
  });
});
