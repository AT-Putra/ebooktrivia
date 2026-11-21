// A play API route handler: the runtime (503 while it cannot start, and 503 for the play routes alone while
// the player login is not configured, lib/runtime.ts) and Next.js after() as the handlers' `defer`: work
// that must not change the answer, such as issuing an OTP, runs once the answer has been sent. In
// production the edge listener's drain calls Next's close(), which waits for that work (packages/edge).
import { after } from "next/server";
import { runtimeOrUnavailable } from "../runtime.ts";
import { type PlayDeps, playError } from "./handlers.ts";

export function playRoute(route: string, handler: (deps: PlayDeps, request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    const rt = await runtimeOrUnavailable(route);
    if (rt instanceof Response) return rt;
    if (rt.play === null) return playError("unavailable");
    return handler(
      {
        ...rt.play,
        defer: (task) => {
          after(task);
        },
      },
      request,
    );
  };
}
