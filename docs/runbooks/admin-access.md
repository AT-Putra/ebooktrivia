# Admin console access: first Owner, sign-in, recovery (US-016, plan M5a.1)

The admin console (`admin.<DOMAIN>`) has two roles, Owner and Staff (`apps/admin/src/lib/policy.ts`).
Every account must use a password and an authenticator app (TOTP). This runbook covers the steps
only the operator can do on the VM: creating the first Owner and recovering a locked-out account.
Both run the admin CLI image and are written to the audit log as actor `cli`.

## 1. Build the CLI image

On the VM, from the checkout (the same way as the app images, see `staging-provision.md`):

```bash
sudo infra/provision/build-images.sh admin-cli
```

This builds `localhost/ebooktrivia/admin-cli:current`. It runs `apps/admin/src/cli/admin.ts` with
the admin app's environment file, so it connects as `ebt_admin` (group `admin_rw` only) and nothing
else. The CLI refuses any other login.

All commands below run as the app user (`APP_USER`, default `ebt`, the rootless podman owner) on
the internal `ebt-data` network, where `postgres` resolves:

```bash
cli() { sudo runuser -u ebt -- env HOME="$(getent passwd ebt | cut -d: -f6)" XDG_RUNTIME_DIR="/run/user/$(id -u ebt)" \
  podman run --rm -it --network ebt-data --env-file /etc/ebooktrivia/admin.env localhost/ebooktrivia/admin-cli:current "$@"; }
```

Passwords are never command-line arguments. The CLI prompts for them without echo (keep `-it`;
Ctrl-C cancels).

## 2. Create the first Owner (once)

```bash
cli bootstrap-owner --email <owner e-mail> --name "<display name>"
```

The CLI prompts for a temporary password twice (12 to 128 characters). It refuses with exit status
2 once any Owner exists, and two runs at the same time still create only one Owner.

Then open `https://admin.<DOMAIN>/login` within **72 hours** and sign in. The console allows only
the TOTP setup:

1. Enter the temporary password and choose a new password.
2. Scan the QR code with an authenticator app, or choose "enter a setup key" (time based, 6 digits,
   30 seconds) and type the key.
3. Save the 10 recovery codes offline. Each code works once and is shown only now. The database
   stores only their argon2id hashes.
4. Enter the first 6-digit code. Two-factor is on, and every other session of the account is
   signed out.

The Owner adds Staff accounts on the Team page, with a temporary password shared out of band.
Each Staff member goes through the same setup at their first sign-in, also within 72 hours. After
the deadline the account cannot sign in until the Owner uses **Reset access** on the Team page.

## 3. Sign-in rules (for support questions)

| Rule | Value |
|---|---|
| Password lockout | 5 wrong passwords in 15 minutes for one e-mail lock that e-mail for 15 minutes. Unknown e-mails are counted the same way. |
| Second-factor lockout | 5 wrong TOTP or recovery codes in 15 minutes for one account lock its second factor for 15 minutes. This is a separate budget from the password step. Better Auth also keeps its own 5-failure TOTP lock. |
| Second-factor hard lock | 20 consecutive failed codes, spread over any number of windows, lock the second factor until a recovery (section 4). Only a successful sign-in resets the count. The log shows `admin.second_factor_locked`, and the audit log shows `admin_auth.second_factor_hard_locked`. |
| Per-address lockout | 5 failures in 15 minutes from one client address (IPv6: per /64) block that address for 15 minutes. Password and code failures share this one key. |
| Storage | All locks are stored in PostgreSQL, so they survive restarts and apply to every app instance. The worker deletes spent rows every minute. It keeps consecutive counts and hard locks. |
| Sessions | Ended after 30 minutes without activity, and 12 hours after sign-in at the latest. Cookie `__Host-admin_session` (Secure, HttpOnly, SameSite=Strict). |
| TOTP codes | Each code is accepted once. A reused code is refused for 2 minutes. |
| Recovery codes | 10 per setup, single use. **Account → Create new recovery codes** (needs a current TOTP code) replaces all of them. The overview warns at 3 or fewer. |
| Disabled account | The Owner's **Disable** on the Team page revokes every session at once. |

## 4. Recover a locked-out account

Use this when the authenticator and the recovery codes are both lost, for a hard lock, an
expired setup, or a forgotten password:

```bash
cli recover --email <e-mail>
```

The CLI always asks for a new temporary password. A recovery that kept the old password would let
anyone who knows it set up their own authenticator. The command:

- turns TOTP off and removes the authenticator secret, every recovery code and every session;
- clears the account's password and second-factor throttle, including the hard lock;
- sets the new password and a new 72-hour setup deadline;
- writes one audit entry (`cli.recover_admin`).

The person then signs in with the temporary password, chooses their own and sets up TOTP again. The
per-address keys are not cleared; they expire on their own within 15 minutes. Verify the person's
identity out of band before running the command: it bypasses the second factor by design.

For Staff, the Owner can do the same from the Team page (**Reset access**, audited as
`admin_user.reset_access`). The Owner's own account needs the CLI.

## 5. Rotate `ADMIN_AUTH_SECRETS`

`ADMIN_AUTH_SECRETS` in `/etc/ebooktrivia/admin.env` holds versioned secrets, newest first:
`<version>:<secret>,...`. The first one signs the session cookies and encrypts new TOTP secrets.
The older ones only decrypt the TOTP secrets that were enrolled under them. To rotate, for example
after a leak:

1. Generate a secret: `openssl rand -hex 32`.
2. Put it in front with the next version and keep the old entry:
   `ADMIN_AUTH_SECRETS=2:<new>,1:<old>`.
3. Restart `admin.service`. Everyone is signed out, because the old cookie signatures no longer
   verify. Enrolled authenticators keep working.
4. Remove `1:<old>` only once every admin has set up TOTP again (or been recovered) under the new
   version. Removing a version makes every authenticator enrolled under it unreadable, and signing
   in with one then fails with an error.

`ADMIN_ORIGIN` (`https://admin.<DOMAIN>`) must equal the address in the browser exactly. If it is
wrong, every sign-in and every change is refused with 403. The image build also needs it, as
`build-images.sh` passes `https://admin.$DOMAIN` into the server-action allowed origins.
