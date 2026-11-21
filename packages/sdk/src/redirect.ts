// The only place the SDK navigates to a server-supplied URL (`snap_redirect_url`). Money is
// involved, so the answer is not trusted: it must be an https URL on the Snap host of the
// configured Midtrans environment, with the shape of a Snap payment page and nothing else (no
// query, no fragment, no user info, no port). Anything else is refused and the form shows its error
// state (an open-redirect guard).
//
// Shape of a Snap `redirect_url`, from Midtrans' own documentation:
//   - https://docs.midtrans.com/docs/snap-snap-integration-guide ... https://app.sandbox.midtrans.com/snap/v2/vtweb/{token}
//   - https://docs.midtrans.com/reference/backend-integration ...... https://app.sandbox.midtrans.com/snap/v3/redirection/{snap_token}
//   - what the sandbox returns (recorded in US-005, 2026-11-21, on dozens of transactions;infra/midtrans-stub/fixtures/snap-create.json)
//     ... https://app.sandbox.midtrans.com/snap/v4/redirection/{uuid}, no query, no fragment
// i.e. `/snap/v<N>/(redirection|vtweb)/<token>` where the token is a UUID. The documentation does
// not state this shape as a contract, so any version number is accepted; the sandbox shape is confirmed, the PRODUCTION
// host's (app.midtrans.com) is not (no production credential was used): check one real Snap URL on the first production
// order, because a real Snap URL that this refuses would turn every payment into the error state.
import { SDK_LIMITS, type SdkLpConfig } from "@ebooktrivia/core/sdk-contract";

const SNAP_HOSTS: Readonly<Record<SdkLpConfig["midtrans_env"], string>> = {
  sandbox: "app.sandbox.midtrans.com",
  production: "app.midtrans.com",
};

const SNAP_PATH = /^\/snap\/v[0-9]{1,2}\/(?:redirection|vtweb)\/[A-Za-z0-9-]{1,200}$/;

/** The normalised URL to navigate to, or null when `raw` is not a Snap payment page of `env`. */
export function snapRedirectTarget(raw: unknown, env: SdkLpConfig["midtrans_env"]): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > SDK_LIMITS.urlMax) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== SNAP_HOSTS[env] || url.port !== "" || url.username !== "" || url.password !== "") return null;
  // Not even an empty query or fragment (`?` and `#` alone parse to an empty `search` / `hash`).
  if (url.href.includes("?") || url.href.includes("#") || !SNAP_PATH.test(url.pathname)) return null;
  // The parsed form is what is used, never the raw string (backslashes, tabs and the like are normalised away).
  return url.href;
}
