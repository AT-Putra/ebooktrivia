// Request helpers for server components, server actions and route handlers.
import { cookies, headers } from "next/headers";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import type { RequestInfo } from "../auth/service.ts";
import { clientIp } from "../client-ip.ts";

export async function requestInfo(): Promise<RequestInfo> {
  const h = new Headers(await headers());
  return { headers: h, ip: clientIp(h) };
}

/** Applies Better Auth's Set-Cookie headers to the response of a server action. */
export async function applySetCookies(setCookies: readonly string[]): Promise<void> {
  if (setCookies.length === 0) return;
  const jar = await cookies();
  for (const [name, cookie] of parseSetCookieHeader(setCookies.join(", "))) {
    jar.set(name, cookie.value, toCookieOptions(cookie));
  }
}
