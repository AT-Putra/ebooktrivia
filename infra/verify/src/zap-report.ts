// The gate of the ZAP scans (US-031; infra/verify/staging/zap-baseline.sh and zap-auth.sh): a ZAP JSON report
// (template traditional-json) fails on ANY High alert (ZAP has no "Critical": High is its top risk), and on any alert
// of a rule the rules file marks FAIL. A rule the rules file marks IGNORE (each with its reason in the file) is left
// out, below High only (an IGNORE never hides a High);
// every other alert is listed as a warning, for the runbook's triage. The same rules file
// (infra/verify/staging/zap/rules.tsv) is the packaged baseline scan's -c config, so both read one list.
//   node infra/verify/src/zap-report-cli.ts <rules.tsv> <report.json>...     exit 0 pass, 1 fail, 2 unreadable

export type RuleAction = "IGNORE" | "INFO" | "WARN" | "FAIL";

export interface ZapAlert {
  readonly pluginId: string;
  readonly name: string;
  /** 0 informational, 1 low, 2 medium, 3 high. */
  readonly risk: number;
  readonly site: string;
  readonly count: number;
  readonly uris: readonly string[];
}

export interface Verdict {
  readonly failures: readonly ZapAlert[];
  readonly warnings: readonly ZapAlert[];
  readonly ignored: readonly ZapAlert[];
  readonly byRisk: Readonly<Record<"high" | "medium" | "low" | "informational", number>>;
}

/**
 * The rules file, zap-baseline's -c format: `<plugin id>\t<IGNORE|INFO|WARN|FAIL>\t(<name>)[\t<message>]` (the message
 * is the reason, shown in ZAP's output too); `#` lines are comments.
 */
export function parseRules(text: string): Map<string, RuleAction> {
  const rules = new Map<string, RuleAction>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const [id = "", action = ""] = line.split("\t");
    if (!/^\d+$/.test(id) || !["IGNORE", "INFO", "WARN", "FAIL"].includes(action)) throw new Error(`rules file: bad line "${line.slice(0, 80)}"`);
    rules.set(id, action as RuleAction);
  }
  return rules;
}

interface ReportJson {
  readonly site?: readonly {
    readonly "@name"?: string;
    readonly alerts?: readonly { readonly pluginid?: string; readonly name?: string; readonly alert?: string; readonly riskcode?: string; readonly count?: string; readonly instances?: readonly { readonly uri?: string }[] }[];
  }[];
}

export function parseReport(json: unknown): ZapAlert[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as ReportJson).site)) throw new Error("not a ZAP traditional-json report (no site list)");
  const sites: NonNullable<ReportJson["site"]> = (json as ReportJson).site ?? [];
  return sites.flatMap((site) =>
    (site.alerts ?? []).map((a) => {
      const risk = Number(a.riskcode);
      if (!/^\d+$/.test(a.pluginid ?? "") || !Number.isInteger(risk) || risk < 0 || risk > 3) throw new Error(`a report alert without a plugin id or risk: ${JSON.stringify(a).slice(0, 120)}`);
      return {
        pluginId: a.pluginid ?? "",
        name: a.name ?? a.alert ?? "",
        risk,
        site: site["@name"] ?? "",
        count: Number(a.count ?? a.instances?.length ?? 0),
        uris: [...new Set((a.instances ?? []).map((i) => i.uri ?? ""))].slice(0, 5),
      };
    }),
  );
}

export function judge(alerts: readonly ZapAlert[], rules: ReadonlyMap<string, RuleAction>): Verdict {
  const failures: ZapAlert[] = [];
  const warnings: ZapAlert[] = [];
  const ignored: ZapAlert[] = [];
  const byRisk = { high: 0, medium: 0, low: 0, informational: 0 };
  for (const alert of alerts) {
    const action = rules.get(alert.pluginId);
    // An IGNORE never hides a High (security review L1): a High alert fails whatever the rules file says.
    if (action === "IGNORE" && alert.risk < 3) {
      ignored.push(alert);
      continue;
    }
    byRisk[(["informational", "low", "medium", "high"] as const)[alert.risk] ?? "informational"]++;
    if (alert.risk >= 3 || action === "FAIL") failures.push(alert);
    else warnings.push(alert);
  }
  return { failures, warnings, ignored, byRisk };
}

const RISK = ["Informational", "Low", "Medium", "High"];
const line = (a: ZapAlert) => `${RISK[a.risk] ?? "?"}  ${a.pluginId}  ${a.name}  (${String(a.count)}x, ${a.site}) ${a.uris.join(" ")}`;

export function formatVerdict(verdict: Verdict): string {
  const out = [
    `ZAP: ${String(verdict.byRisk.high)} high, ${String(verdict.byRisk.medium)} medium, ${String(verdict.byRisk.low)} low, ${String(verdict.byRisk.informational)} informational (${String(verdict.ignored.length)} ignored by the rules file)`,
    ...verdict.failures.map((a) => `FAIL  ${line(a)}`),
    ...verdict.warnings.map((a) => `WARN  ${line(a)}`),
  ];
  return `${out.join("\n")}\n`;
}

/**
 * The proof that an authenticated scan WAS signed in (security review M2): a scan whose login failed crawls only the
 * login page and passes on what it saw. Each plan exports the URLs it reached (AF `export` job, type url); the scan
 * fails unless one of them is a page that only a signed-in user can reach by following links: a console page other
 * than the overview and the account page (the login check polls those), or a program page of the trivia. A URL with a
 * query (Next's `_rsc` prefetches, which the login browser makes) does not count: the spider must have fetched it.
 */
export type ScanTarget = "admin" | "play";

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SIGNED_IN_ONLY: Readonly<Record<ScanTarget, (domain: string) => RegExp>> = {
  admin: (domain) => new RegExp(`^https://admin\\.${escapeRegex(domain)}/(?:team|audit|reports/[a-z-]+|settings/[a-z-]+)/?$`),
  play: (domain) =>
    new RegExp(
      `^https://play\\.${escapeRegex(domain)}/(?!(?:login|masuk|legal|api|cap|files|mockups|trivia|order|_next|robots\\.txt|favicon\\.ico)(?:[/.?]|$))[a-z0-9-]+(?:/set/\\d+)?/?$`,
    ),
};

/** The signed-in-only URLs of an exported URL list (one URL per line; any other text on a line is ignored). */
export function signedInUrls(target: ScanTarget, domain: string, exported: string): string[] {
  const pattern = SIGNED_IN_ONLY[target](domain);
  return exported
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\s+/).filter((word) => word.startsWith("https://")))
    .filter((url) => pattern.test(url));
}
