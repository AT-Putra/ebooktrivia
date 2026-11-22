// Code review US-017 F7: the production podman networks (infra/quadlet ebt-*.network) are never an
// outbound target. Every Subnet= must lie inside a range packages/adapters address-policy refuses
// even for an allowlisted private host (safe-fetch, the SMTP adapter and the admin's endpoint checks
// all use it), so a WAHA / SMTP / postback address can never reach PostgreSQL, Valkey or the apps.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../../../packages/adapters/src/address-policy.ts";

const QUADLET = fileURLToPath(new URL("../../quadlet/", import.meta.url));
const ALLOWLISTED = { allowPrivate: true, allowLoopback: false } as const;

const subnets = readdirSync(QUADLET)
  .filter((f) => /^ebt-.*\.network$/.test(f))
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

  it.each(subnets)("%s Subnet=%s is refused end to end, even for an allowlisted private host", (_file, cidr) => {
    expect(cidr).toMatch(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/);
    for (const address of bounds(cidr)) expect(isBlockedAddress(address, ALLOWLISTED), address).toBe(true);
  });

  it("computes CIDR bounds", () => {
    expect(bounds("10.89.52.0/24")).toEqual(["10.89.52.0", "10.89.52.255"]);
    expect(bounds("10.89.0.0/16")).toEqual(["10.89.0.0", "10.89.255.255"]);
  });
});
