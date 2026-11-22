# Decision: off-host logs (ASVS V16.4.3), US-015

**Status:** proposed for staging, not enabled. **Needs:** the monitoring box (US-014 and US-015 staging), no new tool.

## The gap

Every container logs to journald on the VM (`LogDriver=journald`); nothing is copied off the VM. A compromised host can erase its own trail, including the `RAISE LOG` line of the reveal watch (`security-scans.md` section 5). ASVS V16.4.3 asks for
logs to be sent to a logically separate system.

## Options considered

| Option | Adds | Verdict |
|---|---|---|
| **`systemd-journal-upload` on the VM to `systemd-journal-remote` on the WAHA box** | Two parts of systemd itself (AlmaLinux packages `systemd-journal-remote`, which holds both programs). No agent, no log shipper, no new protocol: the journal's own export format over HTTPS | **Chosen** for the host's journal (every container log, sshd, sudo, the deploy script's `ebt-deploy` lines) |
| GlitchTip for the apps' errors | Already in the plan (this story) | Do it **too**, for errors, not as the log copy: it holds events, not the access, auth and audit trail |
| A log shipper (Vector, Promtail, Filebeat, rsyslog to a SIEM) | A new tool in the plan and a new supply-chain item | Not now. Ask first if the Owner wants searchable logs |
| Do nothing and document the gap | Nothing | The fallback if the Owner declines the monitoring box's extra duty |

## What the chosen option is

- **On the monitoring box** (`systemd-journal-remote`): `systemd-journal-remote.socket` listening on a port that only the VM's address reaches (the box's firewall), `--output=/var/log/journal/remote/`, TLS with a server
  certificate, **client certificates required** (`ClientTrust`), files rotated and kept for 90 days (`journald.conf` limits for the remote directory). Disk: the VM logs about as much as its own journal (set `SystemMaxUse` on
  the VM; the remote copy is the same order of size).
- **On the VM** (`systemd-journal-upload`): `/etc/systemd/journal-upload.conf` with `URL=https://<monitoring box>:19532`, `ServerKeyFile`/`ServerCertificateFile`/`TrustedCertificateFile` for mutual TLS. The unit runs as root and reads the
  system journal **including the rootless app user's** (the journal files in `/var/log/journal/<machine>/user-<uid>.journal`), so every `CONTAINER_NAME=...` line is covered. The VM's egress guard allows
  its traffic (it is root's, not the app user's). Firewalld: outbound is open; nothing inbound changes.
- **A certificate authority of its own:** two certificates (server, one client) made by `openssl` or `step`-free tools the operator already has; the CA key stays offline (E9 of the escrow). This is the one real piece of work, and
  it needs the box, so it is staging-only.
- **Tamper evidence:** the upload is continuous, so what an attacker deletes after the compromise is still on the box; the box's own admin account is separate from the VM's (that is the "logically separate system").
- **Privacy:** the logs carry ids and codes only by construction (`log.ts` allowlists fields and masks free text), so the copy holds no more personal data than the VM's journal. Retention on the remote copy: 90 days.

## Why it is not implemented in this change

It cannot be tested without the monitoring box and a certificate chain, and it changes the VM's packages and a unit that must not be enabled half-configured (a failing upload only logs, but a wrong
certificate would send the journal to nowhere). The steps are a staging task (go-live GL-18's neighbour GL-20), written so the first run is mechanical:

1. On the monitoring box: `dnf install systemd-journal-remote`, make the CA and the two certificates, write `/etc/systemd/journal-remote.conf`, enable `systemd-journal-remote.socket`, open the port to the VM's address only.
2. On the VM: `dnf install systemd-journal-remote` (for `systemd-journal-upload`), copy the client certificate and key (root, 0600) and the CA, write `journal-upload.conf`, `systemctl enable --now systemd-journal-upload`.
3. Verify: `journalctl CONTAINER_NAME=caddy -n 1` on the VM, then the same line in `journalctl --directory=/var/log/journal/remote` on the box; delete a line on the VM's journal and see it still on the box.

ASVS row V16.4.3 stays **Not met** until step 3 passes on staging; its note now points here. V16.4.2 (retention and hardening of the journal) is the same work.
