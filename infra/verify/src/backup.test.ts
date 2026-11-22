// US-015 review: what stops a restore DRILL from writing into production's backups, run as the scripts themselves (the refusals all happen before
// any podman or systemctl call, so no VM is needed); the end to end proof is infra/verify/local/backup-pitr.sh (section 5b) and the staging drill.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replaceAll("\\", "/");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const unix = (path: string): string => path.replaceAll("\\", "/");

let etc: string;
beforeEach(() => {
  etc = unix(mkdtempSync(join(tmpdir(), "ebt-backup-test-")));
  mkdirSync(join(etc, "postgres"));
  writeFileSync(join(etc, "walg.env"), "WALG_S3_PREFIX=s3://ebt-drill-scratch/2026-11-22\nAWS_REGION=eu\n");
  writeFileSync(join(etc, "postgres", "walg_libsodium.key"), "00\n");
  writeFileSync(join(etc, "postgres", "walg_aws_credentials"), "[default]\naws_access_key_id = k\naws_secret_access_key = s\n");
});
afterEach(() => {
  rmSync(etc, { recursive: true, force: true });
});

const restore = (...args: string[]) => {
  const run = spawnSync("bash", [`${REPO}infra/backup/restore-pitr.sh`, ...args], { env: { ...process.env, EBT_ETC: etc }, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};
const withMarker = (): void => {
  writeFileSync(join(etc, "drill-vm"), "");
};
const PROD = "s3://ebt-prod-pitr/walg";

describe.skipIf(!hasBash)("restore-pitr.sh refuses a restore that could write into production's storage", () => {
  it("needs --drill or --disaster", () => {
    const run = restore("--yes-wipe-database");
    expect(run.status).toBe(2);
    expect(run.out).toMatch(/--drill .* or --disaster/);
  });

  it("refuses both flags together, and an unknown one", () => {
    expect(restore("--drill", "--disaster", "--yes-wipe-database").status).toBe(2);
    expect(restore("--drill", "--bogus").status).toBe(2);
  });

  it("needs --yes-wipe-database", () => {
    const run = restore("--disaster");
    expect(run.status).toBe(2);
    expect(run.out).toMatch(/EMPTIES the database volume/);
  });

  it("refuses a drill on a VM without the drill marker (the timers would be on, the backup scripts would run)", () => {
    const run = restore("--drill", "--source-prefix", PROD, "--yes-wipe-database");
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/drill-vm does not exist/);
  });

  it("needs a well formed --source-prefix in a drill", () => {
    withMarker();
    expect(restore("--drill", "--yes-wipe-database").status).toBe(2);
    expect(restore("--drill", "--source-prefix", "/tmp/store", "--yes-wipe-database").status).toBe(2);
    expect(restore("--drill", "--source-prefix", "s3://bucket/a b;rm", "--yes-wipe-database").status).toBe(2);
  });

  it.each([
    ["the same prefix", PROD],
    ["the same prefix with a trailing slash", `${PROD}/`],
    ["a prefix inside production's", `${PROD}/drill`],
    ["a prefix around production's", "s3://ebt-prod-pitr"],
  ])("refuses a drill whose walg.env archives to %s", (_name, own) => {
    withMarker();
    writeFileSync(join(etc, "walg.env"), `WALG_S3_PREFIX=${own}\n`);
    const run = restore("--drill", "--source-prefix", PROD, "--yes-wipe-database");
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/production's storage/);
  });

  it("refuses a walg.env without a prefix, or still holding a placeholder", () => {
    withMarker();
    writeFileSync(join(etc, "walg.env"), "AWS_REGION=eu\n");
    expect(restore("--drill", "--source-prefix", PROD, "--yes-wipe-database").out).toMatch(/no WALG_S3_PREFIX/);
    writeFileSync(join(etc, "walg.env"), "WALG_S3_PREFIX=__SET_ME__\n");
    expect(restore("--drill", "--source-prefix", PROD, "--yes-wipe-database").out).toMatch(/__SET_ME__/);
  });

  it("refuses --source-prefix in a disaster recovery", () => {
    const run = restore("--disaster", "--source-prefix", PROD, "--yes-wipe-database");
    expect(run.status).toBe(2);
    expect(run.out).toMatch(/--source-prefix belongs to --drill only/);
  });
});

describe.skipIf(!hasBash)("a restore-drill VM's worker acts on nothing real (lib.sh, provision.sh, host-check.sh)", () => {
  const lib = `${REPO}infra/provision/lib.sh`;
  const sh = (script: string, input = "") => {
    const run = spawnSync("bash", ["-c", `. ${lib}; ${script}`], { input, encoding: "utf8" });
    return { status: run.status, out: run.stdout };
  };
  const escrowed = [
    "# worker.env",
    "UPTIME_KUMA_PUSH_URL=https://kuma.example.com/api/push/abc123",
    "#   UPTIME_KUMA_ALERTS_PUSH_URL=https://kuma.example.com/api/push/<token>",
    "UPTIME_KUMA_ALERTS_PUSH_URL=https://kuma.example.com/api/push/def456",
    "#   SECRETS_MESSAGING_PRIVATE_KEY=<base64url>",
    "SECRETS_MESSAGING_PRIVATE_KEY=MESSAGINGKEY",
    "SECRETS_CONVERSIONS_PRIVATE_KEY=CONVERSIONSKEY",
    "SECRETS_PAYMENT_PRIVATE_KEY=PAYMENTKEY",
    "DOMAIN=staging.example.test",
    "",
  ].join("\n");

  it("blanks both Kuma push URLs and removes the messaging and conversions private keys, and touches nothing else (comments included)", () => {
    const { status, out } = sh("drill_scrub_worker_env", escrowed);
    expect(status).toBe(0);
    expect(out).toBe(
      [
        "# worker.env",
        "UPTIME_KUMA_PUSH_URL=",
        "#   UPTIME_KUMA_ALERTS_PUSH_URL=https://kuma.example.com/api/push/<token>",
        "UPTIME_KUMA_ALERTS_PUSH_URL=",
        "#   SECRETS_MESSAGING_PRIVATE_KEY=<base64url>",
        "SECRETS_PAYMENT_PRIVATE_KEY=PAYMENTKEY",
        "DOMAIN=staging.example.test",
        "",
      ].join("\n"),
    );
  });

  it("blanks the provisioning placeholder too, and is idempotent (a second run changes nothing)", () => {
    const once = sh("drill_scrub_worker_env", "UPTIME_KUMA_PUSH_URL=__SET_ME__\nSECRETS_MESSAGING_PRIVATE_KEY=k\n").out;
    expect(once).toBe("UPTIME_KUMA_PUSH_URL=\n");
    expect(sh("drill_scrub_worker_env", once).out).toBe(once);
  });

  it("host-check's assertion names each way a drill's worker.env is unsafe, and passes a scrubbed one", () => {
    const file = unix(join(etc, "worker.env"));
    writeFileSync(file, escrowed);
    const unsafe = sh(`drill_worker_env_violations ${file}`).out.trim().split("\n");
    expect(unsafe).toHaveLength(4);
    expect(unsafe.join("\n")).toMatch(/UPTIME_KUMA_PUSH_URL is set[\s\S]*UPTIME_KUMA_ALERTS_PUSH_URL is set[\s\S]*SECRETS_MESSAGING_PRIVATE_KEY is present[\s\S]*SECRETS_CONVERSIONS_PRIVATE_KEY is present/);
    writeFileSync(file, sh("drill_scrub_worker_env", escrowed).out);
    expect(sh(`drill_worker_env_violations ${file}`).out).toBe("");
    // An empty value is "off", not a violation; a commented example is not a setting.
    writeFileSync(file, "UPTIME_KUMA_PUSH_URL=\n#   SECRETS_MESSAGING_PRIVATE_KEY=<base64url>\n");
    expect(sh(`drill_worker_env_violations ${file}`).out).toBe("");
  });

  it("provision.sh applies the scrub to worker.env while the marker exists, and host-check.sh asserts it only then", () => {
    const provision = readFileSync(`${REPO}infra/provision/provision.sh`, "utf8");
    expect(provision).toMatch(/\[\[ \$dest == "\$ETC\/worker\.env" && -e \$ETC\/drill-vm \]\][\s\S]*drill_scrub_worker_env <"\$rendered"/);
    const hostCheck = readFileSync(`${REPO}infra/verify/host-check.sh`, "utf8");
    expect(hostCheck).toMatch(/if \[\[ -e \$ETC\/drill-vm \]\]; then\n\s+section "restore-drill VM[\s\S]*drill_worker_env_violations "\$ETC\/worker\.env"/);
  });
});

describe.skipIf(!hasBash)("recovery-conf.sh and the backup scripts", () => {
  const recoveryConf = (...args: string[]) => {
    const pgdata = unix(mkdtempSync(join(tmpdir(), "ebt-pgdata-test-")));
    const run = spawnSync("sh", [`${REPO}infra/backup/recovery-conf.sh`, pgdata, ...args], { encoding: "utf8" });
    let conf = "";
    try {
      conf = readFileSync(join(pgdata, "postgresql.auto.conf"), "utf8");
    } catch {
      // refused before writing
    }
    rmSync(pgdata, { recursive: true, force: true });
    return { status: run.status, conf };
  };

  it("fetches from the server's own storage without a SOURCE", () => {
    expect(recoveryConf().conf).toContain("restore_command = 'wal-g wal-fetch %f %p'");
  });

  it("fetches from production's storage, and only the fetch, with a SOURCE (a drill)", () => {
    const run = recoveryConf("2026-11-22 10:15:00+00", `WALG_S3_PREFIX=${PROD}`);
    expect(run.conf).toContain(`restore_command = 'env WALG_S3_PREFIX=${PROD} wal-g wal-fetch %f %p'`);
    expect(run.conf).toContain("recovery_target_time = '2026-11-22 10:15:00+00'");
    expect(run.conf).not.toMatch(/archive_command/);
  });

  it.each(["WALG_S3_PREFIX=s3://b/p'; touch /tmp/x; '", "AWS_ENDPOINT=https://x", "WALG_S3_PREFIX=/local", "WALG_FILE_PREFIX=relative", "WALG_S3_PREFIX=s3://b/a b"])(
    "refuses the SOURCE %s",
    (source) => {
      const run = recoveryConf("", source);
      expect(run.status).toBe(2);
      expect(run.conf).toBe("");
    },
  );

  it("refuses to back up on a restore-drill VM, and runs elsewhere", () => {
    const marker = join(etc, "drill-vm");
    const probe = (): number | null =>
      spawnSync("bash", ["-c", `. ${REPO}infra/backup/lib.sh; refuse_on_drill_vm`], { env: { ...process.env, EBT_DRILL_MARKER: marker }, encoding: "utf8" }).status;
    expect(probe()).toBe(0);
    writeFileSync(marker, "");
    expect(probe()).toBe(1);
  });

  it("both nightly scripts call the refusal before they touch storage", () => {
    for (const script of ["walg-base-backup.sh", "restic-backup.sh"]) {
      const text = readFileSync(`${REPO}infra/backup/${script}`, "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      expect(text.indexOf("refuse_on_drill_vm\n")).toBeGreaterThan(-1);
      expect(text.indexOf("refuse_on_drill_vm\n")).toBeLessThan(text.search(/podman (exec|run)/));
    }
  });
});
