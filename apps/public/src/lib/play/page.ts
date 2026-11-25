// The signed-in player of a trivia PAGE (a server component, which cannot set cookies: readPlayer, read only,
// never rotates; the API routes rotate through withPlayer). No player: the login page. The play side not
// configured: the same 503 page as a missing runtime (the error boundary). With `count`, the load is counted
// against the player's page budget (lib/play/trivia.ts PAGE_LIMITS, security review LOW-2): a refused load reads
// nothing more and the page shows a short "slow down" note instead (Valkey down: the error boundary, fail closed).
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getRuntime } from "../runtime.ts";
import { type PlayDeps, readPlayerSession } from "./handlers.ts";
import { limitPageLoad } from "./trivia.ts";

export interface PagePlayer {
  readonly play: Omit<PlayDeps, "defer">;
  readonly playerId: string;
  /** The request's session: the key of the profile card's own-contact read (player_profile_contact). */
  readonly sessionId: string;
  /** Set when this load was over the player's page budget: wait this long. */
  readonly retryAfterSeconds: number | null;
}

export async function pagePlayer(options: { readonly count?: boolean } = {}): Promise<PagePlayer> {
  const { play } = await getRuntime();
  if (play === null) throw new Error("the player login is not configured");
  const signedIn = await readPlayerSession(play, await headers());
  if (signedIn === null) redirect("/login");
  const { playerId, sessionId } = signedIn;
  if (options.count !== true) return { play, playerId, sessionId, retryAfterSeconds: null };
  const decision = await limitPageLoad(play.valkey, playerId);
  return { play, playerId, sessionId, retryAfterSeconds: decision.allowed ? null : decision.retryAfterSeconds };
}
