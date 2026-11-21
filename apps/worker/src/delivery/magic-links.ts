// The real login-link issuer of the deliveries (US-025 on US-026): the token is made here (core issueMagicLink: 32 random bytes), only its SHA-256
// goes to the database (issue_magic_link(player, channel, token_hash), executable by worker_rw), and the link is `<play origin>/masuk#c=<channel>&t=<token>`
// (core magicLinkUrl: the token rides in the URL fragment, so no server or log ever sees it). The database sets the expiry (72 h from ITS clock) and keeps
// one live link per player and channel: a retry of a delivery supersedes the link of the failed attempt. The token exists in this function and in the message
// only: never a log, an error or a table. A player who may not log in (anonymized, no eligible program) or a database that fails is MagicLinkUnavailable,
// which the delivery treats as a fault on our side (core `not_attempted`): nothing is sent.
import { issueMagicLink, magicLinkUrl } from "@ebooktrivia/core";
import type { MagicLinks, MagicLinksFactory } from "./ports.ts";
import { MagicLinkUnavailable } from "./ports.ts";

export const createDatabaseMagicLinks: MagicLinksFactory = ({ sql, playOrigin }): MagicLinks => ({
  async issue({ playerId, channel }) {
    const { token, tokenHash } = issueMagicLink({ channel });
    try {
      await sql`SELECT public.issue_magic_link(${playerId}::uuid, ${channel}::text, ${tokenHash}::bytea)`;
    } catch {
      // The database's own message can name the player: nothing of it is kept.
      throw new MagicLinkUnavailable();
    }
    return magicLinkUrl(playOrigin, channel, token);
  },
});
