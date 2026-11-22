// US-015: the files of the deploy, the backups and the monitoring against each other and against the plan, checked as text (their
// behaviour runs in infra/verify/local/{deploy-sim,backup-pitr,healthz-routing}.sh and on staging, docs/runbooks/deploy.md).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readQuadlet } from "./quadlet.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const code = (path: string): string =>
  read(path)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

const remote = code("infra/deploy/remote.sh");
const workflow = read(".github/workflows/deploy.yml");

describe("remote.sh, the forced command", () => {
  it("maps each image of the manifest to the name the quadlets run, and every such name is a quadlet's image", () => {
    const tags = Object.fromEntries([...remote.matchAll(/^\s+\[([a-z-]+)\]=(localhost\/ebooktrivia\/[a-z-]+:[\w.]+)$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]));
    expect(tags).toEqual({
      public: "localhost/ebooktrivia/public:current",
      admin: "localhost/ebooktrivia/admin:current",
      "admin-cli": "localhost/ebooktrivia/admin-cli:current",
      worker: "localhost/ebooktrivia/worker:current",
      "postgres-walg": "localhost/ebooktrivia/postgres-walg:18.6",
    });
    const quadletImage = (file: string) => readQuadlet(file).get("Container", "Image")[0];
    expect(quadletImage("public@.container")).toBe(tags["public"]);
    expect(quadletImage("admin.container")).toBe(tags["admin"]);
    expect(quadletImage("postgres.container")).toBe(tags["postgres-walg"]);
    // internal and the migrate job run the worker image: one image, five manifest entries (deploy.yml says why).
    for (const file of ["worker.container", "internal.container", "migrate.container"]) expect(quadletImage(file), file).toBe(tags["worker"]);
    // The admin CLI is a one-off container (docs/runbooks/admin-access.md), not a unit.
    expect(read("docs/runbooks/admin-access.md")).toContain("localhost/ebooktrivia/admin-cli:current");
  });

  it("restarts the worker FIRST, then internal, public@a (and lets Caddy see it) before public@b, then admin", () => {
    const roll = /^roll\(\) \{[\s\S]*?^\}/m.exec(remote)?.[0] ?? "";
    const order = [...roll.matchAll(/restart_unit ([a-z@]+)/g)].map((m) => m[1]);
    expect(order).toEqual(["worker", "internal", "public@a", "public@b", "admin"]);
    // Between public@a and public@b: its /livez is waited for, and Caddy's health check (2 s interval, 2 passes) gets its time.
    expect(roll).toMatch(/restart_unit public@a[\s\S]*wait_until \d+ "public@a \/livez"[\s\S]*sleep 6[\s\S]*restart_unit public@b/);
    // The worker's heartbeat after its restart gates everything after it: it loads the Valkey function library public calls.
    expect(roll).toMatch(/restart_unit worker[\s\S]*worker_beat_after[\s\S]*restart_unit internal/);
  });

  it("does the steps in the plan's order, and rolls back on a failure after the images are tagged", () => {
    const deploy = /^do_deploy\(\) \{[\s\S]*?^\}/m.exec(remote)?.[0] ?? "";
    // The last rollback_images is the one after apply_release (an earlier one undoes a failed retag).
    const steps = ["parse_manifest", "pull_images", "snapshot_current_images", "predeploy_dump", "retag_to_manifest", "apply_release"].map((s) => deploy.indexOf(s));
    steps.push(deploy.lastIndexOf("rollback_images"));
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    const apply = /^apply_release\(\) \{[\s\S]*?^\}/m.exec(remote)?.[0] ?? "";
    expect(apply.indexOf("migrate.service")).toBeLessThan(apply.indexOf("roll "));
    expect(apply.indexOf("roll ")).toBeLessThan(apply.indexOf("health_all"));
    // A failed rollback is its own exit status, and a rolled-back deploy another one, so a pipeline can tell them apart.
    expect(deploy).toMatch(/exit 10/);
    expect(deploy).toMatch(/exit 2/);
  });

  it("accepts a digest manifest of the configured registry prefix only: no tag, no other registry, no other key, no failure drill outside staging", () => {
    expect(remote).toContain("@sha256:");
    expect(remote).toMatch(/\[\[ \$value == "\$expected"\* && \$\{value#"\$expected"\} =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
    expect(remote).toMatch(/\*\) die "manifest: unknown key \$key"/);
    expect(remote).toContain('[[ -e $DRILL_FLAG ]] || die "manifest: force_fail is only accepted where');
    expect(remote).toMatch(/\(\(\$# == 1\)\)/);
    expect(remote).toMatch(/deploy\) do_deploy ;;\s+rollback\) do_rollback ;;\s+status\) do_status ;;\s+\*\) die/);
  });

  it("takes a checked pg_dump with retention before it changes anything, and never rolls the schema back", () => {
    expect(remote).toMatch(/pg_dump -U postgres -Fc ebooktrivia/);
    expect(remote).toMatch(/pg_restore -l/);
    expect(read("infra/deploy/remote.sh")).toMatch(/the schema is never rolled back/i);
    expect(remote).toContain("KEEP_DUMPS=7");
  });

  it("logs to the journal, takes a lock, keeps the previous manifest and never logs the registry token", () => {
    expect(remote).toContain("logger -t ebt-deploy");
    expect(remote).toContain("flock -n 9");
    expect(remote).toContain('"$STATE/previous.manifest"');
    expect(remote.split("\n").filter((l) => /\blog\b/.test(l) && /REGISTRY_TOKEN/.test(l))).toEqual([]);
    expect(remote).not.toMatch(/set -x|--password /);
  });
});

describe("provisioning of the deploy login", () => {
  const provision = code("infra/provision/provision.sh");
  it("installs the script root-owned, forces the command with `restrict`, and lets sudo run exactly its three invocations", () => {
    expect(provision).toContain("put_file \"$DEPLOY_SCRIPT\" 755 root root");
    expect(provision).toMatch(/restrict,command="sudo -n %s/);
    expect(provision).toMatch(/NOPASSWD: \$DEPLOY_SCRIPT deploy, \$DEPLOY_SCRIPT rollback, \$DEPLOY_SCRIPT status/);
    expect(provision).toMatch(/visudo -cf/);
    // The login cannot change its own keys: root owns its home and .ssh; no password; not an administrator.
    expect(provision).toContain('ensure_dir "$dhome/.ssh" 755 root root');
    expect(provision).toContain("usermod -L");
    expect(provision).toMatch(/is in group wheel/);
  });

  it("gives the deploy login its own AllowUsers entries and firewall sources, from its own CIDR list", () => {
    const lib = code("infra/provision/lib.sh");
    expect(lib).toMatch(/sshd_allow_users\(\)[\s\S]*CFG_DEPLOY_USER/);
    expect(lib).toMatch(/ssh_source_cidrs\(\)[\s\S]*CFG_DEPLOY_ALLOWED_CIDRS/);
    expect(code("infra/verify/host-check.sh")).toContain("sshd_allow_users");
  });

  it("refuses a public key that carries options (a forced command of its own), and a registry prefix that is not GHCR's", () => {
    const lib = code("infra/provision/lib.sh");
    expect(lib).toContain("key_re='^(ssh-ed25519|sk-ssh-ed25519@openssh\\.com|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+=*( [A-Za-z0-9_.@-]{1,64})?$'");
    expect(lib).toContain("prefix_re='^ghcr\\.io/");
  });
});

describe("deploy.yml", () => {
  const jobs = Object.fromEntries([...workflow.matchAll(/^ {2}(gate|build|deploy):\n([\s\S]*?)(?=^ {2}[a-z]+:\n|(?![\s\S]))/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]));

  it("has the three jobs, in order, and denies every permission by default", () => {
    expect(Object.keys(jobs)).toEqual(["gate", "build", "deploy"]);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(jobs["build"]).toContain("needs: gate");
    expect(jobs["deploy"]).toContain("needs: build");
  });

  it("deploys through GitHub environments (staging and production) whose secrets are environment secrets, and holds no secret itself", () => {
    expect(jobs["deploy"]).toMatch(/environment: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.environment \|\| 'staging' \}\}/);
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(["DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"]));
    expect(workflow).not.toMatch(/-----BEGIN|ssh-ed25519 AAAA|ghp_|ghs_/);
    expect(workflow).toContain("StrictHostKeyChecking=yes");
    // Production is a manual, main-only, reviewed run: the environment's protection rules apply; a push never reaches it.
    expect(workflow).toMatch(/TARGET: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.environment \|\| 'staging' \}\}/);
    expect(jobs["gate"]).toContain("refs/heads/main");
  });

  it("pushes by digest, builds the same targets as build-images.sh (five images), and pins every action to a commit", () => {
    const manifestKeys = [...(jobs["build"] ?? "").matchAll(/for component in ([a-z -]+); do/g)].map((m) => m[1]);
    expect(manifestKeys).toEqual(["public admin admin-cli worker postgres-walg"]);
    const buildImages = read("infra/provision/build-images.sh");
    for (const target of ["public", "admin", "admin-cli", "worker"]) {
      expect(workflow).toMatch(new RegExp(`app ${target}\\b`));
      expect(buildImages).toContain(target);
    }
    expect(workflow).toContain("ADMIN_ORIGIN=https://admin.$DOMAIN");
    expect(jobs["build"]).toMatch(/RepoDigests/);
    for (const [, action] of workflow.matchAll(/uses: (\S+)/g)) expect(action, "action pinned by commit").toMatch(/@[0-9a-f]{40}$/);
  });

  it("sends the pull credential as the job's own short-lived token over the SSH connection, never as a stored secret", () => {
    expect(jobs["deploy"]).toContain("REGISTRY_TOKEN: ${{ github.token }}");
    expect(jobs["deploy"]).toContain("packages: read");
    expect(jobs["build"]).toContain("packages: write");
  });

  it("makes the failure drill staging-only and passes it when the rollback succeeded (exit 10)", () => {
    expect(workflow).toContain("the failure drill is for staging only");
    expect(workflow).toMatch(/\[\[ "\$status" -eq 10 \]\]/);
  });
});

describe("backups", () => {
  it("gives only PostgreSQL the egress network and keeps the keys out of the environment", () => {
    const postgres = readQuadlet("postgres.container");
    expect(postgres.get("Container", "Network").sort()).toEqual(["ebt-backup.network:ip=10.89.54.2", "ebt-data.network:ip=10.89.51.2"]);
    expect(postgres.get("Container", "Volume")).toEqual(
      expect.arrayContaining(["/etc/ebooktrivia/postgres/walg_libsodium.key:/etc/walg/libsodium.key:ro", "/etc/ebooktrivia/postgres/walg_aws_credentials:/etc/walg/aws-credentials:ro"]),
    );
    expect(postgres.get("Container", "EnvironmentFile")).toEqual(["/etc/ebooktrivia/postgres.env", "/etc/ebooktrivia/walg.env"]);
    const exec = postgres.get("Container", "Exec")[0] ?? "";
    expect(exec).toContain("archive_mode=on");
    expect(exec).toContain('"archive_command=wal-g wal-push %%p"');
    expect(exec).toContain("archive_timeout=60");
    expect(exec).toContain("listen_addresses=10.89.51.2");
    expect(read("infra/provision/files/env/walg.env")).not.toMatch(/^(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|WALG_LIBSODIUM_KEY)=/m);
  });

  it("encrypts with libsodium from a key file, keeps 14 base backups, and records the nightly success the worker watches", () => {
    const base = code("infra/backup/walg-base-backup.sh");
    expect(base).toContain("RETAIN=14");
    expect(base).toMatch(/wal-verify integrity/);
    expect(base).toMatch(/beat backup_base/);
    expect(base).toMatch(/raise_alert backup_base_failed critical/);
    expect(read("infra/provision/files/env/walg.env")).toMatch(/^WALG_LIBSODIUM_KEY_PATH=\/etc\/walg\/libsodium\.key$/m);
    expect(read("infra/provision/files/env/walg.env")).toMatch(/^WALG_LIBSODIUM_KEY_TRANSFORM=hex$/m);
  });

  it("backs up the dump, the globals and /srv/data with restic, keeping 7 daily, 4 weekly and 6 monthly, from a digest-pinned image", () => {
    const restic = code("infra/backup/restic-backup.sh");
    expect(restic).toMatch(/pg_dump -U postgres -Fc/);
    expect(restic).toMatch(/pg_dumpall -U postgres --globals-only/);
    expect(restic).toContain("--keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune");
    expect(restic).toMatch(/RESTIC_IMAGE=\$\{EBT_RESTIC_IMAGE:-docker\.io\/restic\/restic:0\.19\.1@sha256:[0-9a-f]{64}\}/);
    expect(restic).toMatch(/beat backup_restic/);
  });

  it("schedules both nightly jobs as the app user's timers, and the timers' services name the checkout", () => {
    const units = readdirSync(join(REPO, "infra/backup/units")).sort();
    expect(units).toEqual(["ebt-backup-base.service", "ebt-backup-base.timer", "ebt-backup-restic.service", "ebt-backup-restic.timer", "ebt-ops-check.service", "ebt-ops-check.timer"]);
    expect(read("infra/backup/units/ebt-ops-check.service")).toMatch(/ExecStart=\/usr\/bin\/bash @REPO@\/infra\/backup\/ops-check\.sh/);
    expect(read("infra/backup/units/ebt-ops-check.timer")).toMatch(/OnUnitActiveSec=5min/);
    expect(read("infra/backup/units/ebt-backup-base.service")).toMatch(/ExecStart=\/usr\/bin\/bash @REPO@\/infra\/backup\/walg-base-backup\.sh/);
    expect(read("infra/backup/units/ebt-backup-restic.timer")).toMatch(/OnCalendar=\*-\*-\* 21:30:00 UTC/);
    expect(code("infra/provision/provision.sh")).toMatch(/step_backup_timers/);
  });

  it("refuses a malformed recovery target instead of writing it into postgresql.auto.conf", () => {
    const script = read("infra/backup/recovery-conf.sh");
    expect(script).toContain("recovery_target_action = 'promote'");
    expect(script).toContain('fetch="wal-g wal-fetch %f %p"');
    expect(script).toContain("restore_command = '$fetch'");
    expect(script).toContain("TARGET_TIME may hold digits");
  });
});

describe("monitoring", () => {
  const compose = read("infra/monitoring/compose.yaml");
  const monitors = JSON.parse(read("infra/monitoring/kuma/monitors.json")) as { notifications: { notificationName: string; type: string }[]; monitors: { monitorName: string; type: string; url?: string; interval: number }[] };

  it("pins every image by digest, binds only to loopback, and gives every container a memory limit", () => {
    for (const [, image] of compose.matchAll(/^\s+image: (\S+)$/gm)) expect(image, "image pinned by digest").toMatch(/@sha256:[0-9a-f]{64}$/);
    for (const [, port] of compose.matchAll(/^\s+- "([^"]+:\d+:\d+)"$/gm)) expect(port, "published port").toMatch(/^127\.0\.0\.1:/);
    expect([...compose.matchAll(/^\s+mem_limit: \S+$/gm)]).toHaveLength(3);
    expect(compose).not.toMatch(/network_mode: host|privileged: true|docker\.sock/);
    expect(compose).toMatch(/^name: ebt-monitoring$/m);
  });

  it("uses the Uptime Kuma, GlitchTip and PostgreSQL versions docs/versions.md records", () => {
    const versions = read("docs/versions.md");
    for (const pin of ["louislam/uptime-kuma:2.5.9@sha256:e88415a90dd2f7efecdbc18de0490aff292764a3ac471531bf1d0481725591bd", "glitchtip/glitchtip:6.2.6@sha256:a3d8eb1b36c1e1603d55ab32711ea3dd8115874742a781a57391a62a16e0dff6"]) {
      expect(compose).toContain(pin);
      expect(versions).toContain(pin.replace(/^[^/]+\//, "").split("@")[0] ?? "");
    }
    expect(compose).toContain(readFileSync(join(REPO, "infra/images/postgres-walg/Dockerfile"), "utf8").match(/postgres:18\.6@sha256:[0-9a-f]{64}/)?.[0] ?? "no pin");
  });

  it("lists the monitors the plan and the alert drills need, every health URL on https and checked every 60 seconds", () => {
    const names = monitors.monitors.map((m) => m.monitorName);
    for (const need of ["ebt api healthz", "ebt admin healthz", "ebt worker heartbeat", "ebt alerts backstop", "ebt vm ping"]) expect(names).toContain(need);
    expect(names.some((n) => n.startsWith("waha session"))).toBe(true);
    for (const m of monitors.monitors.filter((x) => x.monitorName.includes("healthz"))) {
      expect(m.url).toMatch(/^https:\/\//);
      expect(m.interval).toBe(60);
    }
    // The worker push monitor times out at 2 minutes: a killed worker alerts inside the 3 minutes of AC-P12.
    expect(monitors.monitors.find((m) => m.monitorName === "ebt worker heartbeat")).toMatchObject({ type: "push", interval: 120 });
    expect(monitors.notifications.map((n) => n.type).sort()).toEqual(["smtp", "webhook"]);
  });

  it("sends the WhatsApp text JSON-escaped (a quote or a line break in an alert must not break the body), and the drills prove it", () => {
    const body = monitors.notifications.find((n) => n.type === "webhook") as { customBody?: string } | undefined;
    expect(body?.customBody).toContain('"text": {{ msg | json }}}');
    expect(body?.customBody).not.toContain('"{{ msg }}"');
    expect(read("docs/runbooks/monitoring.md")).toContain('"text": {{ msg | json }}}');
    expect(read("infra/monitoring/alert-drill.sh")).toMatch(/kuma-escape\)[\s\S]*a "quoted" word[\s\S]*\$'\\n'/);
  });

  it("keeps the Kuma API key and the push URL out of the command line, and breaks WAL archiving by the credentials file (the quadlet's -c wins over ALTER SYSTEM)", () => {
    expect(code("infra/monitoring/kuma-check.sh")).not.toMatch(/curl[^\n]*(-u |KUMA_API_KEY)/);
    expect(code("infra/monitoring/kuma-check.sh")).toContain("-K-");
    const drill = code("infra/monitoring/alert-drill.sh");
    expect(drill).toContain("-K-");
    expect(drill).not.toMatch(/ALTER SYSTEM (SET|RESET) archive_command/);
    expect(drill).toContain("walg_aws_credentials");
  });

  it("claims the Kuma and GlitchTip accounts over an SSH tunnel before any public name exists, and keeps /api/push/ reachable from the VM", () => {
    const doc = read("docs/runbooks/monitoring.md");
    expect(doc.indexOf("ssh -L 3001")).toBeGreaterThan(-1);
    expect(doc.indexOf("ssh -L 3001")).toBeLessThan(doc.indexOf("Only now, TLS and names"));
    expect(doc).toMatch(/location \/api\/push\/ \{[\s\S]*allow <the app VM's public address>/);
  });

  it("holds no secret: keys and passwords are typed into Kuma, placeholders only here", () => {
    const text = read("infra/monitoring/kuma/monitors.json") + read("infra/monitoring/glitchtip.env.example") + read("infra/monitoring/.env.example");
    expect(text).not.toMatch(/api[-_]?key"?:? ?"[A-Za-z0-9]{16,}"|password"?:? ?"[^<"]{8,}"/i);
    expect(read("infra/monitoring/glitchtip.env.example")).toMatch(/^SECRET_KEY=CHANGE_ME$/m);
  });
});

describe("a deploy survives a dropped SSH connection (US-015 review)", () => {
  const main = remote.slice(remote.indexOf("main() {"));

  it("runs deploy and rollback in their own systemd unit, before the lock, the configuration or any step", () => {
    expect(remote).toMatch(/systemd-run --quiet --wait --pipe --collect --unit="ebt-deploy-\$\(date -u \+%Y%m%dT%H%M%S\)-\$\$"/);
    expect(remote).toContain("--property=KillMode=mixed --property=TimeoutStopSec=1200 --setenv=EBT_DEPLOY_UNIT=1");
    expect(main.indexOf('run_in_unit "$1"')).toBeGreaterThan(-1);
    expect(main.indexOf('run_in_unit "$1"')).toBeLessThan(main.indexOf("flock -n 9"));
    expect(main).toMatch(/\[\[ \$1 != status && \$\{EBT_DEPLOY_UNIT:-\} != 1 \]\]/);
  });

  it("ignores SIGHUP and SIGPIPE, and a write to a closed pipe neither kills the script nor fails a step", () => {
    expect(main).toContain("trap '' HUP PIPE");
    expect(remote).toContain(`printf '%s\\n' "$*" 2>/dev/null || true`);
  });

  it("rolls back on any unexpected end once the images were tagged, and on SIGTERM", () => {
    expect(main).toContain("trap on_exit EXIT");
    expect(main).toMatch(/trap '[^']*exit 143' TERM INT/);
    const onExit = remote.slice(remote.indexOf("on_exit() {"), remote.indexOf("pull_images() {"));
    expect(onExit).toMatch(/\(\(ROLLBACK_ARMED\)\) && \(\(rc != 0\)\)[\s\S]*rollback_images && roll "\$\{CHANGED\[@\]\}" && health_all/);
    const deploy = remote.slice(remote.indexOf("do_deploy() {"), remote.indexOf("do_rollback() {"));
    expect(deploy.indexOf("ROLLBACK_ARMED=1")).toBeGreaterThan(-1);
    expect(deploy.indexOf("ROLLBACK_ARMED=1")).toBeLessThan(deploy.indexOf("retag_to_manifest"));
    // Disarmed wherever the deploy decides its own ending, so that the explicit rollback is the only one.
    expect(deploy.split("ROLLBACK_ARMED=0").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("records how a run ended for `status` (a CI job that lost its connection reads it), and keeps no unused rollback.ids", () => {
    expect(remote).toContain("last-deploy");
    expect(remote).toContain("deploy running:");
    expect(remote).not.toContain("rollback.ids");
  });

  it("accepts the /healthz 404 fallback only while rolling back, never for a new release", () => {
    const deep = remote.slice(remote.indexOf("deep_health_of() {"), remote.indexOf("DOMAIN=\"\"\nhealth_all"));
    expect(deep).toMatch(/404\)\n\s+if \(\(!ROLLING_BACK\)\); then[\s\S]*return 1/);
    expect(remote.slice(remote.indexOf("do_rollback() {"), remote.indexOf("do_status() {"))).toContain("ROLLING_BACK=1");
    expect(remote.slice(remote.indexOf("do_deploy() {"), remote.indexOf("do_rollback() {"))).toMatch(/ROLLING_BACK=1[\s\S]*rollback_images && roll/);
  });

  it("accepts a bot actor as the registry user", () => {
    expect(remote).toContain(String.raw`^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$`);
  });

  it("deploy.yml: an hour for the job, the whole history, and the range check before anything is sent", () => {
    const job = workflow.slice(workflow.indexOf("\n  deploy:\n"));
    expect(job).toMatch(/timeout-minutes: 60/);
    expect(job).toMatch(/fetch-depth: 0/);
    expect(job.indexOf("expand-only.sh")).toBeGreaterThan(-1);
    expect(job.indexOf("expand-only.sh")).toBeLessThan(job.indexOf("payload | ssh_vm deploy"));
    expect(job).toContain("--refuse-contract-ok");
    expect(job).toMatch(/ssh_vm status/);
    expect(workflow).toMatch(/allow_contract_ok:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
  });
});
