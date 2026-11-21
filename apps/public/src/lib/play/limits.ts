// The player login's fixed limits (US-026 security review M1, M2), next to the admin-editable otp.* settings
// they build on. Runbook: docs/runbooks/staging-provision.md "Player login limits".
//
//   IP48_FACTOR            an IPv6 /48 (one site, up to 65536 /64 customer networks) may use this many times
//                          the per-client budget of each route (otp, verify, magic link), on top of the /64
//                          limit; the same ratio as captcha.ip48_cap / captcha.ip_cap (3000 / 300).
//   VERIFY_PHONE_NETWORK_CAP / VERIFY_PHONE_CAP / VERIFY_PHONE_WINDOW_MS
//                          code checks per phone over all its codes, counted in Valkey for EVERY phone, known or
//                          not (so the count reveals nothing, and every verify does the same per-phone writes),
//                          and only for a request whose play-scope Cap token verified (security review N1: no
//                          lockout without proofs of work): 10 per 24 h per (phone, client network: an IPv6 /64
//                          or an IPv4 address), and 30 per 24 h per phone over all networks. One attacker network
//                          spends only its own slice; 3 codes an hour x 5 attempts would otherwise allow 360
//                          guesses a day. A player still locked out has the magic link.
//   VERIFY_FLOOR_MS        every `invalid_code` answer is sent no earlier than this after the request arrived, so
//                          its timing does not show whether a code existed (measured: 3.7 ms with a code, 0.8 ms
//                          without); far above both.
// The global OTP send breaker is the database's (app_settings otp.global_send_cap per 10 minutes, enforced by
// enqueue_otp): it cannot be bypassed by the app, and its default (500) is documented in sql/seed.sql.
export const PLAY_LIMITS = {
  ip48Factor: 10,
  verifyPhoneNetworkCap: 10,
  verifyPhoneCap: 30,
  verifyPhoneWindowMs: 24 * 60 * 60 * 1000,
  verifyFloorMs: 250,
} as const;
