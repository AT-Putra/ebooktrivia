// Criterion 3: enqueue_otp enforces eligibility and the per-phone cap in SQL.
import postgres from "postgres";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { PG_CONNECTION_OPTIONS } from "../src/connection.ts";
import { asRole, bytes, first, sql, sqlState, uniquePhone } from "./db.ts";
import { createPlayer, createProgram } from "./fixtures.ts";

let programId: string;
beforeAll(async () => {
  ({ programId } = await createProgram());
});

/** Stores an OTP row as public_rw (as the app would) and returns its id. */
async function storeOtp(phone: string, expiresInSeconds = 300): Promise<{ id: string; sealed: Buffer }> {
  const sealed = bytes(54);
  const row = await asRole("public_rw", async (tx) =>
    first(
      await tx<{ id: string }[]>`
        INSERT INTO public.player_otps (phone, mac, sealed_code, expires_at)
        VALUES (${phone}, ${bytes(32)}, ${sealed}, now() + make_interval(secs => ${expiresInSeconds}))
        RETURNING id`,
    ),
  );
  return { id: row.id, sealed };
}

const enqueue = (otpId: string, isolation?: string) =>
  asRole(
    "public_rw",
    async (tx) => first(await tx<{ id: string }[]>`SELECT enqueue_otp(${otpId}) AS id`).id,
    isolation,
  );

async function outboxFor(phone: string) {
  return sql<{ id: string; topic: string; payload: { otp_id: string; phone: string }; sealed: Buffer | null }[]>`
    SELECT id, topic, payload, sealed FROM outbox WHERE topic = 'otp.send' AND payload->>'phone' = ${phone}
    ORDER BY created_at`;
}

const ledgerCount = async (phone: string): Promise<number> =>
  Number(first(await sql<{ n: string }[]>`SELECT count(*) AS n FROM otp_enqueues WHERE phone = ${phone}`).n);

describe("enqueue_otp", () => {
  it("enqueues an OTP for an eligible phone, with the sealed code derived from the DB row", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    const otp = await storeOtp(phone);

    const outboxId = await enqueue(otp.id);

    const rows = await outboxFor(phone);
    expect(rows).toHaveLength(1);
    const row = first(rows);
    expect(row.id).toBe(outboxId);
    expect(row.payload).toMatchObject({ otp_id: otp.id, phone });
    expect(row.sealed?.equals(otp.sealed)).toBe(true);
    expect(await ledgerCount(phone)).toBe(1);
  });

  it("is idempotent per OTP: a repeat call returns the same outbox row and does not count again", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    const otp = await storeOtp(phone);
    const a = await enqueue(otp.id);
    const b = await enqueue(otp.id);
    expect(b).toBe(a);
    expect(await outboxFor(phone)).toHaveLength(1);
    expect(await ledgerCount(phone)).toBe(1);
  });

  it("rejects a phone with no player (ET001) and enqueues nothing", async () => {
    const phone = uniquePhone();
    const otp = await storeOtp(phone);
    expect(await sqlState(enqueue(otp.id))).toBe("ET001");
    expect(await outboxFor(phone)).toEqual([]);
    expect(await ledgerCount(phone)).toBe(0);
  });

  it("rejects a player who is not eligible for any program (ET001)", async () => {
    const { phone } = await createPlayer({ programId, eligible: false });
    const otp = await storeOtp(phone);
    expect(await sqlState(enqueue(otp.id))).toBe("ET001");
    expect(await outboxFor(phone)).toEqual([]);
  });

  it("enforces the per-phone cap (seeded 3 per 3600 s): the 4th enqueue is rejected (ET002)", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    for (let i = 0; i < 3; i++) await enqueue((await storeOtp(phone)).id);
    expect(await sqlState(enqueue((await storeOtp(phone)).id))).toBe("ET002");
    expect(await outboxFor(phone)).toHaveLength(3);
    expect(await ledgerCount(phone)).toBe(3);
  });

  it("frees capacity when the window rolls over", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    for (let i = 0; i < 3; i++) await enqueue((await storeOtp(phone)).id);
    expect(await sqlState(enqueue((await storeOtp(phone)).id))).toBe("ET002");

    // Age the oldest enqueue to just past the window (3600 s), as if an hour had passed.
    await sql`
      UPDATE otp_enqueues SET enqueued_at = now() - interval '3601 seconds'
      WHERE otp_id = (SELECT otp_id FROM otp_enqueues WHERE phone = ${phone} ORDER BY enqueued_at LIMIT 1)`;
    await enqueue((await storeOtp(phone)).id);
    expect(await sqlState(enqueue((await storeOtp(phone)).id))).toBe("ET002");

    // One just inside the window still counts.
    await sql`UPDATE otp_enqueues SET enqueued_at = now() - interval '3599 seconds' WHERE phone = ${phone}`;
    expect(await sqlState(enqueue((await storeOtp(phone)).id))).toBe("ET002");
  });

  it("counts every phone separately", async () => {
    const a = await createPlayer({ programId, eligible: true });
    const b = await createPlayer({ programId, eligible: true });
    for (let i = 0; i < 3; i++) await enqueue((await storeOtp(a.phone)).id);
    await enqueue((await storeOtp(b.phone)).id);
    expect(await ledgerCount(b.phone)).toBe(1);
  });

  it("holds the cap under concurrent calls for one phone", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    const otps = await Promise.all(Array.from({ length: 6 }, () => storeOtp(phone)));
    const results = await Promise.allSettled(otps.map((o) => enqueue(o.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => (r.reason as { code?: string }).code)).toEqual(["ET002", "ET002", "ET002"]);
    expect(await ledgerCount(phone)).toBe(3);
  });

  it("reads the cap from app_settings, which admin_rw can edit (AC-A3)", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    await asRole("admin_rw", (tx) => tx`UPDATE public.app_settings SET value = '1' WHERE key = 'otp.phone_cap'`);
    try {
      await enqueue((await storeOtp(phone)).id);
      expect(await sqlState(enqueue((await storeOtp(phone)).id))).toBe("ET002");
    } finally {
      await sql`UPDATE app_settings SET value = '3' WHERE key = 'otp.phone_cap'`;
    }
  });

  it("refuses invalid cap values at write time (CHECK) and fails closed when the setting is missing (ET009)", async () => {
    for (const bad of ["0", "-1", "2.5", '"3"', "null"]) {
      const update = asRole("admin_rw", (tx) => tx.unsafe(`UPDATE public.app_settings SET value = '${bad}' WHERE key = 'otp.phone_cap'`));
      expect(await sqlState(update)).toBe("23514");
    }
    const { phone } = await createPlayer({ programId, eligible: true });
    const otp = await storeOtp(phone);
    const missing = sql.begin(async (tx) => {
      await tx`DELETE FROM app_settings WHERE key = 'otp.phone_cap'`;
      await tx.unsafe("SET LOCAL ROLE public_rw");
      await tx`SELECT enqueue_otp(${otp.id})`;
    });
    expect(await sqlState(missing)).toBe("ET009");
    expect(await ledgerCount(phone)).toBe(0);
  });

  it("rejects an unknown OTP id (ET003) and an expired OTP (ET004)", async () => {
    expect(await sqlState(enqueue("00000000-0000-4000-8000-000000000000"))).toBe("ET003");
    const { phone } = await createPlayer({ programId, eligible: true });
    const expired = await storeOtp(phone, -1);
    expect(await sqlState(enqueue(expired.id))).toBe("ET004");
  });

  it.each(["repeatable read", "serializable"])("refuses isolation level %s (ET005)", async (level) => {
    const { phone } = await createPlayer({ programId, eligible: true });
    const otp = await storeOtp(phone);
    expect(await sqlState(enqueue(otp.id, `isolation level ${level}`))).toBe("ET005");
  });

  // Security review item 2: SSI does not see READ COMMITTED writers, so a SERIALIZABLE caller
  // on an old snapshot counted 0 and went past the cap.
  it("cannot be pushed past the cap by a SERIALIZABLE caller on an old snapshot", async () => {
    const { phone } = await createPlayer({ programId, eligible: true });
    const otps = await Promise.all(Array.from({ length: 4 }, () => storeOtp(phone)));
    let snapshotTaken = (): void => undefined;
    let release = (): void => undefined;
    const taken = new Promise<void>((resolve) => (snapshotTaken = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = sql.begin("isolation level serializable", async (tx) => {
      await tx.unsafe("SET LOCAL ROLE public_rw");
      await tx`SELECT count(*) FROM public.players`; // takes the snapshot
      snapshotTaken();
      await gate;
      await tx`SELECT enqueue_otp(${otps[3]?.id ?? ""})`;
    });
    const heldResult = held.then(
      () => "committed",
      (e: unknown) => (e as { code?: string }).code ?? "error",
    );
    await taken;
    for (const otp of otps.slice(0, 3)) await enqueue(otp.id);
    release();
    expect(await heldResult).not.toBe("committed");
    expect(await ledgerCount(phone)).toBe(3);
  });

  // Security review item 2: now() is the transaction start time, so a transaction held open past
  // the window wrote backdated ledger rows that the next window no longer counted.
  it("counts by the clock, not the transaction start: a held transaction cannot backdate its sends", async () => {
    // A 2 s window makes the clock observable; the admin bounds (app_settings_bounds_check, US-018:
    // at least an hour) are lifted for this test only and restored exactly as they were.
    const [bounds] = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'app_settings_bounds_check'`;
    await sql`ALTER TABLE app_settings DROP CONSTRAINT app_settings_bounds_check`;
    await sql`UPDATE app_settings SET value = '2' WHERE key = 'otp.phone_window_seconds'`;
    try {
      const { phone } = await createPlayer({ programId, eligible: true });
      const otps = await Promise.all(Array.from({ length: 4 }, () => storeOtp(phone)));
      await asRole("public_rw", async (tx) => {
        await tx`SELECT pg_sleep(2.5)`;
        for (const otp of otps.slice(0, 3)) await tx`SELECT enqueue_otp(${otp.id})`;
      });
      // Three sends happened just now; a fourth right away is over the cap of 3 per 2 s.
      expect(await sqlState(enqueue(otps[3]?.id ?? ""))).toBe("ET002");
      const [fresh] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM otp_enqueues WHERE phone = ${phone} AND enqueued_at > clock_timestamp() - interval '2 seconds'`;
      expect(Number(fresh?.n)).toBe(3);
    } finally {
      await sql`UPDATE app_settings SET value = '3600' WHERE key = 'otp.phone_window_seconds'`;
      await sql.unsafe(`ALTER TABLE app_settings ADD CONSTRAINT app_settings_bounds_check ${bounds?.def ?? ""}`);
    }
  });

  // Security review item 3: with `public` on the search_path, a better-matching function planted
  // in schema public won the unqualified hashtextextended(text, 0) call and ran as migrator.
  it("cannot be hijacked by a function planted in schema public", async () => {
    const { phone, playerId } = await createPlayer({ programId, eligible: false });
    const otp = await storeOtp(phone);
    await sql.unsafe(`
      CREATE FUNCTION public.hashtextextended(text, integer) RETURNS bigint LANGUAGE sql AS $$
        UPDATE public.player_programs SET eligible = true, first_paid_at = now() WHERE player_id = '${playerId}';
        SELECT pg_catalog.hashtextextended($1, $2::bigint)
      $$`);
    // A fresh session: pooled sessions may hold a cached plan that resolved the call earlier.
    const fresh = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 1, onnotice: () => undefined });
    try {
      const call = fresh.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE public_rw");
        await tx`SELECT enqueue_otp(${otp.id})`;
      });
      expect(await sqlState(call)).toBe("ET001");
      const [pp] = await sql<{ eligible: boolean }[]>`SELECT eligible FROM player_programs WHERE player_id = ${playerId}`;
      expect(pp?.eligible).toBe(false);
    } finally {
      await fresh.end();
      await sql.unsafe("DROP FUNCTION IF EXISTS public.hashtextextended(text, integer)");
    }
  });

  it("does not let public_rw read, reset or forge the cap ledger", async () => {
    for (const statement of [
      "SELECT * FROM public.otp_enqueues",
      "DELETE FROM public.otp_enqueues",
      "UPDATE public.otp_enqueues SET enqueued_at = now() - interval '1 day'",
      "INSERT INTO public.otp_enqueues (otp_id, phone, outbox_id) VALUES (gen_random_uuid(), '+6281234567890', gen_random_uuid())",
    ]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement)))).toBe("42501");
    }
  });
});

describe("player_otps rows", () => {
  // Security review item 2: created_at / expires_at came from the caller.
  it("stamp created_at from the clock and clamp expires_at to otp.code_ttl_seconds (300)", async () => {
    const row = await asRole("public_rw", async (tx) =>
      first(
        await tx<{ created_at: Date; expires_at: Date; clock: Date }[]>`
          INSERT INTO public.player_otps (phone, mac, sealed_code, expires_at, created_at)
          VALUES (${uniquePhone()}, ${bytes(32)}, ${bytes(54)}, now() + interval '10 years', '2000-01-01T00:00:00Z')
          RETURNING created_at, expires_at, clock_timestamp() AS clock`,
      ),
    );
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(300_000);
    expect(Math.abs(row.clock.getTime() - row.created_at.getTime())).toBeLessThan(5_000);
  });

  it("keep a shorter expires_at the app chose", async () => {
    const row = await asRole("public_rw", async (tx) =>
      first(
        await tx<{ ttl: number }[]>`
          INSERT INTO public.player_otps (phone, mac, sealed_code, expires_at)
          VALUES (${uniquePhone()}, ${bytes(32)}, ${bytes(54)}, clock_timestamp() + interval '60 seconds')
          RETURNING extract(epoch FROM expires_at - created_at)::int AS ttl`,
      ),
    );
    expect(row.ttl).toBeLessThanOrEqual(60);
  });

  // Security review item 8: sealed_code had no length bound. US-011 pins the construction: a
  // 6-digit code in the @ebooktrivia/crypto sealed box is exactly 6 + 48 = 54 bytes.
  it.each([0, 10, 47, 48, 53, 55, 72, 128, 129, 4096])("reject a sealed_code of %i bytes (23514)", async (n) => {
    const insert = asRole(
      "public_rw",
      (tx) => tx`
        INSERT INTO public.player_otps (phone, mac, sealed_code, expires_at)
        VALUES (${uniquePhone()}, ${bytes(32)}, ${bytes(n)}, now() + interval '5 minutes')`,
    );
    expect(await sqlState(insert)).toBe("23514");
  });

  it("accept a sealed_code of exactly 54 bytes", async () => {
    await asRole(
      "public_rw",
      (tx) => tx`
        INSERT INTO public.player_otps (phone, mac, sealed_code, expires_at)
        VALUES (${uniquePhone()}, ${bytes(32)}, ${bytes(54)}, now() + interval '5 minutes')`,
    );
  });
});
