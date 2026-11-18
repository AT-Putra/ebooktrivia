// Story US-014 review fixes: properties of the provisioning files and build inputs that a reader
// can check in the text. Their behaviour runs in infra/verify/local/{vm-sim,stack-sim}.sh.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const code = (path: string) =>
  read(path)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("provisioning", () => {
  it("never acts as root inside a directory the app user owns (S1)", () => {
    const provision = code("infra/provision/provision.sh");
    // Everything under the app user's home goes through the app-user helpers.
    expect(provision).not.toMatch(/\b(put_file|ensure_dir|ensure_symlink|rm -rf?) "?\$(home|qdir|udir)/);
    expect(provision).toMatch(/app_put_file /);
    // The root helpers refuse a destination with a non-root ancestor.
    expect(code("infra/provision/lib.sh")).toMatch(/assert_root_path/);
    // client-ip-probe.sh writes its drop-in as the app user too.
    expect(code("infra/verify/client-ip-probe.sh")).not.toMatch(/(^|\s)put_file "\$dropin"/m);
  });

  it("runs its container-only branches only in the local stand-in (C-L1)", () => {
    expect(code("infra/provision/lib.sh")).toMatch(/EBT_PROVISION_SIM/);
    expect(code("infra/verify/local/vm-sim.sh")).toMatch(/EBT_PROVISION_SIM=1/);
  });

  it("gives the app user no login shell (S5)", () => {
    expect(code("infra/provision/provision.sh")).toMatch(/--shell \/sbin\/nologin/);
  });

  it("renders a first-sorting sshd drop-in with AllowUsers per SSH CIDR and no forwarding (C-M3, S5)", () => {
    const dropin = read("infra/provision/files/sshd-00-ebooktrivia.conf");
    expect(dropin).toMatch(/^DisableForwarding yes$/m);
    expect(dropin).toMatch(/^AllowUsers @ALLOW_USERS@$/m);
    expect(code("infra/provision/provision.sh")).toMatch(/00-ebooktrivia\.conf/);
  });

  it("limits EPEL to fail2ban (S16)", () => {
    expect(code("infra/provision/provision.sh")).toMatch(/includepkgs=fail2ban\*/);
  });

  it("sends no plaintext password on a command line (S12)", () => {
    const dbRoles = code("infra/provision/db-roles.sh");
    expect(dbRoles).not.toMatch(/scram "\$password"/);
    expect(dbRoles).toMatch(/EBT_SCRAM_PASSWORD=/);
  });

  it("confines the Valkey users to their own cache prefix, without key enumeration or script/function control (S8)", () => {
    const acl = read("infra/provision/files/valkey/users.acl.template");
    const user = (name: string) => acl.split("\n").find((l) => l.startsWith(`user ${name} `)) ?? "";
    expect(user("public")).toMatch(/ ~rl:\* ~cache:public:\* /);
    expect(user("admin")).toMatch(/ ~cache:admin:\* /);
    expect(user("worker")).toMatch(/ ~ebt:\* ~cache:worker:\* /);
    for (const name of ["public", "admin"]) {
      expect(user(name), name).toMatch(/-@dangerous -@admin -scan -randomkey -script\|flush -function$/);
      expect(user(name), name).not.toMatch(/~cache:\* /);
    }
  });

  it("builds images from verified inputs only (S16)", () => {
    const app = read("infra/images/app/Containerfile");
    expect(app).not.toMatch(/npm install -g pnpm/);
    expect(app).toMatch(/sha512sum -c/);
    expect(read(".dockerignore")).toMatch(/^\*\*\/\.npmrc$/m);
  });

  it("checks out without persisted credentials in the infra CI job, and smoke-tests the app server (S16, C-L2)", () => {
    const ci = read(".github/workflows/ci.yml");
    const infra = ci.slice(ci.indexOf("\n  infra:"), ci.indexOf("\n  secrets-scan:"));
    expect(infra).toMatch(/persist-credentials: false/);
    expect(ci).toMatch(/infra\/verify\/local\/edge-smoke\.sh/);
  });

  it("pins the podman of the dry run (C-L3)", () => {
    expect(code("infra/verify/local/quadlet-dryrun.sh")).toMatch(/podman-5\.8\.2-12\.el10_2\.alma\.1/);
  });

  it("documents start, rollback and the accepted risks in the runbook (C-M1, C-M9, S11, S8)", () => {
    const runbook = read("docs/runbooks/staging-provision.md");
    expect(runbook).toMatch(/start caddy\.socket caddy\.service/);
    expect(runbook).toMatch(/^## Rollback and recovery$/m);
    expect(runbook).toMatch(/ip_unprivileged_port_start/);
    expect(runbook).toMatch(/noeviction/);
  });

  // Final LOW batch (SL1-SL5, CL1-CL8).
  it("turns off TIOCSTI and runs app-user commands without root's terminal (SL1)", () => {
    expect(read("infra/provision/files/sysctl-90-ebooktrivia.conf")).toMatch(/^dev\.tty\.legacy_tiocsti = 0$/m);
    const lib = code("infra/provision/lib.sh");
    expect(lib.match(/runuser -u "\$CFG_APP_USER" -- setsid -w /g)).toHaveLength(2); // app_sh and as_app
  });

  it("drops the app user's IPv6 link-local and metadata traffic too (SL2)", () => {
    expect(read("infra/provision/files/ebt-egress.nft")).toMatch(/meta skuid "@APP@" ip6 daddr \{ fe80::\/10, fd00:ec2::254 \} counter drop/);
    expect(code("infra/verify/host-check.sh")).toMatch(/fd00:ec2::254/);
  });

  it("starts the app user's manager only after the egress guard (SL3)", () => {
    const provision = code("infra/provision/provision.sh");
    expect(provision).toMatch(/Requires=ebt-egress-guard\.service/);
    expect(provision).toMatch(/After=ebt-egress-guard\.service/);
  });

  it("reloads the egress guard's rules instead of restarting it: a restart would restart the whole stack (SL3 review)", () => {
    expect(read("infra/provision/files/ebt-egress-guard.service")).toMatch(/^ExecReload=\/usr\/sbin\/nft -f \/etc\/nftables\/ebt-egress\.nft$/m);
    const provision = code("infra/provision/provision.sh");
    expect(provision).not.toMatch(/systemctl restart ebt-egress-guard/);
    expect(provision).toMatch(/systemctl reload ebt-egress-guard\.service/);
    expect(provision).toMatch(/restart_needed "ebt-egress-guard\.service \(restarts the whole stack/);
  });

  it("refuses firewalld policies and direct rules it did not ship (SL4)", () => {
    for (const file of ["infra/provision/provision.sh", "infra/verify/host-check.sh"]) {
      expect(code(file), file).toMatch(/--get-policies/);
      expect(code(file), file).toMatch(/--direct --get-all-rules/);
    }
  });

  it("runs auditd, disables cockpit.socket and relabels the provisioned config on every run (CL4, CL5, CL7)", () => {
    const provision = code("infra/provision/provision.sh");
    expect(provision).toMatch(/ensure_unit_enabled auditd/);
    expect(provision).toMatch(/disable --now (--quiet )?cockpit\.socket/);
    expect(provision).toMatch(/restorecon -RFv/);
  });

  it("installs the dry run's podman from the 10.2 vault, with dnf errors kept (CL3)", () => {
    const dryrun = code("infra/verify/local/quadlet-dryrun.sh");
    expect(dryrun).toMatch(/^VAULT=https:\/\/vault\.almalinux\.org\/10\.2$/m);
    expect(dryrun).toMatch(/--repofrompath=ebt-vault-appstream,"\$vault\/AppStream\//);
    expect(dryrun).not.toMatch(/install[^\n]*2>&1/);
  });

  it("drains the real server in the edge smoke test (CL2)", () => {
    const smoke = code("infra/verify/local/edge-smoke.sh");
    expect(smoke).toMatch(/kill -TERM/);
    expect(smoke).toMatch(/drained/);
  });

  it("documents the console password and the Valkey memory watch (CL8, SL5)", () => {
    const runbook = read("docs/runbooks/staging-provision.md");
    expect(runbook).toMatch(/console password/i);
    expect(runbook).toMatch(/used_memory/);
  });
});
