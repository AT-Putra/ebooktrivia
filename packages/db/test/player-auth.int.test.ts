// US-026 (M9a player authentication): the SECURITY DEFINER functions behind the player login and the
// privileges that make them the only path.
//   prepare_player_login   phone -> the player_auth user to issue an OTP for (created here), NULL otherwise
//   player_for_login       player_auth user -> the player id, for a player who may still log in
//   issue_magic_link       worker_rw: one live link per player and channel, expiry from the DB clock
//   consume_magic_link     public_rw: single use, refused on the other channel, after expiry and on replay
import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, first, rolledBack, sql, sqlState, uniquePhone } from "./db.ts";
import { createPlayer, createProgram } from "./fixtures.ts";

let programId: string;
beforeAll(async () => {
  ({ programId } = await createProgram());
});

const hash = (token: string): Buffer => createHash("sha256").update(token).digest();
const newToken = (): string => randomBytes(32).toString("base64url");

const prepare = (phone: string) => asRole("public_rw", async (tx) => first(await tx<{ u: string | null }[]>`SELECT prepare_player_login(${phone}) AS u`).u);
const playerFor = (authUserId: string) => asRole("public_rw", async (tx) => first(await tx<{ p: string | null }[]>`SELECT player_for_login(${authUserId}) AS p`).p);
const issue = (playerId: string, channel: string, tokenHash: Buffer) =>
  asRole("worker_rw", async (tx) => first(await tx<{ id: string }[]>`SELECT issue_magic_link(${playerId}, ${channel}, ${tokenHash}) AS id`).id);
const consume = (tokenHash: Buffer, channel: string) =>
  asRole("public_rw", async (tx) => first(await tx<{ u: string | null }[]>`SELECT consume_magic_link(${tokenHash}, ${channel}) AS u`).u);

async function authUser(id: string) {
  return first(
    await sql<{ name: string; email: string; phone: string | null; verified: boolean | null }[]>`
      SELECT name, email, "phoneNumber" AS phone, "phoneNumberVerified" AS verified FROM player_auth."user" WHERE id = ${id}`,
  );
}
const linkedUser = async (playerId: string): Promise<string | null> => first(await sql<{ u: string | null }[]>`SELECT auth_user_id AS u FROM players WHERE id = ${playerId}`).u;
const authUsersWithPhone = async (phone: string): Promise<number> =>
  Number(first(await sql<{ n: string }[]>`SELECT count(*) AS n FROM player_auth."user" WHERE "phoneNumber" = ${phone}`).n);

describe("prepare_player_login (the OTP path)", () => {
  it("creates the eligible player's player_auth user once (verified phone, placeholder e-mail, no buyer name) and links it", async () => {
    const { playerId, phone } = await createPlayer({ programId, eligible: true });
    const userId = await prepare(phone);
    expect(userId).toEqual(expect.any(String));
    expect(await linkedUser(playerId)).toBe(userId);
    expect(await authUser(userId ?? "")).toEqual({ name: "pemain", email: `${phone}@players.invalid`, phone, verified: true });
    // Idempotent: the same user again, no second row.
    expect(await prepare(phone)).toBe(userId);
    expect(await authUsersWithPhone(phone)).toBe(1);
    expect(await playerFor(userId ?? "")).toBe(playerId);
  });

  it("returns NULL and creates nothing for an unknown phone, a non-eligible player and an anonymized one", async () => {
    expect(await prepare(uniquePhone())).toBeNull();
    const notEligible = await createPlayer({ programId, eligible: false });
    expect(await prepare(notEligible.phone)).toBeNull();
    expect(await linkedUser(notEligible.playerId)).toBeNull();
    expect(await authUsersWithPhone(notEligible.phone)).toBe(0);
    const anonymized = await createPlayer({ programId, eligible: true });
    await sql`UPDATE players SET anonymized_at = now() WHERE id = ${anonymized.playerId}`;
    expect(await prepare(anonymized.phone)).toBeNull();
    expect(await authUsersWithPhone(anonymized.phone)).toBe(0);
  });

  it("links an orphaned player_auth user of the same phone, and never one that another player owns (ET122)", async () => {
    const { playerId, phone } = await createPlayer({ programId, eligible: true });
    const orphan = `orphan-${randomBytes(6).toString("hex")}`;
    await sql`INSERT INTO player_auth."user" (id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified") VALUES (${orphan}, 'x', ${`${phone}@players.invalid`}, false, ${phone}, true)`;
    expect(await prepare(phone)).toBe(orphan);
    expect(await linkedUser(playerId)).toBe(orphan);

    const victim = await createPlayer({ programId, eligible: true });
    const victimUser = await prepare(victim.phone);
    // A second player whose phone the victim's auth user holds (e.g. a stale row) must not take it over.
    const other = await createPlayer({ programId, eligible: true });
    await sql`UPDATE player_auth."user" SET "phoneNumber" = ${other.phone} WHERE id = ${victimUser ?? ""}`;
    expect(await sqlState(prepare(other.phone))).toBe("ET122");
    expect(await linkedUser(other.playerId)).toBeNull();
    expect(await linkedUser(victim.playerId)).toBe(victimUser);
  });

  it("player_for_login answers NULL once the player is no longer eligible or is anonymized", async () => {
    const { playerId, phone } = await createPlayer({ programId, eligible: true });
    const userId = (await prepare(phone)) ?? "";
    expect(await playerFor(userId)).toBe(playerId);
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${playerId}`;
    expect(await playerFor(userId)).toBeNull();
    await sql`UPDATE player_programs SET eligible = true WHERE player_id = ${playerId}`;
    await sql`UPDATE players SET anonymized_at = now() WHERE id = ${playerId}`;
    expect(await playerFor(userId)).toBeNull();
    expect(await playerFor("no-such-user")).toBeNull();
  });
});

describe("magic links", () => {
  it("are issued by worker_rw only, with the database's 72 h expiry, one live link per player and channel", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const first1 = newToken();
    const id1 = await issue(playerId, "whatsapp", hash(first1));
    const row = first(await sql<{ ttl_ok: boolean }[]>`
      SELECT expires_at BETWEEN clock_timestamp() + interval '71 hours 59 minutes' AND clock_timestamp() + interval '72 hours' AS ttl_ok
        FROM magic_links WHERE id = ${id1}`);
    expect(row.ttl_ok).toBe(true);
    const emailToken = newToken();
    await issue(playerId, "email", hash(emailToken));
    // A second WhatsApp link replaces the first; the e-mail link is untouched.
    const second = newToken();
    await issue(playerId, "whatsapp", hash(second));
    const live = await sql<{ channel: string; token_hash: Buffer }[]>`
      SELECT channel, token_hash FROM magic_links WHERE player_id = ${playerId} AND consumed_at IS NULL ORDER BY channel`;
    expect(live.map((l) => [l.channel, l.token_hash.equals(hash(l.channel === "email" ? emailToken : second))])).toEqual([
      ["email", true],
      ["whatsapp", true],
    ]);
    expect(await consume(hash(first1), "whatsapp")).toBeNull();
  });

  it("refuses arguments out of scope (ET120) and a player who may not log in (ET121)", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    expect(await sqlState(issue(playerId, "sms", hash(newToken())))).toBe("ET120");
    expect(await sqlState(issue(playerId, "email", randomBytes(31)))).toBe("ET120");
    const notEligible = await createPlayer({ programId, eligible: false });
    expect(await sqlState(issue(notEligible.playerId, "email", hash(newToken())))).toBe("ET121");
  });

  it("consume: single use, the player's login on success; a replay, the other channel and an unknown token get NULL", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const token = newToken();
    await issue(playerId, "email", hash(token));
    // The other channel is refused and does not use the link up.
    expect(await consume(hash(token), "whatsapp")).toBeNull();
    const userId = await consume(hash(token), "email");
    expect(userId).toEqual(expect.any(String));
    expect(await linkedUser(playerId)).toBe(userId);
    expect(await consume(hash(token), "email")).toBeNull();
    expect(await consume(hash(newToken()), "email")).toBeNull();
    expect(await consume(randomBytes(7), "email")).toBeNull();
  });

  it("consume: an expired link is refused, and a player no longer eligible keeps the link unused", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const expired = newToken();
    const id = await issue(playerId, "whatsapp", hash(expired));
    await sql`UPDATE magic_links SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}`;
    expect(await consume(hash(expired), "whatsapp")).toBeNull();

    const token = newToken();
    const id2 = await issue(playerId, "email", hash(token));
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${playerId}`;
    expect(await consume(hash(token), "email")).toBeNull();
    expect(first(await sql<{ consumed: boolean }[]>`SELECT consumed_at IS NOT NULL AS consumed FROM magic_links WHERE id = ${id2}`).consumed).toBe(false);
  });

  it("magic_link_login_user names the login without using the link up, and is NULL exactly when consume would refuse", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const token = newToken();
    await issue(playerId, "email", hash(token));
    const peek = (h: Buffer, channel: string) =>
      asRole("public_rw", async (tx) => first(await tx<{ u: string | null }[]>`SELECT magic_link_login_user(${h}, ${channel}) AS u`).u);
    const userId = await peek(hash(token), "email");
    expect(userId).toEqual(expect.any(String));
    expect(await peek(hash(token), "email")).toBe(userId);
    expect(await peek(hash(token), "whatsapp")).toBeNull();
    expect(await peek(hash(newToken()), "email")).toBeNull();
    expect(await consume(hash(token), "email")).toBe(userId);
    expect(await peek(hash(token), "email")).toBeNull();
  });

  it("player_login_label shows whose login it is, masked (****890), and nothing for a player who may not log in", async () => {
    const { playerId, phone } = await createPlayer({ programId, eligible: true });
    const userId = (await prepare(phone)) ?? "";
    const label = () => asRole("public_rw", async (tx) => first(await tx<{ l: string | null }[]>`SELECT player_login_label(${userId}) AS l`).l);
    expect(await label()).toBe(`****${phone.slice(-3)}`);
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${playerId}`;
    expect(await label()).toBeNull();
  });

  it("consume: of concurrent consumers exactly one wins", async () => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const token = newToken();
    await issue(playerId, "whatsapp", hash(token));
    const results = await Promise.all(Array.from({ length: 6 }, () => consume(hash(token), "whatsapp")));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe("privileges (US-009 carry-over: public_rw has no read path into players)", () => {
  it.each([
    ["read a player's phone", "SELECT phone FROM public.players"],
    ["read a player's name", "SELECT name FROM public.players"],
    ["read players at all", "SELECT id FROM public.players"],
    ["link a player to a login", "UPDATE public.players SET auth_user_id = NULL"],
    ["read magic links", "SELECT id FROM public.magic_links"],
    ["consume a magic link directly", "UPDATE public.magic_links SET consumed_at = now()"],
    ["insert a magic link", "INSERT INTO public.magic_links (player_id, channel, token_hash, expires_at) VALUES (gen_random_uuid(), 'email', '\\x00', now())"],
    ["read a sealed OTP code", "SELECT sealed_code FROM public.player_otps"],
    ["issue a magic link", "SELECT public.issue_magic_link(gen_random_uuid(), 'email', '\\x00')"],
    ["call the internal user helper", "SELECT public.player_auth_user_for(gen_random_uuid())"],
  ])("public_rw cannot %s", async (_name, statement) => {
    expect(await sqlState(rolledBack("public_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });

  it.each([
    ["insert a magic link directly", "INSERT INTO public.magic_links (player_id, channel, token_hash, expires_at) VALUES (gen_random_uuid(), 'email', '\\x00', now())"],
    ["consume a magic link", "SELECT public.consume_magic_link('\\x00', 'email')"],
    ["prepare a login", "SELECT public.prepare_player_login('+6281200000000')"],
  ])("worker_rw cannot %s", async (_name, statement) => {
    expect(await sqlState(rolledBack("worker_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
  });

  it.each([
    ["insert a magic link", "INSERT INTO public.magic_links (player_id, channel, token_hash, expires_at) VALUES (gen_random_uuid(), 'email', '\\x00', now())"],
    ["consume a magic link", "UPDATE public.magic_links SET consumed_at = now()"],
    ["delete a magic link", "DELETE FROM public.magic_links"],
  ])("admin_rw reads magic links but cannot %s (security review L4)", async (_name, statement) => {
    expect(await sqlState(rolledBack("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
    await rolledBack("admin_rw", (tx) => tx`SELECT id, channel, expires_at, consumed_at FROM public.magic_links LIMIT 1`);
  });

  it.each([
    ["insert a ledger row", "INSERT INTO public.otp_enqueues (otp_id, phone, outbox_id) VALUES (gen_random_uuid(), '+6281200000000', gen_random_uuid())"],
    ["backdate the ledger", "UPDATE public.otp_enqueues SET enqueued_at = now() - interval '2 days'"],
    ["delete the ledger (reset the caps)", "DELETE FROM public.otp_enqueues"],
  ])("admin_rw reads the OTP send ledger but cannot %s (the per-phone cap and the breaker)", async (_name, statement) => {
    expect(await sqlState(rolledBack("admin_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
    await rolledBack("admin_rw", (tx) => tx`SELECT count(*) FROM public.otp_enqueues`);
  });

  it("prune_otp_enqueues (worker_rw) deletes ledger rows older than 24 h only; the worker cannot delete a row itself", async () => {
    const old = uniquePhone();
    const recent = uniquePhone();
    await sql`INSERT INTO otp_enqueues (otp_id, phone, outbox_id, enqueued_at) VALUES (gen_random_uuid(), ${old}, gen_random_uuid(), now() - interval '25 hours'), (gen_random_uuid(), ${recent}, gen_random_uuid(), now() - interval '23 hours')`;
    const pruned = await asRole("worker_rw", async (tx) => first(await tx<{ n: number }[]>`SELECT prune_otp_enqueues() AS n`).n);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT 1 FROM otp_enqueues WHERE phone = ${old}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM otp_enqueues WHERE phone = ${recent}`).toHaveLength(1);
    expect(await sqlState(rolledBack("worker_rw", (tx) => tx`DELETE FROM public.otp_enqueues`))).toBe("42501");
    expect(await sqlState(rolledBack("public_rw", (tx) => tx`SELECT prune_otp_enqueues()`))).toBe("42501");
  });

  it("prune_player_sessions (worker_rw) deletes expired and past-the-cap player sessions with their state, and only those", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    const userId = (await prepare(phone)) ?? "";
    const session = (id: string, expiresIn: string, loginAgo: string) =>
      sql`WITH s AS (INSERT INTO player_auth.session (id, "expiresAt", token, "updatedAt", "userId") VALUES (${id}, now() + ${expiresIn}::interval, ${`tok-${id}`}, now(), ${userId}) RETURNING id)
          INSERT INTO player_auth.session_state (session_id, login_at) SELECT id, now() - ${loginAgo}::interval FROM s`;
    const tag = randomBytes(4).toString("hex");
    await session(`live-${tag}`, "1 day", "1 day");
    await session(`expired-${tag}`, "-1 second", "1 day");
    await session(`capped-${tag}`, "1 day", "91 days");
    const n = await asRole("worker_rw", async (tx) => first(await tx<{ n: number }[]>`SELECT prune_player_sessions() AS n`).n);
    expect(n).toBeGreaterThanOrEqual(2);
    const left = await sql<{ id: string }[]>`SELECT id FROM player_auth.session WHERE id LIKE ${`%-${tag}`} ORDER BY id`;
    expect(left.map((r) => r.id)).toEqual([`live-${tag}`]);
    expect(await sql`SELECT 1 FROM player_auth.session_state WHERE session_id LIKE ${`%-${tag}`}`).toHaveLength(1);
    expect(await sqlState(rolledBack("worker_rw", (tx) => tx`SELECT 1 FROM player_auth.session`))).toBe("42501");
  });

  it("public_rw keeps what the OTP issue and verify need on player_otps (no sealed code read)", async () => {
    await rolledBack("public_rw", async (tx) => {
      const phone = uniquePhone();
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.player_otps (phone, mac, sealed_code, expires_at) VALUES (${phone}, ${randomBytes(32)}, ${randomBytes(54)}, now() + interval '5 minutes') RETURNING id`;
      const [updated] = await tx<{ mac: Buffer; attempts: number }[]>`
        UPDATE public.player_otps SET attempts = attempts + 1 WHERE phone = ${phone} AND attempts < 5 RETURNING mac, attempts`;
      expect(updated?.attempts).toBe(1);
      await tx`DELETE FROM public.player_otps WHERE id = ${row?.id ?? ""}`;
    });
  });
});
