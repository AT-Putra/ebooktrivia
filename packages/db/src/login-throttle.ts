// The admin login throttle window (apps/admin/src/lib/auth/throttle.ts), shared with the worker's
// sweeper (apps/worker sweepLoginThrottle -> public.sweep_login_throttle(window)), so the rows the
// sweeper deletes are exactly the ones whose window the admin app no longer counts.
export const LOGIN_THROTTLE_WINDOW_SECONDS = 15 * 60;
