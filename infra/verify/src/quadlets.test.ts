// Story US-014 criterion 2: the quadlets against the plan M4.2 memory budget and against each
// other (pinned addresses, network membership, pg_hba.conf, the Caddyfile's upstream names, no
// published ports, no secret in a unit file, health checks, image pins). The quadlet generator dry
// run itself is in infra/verify/local/{quadlet-dryrun,vm-sim}.sh.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseQuadlet, type Quadlet, quadletFiles, readQuadlet } from "./quadlet.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BUDGET_MIB: Record<string, number> = {
  "postgres.container": 2048,
  "valkey.container": 512,
  "public@.container": 700, // x2 (public@a, public@b)
  "admin.container": 600,
  "worker.container": 600,
  "internal.container": 120,
  "caddy.container": 150,
};
const LONG_RUNNING = Object.keys(BUDGET_MIB);
const CONTAINERS = [...LONG_RUNNING, "migrate.container"];
const NETWORKS = ["ebt-edge", "ebt-data", "ebt-admin", "ebt-internal", "ebt-backup"];

function memoryMiB(value: string | undefined): number {
  const m = /^(\d+)([mg])$/.exec(value ?? "");
  if (m?.[1] === undefined) throw new Error(`Memory=${String(value)} is not <n>m or <n>g`);
  return Number(m[1]) * (m[2] === "g" ? 1024 : 1);
}

/** A unit as podman runs it: public@a / public@b are the template plus their drop-in. */
interface Unit {
  readonly name: string;
  readonly q: Quadlet;
  readonly networks: Record<string, string>;
  readonly env: Record<string, string>;
}
function units(): Unit[] {
  return CONTAINERS.flatMap((file) => {
    const base = readQuadlet(file);
    const variants: [string, Quadlet[]][] =
      file === "public@.container"
        ? ["a", "b"].map((i) => [
            `public@${i}`,
            [base, parseQuadlet(i, readFileSync(new URL(`../../quadlet/public@${i}.container.d/10-network.conf`, import.meta.url), "utf8"))],
          ])
        : [[file.replace(".container", ""), [base]]];
    return variants.map(([name, layers]) => ({
      name,
      q: base,
      networks: Object.fromEntries(
        layers
          .flatMap((l) => l.get("Container", "Network"))
          .map((n) => {
            const [network = "", ip = ""] = n.split(":ip=");
            return [network.replace(".network", ""), ip];
          }),
      ),
      env: Object.assign({}, ...layers.map((l) => l.environment())) as Record<string, string>,
    }));
  });
}
const unit = (name: string) => {
  const u = units().find((x) => x.name === name);
  if (u === undefined) throw new Error(`no unit ${name}`);
  return u;
};
const members = (network: string) =>
  units()
    .filter((u) => u.networks[network] !== undefined)
    .map((u) => u.name)
    .sort();

describe("quadlets", () => {
  it("exist for every unit of the plan, and units.sh lists exactly them", () => {
    expect(quadletFiles().sort()).toEqual(
      [...CONTAINERS, "caddy.socket", ...NETWORKS.map((n) => `${n}.network`), "ebt-pgdata.volume", "ebt-valkeydata.volume", "ebt-caddy-data.volume", "ebt-caddy-config.volume"].sort(),
    );
    const list = readFileSync(new URL("../../provision/units.sh", import.meta.url), "utf8");
    const array = (name: string) => (new RegExp(`^${name}=\\(([^)]*)\\)`, "m").exec(list)?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect([...array("EBT_SERVICES"), ...array("EBT_ONESHOTS")].sort()).toEqual(units().map((u) => u.name).sort());
    expect(array("EBT_NETWORKS").sort()).toEqual([...NETWORKS].sort());
    expect(array("EBT_VOLUMES").sort()).toEqual(["ebt-caddy-config", "ebt-caddy-data", "ebt-pgdata", "ebt-valkeydata"]);
  });

  it("set the plan's memory limits, within the 8 GB VM with ~2.2 GB for the OS", () => {
    let total = 0;
    for (const file of LONG_RUNNING) {
      const mib = memoryMiB(readQuadlet(file).get("Container", "Memory")[0]);
      expect(mib, file).toBe(BUDGET_MIB[file]);
      total += file === "public@.container" ? 2 * mib : mib;
    }
    expect(total).toBe(5430);
    expect(8 * 1024 - total).toBeGreaterThanOrEqual(2.2 * 1024);
    // The one-shot migrate job runs during a deploy only, inside the OS headroom.
    expect(memoryMiB(readQuadlet("migrate.container").get("Container", "Memory")[0])).toBeLessThanOrEqual(256);
  });

  it("keep Node's heap below each app container's limit", () => {
    for (const file of ["public@.container", "admin.container", "worker.container", "internal.container"]) {
      const q = readQuadlet(file);
      const heap = /--max-old-space-size=(\d+)/.exec(q.environment()["NODE_OPTIONS"] ?? "")?.[1];
      expect(Number(heap), file).toBeLessThan(memoryMiB(q.get("Container", "Memory")[0]) * 0.75);
    }
  });

  it("publish no port: Caddy's listeners come from caddy.socket", () => {
    for (const file of CONTAINERS) expect(readQuadlet(file).get("Container", "PublishPort"), file).toEqual([]);
    expect(readQuadlet("caddy.socket").get("Socket", "ListenStream")).toEqual(["[::]:80", "[::]:443"]);
    expect(readQuadlet("caddy.container").get("Unit", "Requires")).toEqual(["caddy.socket"]);
  });

  it("pin unique addresses on five networks; only the edge network and the backup network (PostgreSQL alone, US-015) have egress", () => {
    const subnet: Record<string, string> = { "ebt-edge": "10.89.50.", "ebt-data": "10.89.51.", "ebt-admin": "10.89.52.", "ebt-internal": "10.89.53.", "ebt-backup": "10.89.54." };
    const seen = new Map<string, string>();
    for (const u of units()) {
      for (const [network, ip] of Object.entries(u.networks)) {
        expect(subnet[network], `${u.name}: unknown network ${network}`).toBeDefined();
        expect(ip.startsWith(subnet[network] ?? "?"), `${u.name}: ${ip} unpinned or outside ${network}`).toBe(true);
        expect(seen.get(ip), `${u.name}: ${ip} taken`).toBeUndefined();
        seen.set(ip, u.name);
      }
    }
    for (const network of NETWORKS) {
      const internal = readQuadlet(`${network}.network`).get("Network", "Internal");
      expect(internal, network).toEqual(network === "ebt-edge" || network === "ebt-backup" ? [] : ["true"]);
    }
  });

  it("isolate admin and internal: each shares a private network with Caddy only", () => {
    expect(members("ebt-admin")).toEqual(["admin", "caddy"]);
    expect(members("ebt-internal")).toEqual(["caddy", "internal"]);
    expect(members("ebt-edge")).toEqual(["caddy", "public@a", "public@b", "worker"]);
    expect(members("ebt-data")).toEqual(["admin", "internal", "migrate", "postgres", "public@a", "public@b", "valkey", "worker"]);
    // US-015: wal-g's egress to the backup storage. Only PostgreSQL joins that network, so nothing can reach it through it.
    expect(members("ebt-backup")).toEqual(["postgres"]);
  });

  it("bind each app to its Caddy-facing address and trust X-Forwarded-For from Caddy's address on that network", () => {
    const caddy = unit("caddy").networks;
    for (const name of ["public@a", "public@b"]) {
      const u = unit(name);
      expect(u.env, name).toMatchObject({ EDGE_HOST: u.networks["ebt-edge"], TRUSTED_PROXY_IP: caddy["ebt-edge"], EDGE_PORT: "3000" });
    }
    const admin = unit("admin");
    expect(admin.env).toMatchObject({ EDGE_HOST: admin.networks["ebt-admin"], TRUSTED_PROXY_IP: caddy["ebt-admin"], EDGE_PORT: "3000" });
    const internal = unit("internal");
    expect(internal.env).toMatchObject({ INTERNAL_HOST: internal.networks["ebt-internal"], INTERNAL_PORT: "9000" });
    expect(caddy).toEqual({ "ebt-edge": "10.89.50.2", "ebt-admin": "10.89.52.2", "ebt-internal": "10.89.53.2" });
  });

  it("match pg_hba.conf: each login from its own containers' data-network addresses", () => {
    const hba = readFileSync(new URL("../../provision/files/postgres/pg_hba.conf", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => /^host\s/.test(l))
      .map((l) => l.split(/\s+/));
    const owners: Record<string, string[]> = {
      ebt_public: ["public@a", "public@b"],
      ebt_admin: ["admin"],
      ebt_worker: ["worker"],
      ebt_internal: ["internal"],
      ebt_migrate: ["migrate"],
    };
    for (const [login, names] of Object.entries(owners)) {
      const want = names.map((n) => ["ebooktrivia", `${String(unit(n).networks["ebt-data"])}/32`, "scram-sha-256"]);
      expect(hba.filter((r) => r[2] === login).map((r) => [r[1], r[3], r[4]]), login).toEqual(want);
    }
    expect(hba.at(-1)).toEqual(["host", "all", "all", "all", "reject"]);
  });

  it("name the containers the Caddyfile dials", () => {
    const caddyfile = readFileSync(new URL("../../caddy/Caddyfile", import.meta.url), "utf8");
    for (const dial of ["public-a:3000", "public-b:3000", "admin:3000", "internal:9000"]) expect(caddyfile).toContain(dial);
    expect(readQuadlet("public@.container").get("Container", "ContainerName")).toEqual(["public-%i"]);
    expect(readQuadlet("admin.container").get("Container", "ContainerName")).toEqual(["admin"]);
    expect(readQuadlet("internal.container").get("Container", "ContainerName")).toEqual(["internal"]);
  });

  it("give every public@ instance drop-in a health check on its own address (CL6)", () => {
    const dropins = readdirSync(new URL("../../quadlet/", import.meta.url)).filter((f) => /^public@\w+\.container\.d$/.test(f));
    expect(dropins.sort()).toEqual(["public@a.container.d", "public@b.container.d"]);
    for (const dir of dropins) {
      const q = parseQuadlet(dir, readFileSync(new URL(`../../quadlet/${dir}/10-network.conf`, import.meta.url), "utf8"));
      const host = q.environment()["EDGE_HOST"];
      expect(host, dir).toMatch(/^10\.89\.50\.\d+$/);
      expect(q.get("Container", "HealthCmd"), dir).toEqual([expect.stringContaining(`/dev/tcp/${String(host)}/3000`)]);
    }
    // The template says so, for whoever adds an instance.
    expect(readFileSync(new URL("../../quadlet/public@.container", import.meta.url), "utf8")).toMatch(/every instance\s+(#\s+)?drop-in must set HealthCmd/i);
  });

  it("report healthy only when serving: /livez on the app's own address, the ask endpoint, pg_isready over TCP, Valkey PING", () => {
    for (const name of ["public@.container", "admin.container", "internal.container", "postgres.container", "valkey.container"]) {
      expect(readQuadlet(name).get("Container", "Notify"), name).toEqual(["healthy"]);
    }
    const healthCmd = (name: string) => {
      const u = unit(name);
      const layers = name.startsWith("public@")
        ? parseQuadlet(name, readFileSync(new URL(`../../quadlet/${name}.container.d/10-network.conf`, import.meta.url), "utf8")).get("Container", "HealthCmd")
        : u.q.get("Container", "HealthCmd");
      expect(layers, name).toHaveLength(1);
      return layers[0] ?? "";
    };
    for (const name of ["public@a", "public@b", "admin"]) {
      expect(healthCmd(name), name).toContain(`/dev/tcp/${String(unit(name).env["EDGE_HOST"])}/3000`);
      expect(healthCmd(name), name).toContain("GET /livez");
    }
    expect(healthCmd("internal")).toContain(`/dev/tcp/${String(unit("internal").env["INTERNAL_HOST"])}/9000`);
    expect(healthCmd("internal")).toContain("/caddy/ask");
    // Over TCP on the pinned address: the entrypoint's temporary initdb server listens on the
    // socket only, so it never looks ready.
    expect(healthCmd("postgres")).toContain(`-h ${String(unit("postgres").networks["ebt-data"])}`);
    for (const name of ["public@.container", "admin.container"]) expect(readQuadlet(name).get("Container", "HealthInterval"), name).toEqual(["2s"]);
  });

  it("run hardened: no new privileges, read-only roots, no capabilities, journald logs", () => {
    for (const file of CONTAINERS) {
      const q = readQuadlet(file);
      expect(q.get("Container", "NoNewPrivileges"), file).toEqual(["true"]);
      expect(q.get("Container", "ReadOnly"), file).toEqual(["true"]);
      expect(q.get("Container", "DropCapability"), file).toEqual(["all"]);
      expect(q.get("Container", "LogDriver"), file).toEqual(["journald"]);
    }
    for (const file of ["postgres.container", "valkey.container"]) expect(readQuadlet(file).get("Container", "User"), file).toEqual(["999:999"]);
    expect(readQuadlet("postgres.container").get("Container", "Tmpfs")).toEqual(["/var/run/postgresql:rw,mode=1777,size=1m"]);
  });

  it("mount data by need: deliverables read-only for public and the worker, the content images read-only for public, everything for admin, LP content for admin (writes) and Caddy (reads), the SDK files for Caddy only", () => {
    const mounts = (name: string) => unit(name).q.get("Container", "Volume").filter((v) => v.startsWith("/srv/")).sort();
    expect(mounts("public@a")).toEqual(["/srv/data/deliverables:/srv/data/deliverables:ro,z", "/srv/data/images:/srv/data/images:ro,z"]);
    expect(mounts("public@b")).toEqual(mounts("public@a"));
    expect(mounts("admin")).toEqual(["/srv/data:/srv/data:z", "/srv/lp:/srv/lp:z"]);
    // US-023: the worker holds the private keys, so it never handles uploaded LP ZIPs.
    expect(mounts("worker")).toEqual(["/srv/data/deliverables:/srv/data/deliverables:ro,z"]);
    expect(mounts("caddy")).toEqual(["/srv/lp:/srv/lp:ro,z", "/srv/sdk:/srv/sdk:ro,z"]);
    for (const name of ["internal", "postgres", "valkey", "migrate"]) expect(mounts(name), name).toEqual([]);
  });

  it("mount provisioned config read-only without relabeling (provision.sh labels it container_file_t, root owns it)", () => {
    for (const file of CONTAINERS) {
      for (const volume of readQuadlet(file).get("Container", "Volume").filter((v) => v.startsWith("/etc/"))) {
        expect(volume, file).toMatch(/^\/etc\/ebooktrivia\/(caddy|postgres|valkey)\/[\w.]+:[\w/.-]+:ro$/);
      }
    }
  });

  it("pin every base image by digest: quadlets, Containerfiles and Dockerfiles", () => {
    for (const file of CONTAINERS) {
      const q = readQuadlet(file);
      const image = q.get("Container", "Image")[0] ?? "";
      if (image.startsWith("localhost/")) expect(q.get("Container", "Pull"), file).toEqual(["never"]);
      else expect(image, file).toMatch(/^docker\.io\/[a-z/]+:[\w.]+@sha256:[0-9a-f]{64}$/);
    }
    const builds: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO, dir))) {
        const rel = join(dir, entry);
        if (["node_modules", ".git", ".next", "coverage"].includes(entry)) continue;
        if (statSync(join(REPO, rel)).isDirectory()) walk(rel);
        else if (/^(Containerfile|Dockerfile)$/.test(entry)) builds.push(rel);
      }
    };
    walk("infra");
    expect(builds.length).toBeGreaterThanOrEqual(5);
    for (const file of builds) {
      const text = readFileSync(join(REPO, file), "utf8");
      const args: Record<string, string> = Object.fromEntries([...text.matchAll(/^ARG (\w+)=(\S+)$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]));
      const stages = new Set([...text.matchAll(/^FROM \S+ AS (\S+)$/gim)].map((m) => m[1]));
      for (const [, ref, stage] of text.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gim)) {
        const image = (ref ?? "").replace(/^\$\{(\w+)\}$/, (_, n: string) => args[n] ?? "");
        if (stages.has(image)) continue;
        // `scratch` is the empty image and has no digest: allowed for the app Containerfile's `sdk` stage only (static files, no image runs).
        if (image === "scratch" && stage === "sdk" && file.replaceAll("\\", "/") === "infra/images/app/Containerfile") continue;
        expect(image, `${file}: FROM ${String(ref)}`).toMatch(/^docker\.io\/[\w./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/);
      }
    }
    const valkey = readQuadlet("valkey.container").get("Container", "Image")[0];
    expect(readFileSync(new URL("../../../apps/worker/test/support/docker.ts", import.meta.url), "utf8")).toContain(`"${String(valkey)}"`);
  });

  it("hold no secret: secrets come from the env files", () => {
    for (const file of CONTAINERS) {
      const q = readQuadlet(file);
      expect(Object.keys(q.environment()).filter((k) => /PASS|SECRET|TOKEN|KEY|DATABASE_URL|AUTH/.test(k)), file).toEqual([]);
      expect(q.get("Container", "EnvironmentFile")[0], file).toMatch(/^\/etc\/ebooktrivia\/[a-z]+\.env$/);
    }
  });

  it("generate env files whose secrets are created on the VM, never written in the repository", () => {
    for (const name of ["public", "admin", "worker", "internal", "migrate", "postgres", "valkey"]) {
      const lines = readFileSync(new URL(`../../provision/files/env/${name}.env`, import.meta.url), "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l));
      for (const line of lines) {
        const [key = "", value = ""] = line.split(/=(.*)/s);
        if (/PASS|SECRET|TOKEN|AUTH|DATABASE_URL/.test(key) && !key.endsWith("_FILE")) expect(value, `${name}.env ${key}`).toMatch(/@GEN@|@GEN_TOKEN_SHA256@/);
      }
    }
    // The postgres server never holds the superuser password in its environment, only a file path.
    expect(readFileSync(new URL("../../provision/files/env/postgres.env", import.meta.url), "utf8")).not.toMatch(/^POSTGRES_PASSWORD=/m);
  });
});
