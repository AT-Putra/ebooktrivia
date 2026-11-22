# Escrow: what the Owner must keep, where, and how to rotate each item (US-015, plan M4 item 6)

The system can be rebuilt on a clean server from **the repository, the backups and the items on this page, and nothing else**. The drill that proves it
is [restore-drill.md](restore-drill.md) (drill D1 of [drills.md](drills.md)); it uses only what is listed here. If a step of that drill needs
something that is not on this page, the drill has failed and this page is incomplete.

## Where

- **Primary: the Owner's password manager**, one entry per row of the tables below. Files (the env files) go in as attachments.
- **Second copy: a sealed paper copy**, kept in a different place from the computer (a safe, a bank box). It holds the **restore kit**: the short items marked
  **paper** below. They are enough to read the backups; the env files are in the password manager and in an encrypted offline copy (an encrypted USB drive or an
  encrypted archive on a second cloud account) that the Owner refreshes with the checklist at the end.
- **Never** on the VM only, in the repository, in chat, in e-mail, or in the CI settings (GitHub holds the deploy key, nothing else).
- Make each item the day it is created, before it is used: several are generated once on the VM (marked **generated on the VM**) and cannot be recovered
  from it afterwards if the VM is lost.

## The items

| # | Item | What it is, and where it lives on the VM | Paper | If it is lost |
|---|---|---|---|---|
| E1 | **Scope private keys**: `SECRETS_PAYMENT_PRIVATE_KEY`, `SECRETS_MESSAGING_PRIVATE_KEY`, `SECRETS_CONVERSIONS_PRIVATE_KEY`, with their public halves `SECRETS_*_PUBLIC_KEY` | base64url X25519 keys (43 characters each). Private halves: `worker.env` (all three) and `public.env` (the payment key only); public halves: `admin.env` (all three) and `public.env` (the messaging one). **Made on the Owner's own computer, never on the VM** (below) | yes | Every sealed secret (the Midtrans server keys, the SMTP password, the WAHA API keys, the adnets' secrets and CAPI tokens) is unreadable. Nothing in the database can recover them: make a new key pair and **enter every secret again** in the console |
| E2 | **`WAHA_WEBHOOK_HMAC_SECRET`** | A random string of at least 16 characters in `public.env`; the same value is each WAHA session's webhook HMAC key on the WAHA box | yes | Make a new one, put it in `public.env` and in every session's webhook, restart `public@a` and `public@b`; webhooks fail their signature check in between |
| E3 | **The wal-g libsodium key** | 64 hex digits in `/etc/ebooktrivia/postgres/walg_libsodium.key`. **Generated on the VM** by `provision.sh` the first time (it prints a note); every base backup and every WAL segment is encrypted with it before it leaves the VM | yes | **Every backup and every WAL segment in storage is unreadable.** There is no recovery: take a new base backup under a new key at once (the restic copy and `pg_dump` files still hold the data) |
| E4 | **The S3 credentials of wal-g** | The access key id and secret in `/etc/ebooktrivia/postgres/walg_aws_credentials` (an AWS shared-credentials file), and `WALG_S3_PREFIX`, `AWS_ENDPOINT`, `AWS_REGION` in `walg.env` | yes | Make a new access key at the storage provider, put it in the file; backups continue. The data in storage is not lost |
| E5 | **The restic repository and password** | `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` and the S3 keys of the **second** storage location in `/etc/ebooktrivia/restic.env`. `RESTIC_PASSWORD` is **generated on the VM** by `provision.sh` | yes | Without the password the repository cannot be read. Start a new repository (`restic init`) from the next night |
| E6 | **The env files** | `/etc/ebooktrivia/{public,admin,worker,internal,migrate,valkey,postgres,walg,restic,caddy}.env`, `provision.env`, and `postgres/superuser.pass`. They hold the **generated** secrets: the database logins' passwords (the restored cluster has the same roles, so the passwords must match), the Valkey passwords, `ADMIN_AUTH_SECRETS` (the TOTP seeds of every admin are encrypted with it), `CAPTCHA_HMAC_KEY`, `PLAYER_AUTH_SECRETS`, `PLAYER_OTP_PEPPER`, the GlitchTip hook token's SHA-256. `provision.sh` keeps a value that is already in a file, so putting the escrowed files in place **before** it runs gives the same secrets back | no | A rebuilt VM gets new passwords that do not match the restored database roles (`db-roles.sh` can reset the roles to the new passwords), a new `ADMIN_AUTH_SECRETS` makes every enrolled authenticator unreadable (the Owner re-enrols with a recovery code, E8), a new `CAPTCHA_HMAC_KEY` and the player secrets log players out |
| E7 | **The Midtrans keys** | The production and sandbox server and client keys and the merchant id, as shown in the Midtrans dashboard. In the system they are sealed in the database (readable only with E1) | no (the dashboard issues new ones) | With E1 intact nothing is needed. Without it, re-issue the keys in the dashboard and enter them in Admin, Settings, Midtrans. Keep a plain copy here so the first checkout works the hour the console is back |
| E8 | **The admin recovery** | The Owner's console login (e-mail and password), the authenticator's seed or the way to move it, and the **10 recovery codes** shown once at enrolment. `docs/runbooks/admin-access.md` has the CLI for a locked-out Owner (it needs SSH to the VM and E6) | yes (the recovery codes) | A locked-out Owner with no recovery code and no E6 cannot get back in: `admin-access.md` section 4 (a locked-out account) |
| E9 | **The accounts** | The login of every account the system depends on: the VM provider and its web console password, the DNS registrar, both S3 storage accounts, the Midtrans dashboard, the WAHA box, GitHub (the repository and the `staging` and `production` environments), the SMTP provider, the monitoring box's Uptime Kuma and GlitchTip admin logins | no | Each is recoverable through its own provider, slowly: that is why they are listed |
| E10 | **The deploy key** | The CI's SSH private key is a GitHub environment secret (`DEPLOY_SSH_KEY`); its public half is `DEPLOY_PUBLIC_KEY` in `provision.env` (E6). Keep the public half and the `DEPLOY_KNOWN_HOSTS` line (the VM's host key) | no | Make a new key pair, change `DEPLOY_PUBLIC_KEY`, run `provision.sh`, update the GitHub secret. The key can do nothing but run the forced command |

| E11 | **The drill keys** | Two S3 access keys made at the storage providers **for restore drills only**: (a) for wal-g's bucket, **read-only on production's prefix and read and write on a scratch prefix** (`s3://<scratch bucket>/...`), the AWS-credentials file a drill VM puts in `postgres/walg_aws_credentials`; (b) for restic's bucket, **read-only** (`restic.env` on a drill VM, used with `--no-lock`). The full keys (E4, E5) are never put on a drill VM. Provider policy, in words: GetObject and ListBucket on production's bucket, nothing else there | no | Make new ones at the provider and replace the escrowed copy; production is unaffected. Until they exist no drill can be run: the drill must not fall back to E4 or E5 |

Not secrets, but needed on the day: the repository (GitHub access), control of the DNS records, the provider's console, the list of the Owner's WhatsApp
numbers and sessions. They are in E9.

### Making the scope key pairs (E1)

On the Owner's own computer, from a checkout of the repository with Node 26 (the keys never touch the VM until they are put in the env files):

```sh
cd packages/crypto
for scope in payment messaging conversions; do
  node --input-type=module -e 'import { generateScopeKeyPair } from "./src/index.ts"; const k = generateScopeKeyPair(); console.log(process.argv[1], "PRIVATE", k.privateKey.toString("base64url")); console.log(process.argv[1], "PUBLIC ", k.publicKey.toString("base64url"));' "$scope"
done
```

Put each line in the password manager and on the paper copy, then in the env files as `docs/runbooks/staging-provision.md` says (the private key of the payment scope in `public.env`
and `worker.env`; the messaging and conversions private keys in `worker.env`; the public keys in `admin.env`, and the messaging public key in `public.env`).

## How to rotate each item

| Item | Rotation |
|---|---|
| E1 | A new pair **orphans every secret sealed to the old one**: make the new pair, put the new public key in `admin.env` (and `public.env`) and the new private key in `worker.env`, restart `admin`, `worker`, `public@a`, `public@b`, then **enter every secret of that scope again** in the console (Midtrans keys, SMTP password, WAHA API keys, adnet secrets, CAPI tokens). Rotating the payment key also voids every outstanding signed download link (`staging-provision.md`, Routine operations). Update the escrow the same day |
| E2 | New value in `public.env` and in every WAHA session's webhook, restart `public@a` and `public@b` (`delivery.md`, "Setting up the webhook") |
| E3 | The old backups need the old key. Put the new key in `walg_libsodium.key`, `systemctl --user restart postgres.service` (WAL from now on is under the new key), then run `infra/backup/walg-base-backup.sh` **at once** so a restorable backup exists under the new key. **Keep both keys in the escrow until every backup made under the old one has aged out (14 days)** |
| E4 | New access key at the provider, edit `walg_aws_credentials` (read at every wal-g run: no restart), run `systemctl --user start ebt-backup-base.service` and check it passes, then delete the old key at the provider |
| E5 | `restic key add` a new password, then `restic key remove` the old one (run through the same container: `podman run --rm -it --network ebt-backup --env-file /etc/ebooktrivia/restic.env docker.io/restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 key add`), then put the new `RESTIC_PASSWORD` in `restic.env`. For the S3 keys: as E4 |
| E6 | Per value, as its runbook says: a database password (`db-roles.sh` after changing the env file), `ADMIN_AUTH_SECRETS` (prepend a new version, `admin-access.md` section 5), `CAPTCHA_HMAC_KEY` (`staging-provision.md`, restart both public instances together). **Re-escrow the changed file the same day** |
| E7 | Re-issue in the Midtrans dashboard, enter in the console, update the plain copy |
| E8 | A new recovery-code set from the console (Account, "Regenerate recovery codes") replaces the old one; replace the paper copy |
| E9, E10 | At the provider; E10 as in the table above |

## The escrow checklist

Tick each line with a date, when the escrow is first made and again after every change above, and every quarter. A line is ticked only after the copy was opened and read back.

| Check | Date, who |
|---|---|
| E1 all six keys are in the password manager and on paper; the paper reads back correctly | |
| E2 `WAHA_WEBHOOK_HMAC_SECRET` is in both | |
| E3 the wal-g libsodium key is in both, **the day provisioning generated it** | |
| E4 the wal-g S3 credentials, endpoint, prefix and region are in the password manager and on paper | |
| E5 the restic password and repository are in both | |
| E6 the env files are in the password manager and in the encrypted offline copy, and are the current ones (compare `sha256sum` of each with the VM) | |
| E7 the Midtrans keys and merchant id | |
| E8 the 10 recovery codes are on paper, unused ones counted | |
| E9 the account logins are all in the password manager, and each one was opened this quarter | |
| E10 the deploy key's public half and the VM's host key line | |
| E11 the two drill keys are in the password manager; a read of production's prefix works with them and a write to it is **refused** (try `aws s3 cp` of a small file to production's prefix: it must fail) | |
| The restore drill ([restore-drill.md](restore-drill.md)) was run from this page only, and every secret it needed was here | |
