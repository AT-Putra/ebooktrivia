// US-017 (M5a-2) settings against a real database, as the admin_rw login the app uses:
//   - secrets are write-only: sealed with public keys only, the admin login cannot read any sealed
//     column, the admin process has no opener, only the private key (worker side) decrypts, and the
//     audit log records {set} only;
//   - program field lock + extend-only reschedule (server-side), clone;
//   - LP domain registration with the registrable-domain check;
//   - chunked PDF upload: warning confirmation, hard cap, chunk hashes, whole-file hash, offsets,
//     the claim against chunk writes, one completion per session, quota and sweeper;
//   - template test-send writes a worker job (outbox row), only to the requester's login e-mail or
//     the Owner's WhatsApp test numbers, capped per admin (hour, day) and in total;
//   - the app pool returns real Dates (Better Auth's drizzle has its own pool).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretOpener, createSecretSealer, CryptoError, generateScopeKeyPair, openerFromEnv } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";
import { createAdnet, parseAdnet, setAdnetSecret } from "../src/lib/settings/adnets.ts";
import { loadSettingsConfig, PDF_WARN_BYTES, type SettingsConfig } from "../src/lib/settings/env.ts";
import { pdfChunk } from "../src/lib/next/pdf-upload-routes.ts";
import type { RouteContext } from "../src/lib/next/route.ts";
import { auditedChange, CONCURRENT_SAVE } from "../src/lib/settings/audited.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { createLandingPage, registerDomain } from "../src/lib/settings/landing-pages.ts";
import { serverKeyStatuses, setEnvironment, setServerKey } from "../src/lib/settings/midtrans.ts";
import { createProduct, updateProductCommerce } from "../src/lib/settings/products.ts";
import { cloneProgram, createProgram, rescheduleProgram, salesWindow, setProgramStatus, updateProgram, type ProgramFields } from "../src/lib/settings/programs.ts";
import { getSmtp, parseSmtp, saveSmtp, setSmtpPassword } from "../src/lib/settings/smtp.ts";
import { addTestRecipient, listTemplates, listTestRecipients, parseTemplate, removeTestRecipient, requestTestSend, TEST_RECIPIENT_MAX, TEST_SEND_CAPS } from "../src/lib/settings/templates.ts";
import { CHUNK_BYTES, completeUpload, initPdfUpload, parseInit, sweepUploads, writeChunk } from "../src/lib/settings/uploads.ts";
import { createWahaServer, createWahaSession, parseWahaServer, parseWahaSession, setWahaApiKey, updateWahaServer } from "../src/lib/settings/waha.ts";

const pairs = { payment: generateScopeKeyPair(), messaging: generateScopeKeyPair(), conversions: generateScopeKeyPair() };
const sealer = createSecretSealer({ payment: pairs.payment.publicKey, messaging: pairs.messaging.publicKey, conversions: pairs.conversions.publicKey });
/** The worker side (private keys): only here to prove what the admin wrote opens correctly. */
const workerOpener = createSecretOpener({ payment: pairs.payment.privateKey, messaging: pairs.messaging.privateKey, conversions: pairs.conversions.privateKey });

let dataDir = "";
let settings: SettingsConfig;
let rt: ReturnType<typeof newRuntime>;
let ownerId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-admin-data-"));
  // Generous quotas here; the quota test uses its own strict settings.
  settings = { domain: "example.test", dataDir, pdfMaxBytes: 30 * 1024 * 1024, uploadMaxOpenSessions: 20, uploadMaxStagedBytes: 1024 * 1024 * 1024, sealer };
  rt = newRuntime(undefined, settings);
  ownerId = (await createTestAdmin(rt, "owner")).userId;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);

async function sealedRow(name: string) {
  const [row] = await root<{ id: string; scope: string; name: string; adnetId: string | null; boundHost: string | null; keyId: string; ciphertext: Uint8Array; nonce: Uint8Array; sealedDek: Uint8Array; last4: string }[]>`
    SELECT id, scope, name, adnet_id AS "adnetId", bound_host AS "boundHost", key_id AS "keyId", ciphertext, nonce, sealed_dek AS "sealedDek", last4
      FROM settings_secrets WHERE name = ${name}`;
  if (row === undefined) throw new Error(`no secret ${name}`);
  return row;
}

describe("write-only secrets (AC-A1/A2, plan M2.3)", () => {
  it("the admin process holds no opener: its env refuses private keys and an opener cannot be built from it", () => {
    const adminEnv = { SECRETS_PAYMENT_PUBLIC_KEY: Buffer.from(pairs.payment.publicKey).toString("base64url") };
    expect(() => openerFromEnv(adminEnv)).toThrow(CryptoError);
    expect(() => loadSettingsConfig({ ...adminEnv, SECRETS_PAYMENT_PRIVATE_KEY: Buffer.from(pairs.payment.privateKey).toString("base64url") })).toThrow(/must not hold a private key/);
    const loaded = loadSettingsConfig(adminEnv);
    expect(Object.keys(loaded.sealer ?? {}).sort()).toEqual(["keyId", "scopes", "sealOtp", "sealSecret"]);
  });

  it("a Midtrans key is sealed to the payment key: the admin login cannot read it back, the private key opens it", async () => {
    const key = `SB-Mid-server-${suffix()}${suffix()}${suffix()}`;
    await as(() => setServerKey(rt.sql, settings, "sandbox", key));
    const name = SECRET_NAMES.midtransServerKey("sandbox");
    const row = await sealedRow(name);
    expect(row).toMatchObject({ scope: "payment", boundHost: null, last4: key.slice(-4) });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(key);
    expect(workerOpener.openSecret(row)).toBe(key);
    // A decrypt attempt with anything but the private key fails (wrong scope key, admin has none).
    expect(() => createSecretOpener({ payment: pairs.messaging.privateKey }).openSecret(row)).toThrow(CryptoError);
    for (const column of ["ciphertext", "nonce", "sealed_dek"]) {
      await expect(rt.sql.unsafe(`SELECT ${column} FROM public.settings_secrets WHERE name = $1`, [name])).rejects.toMatchObject({ code: "42501" });
    }
    // The console shows set + last4 only.
    expect((await serverKeyStatuses(rt.sql)).sandbox).toMatchObject({ set: true, last4: key.slice(-4) });
    // Audit: {set} only, no value and no last4.
    const [audit] = await root<{ text: string; changes: Record<string, unknown> }[]>`
      SELECT row_to_json(a)::text AS text, changes FROM audit_log a WHERE action = 'settings_secret.set' AND entity_id = ${row.id} ORDER BY id DESC LIMIT 1`;
    expect(audit?.changes["value"]).toEqual({ set: true });
    expect(audit?.text).not.toContain(key);
    expect(audit?.text).not.toContain(`"${key.slice(-4)}"`);
  });

  it("replacing a secret keeps its row id (part of the AAD) and records {set: true} again", async () => {
    const first = `SB-Mid-server-${suffix()}${suffix()}${suffix()}`;
    const second = `SB-Mid-server-${suffix()}${suffix()}${suffix()}`;
    await as(() => setServerKey(rt.sql, settings, "sandbox", first));
    const before = await sealedRow(SECRET_NAMES.midtransServerKey("sandbox"));
    await as(() => setServerKey(rt.sql, settings, "sandbox", second));
    const after = await sealedRow(SECRET_NAMES.midtransServerKey("sandbox"));
    expect(after.id).toBe(before.id);
    expect(workerOpener.openSecret(after)).toBe(second);
  });

  it("production needs its own key, and a sandbox key is refused there", async () => {
    await expect(as(() => setEnvironment(rt.sql, ownerId, "production"))).rejects.toThrow(/production server key/);
    await expect(as(() => setServerKey(rt.sql, settings, "production", "SB-Mid-server-abcdefgh1234"))).rejects.toThrow(InvalidInput);
    await as(() => setServerKey(rt.sql, settings, "production", `Mid-server-${suffix()}${suffix()}`));
    await as(() => setEnvironment(rt.sql, ownerId, "production"));
    const [env] = await root<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'midtrans.environment'`;
    expect(env?.value).toBe("production");
    const [audit] = await root<{ changes: unknown }[]>`SELECT changes FROM audit_log WHERE action = 'app_setting.update' AND entity_id = 'midtrans.environment' ORDER BY id DESC LIMIT 1`;
    expect(audit?.changes).toEqual({ value: { before: "sandbox", after: "production" } });
    await as(() => setEnvironment(rt.sql, ownerId, "sandbox"));
  });

  it("the SMTP password is bound to the SMTP host and removed when the host changes", async () => {
    const values = { host: "smtp.example.test", port: "587", security: "starttls", username: "mailer", fromAddress: "noreply@example.test", fromName: "Toko" };
    await as(() => saveSmtp(rt.sql, parseSmtp(values, false)));
    const password = `smtp-${suffix()}-${suffix()}`;
    await as(() => setSmtpPassword(rt.sql, settings, password));
    const row = await sealedRow(SECRET_NAMES.smtpPassword);
    expect(row).toMatchObject({ scope: "messaging", boundHost: "smtp.example.test" });
    expect(workerOpener.openSecret(row)).toBe(password);
    expect((await getSmtp(rt.sql)).password.set).toBe(true);
    const moved = await as(() => saveSmtp(rt.sql, parseSmtp({ ...values, host: "mail.example.test" }, false)));
    expect(moved.passwordCleared).toBe(true);
    expect((await getSmtp(rt.sql)).password.set).toBe(false);
    // The user name and sender are references only in the audit log.
    const [audit] = await root<{ text: string; pii_refs: string[] }[]>`SELECT row_to_json(a)::text AS text, pii_refs FROM audit_log a WHERE action = 'smtp.update' ORDER BY id DESC LIMIT 1`;
    expect(audit?.text).not.toContain("noreply@example.test");
    expect(audit?.text).not.toContain("mailer");
  });

  it("a WAHA API key is bound to the server host and removed when the base URL moves; the private-IP flag is audited", async () => {
    const id = await as(() => createWahaServer(rt.sql, parseWahaServer({ name: `W ${suffix()}`, baseUrl: "https://10.1.2.3:3000/" }, { allowPrivateIp: true, active: true })));
    await as(() => setWahaApiKey(rt.sql, settings, id, `waha-${suffix()}-${suffix()}`));
    expect((await sealedRow(SECRET_NAMES.wahaApiKey(id))).boundHost).toBe("10.1.2.3:3000");
    const [created] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'waha_server.create' AND entity_id = ${id}`;
    expect(created?.changes["allow_private_ip"]).toEqual({ after: true });
    const same = await as(() => updateWahaServer(rt.sql, id, parseWahaServer({ name: "Renamed", baseUrl: "https://10.1.2.3:3000/" }, { allowPrivateIp: true, active: false })));
    expect(same.keyCleared).toBe(false);
    const [update] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'waha_server.update' AND entity_id = ${id} ORDER BY id DESC LIMIT 1`;
    expect(update?.changes["active"]).toEqual({ before: true, after: false });
    const moved = await as(() => updateWahaServer(rt.sql, id, parseWahaServer({ name: "Renamed", baseUrl: "https://other.example.test/" }, { allowPrivateIp: false, active: true })));
    expect(moved.keyCleared).toBe(true);
    // A host name may not carry the private-IP flag (security review US-017 S3).
    expect(() => parseWahaServer({ name: "X", baseUrl: "https://waha.example.test/" }, { allowPrivateIp: true, active: true })).toThrow(/IPv4 address only/);
  });

  it("adnet secrets are bound to the adnet and its endpoint host", async () => {
    const adnetId = await as(() =>
      createAdnet(
        rt.sql,
        parseAdnet({ slug: `ad-${suffix()}`, name: "Ad", clickidParam: "cid", mo: "", mt: "https://pb.example.test/mt?c={clickid}&t={txid}&p={payout}&s={status}&k={secret:api_key}", reversal: "", payout: "1000" }, true),
      ),
    );
    await as(() => setAdnetSecret(rt.sql, settings, adnetId, "api_key", `tok-${suffix()}-${suffix()}`));
    const [row] = await root<{ adnet_id: string; bound_host: string; scope: string }[]>`SELECT adnet_id, bound_host, scope FROM settings_secrets WHERE adnet_id = ${adnetId}`;
    expect(row).toEqual({ adnet_id: adnetId, bound_host: "pb.example.test", scope: "conversions" });
  });
});

const programInput = (productId: string, slug: string, change: Partial<ProgramFields> = {}): ProgramFields => ({
  productId,
  slug,
  name: "Musim 1",
  ...salesWindow("2027-04-01", "2027-06-30"),
  graceDays: 30,
  defaultPoints: 10,
  defaultTimerSeconds: 20,
  leaderboardTopN: 10,
  ...change,
});

async function paidOrderFor(programId: string, productId: string): Promise<void> {
  const [lp] = await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${programId}) RETURNING id`;
  // As the superuser (the checkout guard trusts it), then paid like the worker does.
  const [order] = await root<{ id: string }[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, expires_at)
    VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${suffix().toUpperCase()}, ${lp?.id ?? ""}, ${programId}, ${productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid', sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, now() + interval '1 day')
    RETURNING id`;
  await root`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order?.id ?? ""}`;
}

describe("programs: field lock after the first PAID order, extend-only reschedule, clone", () => {
  it("edits freely before the first paid order, refuses locked fields after it, extends only", async () => {
    const productId = await as(() => createProduct(rt.sql, { title: `Ebook ${suffix()}`, priceIdr: 49_000 }));
    const slug = `musim-${suffix()}`;
    const id = await as(() => createProgram(rt.sql, programInput(productId, slug)));
    await as(() => updateProgram(rt.sql, id, programInput(productId, slug, { ...salesWindow("2027-04-01", "2027-06-15"), graceDays: 20 })));
    await paidOrderFor(id, productId);
    const [locked] = await root<{ locked_at: Date | null }[]>`SELECT locked_at FROM programs WHERE id = ${id}`;
    expect(locked?.locked_at).toBeInstanceOf(Date);

    for (const change of [{ slug: `other-${suffix()}` }, salesWindow("2027-04-02", "2027-06-15"), { graceDays: 25 }, salesWindow("2027-04-01", "2027-06-20")]) {
      await expect(as(() => updateProgram(rt.sql, id, programInput(productId, slug, { ...salesWindow("2027-04-01", "2027-06-15"), graceDays: 20, ...change }))), JSON.stringify(change)).rejects.toThrow(/locked/);
    }
    // Unlocked fields still edit.
    await as(() => updateProgram(rt.sql, id, programInput(productId, slug, { ...salesWindow("2027-04-01", "2027-06-15"), graceDays: 20, name: "Musim Satu", leaderboardTopN: 20 })));
    // Reschedule: earlier or less grace refused, later accepted.
    await expect(as(() => rescheduleProgram(rt.sql, id, { lastDay: "2027-06-14", graceDays: 20 }))).rejects.toThrow(/only move/);
    await expect(as(() => rescheduleProgram(rt.sql, id, { lastDay: "2027-06-15", graceDays: 19 }))).rejects.toThrow(/only move/);
    await as(() => rescheduleProgram(rt.sql, id, { lastDay: "2027-06-30", graceDays: 30 }));
    const [row] = await root<{ sales_end_at: Date; grace_days: number; name: string }[]>`SELECT sales_end_at, grace_days, name FROM programs WHERE id = ${id}`;
    expect(row).toEqual({ sales_end_at: new Date("2027-06-30T17:00:00.000Z"), grace_days: 30, name: "Musim Satu" });
    const [audit] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'program.reschedule' AND entity_id = ${id} ORDER BY id DESC LIMIT 1`;
    expect(audit?.changes).toMatchObject({
      sales_end_at: { before: "2027-06-15T17:00:00.000Z", after: "2027-06-30T17:00:00.000Z" },
      grace_days: { before: 20, after: 30 },
      grace_end_before: "2027-07-05",
      grace_end_after: "2027-07-30",
      locked: true,
    });
    // The database refuses the same even when the app check is skipped.
    await expect(rt.sql`UPDATE public.programs SET sales_end_at = sales_end_at - interval '1 day' WHERE id = ${id}`).rejects.toMatchObject({ code: "ET048" });
  });

  it("clones settings and content into an unlocked draft: every set, question and option in place", async () => {
    const productId = await as(() => createProduct(rt.sql, { title: `Ebook ${suffix()}`, priceIdr: 49_000 }));
    const source = await as(() => createProgram(rt.sql, programInput(productId, `src-${suffix()}`)));
    // 2 sets x 2 questions, distinct prompts / labels, the correct option at different positions.
    for (const s of [1, 2]) {
      const [set] = await root<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${source}, ${s}, ${`Set ${String(s)}`}) RETURNING id`;
      for (const q of [1, 2]) {
        const [question] = await root<{ id: string }[]>`
          INSERT INTO questions (set_id, position, prompt, points, timer_seconds, explanation)
          VALUES (${set?.id ?? ""}, ${q}, ${`S${String(s)}Q${String(q)}`}, ${10 * s + q}, ${20 + q}, ${`why ${String(s)}.${String(q)}`}) RETURNING id`;
        for (const o of [1, 2, 3]) {
          await root`
            INSERT INTO question_options (question_id, position, label, is_correct)
            VALUES (${question?.id ?? ""}, ${o}, ${`S${String(s)}Q${String(q)}O${String(o)}`}, ${o === ((s + q) % 3) + 1})`;
        }
      }
    }
    await root`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${source}, 1, 1, 'Juara 1', 1000000), (${source}, 2, 5, 'Juara 2-5', 100000)`;
    await paidOrderFor(source, productId);
    const copy = await as(() => cloneProgram(rt.sql, source, { slug: `copy-${suffix()}`, name: "Musim 2" }));
    const shape = (programId: string) =>
      root<{ set_pos: number; title: string; q_pos: number; prompt: string; points: number; timer: number; explanation: string; o_pos: number; label: string; correct: boolean }[]>`
        SELECT s.position AS set_pos, s.title, q.position AS q_pos, q.prompt, q.points, q.timer_seconds AS timer, q.explanation,
               o.position AS o_pos, o.label, o.is_correct AS correct
          FROM trivia_sets s JOIN questions q ON q.set_id = s.id JOIN question_options o ON o.question_id = q.id
         WHERE s.program_id = ${programId} ORDER BY 1, 3, 8`;
    const original = await shape(source);
    expect(original).toHaveLength(12);
    expect(await shape(copy)).toEqual(original);
    const tiers = (programId: string) => root`SELECT rank_from, rank_to, name, value_idr::text FROM prize_tiers WHERE program_id = ${programId} ORDER BY rank_from`;
    expect(await tiers(copy)).toEqual(await tiers(source));
    const [program] = await root<{ status: string; locked_at: Date | null; cloned: string }[]>`
      SELECT status::text AS status, locked_at, cloned_from_program_id AS cloned FROM programs WHERE id = ${copy}`;
    expect(program).toEqual({ status: "draft", locked_at: null, cloned: source });
  });

  it("an ended program cannot be rescheduled or have its dates edited (code review CM4)", async () => {
    const productId = await as(() => createProduct(rt.sql, { title: `Ebook ${suffix()}`, priceIdr: 49_000 }));
    const slug = `ended-${suffix()}`;
    const id = await as(() => createProgram(rt.sql, programInput(productId, slug)));
    await root`UPDATE programs SET status = 'awaiting_confirmation' WHERE id = ${id}`;
    await expect(as(() => rescheduleProgram(rt.sql, id, { lastDay: "2027-07-30", graceDays: 40 }))).rejects.toThrow(/contest has ended/);
    await expect(as(() => updateProgram(rt.sql, id, programInput(productId, slug, { graceDays: 31 })))).rejects.toThrow(/contest has ended/);
    await as(() => updateProgram(rt.sql, id, programInput(productId, slug, { name: "Renamed after the end" })));
  });

  it("publishing needs the product's PDF and the product on sale (code review L3)", async () => {
    const productId = await as(() => createProduct(rt.sql, { title: `Ebook ${suffix()}`, priceIdr: 49_000 }));
    const id = await as(() => createProgram(rt.sql, programInput(productId, `pub-${suffix()}`)));
    await expect(as(() => setProgramStatus(rt.sql, id, "published"))).rejects.toThrow(/Upload the ebook PDF/);
    await uploadAll(productId, pdfBytes(CHUNK_BYTES));
    await as(() => updateProductCommerce(rt.sql, productId, { priceIdr: 49_000, active: false }));
    await expect(as(() => setProgramStatus(rt.sql, id, "published"))).rejects.toThrow(/not on sale/);
    await as(() => updateProductCommerce(rt.sql, productId, { priceIdr: 49_000, active: true }));
    await as(() => setProgramStatus(rt.sql, id, "published"));
  });
});

describe("LP domains (risk R4)", () => {
  it("registers a domain in stored form and refuses the app's own registrable domain and duplicates", async () => {
    const productId = await as(() => createProduct(rt.sql, { title: `Ebook ${suffix()}`, priceIdr: 49_000 }));
    const programId = await as(() => createProgram(rt.sql, programInput(productId, `lp-${suffix()}`)));
    const lp = await as(() => createLandingPage(rt.sql, { name: "LP", programId }));
    const host = `Promo-${suffix()}.Brand.Example`;
    expect(await as(() => registerDomain(rt.sql, lp, host, settings.domain))).toBe(host.toLowerCase());
    await expect(as(() => registerDomain(rt.sql, lp, host.toLowerCase(), settings.domain))).rejects.toThrow(/already registered/);
    for (const bad of ["admin.example.test", "EXAMPLE.TEST", "example.test.", "203.0.113.5", "co.id"]) {
      await expect(as(() => registerDomain(rt.sql, lp, bad, settings.domain)), bad).rejects.toThrow(InvalidInput);
    }
    expect(await root`SELECT 1 FROM lp_domains WHERE host LIKE '%example.test%'`).toHaveLength(0);
  });
});

/** A PDF of `size` bytes (valid magic bytes; the content is filler). */
const pdfBytes = (size: number, fill = 0x20): Buffer => {
  const bytes = Buffer.alloc(size, fill);
  bytes.write("%PDF-1.7\n", 0, "latin1");
  bytes.write("\n%%EOF\n", size - 7, "latin1");
  return bytes;
};
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const chunkOf = (bytes: Buffer, i: number): Buffer => bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);

async function newProduct(): Promise<string> {
  return as(() => createProduct(rt.sql, { title: `Ebook ${suffix()}`, priceIdr: 49_000 }));
}

async function startUpload(productId: string, bytes: Buffer, opts: { confirmLarge?: boolean; admin?: string; settings?: SettingsConfig } = {}) {
  const who = opts.admin ?? ownerId;
  const init = await asAdmin(who, () =>
    initPdfUpload(rt.sql, opts.settings ?? settings, who, { productId, filename: "ebook.pdf", size: bytes.length, sha256: sha(bytes), confirmLarge: opts.confirmLarge ?? false }),
  );
  if (init.kind !== "ready") throw new Error(`expected ready, got ${init.kind}`);
  return init;
}

const put = (sessionId: string, i: number, bytes: Buffer, admin = ownerId) =>
  asAdmin(admin, () => writeChunk(rt.sql, settings, admin, { sessionId, index: i, sha256: sha(chunkOf(bytes, i)), bytes: chunkOf(bytes, i) }));

async function uploadAll(productId: string, bytes: Buffer, confirmLarge = false) {
  const init = await startUpload(productId, bytes, { confirmLarge });
  for (let i = 0; i < init.chunkCount; i++) await put(init.sessionId, i, bytes);
  return { ...init, done: await as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId)) };
}

const storedPdf = (productId: string) =>
  root<{ storage_path: string; sha256: Uint8Array }[]>`
    SELECT u.storage_path, u.sha256 FROM products p JOIN uploads u ON u.id = p.pdf_upload_id WHERE p.id = ${productId}`;

describe("chunked PDF upload (AC-D7, plan M2.5)", () => {
  it("over 20 MiB needs the confirmation, then uploads in hash-checked chunks and becomes the product's PDF", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(PDF_WARN_BYTES + 1024 * 1024);
    expect(await as(() => initPdfUpload(rt.sql, settings, ownerId, { productId, filename: "ebook.pdf", size: bytes.length, sha256: sha(bytes), confirmLarge: false }))).toEqual({
      kind: "needs_confirmation",
      warnBytes: PDF_WARN_BYTES,
    });
    const result = await uploadAll(productId, bytes, true);
    expect(result.done.large).toBe(true);
    const [row] = await storedPdf(productId);
    expect(row?.storage_path).toBe(`deliverables/${result.done.uploadId}.pdf`);
    expect(Buffer.from(row?.sha256 ?? []).toString("hex")).toBe(sha(bytes));
    expect(sha(await readFile(join(dataDir, row?.storage_path ?? "")))).toBe(sha(bytes));
    await expect(stat(join(dataDir, "upload-staging", `${result.sessionId}.part`))).rejects.toMatchObject({ code: "ENOENT" });
    const [audit] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'product.pdf_set' AND entity_id = ${productId}`;
    expect(audit?.changes).toMatchObject({ pdf_upload_id: { before: null, after: result.done.uploadId }, large: true, large_confirmed: true });
  }, 60_000);

  it("refuses over the hard cap before anything is written", async () => {
    const productId = await newProduct();
    expect(await as(() => initPdfUpload(rt.sql, settings, ownerId, { productId, filename: "big.pdf", size: settings.pdfMaxBytes + 1, sha256: "0".repeat(64), confirmLarge: true }))).toEqual({
      kind: "too_large",
      maxBytes: settings.pdfMaxBytes,
    });
  });

  it("refuses a corrupt chunk, a chunk of the wrong size, and another admin's session; resumes with the chunks received", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(2 * CHUNK_BYTES + 10);
    const init = await startUpload(productId, bytes);
    expect(init.chunkCount).toBe(3);
    const first = chunkOf(bytes, 0);
    await expect(as(() => writeChunk(rt.sql, settings, ownerId, { sessionId: init.sessionId, index: 0, sha256: sha(Buffer.from("x")), bytes: first }))).rejects.toThrow(/hash mismatch/);
    await expect(as(() => writeChunk(rt.sql, settings, ownerId, { sessionId: init.sessionId, index: 0, sha256: sha(first.subarray(1)), bytes: first.subarray(1) }))).rejects.toThrow(/wrong size/);
    await expect(as(() => writeChunk(rt.sql, settings, ownerId, { sessionId: init.sessionId, index: 3, sha256: sha(first), bytes: first }))).rejects.toThrow(/out of range/);
    const other = (await createTestAdmin(rt, "staff")).userId;
    await expect(put(init.sessionId, 0, bytes, other)).rejects.toThrow(/finished, being completed or expired/);
    await put(init.sessionId, 0, bytes);
    await expect(as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId))).rejects.toThrow(/missing/);
    const resumed = await startUpload(productId, bytes);
    expect(resumed).toMatchObject({ sessionId: init.sessionId, received: [0] });
  });

  it("refuses bytes that are not a PDF at completion, whatever the name", async () => {
    const productId = await newProduct();
    const html = Buffer.from("<html><script>alert(1)</script></html>".padEnd(4096, " "));
    await expect(uploadAll(productId, html)).rejects.toThrow(/not a PDF/);
    expect(await root`SELECT 1 FROM products WHERE id = ${productId} AND pdf_upload_id IS NOT NULL`).toHaveLength(0);
  });

  // Code review US-017 M2 (each mutation-checked: see the report).
  it("checks the whole file against the hash declared at init, not only each chunk", async () => {
    const productId = await newProduct();
    const declared = pdfBytes(2 * CHUNK_BYTES + 10);
    const init = await startUpload(productId, declared);
    // Every chunk carries its own correct hash, but the file is not the one declared.
    const other = pdfBytes(declared.length, 0x41);
    for (let i = 0; i < init.chunkCount; i++) await put(init.sessionId, i, other);
    const before = (await readdir(join(dataDir, "deliverables")).catch(() => [])).length;
    await expect(as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId))).rejects.toThrow(/does not match its hash/);
    expect(await storedPdf(productId)).toHaveLength(0);
    expect(await root`SELECT 1 FROM upload_sessions WHERE id = ${init.sessionId}`).toHaveLength(0);
    expect((await readdir(join(dataDir, "deliverables")).catch(() => [])).length).toBe(before);
  });

  it("writes each chunk at its offset, in any order (2, 0, 1)", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(2 * CHUNK_BYTES + 10);
    // Distinct content per chunk, so a chunk written at the wrong place changes the file.
    bytes.fill(0x31, CHUNK_BYTES, 2 * CHUNK_BYTES);
    bytes.fill(0x32, 2 * CHUNK_BYTES, bytes.length - 7);
    const init = await startUpload(productId, bytes);
    for (const i of [2, 0, 1]) await put(init.sessionId, i, bytes);
    await as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId));
    const [row] = await storedPdf(productId);
    expect(sha(await readFile(join(dataDir, row?.storage_path ?? "")))).toBe(sha(bytes));
  });

  it("answers 413 to a chunk body over CHUNK_BYTES before reading it all", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(2 * CHUNK_BYTES);
    const init = await startUpload(productId, bytes);
    const oversize = Buffer.concat([chunkOf(bytes, 0), Buffer.from("x")]);
    const ctx = { rt, req: { headers: new Headers(), ip: null }, admin: { userId: ownerId, role: "owner", displayName: "Owner" } } as unknown as RouteContext;
    const request = new Request(`http://127.0.0.1/uploads/pdf/chunk?session=${init.sessionId}&index=0`, {
      method: "POST",
      headers: { "x-chunk-sha256": sha(oversize) },
      body: new Blob([oversize]).stream(),
      duplex: "half",
    } as RequestInit);
    const response = await as(() => pdfChunk(ctx, request));
    expect(response.status).toBe(413);
  });

  it("refuses an unsafe original file name at init (it may become an attachment name)", async () => {
    const productId = await newProduct();
    for (const filename of ['eb"ook.pdf', "a/b.pdf", ".hidden.pdf", "e\nx.pdf"]) {
      expect(() => parseInit({ productId, filename, size: 10, sha256: "0".repeat(64) }), filename).toThrow(InvalidInput);
    }
    expect(parseInit({ productId, filename: "Ebook Musim 1.pdf", size: 10, sha256: "0".repeat(64) }).filename).toBe("Ebook Musim 1.pdf");
  });
});

describe("upload completion races (security review US-017 M1/M2)", () => {
  it("a chunk write after the claim is refused, and the stored file is the file that was hashed", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(2 * CHUNK_BYTES + 10);
    const init = await startUpload(productId, bytes);
    for (let i = 0; i < init.chunkCount; i++) await put(init.sessionId, i, bytes);
    let late: unknown = null;
    const tampered = Buffer.alloc(CHUNK_BYTES, 0x58);
    const done = await as(() =>
      completeUpload(rt.sql, settings, ownerId, init.sessionId, {
        afterClaim: async () => {
          late = await as(() => writeChunk(rt.sql, settings, ownerId, { sessionId: init.sessionId, index: 1, sha256: sha(tampered), bytes: tampered })).catch((e: unknown) => e);
        },
      }),
    );
    expect(late).toBeInstanceOf(InvalidInput);
    const [row] = await storedPdf(productId);
    expect(done.uploadId).toBeTruthy();
    expect(sha(await readFile(join(dataDir, row?.storage_path ?? "")))).toBe(Buffer.from(row?.sha256 ?? []).toString("hex"));
    expect(Buffer.from(row?.sha256 ?? []).toString("hex")).toBe(sha(bytes));
  });

  it("a completion waits for a chunk write in flight; what it stores matches uploads.sha256", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(2 * CHUNK_BYTES + 10);
    const init = await startUpload(productId, bytes);
    for (let i = 0; i < init.chunkCount; i++) await put(init.sessionId, i, bytes);
    // Re-send chunk 1 with other content (its own hash valid); while it holds the session, complete.
    const tampered = Buffer.alloc(CHUNK_BYTES, 0x58);
    let completion: Promise<unknown> = Promise.resolve();
    await as(() =>
      writeChunk(
        rt.sql,
        settings,
        ownerId,
        { sessionId: init.sessionId, index: 1, sha256: sha(tampered), bytes: tampered },
        {
          whileWritingChunk: async () => {
            completion = as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId)).catch((e: unknown) => e);
            await new Promise((r) => setTimeout(r, 300));
          },
        },
      ),
    );
    // The completion ran after the write: the file no longer matches the declared hash -> refused.
    expect(await completion).toBeInstanceOf(InvalidInput);
    expect(await storedPdf(productId)).toHaveLength(0);
  });

  it("two concurrent completions: one succeeds, the other is refused", async () => {
    const productId = await newProduct();
    const bytes = pdfBytes(3 * CHUNK_BYTES);
    const init = await startUpload(productId, bytes);
    for (let i = 0; i < init.chunkCount; i++) await put(init.sessionId, i, bytes);
    const results = await Promise.allSettled([0, 1].map(() => as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : null).toBeInstanceOf(InvalidInput);
    expect(await root`SELECT 1 FROM uploads WHERE id IN (SELECT upload_id FROM upload_sessions WHERE id = ${init.sessionId})`).toHaveLength(1);
  });
});

describe("upload quota and sweeper (security review US-017 M1, code review M1)", () => {
  /** Bytes the global staging quota already counts: unfinished uploads + replaced, unpurged PDFs. */
  const usedBytes = async (): Promise<number> =>
    Number(
      (
        await root<{ n: string }[]>`
        SELECT (SELECT coalesce(sum(size_bytes), 0) FROM upload_sessions WHERE completed_at IS NULL AND expires_at > now())
             + (SELECT coalesce(sum(size_bytes), 0) FROM uploads WHERE superseded_at IS NOT NULL) AS n`
      )[0]?.n ?? 0,
    );

  it("refuses a fourth unfinished upload per admin", async () => {
    const admin = (await createTestAdmin(rt, "staff")).userId;
    const strict: SettingsConfig = { ...settings, uploadMaxOpenSessions: 3 };
    const productId = await newProduct();
    for (let n = 0; n < 3; n++) await startUpload(productId, pdfBytes(CHUNK_BYTES + n), { admin, settings: strict });
    await expect(startUpload(productId, pdfBytes(CHUNK_BYTES + 9), { admin, settings: strict })).rejects.toThrow(/3 unfinished uploads/);
    // Another admin still may (the session count is per admin).
    await startUpload(productId, pdfBytes(CHUNK_BYTES + 9), { admin: (await createTestAdmin(rt, "staff")).userId, settings: strict });
  });

  it("caps staged bytes for the whole server, across admins (security review F2)", async () => {
    const strict: SettingsConfig = { ...settings, uploadMaxStagedBytes: (await usedBytes()) + 4 * CHUNK_BYTES };
    const productId = await newProduct();
    await startUpload(productId, pdfBytes(3 * CHUNK_BYTES), { admin: (await createTestAdmin(rt, "staff")).userId, settings: strict });
    await expect(startUpload(productId, pdfBytes(2 * CHUNK_BYTES), { admin: (await createTestAdmin(rt, "staff")).userId, settings: strict })).rejects.toThrow(/upload space is full/);
  });

  it("counts replaced PDFs that are not purged yet in the staged bytes (security review F2)", async () => {
    const productId = await newProduct();
    const strict: SettingsConfig = { ...settings, uploadMaxStagedBytes: (await usedBytes()) + 4 * CHUNK_BYTES };
    const fake = randomUUID();
    await root`
      INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256, superseded_at)
      VALUES (${fake}, 'pdf', ${`deliverables/${fake}.pdf`}, 'application/pdf', ${3 * CHUNK_BYTES}, ${Buffer.alloc(32)}, now())`;
    await expect(startUpload(productId, pdfBytes(2 * CHUNK_BYTES), { settings: strict })).rejects.toThrow(/upload space is full/);
    await root`DELETE FROM uploads WHERE id = ${fake}`;
    await startUpload(productId, pdfBytes(2 * CHUNK_BYTES), { settings: strict });
  });

  it("removes expired sessions of every admin, orphan staging files, replaced PDFs after the grace period and orphan deliverables", async () => {
    // A replaced PDF: two uploads, the first superseded long enough ago. (Every init sweeps, so the
    // setup below comes after these uploads.)
    const replaced = await newProduct();
    const firstUpload = await uploadAll(replaced, pdfBytes(CHUNK_BYTES));
    const secondUpload = await uploadAll(replaced, pdfBytes(CHUNK_BYTES, 0x41));
    // An expired session of another admin, with its staging file.
    const other = (await createTestAdmin(rt, "staff")).userId;
    const productId = await newProduct();
    const expired = await startUpload(productId, pdfBytes(CHUNK_BYTES), { admin: other });
    await root`UPDATE uploads SET superseded_at = now() - interval '2 hours' WHERE id = ${firstUpload.done.uploadId}`;
    await root`UPDATE upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${expired.sessionId}`;
    // An orphan staging file (no session) and an orphan deliverable (no uploads row), both old.
    const old = new Date(Date.now() - 60 * 60_000);
    const orphanPart = join(dataDir, "upload-staging", `${randomUUID()}.part`);
    const orphanPdf = join(dataDir, "deliverables", `${randomUUID()}.pdf`);
    await mkdir(join(dataDir, "deliverables"), { recursive: true });
    for (const path of [orphanPart, orphanPdf]) {
      await writeFile(path, "x");
      await utimes(path, old, old);
    }
    const result = await sweepUploads(rt.sql, settings);
    expect(result.expiredSessions).toBeGreaterThanOrEqual(1);
    expect(result.orphanStagingFiles).toBeGreaterThanOrEqual(1);
    expect(result.supersededPdfs).toBeGreaterThanOrEqual(1);
    expect(result.orphanPdfs).toBeGreaterThanOrEqual(1);
    expect(await root`SELECT 1 FROM upload_sessions WHERE id = ${expired.sessionId}`).toHaveLength(0);
    for (const path of [orphanPart, orphanPdf, join(dataDir, "upload-staging", `${expired.sessionId}.part`), join(dataDir, "deliverables", `${firstUpload.done.uploadId}.pdf`)]) {
      await expect(stat(path), path).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await root`SELECT 1 FROM uploads WHERE id = ${firstUpload.done.uploadId}`).toHaveLength(0);
    // The current PDF stays.
    expect((await stat(join(dataDir, "deliverables", `${secondUpload.done.uploadId}.pdf`))).size).toBe(CHUNK_BYTES);
    const [purge] = await root<{ actor_kind: string }[]>`SELECT actor_kind FROM audit_log WHERE action = 'upload.purge' AND entity_id = ${firstUpload.done.uploadId}`;
    expect(purge).toEqual({ actor_kind: "system" });
  });

  it("never blocks on a foreign entry: a directory and a stray file are logged and left alone, and init still works (security review F1)", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const dirLike = join(dataDir, "upload-staging", `${randomUUID()}.part`);
    const stray = join(dataDir, "upload-staging", "notes.txt");
    const deliverableDir = join(dataDir, "deliverables", `${randomUUID()}.pdf`);
    for (const d of [dirLike, deliverableDir]) await mkdir(d, { recursive: true });
    await writeFile(stray, "keep me");
    for (const p of [dirLike, stray, deliverableDir]) await utimes(p, old, old);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    let result;
    try {
      result = await sweepUploads(rt.sql, settings);
    } finally {
      spy.mockRestore();
    }
    expect(result.leftAlone).toBeGreaterThanOrEqual(3);
    expect(lines.filter((l) => l.includes("admin.upload_sweep_left_alone")).length).toBeGreaterThanOrEqual(3);
    for (const p of [dirLike, stray, deliverableDir]) expect((await stat(p)).isFile() || (await stat(p)).isDirectory(), p).toBe(true);
    // The upload path still works with those entries there.
    const productId = await newProduct();
    const bytes = pdfBytes(CHUNK_BYTES);
    const init = await startUpload(productId, bytes);
    await put(init.sessionId, 0, bytes);
    await as(() => completeUpload(rt.sql, settings, ownerId, init.sessionId));
    await rm(dirLike, { recursive: true });
    await rm(stray);
    await rm(deliverableDir, { recursive: true });
  });

  it("runs one sweep at a time across instances: a held lock skips the run, and a PDF is purged once (security review F3)", async () => {
    const productId = await newProduct();
    const first = await uploadAll(productId, pdfBytes(CHUNK_BYTES));
    await uploadAll(productId, pdfBytes(CHUNK_BYTES, 0x41));
    await root`UPDATE uploads SET superseded_at = now() - interval '2 hours' WHERE id = ${first.done.uploadId}`;
    const other = await root.reserve();
    try {
      await other`SELECT pg_advisory_lock(hashtextextended('upload_sweep', 0))`;
      expect(await sweepUploads(rt.sql, settings)).toMatchObject({ skipped: true, supersededPdfs: 0 });
      expect(await root`SELECT 1 FROM uploads WHERE id = ${first.done.uploadId}`).toHaveLength(1);
      await other`SELECT pg_advisory_unlock(hashtextextended('upload_sweep', 0))`;
    } finally {
      other.release();
    }
    const runs = await Promise.all([sweepUploads(rt.sql, settings), sweepUploads(newRuntime(undefined, settings).sql, settings)]);
    expect(runs.every((r) => !r.skipped || r.supersededPdfs === 0)).toBe(true);
    await sweepUploads(rt.sql, settings);
    expect(await root`SELECT 1 FROM audit_log WHERE action = 'upload.purge' AND entity_id = ${first.done.uploadId}`).toHaveLength(1);
  });

  it("never expires a session whose completion claimed it recently; a crashed claim is removed (code review F6)", async () => {
    const productId = await newProduct();
    const recent = await startUpload(productId, pdfBytes(CHUNK_BYTES));
    const crashed = await startUpload(productId, pdfBytes(CHUNK_BYTES + 1));
    await root`UPDATE upload_sessions SET expires_at = now() - interval '1 minute', completing_at = now() WHERE id = ${recent.sessionId}`;
    await root`UPDATE upload_sessions SET completing_at = now() - interval '2 hours' WHERE id = ${crashed.sessionId}`;
    await sweepUploads(rt.sql, settings);
    expect(await root`SELECT 1 FROM upload_sessions WHERE id = ${recent.sessionId}`).toHaveLength(1);
    expect((await stat(join(dataDir, "upload-staging", `${recent.sessionId}.part`))).isFile()).toBe(true);
    expect(await root`SELECT 1 FROM upload_sessions WHERE id = ${crashed.sessionId}`).toHaveLength(0);
  });

  it("keeps a deliverable that any uploads row refers to, whatever its kind (security review F4)", async () => {
    const id = randomUUID();
    const path = join(dataDir, "deliverables", `${id}.pdf`);
    await writeFile(path, "%PDF-1.7 proof");
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(path, old, old);
    await root`
      INSERT INTO uploads (id, kind, storage_path, content_type, size_bytes, sha256)
      VALUES (${id}, 'proof', ${`deliverables/${id}.pdf`}, 'application/pdf', 14, ${Buffer.alloc(32)})`;
    await sweepUploads(rt.sql, settings);
    expect((await stat(path)).isFile()).toBe(true);
    await root`DELETE FROM uploads WHERE id = ${id}`;
  });

  it("leaves a freshly replaced PDF, a young orphan file and live sessions alone", async () => {
    const productId = await newProduct();
    const a = await uploadAll(productId, pdfBytes(CHUNK_BYTES));
    await uploadAll(productId, pdfBytes(CHUNK_BYTES, 0x41));
    const live = await startUpload(productId, pdfBytes(CHUNK_BYTES, 0x42));
    const young = join(dataDir, "upload-staging", `${randomUUID()}.part`);
    await writeFile(young, "x");
    await sweepUploads(rt.sql, settings);
    expect((await stat(join(dataDir, "deliverables", `${a.done.uploadId}.pdf`))).size).toBe(CHUNK_BYTES);
    expect((await stat(young)).size).toBe(1);
    expect((await stat(join(dataDir, "upload-staging", `${live.sessionId}.part`))).size).toBe(CHUNK_BYTES);
  });
});

describe("message templates (AC-A10)", () => {
  it("the seeded Bahasa Indonesia templates pass the editor's own checks", async () => {
    const templates = await listTemplates(rt.sql);
    expect(templates.map((t) => `${t.key}/${t.channel}`).sort()).toEqual(["delivery/email", "delivery/whatsapp", "delivery_without_link/whatsapp", "otp/whatsapp"]);
    for (const t of templates) expect(() => parseTemplate(t.key, t.channel, { subject: t.subject ?? "", body: t.body }), t.key).not.toThrow();
  });

  const templateId = async (key: string, channel: string): Promise<string> =>
    (await root<{ id: string }[]>`SELECT id FROM message_templates WHERE key = ${key} AND channel = ${channel}`)[0]?.id ?? "";

  it("an e-mail test-send goes to the requester's own login address and writes a worker job (outbox), never a send", async () => {
    const staff = await createTestAdmin(rt, "staff");
    const template = await templateId("delivery", "email");
    const id = await asAdmin(staff.userId, () => requestTestSend(rt.sql, staff.userId, { templateId: template, testRecipientId: null, wahaSessionId: null }));
    const [job] = await root<{ topic: string; payload: unknown; processed_at: Date | null; status: string; recipient: string; text: string }[]>`
      SELECT o.topic, o.payload, o.processed_at, t.status, t.recipient, row_to_json(a)::text AS text
        FROM outbox o JOIN template_test_sends t ON t.id = (o.payload ->> 'test_send_id')::uuid
        JOIN audit_log a ON a.entity_id = t.id::text AND a.action = 'message_template.test_send'
       WHERE t.id = ${id}`;
    expect(job).toMatchObject({ topic: "template.test_send", payload: { test_send_id: id }, processed_at: null, status: "pending", recipient: staff.email });
    expect(job?.text).not.toContain(staff.email);
  });

  it("caps test-sends at 10 per admin and hour, also for 11 parallel requests", async () => {
    const admin = (await createTestAdmin(rt, "staff")).userId;
    const template = await templateId("delivery", "email");
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, () => asAdmin(admin, () => requestTestSend(rt.sql, admin, { templateId: template, testRecipientId: null, wahaSessionId: null }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(TEST_SEND_CAPS.perAdminHour);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(InvalidInput);
  });

  it("caps test-sends at 30 per admin and day, and 30 per hour for all admins together", async () => {
    const template = await templateId("delivery", "email");
    const admin = (await createTestAdmin(rt, "staff")).userId;
    // 30 earlier today (more than an hour ago) for this admin.
    await root`
      INSERT INTO template_test_sends (template_id, channel, recipient, requested_by_admin_user_id, status, created_at)
      SELECT ${template}, 'email', 'x@example.test', ${admin}, 'sent', now() - interval '3 hours' FROM generate_series(1, 30)`;
    await expect(asAdmin(admin, () => requestTestSend(rt.sql, admin, { templateId: template, testRecipientId: null, wahaSessionId: null }))).rejects.toThrow(/per day/);
    // 30 by others in the last hour: a fresh admin is refused too.
    const others = (await createTestAdmin(rt, "staff")).userId;
    const [{ n } = { n: 0 }] = await root<{ n: number }[]>`SELECT count(*)::int AS n FROM template_test_sends WHERE created_at > now() - interval '1 hour'`;
    await root`
      INSERT INTO template_test_sends (template_id, channel, recipient, requested_by_admin_user_id, status)
      SELECT ${template}, 'email', 'x@example.test', ${others}, 'sent' FROM generate_series(1, ${Math.max(0, 30 - n)}::int)`;
    const fresh = (await createTestAdmin(rt, "staff")).userId;
    await expect(asAdmin(fresh, () => requestTestSend(rt.sql, fresh, { templateId: template, testRecipientId: null, wahaSessionId: null }))).rejects.toThrow(/hourly maximum/);
    await root`DELETE FROM template_test_sends WHERE recipient = 'x@example.test'`;
  });

  it("a WhatsApp test-send goes only to a number on the Owner's list (at most 5), from an active session", async () => {
    const template = await templateId("otp", "whatsapp");
    const serverId = await as(() => createWahaServer(rt.sql, parseWahaServer({ name: `T ${suffix()}`, baseUrl: `https://waha-${suffix()}.example.test/` }, { allowPrivateIp: false, active: true })));
    const sessionId = await as(() => createWahaSession(rt.sql, parseWahaSession({ serverId, sessionName: "default", phone: "", weight: "1", dailyCap: "10" }, true)));
    await expect(as(() => requestTestSend(rt.sql, ownerId, { templateId: template, testRecipientId: null, wahaSessionId: sessionId }))).rejects.toThrow(/test number/);
    await expect(as(() => requestTestSend(rt.sql, ownerId, { templateId: template, testRecipientId: randomUUID(), wahaSessionId: sessionId }))).rejects.toThrow(/test-recipient list/);
    await expect(as(() => requestTestSend(rt.sql, ownerId, { templateId: template, testRecipientId: randomUUID(), wahaSessionId: randomUUID() }))).rejects.toThrow(/active WhatsApp session/);

    await root`DELETE FROM test_recipients`;
    for (let i = 0; i < TEST_RECIPIENT_MAX; i++) await as(() => addTestRecipient(rt.sql, ownerId, { phone: `0812345678${String(i).padStart(2, "0")}`, label: `Uji ${String(i)}` }));
    await expect(as(() => addTestRecipient(rt.sql, ownerId, { phone: "081299999999", label: "Sixth" }))).rejects.toThrow(/At most 5/);
    await expect(as(() => addTestRecipient(rt.sql, ownerId, { phone: "0212345678", label: "Landline" }))).rejects.toThrow(InvalidInput);
    const [recipient] = await root<{ id: string; phone: string }[]>`SELECT id, phone FROM test_recipients ORDER BY label LIMIT 1`;
    const id = await as(() => requestTestSend(rt.sql, ownerId, { templateId: template, testRecipientId: recipient?.id ?? "", wahaSessionId: sessionId }));
    expect((await root<{ recipient: string }[]>`SELECT recipient FROM template_test_sends WHERE id = ${id}`)[0]?.recipient).toBe(recipient?.phone);
    // Adding / removing a test number is audited, the number by reference only.
    const [added] = await root<{ text: string; pii_refs: string[] }[]>`SELECT row_to_json(a)::text AS text, pii_refs FROM audit_log a WHERE action = 'test_recipient.add' ORDER BY id DESC LIMIT 1`;
    expect(added?.pii_refs[0]).toMatch(/^test_recipient:[0-9a-f-]+\.phone set$/);
    expect(added?.text).not.toContain("+62812345678");
    await as(() => removeTestRecipient(rt.sql, recipient?.id ?? ""));
    expect(await listTestRecipients(rt.sql)).toHaveLength(TEST_RECIPIENT_MAX - 1);
    await root`DELETE FROM test_recipients`;
  });
});

describe("racing first saves (code review US-017 L9)", () => {
  it("a unique-key race becomes a retry message, not a 500", async () => {
    await root`DELETE FROM smtp_settings`;
    const insert = (tx: Parameters<Parameters<typeof auditedChange>[1]>[0]) =>
      tx`INSERT INTO public.smtp_settings (host, port, security, from_address) VALUES ('smtp.example.test', 587, 'starttls', 'a@example.test')`;
    await expect(
      as(() =>
        auditedChange(
          rt.sql,
          async (tx, audit) => {
            await insert(tx);
            await insert(tx); // what the second of two concurrent first saves runs into
            audit({ action: "smtp.update", entityType: "smtp_settings", entityId: "default" });
          },
          { "23505": CONCURRENT_SAVE },
        ),
      ),
    ).rejects.toThrow(CONCURRENT_SAVE);
    expect(await root`SELECT 1 FROM smtp_settings`).toHaveLength(0);
  });
});

describe("the app pool keeps postgres.js defaults (code review US-017 CM3)", () => {
  it("returns Dates for timestamptz and parsed json, even after Better Auth's drizzle adapter was built", async () => {
    expect(rt.auth).toBeDefined();
    const [row] = await rt.sql<{ t: unknown; j: unknown }[]>`SELECT clock_timestamp() AS t, '{"a": 1}'::jsonb AS j`;
    expect(row?.t).toBeInstanceOf(Date);
    expect(row?.j).toEqual({ a: 1 });
    const at = new Date("2027-06-30T17:00:00.000Z");
    const [echo] = await rt.sql<{ t: Date; j: unknown }[]>`SELECT ${at}::timestamptz AS t, ${rt.sql.json({ b: [1, 2] })}::jsonb AS j`;
    expect(echo).toEqual({ t: at, j: { b: [1, 2] } });
  });
});

describe("least privilege", () => {
  it("the public app's role cannot read test-sends, upload sessions or SMTP settings", async () => {
    const pub = postgres(inject("publicDbUrl"), { max: 1, onnotice: () => undefined });
    try {
      for (const table of ["template_test_sends", "upload_sessions", "smtp_settings", "settings_secrets"]) {
        await expect(pub.unsafe(`SELECT 1 FROM public.${table}`), table).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await pub.end({ timeout: 5 });
    }
  });
});

