// US-030 (M10b) prize fulfilment and the chargeback re-award, in the database (sql/fulfillment.sql, sql/contest.sql, triggers.sql):
//   - the Owner's confirmation creates one pending fulfilment per confirmed winner;
//   - pending -> contacted -> sent -> done, exactly one step at a time, stamping who and when; done is final; a correction goes
//     back one step with a reason only, clearing the stamps of the step it undoes; stale and repeated steps; all audited;
//   - notes (plain text, capped, audited by reference only) and the proof (kind proof; a replaced proof is deleted);
//   - a flagged or revoked winner is halted (ET082); only prize_fulfillment moves a fulfilment (ET175), only admin_rw may call;
//   - revoke and re-award to the next eligible rank (skipping refunded, charged-back and erased players), reinstatement with the
//     eligibility re-check, both idempotent and race-safe under the contest lock.
import { describe, expect, it } from "vitest";
import { admins, confirm, contest, finalized, rankedPlayer, snapshot, tier, winnersOf } from "./contest-fixtures.ts";
import { asRole, bytes, first, rolledBack, sql, sqlState, suffix } from "./db.ts";

type Summary = Record<string, unknown>;

const step = async (id: string, from: string, to: string, reason: string | null = null, actor?: string): Promise<Summary> => {
  const a = actor ?? (await admins()).owner;
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ s: Summary }[]>`SELECT public.fulfillment_step(${id}::uuid, ${from}, ${to}, ${reason}, ${a}, 'req-f', '198.51.100.9'::inet) AS s`).s,
  );
};
const notes = async (id: string, text: string | null): Promise<Summary> => {
  const { owner } = await admins();
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ s: Summary }[]>`SELECT public.fulfillment_set_notes(${id}::uuid, ${text}, ${owner}, 'req-n', '198.51.100.9'::inet) AS s`).s,
  );
};
const proofUpload = async (kind = "proof"): Promise<{ id: string; path: string }> => {
  const id = (await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0]?.id ?? "";
  const path = `proofs/${id}.webp`;
  await sql`INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256) VALUES (${id}, ${kind}, ${path}, 'image/webp', 10, ${bytes(32)})`;
  return { id, path };
};
const setProof = async (id: string, uploadId: string): Promise<Summary> => {
  const { owner } = await admins();
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ s: Summary }[]>`SELECT public.fulfillment_set_proof(${id}::uuid, ${uploadId}::uuid, ${owner}, 'req-p', '198.51.100.9'::inet) AS s`).s,
  );
};
const revoke = async (winnerId: string, reason = "Chargeback dari bank pembeli."): Promise<Summary> => {
  const { owner } = await admins();
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ s: Summary }[]>`SELECT public.revoke_winner(${winnerId}::uuid, ${reason}, ${owner}, 'req-r', '198.51.100.9'::inet) AS s`).s,
  );
};
const reinstate = async (winnerId: string, reason = "Sengketa selesai, dana kembali."): Promise<Summary> => {
  const { owner } = await admins();
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ s: Summary }[]>`SELECT public.reinstate_winner(${winnerId}::uuid, ${reason}, ${owner}, 'req-i', '198.51.100.9'::inet) AS s`).s,
  );
};
const flag = (winnerId: string) =>
  asRole("worker_rw", (tx) => tx`UPDATE winners SET status = 'flagged', flagged_at = clock_timestamp(), flag_reason = 'chargeback', updated_at = clock_timestamp() WHERE id = ${winnerId}`);
const fulfillment = (id: string) =>
  sql<{ status: string; contacted_at: Date | null; contacted_by_admin_user_id: string | null; sent_at: Date | null; sent_by_admin_user_id: string | null; done_at: Date | null; notes: string | null; proof_upload_id: string | null }[]>`
    SELECT status::text AS status, contacted_at, contacted_by_admin_user_id, sent_at, sent_by_admin_user_id, done_at, notes, proof_upload_id FROM fulfillments WHERE id = ${id}`.then(first);
const audits = (entityId: string) =>
  sql<{ action: string; changes: Record<string, unknown>; pii_refs: string[]; actor_admin_user_id: string | null }[]>`
    SELECT action, changes, pii_refs, actor_admin_user_id FROM audit_log WHERE entity_id = ${entityId} ORDER BY id`;

describe("fulfilment rows", () => {
  it("the Owner's confirmation creates one pending fulfilment per confirmed winner, nothing for the others", async () => {
    const { c } = await finalized(4);
    const winners = await winnersOf(c.programId);
    expect(winners.map((w) => [w.rank, w.status, w.fulfillment])).toEqual([
      [1, "confirmed", "pending"],
      [2, "confirmed", "pending"],
    ]);
  });
});

describe("the fulfilment machine (sql/fulfillment.sql)", () => {
  it("moves pending -> contacted -> sent -> done one step at a time, stamping the actor and the time; done is final", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    const { owner } = await admins();
    expect(await sqlState(step(id, "pending", "sent"))).toBe("ET172");
    const before = new Date();
    expect(await step(id, "pending", "contacted")).toMatchObject({ status: "contacted", changed: true });
    const contacted = await fulfillment(id);
    expect(contacted).toMatchObject({ status: "contacted", contacted_by_admin_user_id: owner, sent_at: null, done_at: null });
    expect(contacted.contacted_at?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    await step(id, "contacted", "sent");
    await step(id, "sent", "done");
    expect(await fulfillment(id)).toMatchObject({ status: "done", sent_by_admin_user_id: owner });
    expect((await fulfillment(id)).done_at).toBeInstanceOf(Date);
    // Done is final: no correction out of it, whatever the reason.
    expect(await sqlState(step(id, "done", "sent", "Salah klik, belum dikirim."))).toBe("ET172");
    expect((await audits(id)).map((a) => [a.action, a.changes["status"]])).toEqual([
      ["fulfillment.advance", { before: "pending", after: "contacted" }],
      ["fulfillment.advance", { before: "contacted", after: "sent" }],
      ["fulfillment.advance", { before: "sent", after: "done" }],
    ]);
  });

  it("a correction goes back exactly one step, only with a reason without contact details, clears the undone step and is audited", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    await step(id, "pending", "contacted");
    await step(id, "contacted", "sent");
    expect(await sqlState(step(id, "sent", "contacted"))).toBe("ET171");
    expect(await sqlState(step(id, "sent", "contacted", "kurang"))).toBe("ET171");
    expect(await sqlState(step(id, "sent", "contacted", "Telepon 081234567890 dulu"))).toBe("ET171");
    expect(await sqlState(step(id, "sent", "pending", "Dua langkah sekaligus tidak boleh."))).toBe("ET172");
    await step(id, "sent", "contacted", "Kurir belum mengambil paket.");
    expect(await fulfillment(id)).toMatchObject({ status: "contacted", sent_at: null, sent_by_admin_user_id: null });
    expect((await fulfillment(id)).contacted_at).toBeInstanceOf(Date);
    // The reason is kept on the row; the append-only audit records only that one was given (free text may name the winner).
    expect(first(await sql<{ correction_reason: string }[]>`SELECT correction_reason FROM fulfillments WHERE id = ${id}`).correction_reason).toBe("Kurir belum mengambil paket.");
    const last = (await audits(id)).at(-1);
    expect(last).toMatchObject({ action: "fulfillment.correct", changes: { status: { before: "sent", after: "contacted" } }, pii_refs: [`fulfillment:${id}.correction_reason set`] });
    expect(JSON.stringify(last)).not.toContain("Kurir");
  });

  it("refuses a stale status and changes nothing on a repeated step (two clicks, two Owners)", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    const [a, b] = await Promise.all([step(id, "pending", "contacted"), step(id, "pending", "contacted")]);
    expect([a["changed"], b["changed"]].sort()).toEqual([false, true]);
    expect((await audits(id)).filter((x) => x.action === "fulfillment.advance")).toHaveLength(1);
    await step(id, "contacted", "sent");
    expect(await sqlState(step(id, "pending", "contacted"))).toBe("ET172");
  });

  it("only an active Owner, only through the functions: Staff (ET171), other roles (42501), direct writes (42501, ET175)", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    const { staff } = await admins();
    expect(await sqlState(step(id, "pending", "contacted", null, staff))).toBe("ET171");
    for (const role of ["public_rw", "worker_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.fulfillment_step(${id}::uuid, 'pending', 'contacted', NULL, 'x', NULL, NULL)`)), role).toBe("42501");
    }
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE fulfillments SET status = 'done' WHERE id = ${id}`))).toBe("42501");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM fulfillments WHERE id = ${id}`))).toBe("42501");
    // Even the functions' owner cannot skip a step outside the function's checks (the guard holds for every writer).
    await rolledBack("prize_fulfillment", async (tx) => {
      expect(await sqlState(tx`UPDATE fulfillments SET status = 'sent', contacted_at = now(), contacted_by_admin_user_id = 'x', sent_at = now(), sent_by_admin_user_id = 'x' WHERE id = ${id}`)).toBe("ET175");
    });
    await rolledBack("pii_eraser", async (tx) => {
      expect(await sqlState(tx`UPDATE fulfillments SET status = 'contacted', contacted_at = now(), contacted_by_admin_user_id = 'x' WHERE winner_id = ${w?.id ?? ""}`)).toBe("42501");
    });
    expect(await fulfillment(id)).toMatchObject({ status: "pending" });
  });

  it("notes: plain text up to 2000 characters, the audit names only the change; editable while the winner is halted", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    const text = "Hubungi Budi Santoso di 081299998888 sore hari.";
    expect(await notes(id, `  ${text}  `)).toMatchObject({ changed: true });
    expect((await fulfillment(id)).notes).toBe(text);
    expect(await notes(id, text)).toMatchObject({ changed: false });
    expect(await sqlState(notes(id, "x".repeat(2001)))).toBe("ET171");
    expect(await sqlState(notes(id, "bel\u0007"))).toBe("ET171");
    const audit = (await audits(id)).filter((a) => a.action === "fulfillment.notes");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("Budi");
    expect(JSON.stringify(audit)).not.toContain("081299998888");
    expect(audit[0]?.pii_refs).toEqual([`fulfillment:${id}.notes set`]);
    await flag(w?.id ?? "");
    expect(await notes(id, "")).toMatchObject({ changed: true });
    expect((await fulfillment(id)).notes).toBeNull();
  });

  it("proof: an upload of kind proof only; replacing it deletes the old upload and returns its path for the file", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    const image = await proofUpload("image");
    expect(await sqlState(setProof(id, image.id))).toBe("ET171");
    const one = await proofUpload();
    expect(await setProof(id, one.id)).toMatchObject({ changed: true, replaced_storage_path: null });
    expect(await setProof(id, one.id)).toMatchObject({ changed: false });
    const two = await proofUpload();
    expect(await setProof(id, two.id)).toMatchObject({ changed: true, replaced_storage_path: one.path });
    expect(await sql`SELECT 1 FROM uploads WHERE id = ${one.id}`).toHaveLength(0);
    expect((await fulfillment(id)).proof_upload_id).toBe(two.id);
    expect((await audits(id)).filter((a) => a.action === "fulfillment.proof").map((a) => a.changes)).toEqual([
      expect.objectContaining({ upload_id: one.id, replaced_upload_id: null }),
      expect.objectContaining({ upload_id: two.id, replaced_upload_id: one.id }),
    ]);
  });

  it("a flagged winner (chargeback) is halted: no step and no proof (ET082), also for a direct write", async () => {
    const { c } = await finalized(2);
    const [w] = await winnersOf(c.programId);
    const id = w?.fulfillment_id ?? "";
    await flag(w?.id ?? "");
    expect(await sqlState(step(id, "pending", "contacted"))).toBe("ET082");
    expect(await sqlState(setProof(id, (await proofUpload()).id))).toBe("ET082");
    await rolledBack(null, async (tx) => {
      expect(await sqlState(tx`UPDATE fulfillments SET status = 'contacted', contacted_at = now(), contacted_by_admin_user_id = 'x' WHERE id = ${id}`)).toBe("ET082");
    });
  });
});

describe("revoke and re-award, reinstatement (sql/contest.sql)", () => {
  it("re-awards a revoked winner's tier to the next eligible rank: skips refunded, charged-back and erased players; confirmed, pending fulfilment, audited", async () => {
    const { c, players, gold } = await finalized(7);
    const [first1] = await winnersOf(c.programId);
    // rank 3 refunded, rank 4 charged back (still eligible through another order), rank 5 erased: rank 6 is next.
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${players[2]?.id ?? ""}`;
    const lp = first(await sql<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${c.programId}) RETURNING id`);
    const product = first(await sql<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${c.programId}`);
    const publicId = `${suffix()}${suffix()}${suffix()}`;
    const orderCode = `${suffix().toUpperCase()}AB`;
    const order = first(
      await sql<{ id: string }[]>`
        INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, player_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
        VALUES (${publicId}, ${orderCode}, ${lp.id}, ${c.programId}, ${product.product_id}, ${players[3]?.id ?? ""}, 'X', ${players[3]?.phone ?? ""}, 'x@example.test', ${bytes(32)}, 49000, 'refunded', now())
        RETURNING id`,
    );
    await sql`INSERT INTO payments (order_id, gateway_txn_id, transaction_status, gross_amount_idr) VALUES (${order.id}, ${`txn-${suffix()}`}, 'chargeback', 49000)`;
    await sql`UPDATE players SET anonymized_at = now(), phone = NULL, name = '', email = NULL WHERE id = ${players[4]?.id ?? ""}`;
    await flag(first1?.id ?? "");
    const summary = await revoke(first1?.id ?? "");
    expect(summary).toMatchObject({ revoked: true, reawarded_rank: 6, candidates_skipped: 3 });
    const winners = await winnersOf(c.programId);
    expect(winners.map((w) => [w.rank, w.status, w.fulfillment])).toEqual([
      [1, "revoked", "pending"],
      [2, "confirmed", "pending"],
      [6, "confirmed", "pending"],
    ]);
    const next = winners.find((w) => w.rank === 6);
    expect(next).toMatchObject({ player_id: players[5]?.id, prize_tier_id: gold, replaces_winner_id: first1?.id });
    const [audit] = await audits(first1?.id ?? "");
    expect(audit?.action).toBe("contest.winner_revoke");
    expect(audit?.changes).toMatchObject({ reawarded_winner_id: next?.id });
    expect(audit?.pii_refs).toEqual([`winner:${first1?.id ?? ""}.decision_reason set`]);
    expect(JSON.stringify(audit)).not.toContain("Chargeback dari bank");
    expect(first(await sql<{ decision_reason: string }[]>`SELECT decision_reason FROM winners WHERE id = ${first1?.id ?? ""}`).decision_reason).toBe("Chargeback dari bank pembeli.");
    expect(JSON.stringify(audit)).not.toContain(players[5]?.id ?? "-");
    // The revoked winner's fulfilment is halted; the new one moves.
    expect(await sqlState(step(winners[0]?.fulfillment_id ?? "", "pending", "contacted"))).toBe("ET082");
    expect(await step(next?.fulfillment_id ?? "", "pending", "contacted")).toMatchObject({ changed: true });
  });

  it("is idempotent and race-safe: two concurrent revokes of one winner make exactly one re-award", async () => {
    const { c } = await finalized(5);
    const [w] = await winnersOf(c.programId);
    await flag(w?.id ?? "");
    const results = await Promise.all([revoke(w?.id ?? ""), revoke(w?.id ?? ""), revoke(w?.id ?? "")]);
    expect(results.filter((r) => r["revoked"] === true)).toHaveLength(1);
    expect(new Set(results.map((r) => r["reawarded_winner_id"])).size).toBe(1);
    const winners = await winnersOf(c.programId);
    expect(winners.filter((x) => x.replaces_winner_id === w?.id)).toHaveLength(1);
    expect(winners.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect((await audits(w?.id ?? "")).filter((a) => a.action === "contest.winner_revoke")).toHaveLength(1);
  });

  it("concurrent revokes of two winners each take a different next player (the contest lock serialises them)", async () => {
    const { c } = await finalized(5);
    const [a, b] = await winnersOf(c.programId);
    await Promise.all([revoke(a?.id ?? ""), revoke(b?.id ?? "")]);
    const live = (await winnersOf(c.programId)).filter((w) => w.status === "confirmed").map((w) => w.rank).sort();
    expect(live).toEqual([3, 4]);
  });

  it("reinstates a flagged winner who is still paid (eligibility re-checked under the lock), refuses one who is not (ET174); idempotent", async () => {
    const { c, players } = await finalized(3);
    const [w1, w2] = await winnersOf(c.programId);
    await flag(w1?.id ?? "");
    await flag(w2?.id ?? "");
    expect(await reinstate(w1?.id ?? "")).toMatchObject({ reinstated: true });
    expect(await reinstate(w1?.id ?? "")).toMatchObject({ reinstated: false });
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${players[1]?.id ?? ""}`;
    expect(await sqlState(reinstate(w2?.id ?? ""))).toBe("ET174");
    expect(await sqlState(reinstate(w1?.id ?? "", "pendek"))).toBe("ET171");
    const winners = await winnersOf(c.programId);
    expect(winners.map((w) => w.status)).toEqual(["confirmed", "flagged"]);
    expect(await step(winners[0]?.fulfillment_id ?? "", "pending", "contacted")).toMatchObject({ changed: true });
    // A revoked winner is never reinstated.
    await revoke(w2?.id ?? "");
    expect(await sqlState(reinstate(w2?.id ?? ""))).toBe("ET173");
  });

  it("before the confirmation a reinstated winner goes back to awaiting it, unconfirmed, and the Owner's confirmation then confirms it", async () => {
    const c = await contest();
    await tier(c.programId, 1, 2);
    for (let i = 0; i < 3; i++) await rankedPlayer(c, (i + 1) * 1000);
    await snapshot(c.programId);
    const [w1] = await winnersOf(c.programId);
    await flag(w1?.id ?? "");
    expect(await sqlState(confirm(c.programId))).toBe("ET107");
    expect(await reinstate(w1?.id ?? "")).toMatchObject({ reinstated: true });
    expect(first(await sql<{ status: string; confirmed_at: Date | null }[]>`SELECT status::text AS status, confirmed_at FROM winners WHERE id = ${w1?.id ?? ""}`)).toEqual({
      status: "awaiting_confirmation",
      confirmed_at: null,
    });
    expect(await reinstate(w1?.id ?? "")).toMatchObject({ reinstated: false });
    expect(await confirm(c.programId)).toMatchObject({ winners_confirmed: 2 });
    expect((await winnersOf(c.programId)).map((w) => [w.rank, w.status, w.fulfillment])).toEqual([
      [1, "confirmed", "pending"],
      [2, "confirmed", "pending"],
    ]);
    // The winners guard admits flagged -> awaiting_confirmation only for a winner never confirmed, inside contest_results' functions.
    const [, w2] = await winnersOf(c.programId);
    await flag(w2?.id ?? "");
    await rolledBack("contest_results", async (tx) => {
      expect(await sqlState(tx`UPDATE winners SET status = 'awaiting_confirmation', confirmed_at = NULL WHERE id = ${w2?.id ?? ""}`)).toBe("ET105");
    });
  });

  it("reinstatement is race-safe: two at once make one change; against a revoke, the winner ends revoked with exactly one re-award", async () => {
    const { c } = await finalized(4);
    const [w1, w2] = await winnersOf(c.programId);
    await flag(w1?.id ?? "");
    const twice = await Promise.all([reinstate(w1?.id ?? ""), reinstate(w1?.id ?? "")]);
    expect(twice.map((r) => r["reinstated"]).sort()).toEqual([false, true]);
    expect((await audits(w1?.id ?? "")).filter((a) => a.action === "contest.winner_reinstate")).toHaveLength(1);

    await flag(w2?.id ?? "");
    const [back, gone] = await Promise.allSettled([reinstate(w2?.id ?? ""), revoke(w2?.id ?? "")]);
    expect(gone.status).toBe("fulfilled");
    // Reinstated first (then revoked as a confirmed winner), or revoked first (then the reinstatement is refused, ET173).
    if (back.status === "rejected") expect((back.reason as { code?: string }).code).toBe("ET173");
    const winners = await winnersOf(c.programId);
    expect(winners.find((x) => x.id === w2?.id)?.status).toBe("revoked");
    expect(winners.filter((x) => x.replaces_winner_id === w2?.id)).toHaveLength(1);
  });

  it("before confirmation: the replacement awaits confirmation, the revoked one no longer blocks it, an erased winner does (ET107)", async () => {
    const c = await contest();
    await tier(c.programId, 1, 2);
    const ps = [];
    for (let i = 0; i < 4; i++) ps.push(await rankedPlayer(c, (i + 1) * 1000));
    await snapshot(c.programId);
    const [w1, w2] = await winnersOf(c.programId);
    await sql`UPDATE players SET anonymized_at = now(), phone = NULL, name = '', email = NULL WHERE id = ${ps[1]?.id ?? ""}`;
    expect(await sqlState(confirm(c.programId))).toBe("ET107");
    await flag(w1?.id ?? "");
    await revoke(w1?.id ?? "");
    await revoke(w2?.id ?? "", "Pemenang meminta datanya dihapus.");
    const pending = await winnersOf(c.programId);
    expect(pending.map((w) => [w.rank, w.status, w.fulfillment])).toEqual([
      [1, "revoked", null],
      [2, "revoked", null],
      [3, "awaiting_confirmation", null],
      [4, "awaiting_confirmation", null],
    ]);
    expect(await confirm(c.programId)).toMatchObject({ winners_confirmed: 2 });
    expect((await winnersOf(c.programId)).map((w) => [w.rank, w.status, w.fulfillment])).toEqual([
      [1, "revoked", null],
      [2, "revoked", null],
      [3, "confirmed", "pending"],
      [4, "confirmed", "pending"],
    ]);
  });

  it("with no eligible player left nothing is re-awarded; a delivered prize is never revoked (ET173); Staff and other roles are refused", async () => {
    const { c } = await finalized(2);
    const [w1, w2] = await winnersOf(c.programId);
    expect(await revoke(w2?.id ?? "")).toMatchObject({ revoked: true, reawarded_winner_id: null });
    const id = w1?.fulfillment_id ?? "";
    await step(id, "pending", "contacted");
    await step(id, "contacted", "sent");
    await step(id, "sent", "done");
    expect(await sqlState(revoke(w1?.id ?? ""))).toBe("ET173");
    const { staff } = await admins();
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT public.revoke_winner(${w1?.id ?? ""}::uuid, 'Alasan yang cukup panjang.', ${staff}, NULL, NULL)`))).toBe("ET171");
    for (const role of ["public_rw", "worker_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.revoke_winner(${w1?.id ?? ""}::uuid, 'Alasan yang cukup panjang.', 'x', NULL, NULL)`)), role).toBe("42501");
    }
    // The re-award link is frozen with the winner.
    await rolledBack(null, async (tx) => {
      expect(await sqlState(tx`UPDATE winners SET replaces_winner_id = ${w2?.id ?? ""} WHERE id = ${w1?.id ?? ""}`)).toBe("ET105");
    });
  });
});
