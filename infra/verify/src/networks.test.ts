// Code review US-017 F7: the production podman networks (infra/quadlet ebt-*.network) are never an
// outbound target. Every Subnet= must lie inside a range packages/adapters address-policy refuses
// even for an allowlisted private host (safe-fetch, the SMTP adapter and the admin's endpoint checks
// all use it), so a WAHA / SMTP / postback address can never reach PostgreSQL, Valkey or the apps.
// ONE exception, on purpose (2026-11-25): ebt-preflight, where the worker's pre-flight of a WhatsApp file send reaches the api site
// (WORKER_API_EDGE_ADDRESS) because a rootless container cannot reach the VM's own public address. Its only other member is Caddy,
// which answers there for the public api site alone (caddyfile.test.ts), so what it opens is what the internet already reaches:
// still never PostgreSQL, Valkey or an app.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../../../packages/adapters/src/address-policy.ts";

const QUADLET = fileURLToPath(new URL("../../quadlet/", import.meta.url));
const ALLOWLISTED = { allowPrivate: true, allowLoopback: false } as const;

/** The one network outbound calls may reach (see above): Caddy and the worker only, internal. */
const PREFLIGHT = "ebt-preflight.network";

const subnets = readdirSync(QUADLET)
  .filter((f) => /^ebt-.*\.network$/.test(f) && f !== PREFLIGHT)
  .flatMap((f) => [...readFileSync(join(QUADLET, f), "utf8").matchAll(/^Subnet=(\S+)$/gm)].map((m) => [f, m[1] ?? ""] as const));

/** First and last IPv4 address of a CIDR block. */
function bounds(cidr: string): [string, string] {
  const [base = "", bits = "32"] = cidr.split("/");
  const value = base.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(bits));
  const start = value - (value % size);
  const ip = (n: number) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
  return [ip(start), ip(start + size - 1)];
}

describe("podman networks vs the outbound address policy", () => {
  it("finds the ebt-* networks", () => {
    expect(subnets.map(([f]) => f).sort()).toEqual(["ebt-admin.network", "ebt-backup.network", "ebt-data.network", "ebt-edge.network", "ebt-internal.network"]);
  });

  it("keeps the one reachable network (ebt-preflight) internal, with Caddy and the worker as its only members", () => {
    const file = readFileSync(join(QUADLET, PREFLIGHT), "utf8");
    expect(file).toMatch(/^Internal=true$/m);
    const members = readdirSync(QUADLET)
      .filter((f) => f.endsWith(".container"))
      .filter((f) => readFileSync(join(QUADLET, f), "utf8").includes(`Network=${PREFLIGHT}:`))
      .sort();
    expect(members).toEqual(["caddy.container", "worker.container"]);
  });

  it.each(subnets)("%s Subnet=%s is refused end to end, even for an allowlisted private host", (_file, cidr) => {
    expect(cidr).toMatch(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/);
    for (const address of bounds(cidr)) expect(isBlockedAddress(address, ALLOWLISTED), address).toBe(true);
  });

  it("computes CIDR bounds", () => {
    expect(bounds("10.89.52.0/24")).toEqual(["10.89.52.0", "10.89.52.255"]);
    expect(bounds("10.89.0.0/16")).toEqual(["10.89.0.0", "10.89.255.255"]);
  });
});
