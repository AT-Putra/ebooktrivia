// US-030 admin side, as the admin_rw login with ADMIN_DATA_DIR in a temporary directory:
//   - prize fulfilment (lib/settings/fulfillment.ts): nothing before the Owner confirmed the winners; the steps, a stale step, a
//     correction's reason, done final, the halt and the Staff refusal as form messages; the revoke and re-award;
//   - the proof (lib/next/proof-routes.ts): stored privately under proofs/ by the upload policy (an image re-encoded to WebP, a PDF
//     as it is, anything else refused); a replace deletes the old file; the download is an audited ATTACHMENT (nosniff, sandbox CSP);
//     a missing file answers 404; the upload sweeper removes a proof file left without a row;
//   - deletion requests (lib/settings/privacy.ts): one subject per lookup (phone, e-mail, order id; an ambiguous e-mail and an
//     unknown one refused; one pending request per person), the review with the consents, the execution with the typed reference
//     (the proof FILE is removed after the commit, an undelivered prize refused), the rejection; the audit holds no phone.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadProof, uploadProof } from "../src/lib/next/proof-routes.ts";
import type { RouteContext } from "../src/lib/next/route.ts";
import { confirmWinners } from "../src/lib/settings/contest.ts";
import type { SettingsConfig } from "../src/lib/settings/env.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { getFulfillmentPage, HALTED, moveFulfillment, parseCorrectionReason, revokeWinner, saveNotes, STALE } from "../src/lib/settings/fulfillment.ts";
import {
  ALREADY_PENDING,
  BLOCK_PRIZE,
  createDeletionRequest,
  executeDeletionRequest,
  getDeletionReview,
  NO_SUBJECT,
  parseDeletionRequest,
  rejectDeletionRequest,
  SEVERAL_SUBJECTS,
} from "../src/lib/settings/privacy.ts";
import { sweepUploads } from "../src/lib/settings/uploads.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

type Id = { id: string };
const DAY = 86_400_000;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

let dataDir = "";
let settings: SettingsConfig;
let rt: ReturnType<typeof newRuntime>;
let ownerId = "";
let staffId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-proof-"));
  settings = { domain: "example.test", dataDir, lpDir: null, pdfMaxBytes: 1024 * 1024, uploadMaxOpenSessions: 3, uploadMaxStagedBytes: 64 * 1024 * 1024, sealer: null };
  rt = newRuntime(undefined, settings);
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  staffId = (await createTestAdmin(rt, "staff")).userId;
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof InvalidInput) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
};
const owner = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);
const phone = (): string => `+62818${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

/** A program whose grace ended, `n` ranked players (rank i+1 answered after (i+1) s), tier 1-2, the snapshot written. */
async function contest(n: number) {
  const graceEnd = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * 60_000);
  const salesEnd = new Date(graceEnd.getTime() - 2 * DAY);
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const { id: programId } = await one(root<Id[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`ful-${suffix()}`}, 'Hadiah', 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, 2) RETURNING id`);
  const { id: setId } = await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'Set') RETURNING id`);
  const { id: questionId } = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${setId}, 1, 'Q', 10, 20) RETURNING id`);
  const right = await one(root<Id[]>`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${questionId}, 1, 'A', true) RETURNING id`);
  await root`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, 1, 2, 'Hadiah', 250000)`;
  const lp = await one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${programId}) RETURNING id`);
  const [terms, privacy] = await root<Id[]>`
    INSERT INTO legal_pages (program_id, kind, version, title, body) VALUES (${programId}, 'terms', 1, 'S&K', 'Isi'), (${programId}, 'privacy', 1, 'Privasi', 'Isi') RETURNING id`;
  await root`UPDATE legal_pages SET published_at = now() WHERE program_id = ${programId}`;
  const players: { id: string; phone: string; email: string; publicId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const p = { phone: phone(), email: `win${suffix()}@example.test` };
    const { id } = await one(root<Id[]>`INSERT INTO players (phone, name, email) VALUES (${p.phone}, ${`Pemenang ${String(i + 1)}`}, ${p.email}) RETURNING id`);
    await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${programId}, ${new Date(graceEnd.getTime() - 20 * DAY)}, true)`;
    const publicId = `${suffix()}${suffix()}${suffix()}`;
    const order = await one(root<Id[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, player_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, paid_at, ip)
      VALUES (${publicId}, ${`${suffix()}${suffix()}`.toUpperCase()}, ${lp.id}, ${programId}, ${product.id}, ${id}, ${`Pemenang ${String(i + 1)}`}, ${p.phone}, ${p.email},
              sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, 'paid', now() + interval '1 hour', now(), '2001:db8::5') RETURNING id`);
    await root`INSERT INTO consents (order_id, legal_page_id, ip, ua_hash) VALUES (${order.id}, ${terms?.id ?? ""}, '2001:db8::5', sha256('ua')), (${order.id}, ${privacy?.id ?? ""}, '2001:db8::5', sha256('ua'))`;
    const { id: attemptId } = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${id}, ${setId}) RETURNING id`);
    const served = new Date(graceEnd.getTime() - DAY);
    await root`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id)
      VALUES (${attemptId}, ${questionId}, 1, ${[right.id]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)}, ${new Date(served.getTime() + (i + 1) * 1000)}, ${right.id})`;
    players.push({ id, ...p, publicId });
  }
  await root.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE worker_rw");
    await tx`SELECT public.create_leaderboard_snapshot(${programId}::uuid)`;
  });
  return { programId, players };
}

async function finalized(n = 3) {
  const c = await contest(n);
  await owner(() => confirmWinners(rt.sql, c.programId));
  const page = await getFulfillmentPage(rt.sql, c.programId);
  if (page === null) throw new Error("not finalized");
  return { ...c, page };
}

const ctx = (): RouteContext => ({ rt, req: { headers: new Headers(), ip: null }, admin: { userId: ownerId, role: "owner", displayName: "Owner" } }) as unknown as RouteContext;
const post = (path: string, body: Uint8Array | null, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers, ...(body === null ? {} : { body: new Blob([new Uint8Array(body)]).stream(), duplex: "half" }) });
const uploadAs = (fulfillmentId: string, bytes: Buffer, name: string, type: string) =>
  owner(() => uploadProof(ctx(), post(`/uploads/proof?fulfillment=${fulfillmentId}`, bytes, { "content-type": type, "x-file-name": encodeURIComponent(name) })));
const proofOf = (fulfillmentId: string) =>
  root<{ storage_path: string; content_type: string; original_filename: string | null }[]>`
    SELECT u.storage_path, u.content_type, u.original_filename FROM fulfillments f JOIN uploads u ON u.id = f.proof_upload_id WHERE f.id = ${fulfillmentId}`.then((r) => r[0]);

describe("prize fulfilment (lib/settings/fulfillment.ts)", () => {
  it("shows nothing before the confirmation; then the winners by rank with their prize, contact and a pending fulfilment", async () => {
    const c = await contest(3);
    expect(await getFulfillmentPage(rt.sql, c.programId)).toBeNull();
    await owner(() => confirmWinners(rt.sql, c.programId));
    const page = await getFulfillmentPage(rt.sql, c.programId);
    expect(page?.winners.map((w) => [w.rank, w.prizeName, w.prizeValueIdr, w.status, w.name, w.phone, w.fulfillment?.status])).toEqual([
      [1, "Hadiah", 250000, "confirmed", "Pemenang 1", c.players[0]?.phone, "pending"],
      [2, "Hadiah", 250000, "confirmed", "Pemenang 2", c.players[1]?.phone, "pending"],
    ]);
  });

  it("moves step by step with the Owner as the actor; stale, unreasoned and final moves and Staff are refused with form messages", async () => {
    const { page } = await finalized();
    const f = page.winners[0]?.fulfillment?.id ?? "";
    expect(await owner(() => moveFulfillment(rt.sql, f, "pending", "advance", null))).toEqual({ to: "contacted", changed: true });
    expect(await refusal(owner(() => moveFulfillment(rt.sql, f, "pending", "advance", null).then(() => moveFulfillment(rt.sql, f, "sent", "advance", null))))).toBe(STALE);
    const form = new FormData();
    form.set("reason", "Telp 081234567890");
    expect(() => parseCorrectionReason(form)).toThrow(InvalidInput);
    expect(await owner(() => moveFulfillment(rt.sql, f, "contacted", "correct", "Belum dihubungi, salah klik."))).toEqual({ to: "pending", changed: true });
    expect(await refusal(asAdmin(staffId, () => moveFulfillment(rt.sql, f, "pending", "advance", null)))).toMatch(/Only an active Owner/);
    for (const from of ["pending", "contacted", "sent"] as const) await owner(() => moveFulfillment(rt.sql, f, from, "advance", null));
    expect(await refusal(owner(() => moveFulfillment(rt.sql, f, "done", "correct", "Salah klik, belum terkirim.")))).toMatch(/Done is final/);
    const audit = await root<{ action: string; actor_admin_user_id: string; request_id: string | null }[]>`SELECT action, actor_admin_user_id, request_id FROM audit_log WHERE entity_id = ${f} ORDER BY id`;
    expect(audit.map((a) => a.action)).toEqual(["fulfillment.advance", "fulfillment.correct", "fulfillment.advance", "fulfillment.advance", "fulfillment.advance"]);
    expect(audit.every((a) => a.actor_admin_user_id === ownerId && a.request_id !== null)).toBe(true);
  });

  it("a chargeback halts the fulfilment (the HALTED message), notes stay editable, and the Owner re-awards to the next rank", async () => {
    const { programId, page, players } = await finalized(3);
    const w = page.winners[0];
    await root.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE worker_rw");
      await tx`UPDATE winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE id = ${w?.winnerId ?? ""}`;
    });
    expect(await refusal(owner(() => moveFulfillment(rt.sql, w?.fulfillment?.id ?? "", "pending", "advance", null)))).toBe(HALTED);
    expect(await owner(() => saveNotes(rt.sql, w?.fulfillment?.id ?? "", "Menunggu keputusan bank."))).toBe(true);
    expect(await owner(() => revokeWinner(rt.sql, w?.winnerId ?? "", "Chargeback dikonfirmasi bank."))).toEqual({ revoked: true, reawardedRank: 3 });
    const after = await getFulfillmentPage(rt.sql, programId);
    expect(after?.winners.map((x) => [x.rank, x.status, x.replacesRank, x.phone])).toEqual([
      [1, "revoked", null, players[0]?.phone],
      [2, "confirmed", null, players[1]?.phone],
      [3, "confirmed", 1, players[2]?.phone],
    ]);
  });
});

describe("the proof (lib/next/proof-routes.ts)", () => {
  it("stores an image re-encoded to WebP under proofs/ (no original name kept); a replace deletes the old file; other files are refused", async () => {
    const { page } = await finalized();
    const f = page.winners[0]?.fulfillment?.id ?? "";
    expect((await uploadAs(f, Buffer.from("<html>"), "bukti.html", "text/html")).status).toBe(400);
    expect((await uploadAs(f, PNG, "bukti Budi.jpg", "image/jpeg")).status).toBe(400);
    expect((await uploadAs(f, PNG, "bukti Budi.png", "image/png")).status).toBe(200);
    const first = await proofOf(f);
    expect(first).toMatchObject({ content_type: "image/webp", original_filename: null });
    expect(first?.storage_path).toMatch(/^proofs\/[0-9a-f-]{36}\.webp$/);
    const bytes = await readFile(join(dataDir, first?.storage_path ?? ""));
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect((await uploadAs(f, PDF, "resi.pdf", "application/pdf")).status).toBe(200);
    const second = await proofOf(f);
    expect(second).toMatchObject({ content_type: "application/pdf" });
    expect(await readdir(join(dataDir, "proofs"))).not.toContain(first?.storage_path.slice("proofs/".length));
    expect(await root`SELECT 1 FROM uploads WHERE storage_path = ${first?.storage_path ?? ""}`).toHaveLength(0);
  });

  it("downloads only as an audited attachment with nosniff and a sandbox CSP; a missing file answers 404", async () => {
    const { page } = await finalized();
    const f = page.winners[0]?.fulfillment?.id ?? "";
    expect((await owner(() => downloadProof(ctx(), post(`/fulfillment/proof?fulfillment=${f}`, null)))).status).toBe(404);
    await uploadAs(f, PDF, "resi.pdf", "application/pdf");
    const res = await owner(() => downloadProof(ctx(), post(`/fulfillment/proof?fulfillment=${f}`, null)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="proof-1-[0-9a-f]{8}\.pdf"$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    expect(await root`SELECT 1 FROM audit_log WHERE action = 'fulfillment.proof_download' AND entity_id = ${f}`).toHaveLength(1);
    await rm(join(dataDir, (await proofOf(f))?.storage_path ?? ""));
    expect((await owner(() => downloadProof(ctx(), post(`/fulfillment/proof?fulfillment=${f}`, null)))).status).toBe(404);
  });

  it("the upload sweeper removes a proof file left without an uploads row, once it is old enough", async () => {
    await mkdir(join(dataDir, "proofs"), { recursive: true });
    const orphan = `${randomUUID()}.webp`;
    const young = `${randomUUID()}.webp`;
    await writeFile(join(dataDir, "proofs", orphan), "x");
    await writeFile(join(dataDir, "proofs", young), "x");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(dataDir, "proofs", orphan), old, old);
    const result = await sweepUploads(rt.sql, settings);
    expect(result.orphanProofs).toBeGreaterThanOrEqual(1);
    const left = await readdir(join(dataDir, "proofs"));
    expect(left).not.toContain(orphan);
    expect(left).toContain(young);
  });
});

describe("deletion requests (lib/settings/privacy.ts)", () => {
  const form = (kind: string, value: string, reason = "Diminta lewat email pada 20 November.") => {
    const f = new FormData();
    f.set("kind", kind);
    f.set("value", value);
    f.set("reason", reason);
    return parseDeletionRequest(f);
  };

  it("resolves one subject by phone (any national form), e-mail or order id; unknown and ambiguous lookups and a second pending request are refused", async () => {
    const { players } = await contest(1);
    const p = players[0];
    expect(await refusal(owner(() => createDeletionRequest(rt.sql, form("phone", "0812 0000 0000"))))).toBe(NO_SUBJECT);
    const local = `0${p?.phone.slice(3) ?? ""}`;
    const id = await owner(() => createDeletionRequest(rt.sql, form("phone", local)));
    expect(await refusal(owner(() => createDeletionRequest(rt.sql, form("order", p?.publicId ?? ""))))).toBe(ALREADY_PENDING);
    expect(await refusal(owner(() => createDeletionRequest(rt.sql, form("email", (p?.email ?? "").toUpperCase()))))).toBe(ALREADY_PENDING);
    const audit = await one(root<{ changes: Record<string, unknown>; pii_refs: string[] }[]>`SELECT changes, pii_refs FROM audit_log WHERE entity_id = ${id} AND action = 'privacy.deletion_request'`);
    expect(JSON.stringify(audit)).not.toContain(p?.phone.slice(3) ?? "-");
    // The phone and the request's text are referenced only (free text may name the person).
    expect(audit.pii_refs.sort()).toEqual([`deletion_request:${id}.note set`, `deletion_request:${id}.subject_phone set`]);
    expect(JSON.stringify(audit)).not.toContain("Diminta lewat email");
    // One e-mail, two phones: ask for the number.
    const shared = `shared${suffix()}@example.test`;
    await root`UPDATE players SET email = ${shared} WHERE id = ${p?.id ?? ""}`;
    await root`INSERT INTO players (phone, name, email) VALUES (${phone()}, 'Saudara', ${shared})`;
    expect(await refusal(owner(() => createDeletionRequest(rt.sql, form("email", shared))))).toBe(SEVERAL_SUBJECTS);
    expect(() => form("phone", "12345")).toThrow(InvalidInput);
    expect(() => form("phone", local, "Telp 081234567890 minta hapus")).toThrow(InvalidInput);
  });

  it("reviews the subject with the consents, refuses an undelivered prize, executes with the typed reference and removes the proof file", async () => {
    const { programId, page, players } = await finalized(3);
    const w = page.winners[0];
    const f = w?.fulfillment?.id ?? "";
    await uploadAs(f, PNG, "bukti.png", "image/png");
    const proof = await proofOf(f);
    const id = await owner(() => createDeletionRequest(rt.sql, form("phone", players[0]?.phone ?? "")));
    const review = await getDeletionReview(rt.sql, id);
    expect(review?.subject).toMatchObject({ name: "Pemenang 1", phone: players[0]?.phone });
    expect(review?.subject?.orders[0]?.consents.map((c) => [c.kind, c.version, c.ip, c.uaRecorded])).toEqual([
      ["privacy", 1, "2001:db8::5", true],
      ["terms", 1, "2001:db8::5", true],
    ]);
    expect(review?.subject?.blockers).toEqual([BLOCK_PRIZE]);
    expect(await refusal(owner(() => executeDeletionRequest(rt.sql, settings, id, id.slice(0, 8))))).toBe(BLOCK_PRIZE);
    for (const from of ["pending", "contacted", "sent"] as const) await owner(() => moveFulfillment(rt.sql, f, from, "advance", null));
    expect(await refusal(owner(() => executeDeletionRequest(rt.sql, settings, id, "nope")))).toMatch(/Type the request's reference/);
    expect(await owner(() => executeDeletionRequest(rt.sql, settings, id, id.slice(0, 8)))).toEqual({ erased: true, orders: 1 });
    expect(await readdir(join(dataDir, "proofs"))).not.toContain(proof?.storage_path.slice("proofs/".length));
    expect(await owner(() => executeDeletionRequest(rt.sql, settings, id, id.slice(0, 8)))).toEqual({ erased: false, orders: 1 });
    const done = await getDeletionReview(rt.sql, id);
    expect(done).toMatchObject({ status: "completed", subject: null });
    expect((await getFulfillmentPage(rt.sql, programId))?.winners[0]).toMatchObject({ erased: true, phone: null, fulfillment: { status: "done", notes: null, proof: null } });
  });

  it("rejects with a reason and drops the phone; a decided request is not decided again", async () => {
    const { players } = await contest(1);
    const id = await owner(() => createDeletionRequest(rt.sql, form("phone", players[0]?.phone ?? "")));
    await owner(() => rejectDeletionRequest(rt.sql, id, "Pemohon tidak bisa membuktikan nomornya."));
    expect(await one(root`SELECT status, subject_phone, decision_note FROM deletion_requests WHERE id = ${id}`)).toEqual({
      status: "rejected",
      subject_phone: null,
      decision_note: "Pemohon tidak bisa membuktikan nomornya.",
    });
    const rejection = await one(root<{ changes: Record<string, unknown>; pii_refs: string[] }[]>`SELECT changes, pii_refs FROM audit_log WHERE entity_id = ${id} AND action = 'privacy.deletion_reject'`);
    expect(JSON.stringify(rejection)).not.toContain("membuktikan");
    expect(rejection.pii_refs).toContain(`deletion_request:${id}.decision_note set`);
    expect(await refusal(owner(() => rejectDeletionRequest(rt.sql, id, "Kedua kalinya ditolak.")))).toMatch(/already decided/);
    expect(await refusal(owner(() => executeDeletionRequest(rt.sql, settings, id, id.slice(0, 8))))).toMatch(/rejected/);
  });
});
