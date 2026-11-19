// What an auth.api call is allowed to see of the incoming request (no I/O).

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase().slice(0, 320);

/** Headers for an auth.api call: only the named cookies, plus the client address and user agent. */
export function authHeaders(source: Headers, cookieNames: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of ["x-forwarded-for", "user-agent"]) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  const wanted = new Set(cookieNames);
  const kept = (source.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("=") && wanted.has(pair.slice(0, pair.indexOf("=")).trim()));
  if (kept.length > 0) headers.set("cookie", kept.join("; "));
  return headers;
}
