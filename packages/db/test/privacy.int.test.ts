// US-030 (M10b) UU PDP deletion = anonymization (sql/privacy.sql erase_data_subject, plan §10 item 6), the AC's PII scan:
//   - two data subjects with unique markers (name, the E.164 phone and its 08... / 62... forms, the @c.us chat id, a LID, the
//     e-mail, an IP and a user agent, and their hashed forms) walk a full journey: checkout with consents, the payment attempt
//     and notification, deliveries and the WhatsApp rows, OTPs and magic links, the player login, play, the results snapshot,
//     a winner with a fulfilment and its proof, the outbox and alerts;
//   - subject A is erased; then EVERY text, varchar, char, json(b), inet, bytea column (and arrays of them) of EVERY table of the
//     schemas, found from information_schema (a future table is covered automatically), is scanned: no marker of A anywhere,
//     and B's markers exactly where they were;
//   - the reports' totals are identical before and after (the pseudonymous financial rows stay);
//   - the edge cases: an undelivered prize (ET177, then the forfeit path), an open or in-review order (ET178), idempotence and a
//     race, a rejected request (ET176), the live contest (no login, "***" on the leaderboard), a later purchase with the same
//     phone (a new subject), the guards on decided requests and anonymized rows (ET176, ET179), the webhook dedupe.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admins, confirm, contest, type Contest, rankedPlayer, snapshot, tier, winnersOf } from "./contest-fixtures.ts";
import { asRole, first, rolledBack, sql, sqlState, suffix } from "./db.ts";

type Id = { id: string };
const sha256 = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();
const hex = (b: Buffer): string => b.toString("hex");
const contactKey = (chatId: string): string => hex(sha256(`ebooktrivia/contact/v1|${chatId}`));

interface Markers {
  readonly name: string;
  readonly phone: string;
  readonly local: string;
  readonly digits: string;
  readonly jid: string;
  readonly lid: string;
  readonly email: string;
  readonly ip: string;
  readonly ua: string;
}

function markers(): Markers {
  const tag = randomBytes(4).toString("hex");
  const local = `812${String(randomInt(10_000_000, 99_999_999))}`;
  const lid = String(randomInt(100_000_000, 999_999_999)) + String(randomInt(100_000, 999_999));
  return {
    name: `Zqx${tag} Wirya`,
    phone: `+62${local}`,
    local: `0${local}`,
    digits: `62${local}`,
    jid: `62${local}@c.us`,
    lid: `${lid}@lid`,
    email: `pii${tag}@example.test`,
    // Groups without a leading zero: the text form of an inet is the canonical one (0a1b would come back as a1b).
    ip: `2001:db8:${randomInt(0x1000, 0xffff).toString(16)}:${randomInt(0x1000, 0xffff).toString(16)}::7`,
    ua: `Mozilla/5.0 (PiiMarker ${tag}) Safari`,
  };
}

/**
 * What a scan looks for. Text (lower case, a substring of any text-like value): the name and its unique tag alone, the phone in
 * every form, the chat ids and the lid digits, the e-mail, IP and user agent, and their hashes in hex and base64 (CAPI hashes the
 * e-mail and the phone digits; the pool keys a contact on a chat id OR the phone). Bytes (inside a bytea): the raw SHA-256 of the
 * e-mail, the phone, its digits and the user agent, the buyer key, and the UTF-8 of the identifiers.
 */
function patterns(m: Markers): { text: string[]; bytes: Buffer[] } {
  const hashes = [sha256(m.email), sha256(m.digits), sha256(m.phone), sha256(m.ua)];
  return {
    text: [
      m.name, m.name.split(" ")[0] ?? "", m.phone, m.local, m.digits, m.jid, m.lid, m.lid.split("@")[0] ?? "", m.email, m.ip, m.ua,
      ...hashes.map(hex), ...hashes.map((h) => h.toString("base64")), contactKey(m.jid), contactKey(m.lid), contactKey(m.phone),
    ].map((s) => s.toLowerCase()),
    bytes: [...hashes, sha256(`${m.phone}|${m.name.toLowerCase()}|${m.email}`), Buffer.from(m.phone), Buffer.from(m.email), Buffer.from(m.name)],
  };
}

interface Column {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly bytea: boolean;
  readonly array: boolean;
}

/** Every text-like and bytea column of every base table of every schema but the system ones, from information_schema. */
async function scannedColumns(): Promise<Column[]> {
  const rows = await sql<{ schema: string; table: string; column: string; data_type: string; udt_name: string }[]>`
    SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column, c.data_type, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg\_%'
       AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'inet', 'cidr', 'bytea')
            OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar', '_bpchar', '_json', '_jsonb', '_inet', '_cidr', '_bytea')))
     ORDER BY 1, 2, 3`;
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    column: r.column,
    bytea: r.udt_name === "bytea" || r.udt_name === "_bytea",
    array: r.udt_name.startsWith("_"),
  }));
}

const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;

/** Rows per column that hold any of the markers (text: as a substring of the lower-cased value; bytes: inside a bytea); only columns with a hit. */
async function scan(m: Markers): Promise<Record<string, number>> {
  const p = patterns(m);
  const hits: Record<string, number> = {};
  for (const col of await scannedColumns()) {
    const c = ident(col.column);
    const text = `EXISTS (SELECT 1 FROM unnest($1::text[]) t WHERE strpos(lower(${c}::text), t) > 0)`;
    const bytes = col.array
      ? `EXISTS (SELECT 1 FROM unnest(${c}) v, unnest($2::text[]) h WHERE position(decode(h, 'hex') IN v) > 0)`
      : `EXISTS (SELECT 1 FROM unnest($2::text[]) h WHERE position(decode(h, 'hex') IN ${c}) > 0)`;
    const query = `SELECT count(*)::int AS n FROM ${ident(col.schema)}.${ident(col.table)} WHERE ${c} IS NOT NULL AND (${text}${col.bytea ? ` OR ${bytes}` : ""})`;
    const [row] = await sql.unsafe<{ n: number }[]>(query, col.bytea ? [p.text, p.bytes.map((b) => b.toString("hex"))] : [p.text]);
    if ((row?.n ?? 0) > 0) hits[`${col.schema}.${col.table}.${col.column}`] = row?.n ?? 0;
  }
  return hits;
}

/** The program, landing page, legal pages, adnet and WhatsApp number every subject of a test shares. */
interface World {
  readonly c: Contest;
  readonly lpId: string;
  readonly productId: string;
  readonly terms: string;
  readonly privacy: string;
  readonly adnetId: string;
  readonly sessionId: string;
}

async function world(c: Contest): Promise<World> {
  const { product_id: productId } = first(await sql<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${c.programId}`);
  const { id: lpId } = first(await sql<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${c.programId}) RETURNING id`);
  const [terms, privacy] = await sql<Id[]>`
    INSERT INTO legal_pages (program_id, kind, version, title, body) VALUES (${c.programId}, 'terms', 1, 'S&K', 'Isi'), (${c.programId}, 'privacy', 1, 'Privasi', 'Isi') RETURNING id`;
  await sql`UPDATE legal_pages SET published_at = now() WHERE program_id = ${c.programId}`;
  const { id: adnetId } = first(await sql<Id[]>`INSERT INTO adnets (slug, name, clickid_param, payout_idr) VALUES (${`net-${suffix()}`}, 'Net', 'clickid', 5000) RETURNING id`);
  const host = `waha-${suffix()}.example.test`;
  const { id: serverId } = first(await sql<Id[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES ('WAHA', ${`https://${host}`}, ${host}) RETURNING id`);
  const { id: sessionId } = first(await sql<Id[]>`INSERT INTO waha_sessions (server_id, session_name, phone, status) VALUES (${serverId}, ${`s${suffix()}`}, '+6281100001111', 'WORKING') RETURNING id`);
  return { c, lpId, productId, terms: terms?.id ?? "", privacy: privacy?.id ?? "", adnetId, sessionId };
}

interface Journey {
  readonly m: Markers;
  readonly playerId: string;
  readonly orderId: string;
  readonly publicId: string;
  readonly deliveryIds: string[];
}

/** The order (paid, with its whole trail) and the rest of the journey of one subject who already played in `w.c`. */
async function journey(w: World, m: Markers, playerId: string, opts: { status?: string } = {}): Promise<Journey> {
  const uaHash = sha256(m.ua);
  await sql`UPDATE players SET name = ${m.name}, email = ${m.email} WHERE id = ${playerId}`;
  const { id: visitId } = first(
    await sql<Id[]>`
      INSERT INTO visits (landing_page_id, adnet_id, clickid, utm_campaign, fbclid, fbp, fbc, ttclid, gclid, ip, ua_hash)
      VALUES (${w.lpId}, ${w.adnetId}, ${`clk${suffix()}`}, 'promo', ${`fbclid${suffix()}`}, ${`fb.1.${suffix()}`}, ${`fb.1.${suffix()}.c`}, ${`tt${suffix()}`}, ${`g${suffix()}`},
              ${m.ip}::inet, ${uaHash}) RETURNING id`,
  );
  const publicId = `${suffix()}${suffix()}${suffix()}`;
  const status = opts.status ?? "paid";
  const { id: orderId } = first(
    await sql<Id[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, player_id, buyer_name, buyer_phone, buyer_email, buyer_key,
                          amount_idr, status, expires_at, visit_id, adnet_id, clickid, utm_campaign, fbclid, fbp, fbc, ttclid, gclid, ip, ua_hash, paid_at, mo_outbox_id)
      VALUES (${publicId}, ${`${suffix().toUpperCase()}PQ`}, ${w.lpId}, ${w.c.programId}, ${w.productId}, ${status === "paid" ? playerId : null}, ${m.name}, ${m.phone}, ${m.email},
              ${sha256(`${m.phone}|${m.name.toLowerCase()}|${m.email}`)}, 49000, ${status}, now() + interval '1 hour', ${visitId}, ${w.adnetId}, ${`clk${suffix()}`}, 'promo',
              ${`fbclid${suffix()}`}, ${`fb.1.${suffix()}`}, ${`fb.1.${suffix()}.c`}, ${`tt${suffix()}`}, ${`g${suffix()}`}, ${m.ip}::inet, ${uaHash},
              ${status === "paid" ? new Date() : null}, gen_random_uuid())
      RETURNING id`,
  );
  await sql`INSERT INTO consents (order_id, legal_page_id, ip, ua_hash) VALUES (${orderId}, ${w.terms}, ${m.ip}::inet, ${uaHash}), (${orderId}, ${w.privacy}, ${m.ip}::inet, ${uaHash})`;
  // An earlier visit from the same browser that led to no order (it is matched by the IP address and the user-agent hash).
  await sql`INSERT INTO visits (landing_page_id, utm_campaign, fbp, ip, ua_hash) VALUES (${w.lpId}, 'promo', ${`fb.1.${suffix()}`}, ${m.ip}::inet, ${uaHash})`;
  const midtransOrderId = `${publicId}-1`;
  await sql`INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, status, snap_token, redirect_url) VALUES (${orderId}, 1, ${midtransOrderId}, 'created', 'tok', 'https://app.sandbox.midtrans.com/snap/v4/x')`;
  const raw = {
    transaction_id: `txn-${suffix()}`, order_id: midtransOrderId, transaction_status: "settlement", status_code: "200", gross_amount: "49000.00",
    payment_type: "bank_transfer", customer_details: { first_name: m.name, email: m.email, phone: m.local }, va_numbers: [{ bank: "bca", va_number: m.digits }],
  };
  await sql`INSERT INTO payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw) VALUES (${midtransOrderId}, 'settlement', '200', ${suffix()}, ${sql.json(raw)})`;
  if (status !== "paid") return { m, playerId, orderId, publicId, deliveryIds: [] };
  await sql`INSERT INTO payments (order_id, gateway_txn_id, transaction_status, gross_amount_idr, payment_type, settled_at, raw) VALUES (${orderId}, ${raw.transaction_id}, 'settlement', 49000, 'bank_transfer', now(), ${sql.json(raw)})`;
  // Sends: e-mail and WhatsApp deliveries (the opener, the buyer-first reply to a @lid chat), the pool's ledger, the inbound messages.
  const deliveries = await sql<Id[]>`
    INSERT INTO deliveries (order_id, channel, status, session_id, wa_chat_id, reply_chat_id, wa_message_id, sent_at, attempts)
    VALUES (${orderId}, 'email', 'sent', NULL, NULL, NULL, NULL, now(), 1),
           (${orderId}, 'whatsapp', 'sent', ${w.sessionId}, ${m.jid}, ${m.lid}, ${`true_${m.lid}_3EB0${suffix().toUpperCase()}`}, now(), 1)
    RETURNING id`;
  const waDelivery = deliveries[1]?.id ?? "";
  await sql`INSERT INTO delivery_openers (delivery_id, status, attempts, session_id, wa_message_id, sent_at) VALUES (${waDelivery}, 'sent', 1, ${w.sessionId}, ${`true_${m.jid}_3EB0${suffix().toUpperCase()}`}, now())`;
  await sql`
    INSERT INTO waha_sends (session_id, delivery_id, kind, contact_key, outcome) VALUES
      (${w.sessionId}, ${waDelivery}, 'opener', ${contactKey(m.jid)}, 'sent'), (${w.sessionId}, NULL, 'otp', ${contactKey(m.phone)}, 'sent'),
      (${w.sessionId}, NULL, 'text', ${contactKey(m.lid)}, 'sent')`;
  for (const from of [m.jid, m.lid]) {
    const messageId = `false_${from}_${suffix().toUpperCase()}`;
    const { id: inboundId } = first(
      await sql<Id[]>`
        INSERT INTO waha_inbound (message_id, session_id, session_name, from_jid, body, raw, outcome, processed_at)
        VALUES (${messageId}, ${w.sessionId}, 'default', ${from}, ${`Halo, saya ${m.name}`},
                ${sql.json({ from, notifyName: m.name, body: `Halo, saya ${m.name}` })}, 'delivered', now())
        RETURNING id`,
    );
    // The job the webhook queued for it (functions.sql enqueue_waha_inbound): its payload carries the message id.
    await sql`INSERT INTO outbox (topic, dedupe_key, payload, processed_at) VALUES ('waha.inbound', ${`waha.inbound:${inboundId}`}, ${sql.json({ inbound_id: inboundId, message_id: messageId })}, now())`;
  }
  await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, lid_checked_at) VALUES (${m.phone}, true, ${m.lid}, ${m.lid}, now())`;
  // Conversions: the S2S MT (sent) and a CAPI MT still pending (it would send the hashed e-mail and phone).
  const [s2s] = await sql<Id[]>`
    INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, sent_at, maybe_counted, reported_payout_idr)
    VALUES (${orderId}, 's2s', 'mt', 'sent', ${w.adnetId}, ${orderId}, gen_random_uuid(), 49000, now(), true, 5000),
           (${orderId}, 'meta', 'mt', 'pending', NULL, ${orderId}, gen_random_uuid(), 49000, NULL, false, NULL)
    RETURNING id`;
  await sql`INSERT INTO conversion_attempts (conversion_event_id, attempt, request_url_redacted, http_status) VALUES (${s2s?.id ?? ""}, 1, 'https://net.example.test/pb?clickid=***', 200)`;
  // OTP, the send ledger and its outbox row; magic links; the Better Auth player login.
  const { id: otpId } = first(await sql<Id[]>`INSERT INTO player_otps (phone, mac, expires_at) VALUES (${m.phone}, ${randomBytes(32)}, now() + interval '5 minutes') RETURNING id`);
  const { id: outboxId } = first(
    await sql<Id[]>`INSERT INTO outbox (topic, dedupe_key, payload, processed_at) VALUES ('otp.send', ${`otp.send:${otpId}`}, ${sql.json({ otp_id: otpId, phone: m.phone })}, now()) RETURNING id`,
  );
  await sql`INSERT INTO otp_enqueues (otp_id, phone, outbox_id) VALUES (${otpId}, ${m.phone}, ${outboxId})`;
  await sql`INSERT INTO magic_links (player_id, channel, token_hash, expires_at) VALUES (${playerId}, 'whatsapp', ${randomBytes(32)}, now() + interval '72 hours'), (${playerId}, 'email', ${randomBytes(32)}, now() + interval '72 hours')`;
  const userId = `u-${suffix()}`;
  await sql`INSERT INTO player_auth."user" (id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified") VALUES (${userId}, 'pemain', ${`${m.phone}@players.invalid`}, false, ${m.phone}, true)`;
  await sql`UPDATE players SET auth_user_id = ${userId} WHERE id = ${playerId}`;
  const sessionId = `s-${suffix()}`;
  await sql`INSERT INTO player_auth.session (id, "expiresAt", token, "updatedAt", "ipAddress", "userAgent", "userId") VALUES (${sessionId}, now() + interval '30 days', ${suffix()}, now(), ${m.ip}, ${m.ua}, ${userId})`;
  await sql`INSERT INTO player_auth.session_state (session_id, login_at) VALUES (${sessionId}, now())`;
  await sql`INSERT INTO player_auth.account (id, "accountId", "providerId", "userId", "updatedAt") VALUES (${`a-${suffix()}`}, ${userId}, 'phone-number', ${userId}, now())`;
  await sql`INSERT INTO player_auth.verification (id, identifier, value, "expiresAt") VALUES (${`v-${suffix()}`}, ${m.phone}, '123456', now() + interval '5 minutes')`;
  // Play: the device of the subject's answers.
  await sql`UPDATE attempt_questions SET ip = ${m.ip}::inet, ua_hash = ${uaHash} WHERE attempt_id IN (SELECT id FROM set_attempts WHERE player_id = ${playerId})`;
  // Alerts: one by reference (the normal case) and one that quotes the phone (a leak the erasure must still catch).
  await sql`INSERT INTO alerts (source, kind, severity, message, payload) VALUES ('worker', 'winner_flagged', 'critical', 'a winner was flagged', ${sql.json({ order_id: orderId })}),
                                                                              ('worker', 'delivery_failed', 'warning', 'delivery failed', ${sql.json({ to: m.phone })})`;
  return { m, playerId, orderId, publicId, deliveryIds: deliveries.map((d) => d.id) };
}

async function requestFor(phone: string): Promise<string> {
  const { owner } = await admins();
  return asRole("admin_rw", async (tx) =>
    first(await tx<Id[]>`
      INSERT INTO deletion_requests (subject_phone, lookup_kind, note, requested_by_admin_user_id) VALUES (${phone}, 'phone', 'Permintaan lewat email.', ${owner}) RETURNING id`).id,
  );
}

const erase = async (requestId: string, confirmation = requestId.slice(0, 8), actor?: string): Promise<Record<string, unknown>> => {
  const a = actor ?? (await admins()).owner;
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ s: Record<string, unknown> }[]>`SELECT public.erase_data_subject(${requestId}::uuid, ${confirmation}, ${a}, 'req-del', '198.51.100.10'::inet) AS s`).s,
  );
};

const step = async (fulfillmentId: string, from: string, to: string) => {
  const { owner } = await admins();
  await asRole("admin_rw", (tx) => tx`SELECT public.fulfillment_step(${fulfillmentId}::uuid, ${from}, ${to}, NULL, ${owner}, NULL, NULL)`);
};

/** The report totals of a program: the rollup rows (refreshed now) and the raw money and S2S counts. */
async function reportTotals(programId: string): Promise<unknown> {
  await asRole("worker_rw", (tx) => tx`SELECT public.refresh_report_rollups(clock_timestamp(), 120)`);
  const rollup = await sql`
    SELECT day::text, landing_page_id, adnet_id, utm_campaign, status::text, orders, mo, mt, amount_idr::text, revenue_idr::text, fee_idr::text, fee_missing, payout_idr::text
      FROM report_orders_daily WHERE program_id = ${programId} ORDER BY day, status, adnet_id NULLS FIRST, utm_campaign`;
  const raw = await sql`
    SELECT count(*)::int AS orders, coalesce(sum(amount_idr) FILTER (WHERE status = 'paid'), 0)::text AS revenue,
           count(*) FILTER (WHERE status = 'paid' AND clickid IS NOT NULL)::int AS paid_with_clickid,
           (SELECT count(*)::int FROM conversion_events c JOIN orders o2 ON o2.id = c.order_id
             WHERE o2.program_id = ${programId} AND c.sink = 's2s' AND c.kind = 'mt' AND c.status IN ('sent', 'failed')) AS s2s_mt
      FROM orders WHERE program_id = ${programId}`;
  return { rollup, raw };
}

/** A finalized contest whose winners are A (rank 1, prize delivered) and B (rank 2, fulfilment pending), both with notes and a proof. */
async function finalizedPair(): Promise<{ w: World; a: Journey; b: Journey }> {
  const c = await contest();
  await tier(c.programId, 1, 1);
  await tier(c.programId, 2, 2);
  const ma = markers();
  const mb = markers();
  const pa = await rankedPlayer(c, 1000, { phone: ma.phone, name: ma.name, email: ma.email });
  const pb = await rankedPlayer(c, 2000, { phone: mb.phone, name: mb.name, email: mb.email });
  await rankedPlayer(c, 3000);
  const w = await world(c);
  const a = await journey(w, ma, pa.id);
  const b = await journey(w, mb, pb.id);
  await snapshot(c.programId);
  await confirm(c.programId);
  const { owner } = await admins();
  for (const [j, done] of [[a, true], [b, false]] as const) {
    const winner = (await winnersOf(c.programId)).find((x) => x.player_id === j.playerId);
    const fid = winner?.fulfillment_id ?? "";
    await asRole("admin_rw", (tx) => tx`SELECT public.fulfillment_set_notes(${fid}::uuid, ${`Hubungi ${j.m.name} di ${j.m.local}`}, ${owner}, NULL, NULL)`);
    const uploadId = first(await sql<Id[]>`SELECT gen_random_uuid() AS id`).id;
    await sql`INSERT INTO uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256)
              VALUES (${uploadId}, 'proof', ${`proofs/${uploadId}.webp`}, ${`bukti ${j.m.name}.jpg`}, 'image/webp', 10, ${randomBytes(32)})`;
    await step(fid, "pending", "contacted");
    // A correction whose reason names the winner (free text: kept on the row, blanked by the erasure).
    await asRole("admin_rw", (tx) => tx`SELECT public.fulfillment_step(${fid}::uuid, 'contacted', 'pending', ${`Salah klik untuk ${j.m.name}`}, ${owner}, NULL, NULL)`);
    await step(fid, "pending", "contacted");
    await asRole("admin_rw", (tx) => tx`SELECT public.fulfillment_set_proof(${fid}::uuid, ${uploadId}::uuid, ${owner}, NULL, NULL)`);
    if (done) {
      await step(fid, "contacted", "sent");
      await step(fid, "sent", "done");
    }
  }
  return { w, a, b };
}

describe("the PII scan after a deletion (the AC)", () => {
  it("finds no marker of the erased subject in any text, jsonb, inet or bytea column of any table; the other subject is intact; reports unchanged", async () => {
    const { w, a, b } = await finalizedPair();
    const requestId = await requestFor(a.m.phone);
    const totalsBefore = await reportTotals(w.c.programId);
    const aBefore = await scan(a.m);
    const bBefore = await scan(b.m);
    // The seed really put A's data where the inventory says it lives (the scan is not vacuous).
    expect(Object.keys(aBefore)).toEqual(
      expect.arrayContaining([
        "public.players.name", "public.players.phone", "public.players.email", "public.orders.buyer_name", "public.orders.buyer_phone", "public.orders.buyer_email",
        "public.orders.buyer_key", "public.orders.ip", "public.orders.ua_hash", "public.consents.ip", "public.consents.ua_hash", "public.visits.ip", "public.visits.ua_hash",
        "public.attempt_questions.ip", "public.attempt_questions.ua_hash", "public.payment_notifications.raw", "public.payments.raw", "public.deliveries.wa_chat_id",
        "public.deliveries.reply_chat_id", "public.deliveries.wa_message_id", "public.delivery_openers.wa_message_id", "public.waha_sends.contact_key",
        "public.waha_inbound.message_id", "public.waha_inbound.from_jid", "public.waha_inbound.body", "public.waha_inbound.raw", "public.wa_contacts.phone",
        "public.wa_contacts.chat_id", "public.wa_contacts.lid", "public.player_otps.phone", "public.otp_enqueues.phone", "public.outbox.payload", "public.alerts.payload",
        "public.fulfillments.notes", "public.uploads.original_filename", "public.deletion_requests.subject_phone", "player_auth.user.phoneNumber", "player_auth.user.email",
        "player_auth.session.ipAddress", "player_auth.session.userAgent", "player_auth.verification.identifier",
      ]),
    );

    const summary = await erase(requestId);
    // Two visits: the order's, and the earlier one from the same browser (same IP and user-agent hash).
    expect(summary).toMatchObject({ erased: true, orders: 1, player: true, consents: 2, visits: 2, capi_cancelled: 1, files: 1, login_users: 1, magic_links: 2 });
    expect(summary["removed_files"]).toEqual([expect.stringMatching(/^proofs\/[0-9a-f-]{36}\.webp$/)]);

    expect(await scan(a.m)).toEqual({});
    expect(await scan(b.m)).toEqual(bBefore);
    expect(await reportTotals(w.c.programId)).toEqual(totalsBefore);

    // The pseudonymous rows stay: the order (money, status, attribution), its consents, the play rows, the winner and its fulfilment.
    expect(first(await sql`SELECT status::text, amount_idr::int, player_id, anonymized_at IS NOT NULL AS anonymized, clickid IS NOT NULL AS clickid FROM orders WHERE id = ${a.orderId}`)).toEqual({
      status: "paid", amount_idr: 49000, player_id: a.playerId, anonymized: true, clickid: true,
    });
    expect(await sql`SELECT legal_page_id FROM consents WHERE order_id = ${a.orderId}`).toHaveLength(2);
    expect((await winnersOf(w.c.programId)).find((x) => x.player_id === a.playerId)).toMatchObject({ status: "confirmed", fulfillment: "done" });
    expect(await sql`SELECT 1 FROM set_attempts WHERE player_id = ${a.playerId}`).toHaveLength(1);
    // The request is completed, keeps no phone, and the audit holds references only.
    expect(first(await sql`SELECT status, subject_phone, player_id FROM deletion_requests WHERE id = ${requestId}`)).toEqual({ status: "completed", subject_phone: null, player_id: a.playerId });
    const audit = first(await sql<{ pii_refs: string[] }[]>`SELECT pii_refs FROM audit_log WHERE action = 'privacy.deletion_execute' AND entity_id = ${requestId}`);
    expect(audit.pii_refs).toEqual([`player:${a.playerId} anonymized`, `order:${a.orderId} anonymized`]);
    // Nothing unsent goes out to the erased subject.
    expect(first(await sql`SELECT status::text, last_error FROM conversion_events WHERE order_id = ${a.orderId} AND sink = 'meta'`)).toEqual({ status: "failed", last_error: "subject_erased" });
  });
});

describe("erase_data_subject: refusals and edge cases", () => {
  it("refuses while the subject holds a prize not delivered (ET177); after the Owner's forfeit (revoke and re-award) it erases", async () => {
    const { w, b } = await finalizedPair();
    const requestId = await requestFor(b.m.phone);
    expect(await sqlState(erase(requestId))).toBe("ET177");
    const winner = (await winnersOf(w.c.programId)).find((x) => x.player_id === b.playerId);
    const { owner } = await admins();
    await asRole("admin_rw", (tx) => tx`SELECT public.revoke_winner(${winner?.id ?? ""}::uuid, ${`${b.m.name} meminta penghapusan data.`}, ${owner}, NULL, NULL)`);
    const summary = await erase(requestId);
    expect(summary).toMatchObject({ erased: true, files: 1 });
    expect(await scan(b.m)).toEqual({});
    // The prize went to the next eligible player, who is untouched.
    expect((await winnersOf(w.c.programId)).map((x) => [x.rank, x.status])).toEqual([
      [1, "confirmed"],
      [2, "revoked"],
      [3, "confirmed"],
    ]);
  });

  it("refuses while an order of the subject is pending or in review (ET178), and erases once it has expired", async () => {
    const c = await contest(-30 * 86_400_000);
    const w = await world(c);
    const m = markers();
    await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id, { status: "pending" });
    const requestId = await requestFor(m.phone);
    expect(await sqlState(erase(requestId))).toBe("ET178");
    await sql`UPDATE orders SET status = 'review' WHERE buyer_phone = ${m.phone}`;
    expect(await sqlState(erase(requestId))).toBe("ET178");
    await sql`UPDATE orders SET status = 'expired' WHERE buyer_phone = ${m.phone}`;
    expect(await erase(requestId)).toMatchObject({ erased: true, orders: 1 });
    expect(await scan(m)).toEqual({});
  });

  it("is idempotent and race-safe (one erasure, the others no-ops); only an Owner who typed the reference; a rejected request is never executed", async () => {
    const c = await contest(-30 * 86_400_000);
    const w = await world(c);
    const m = markers();
    await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    const requestId = await requestFor(m.phone);
    const { staff } = await admins();
    expect(await sqlState(erase(requestId, "wrong"))).toBe("ET171");
    expect(await sqlState(erase(requestId, requestId.slice(0, 8), staff))).toBe("ET171");
    for (const role of ["public_rw", "worker_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.erase_data_subject(${requestId}::uuid, 'x', 'x', NULL, NULL)`)), role).toBe("42501");
    }
    const results = await Promise.all([erase(requestId), erase(requestId), erase(requestId)]);
    expect(results.filter((r) => r["erased"] === true)).toHaveLength(1);
    expect(new Set(results.map((r) => r["orders"]))).toEqual(new Set([1]));
    expect(await sql`SELECT 1 FROM audit_log WHERE action = 'privacy.deletion_execute' AND entity_id = ${requestId}`).toHaveLength(1);

    const other = markers();
    await journey(w, other, (await rankedPlayer(c, 2000, { phone: other.phone })).id);
    const rejected = await requestFor(other.phone);
    await asRole("admin_rw", (tx) => tx`
      UPDATE deletion_requests SET status = 'rejected', rejected_at = now(), decided_by_admin_user_id = 'x', decision_note = 'Identitas pemohon tidak cocok.', subject_phone = NULL
       WHERE id = ${rejected}`);
    expect(await sqlState(erase(rejected))).toBe("ET176");
  });

  it("a subject in a live contest loses every login, and the live leaderboard shows them as *** without moving anyone's rank", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    const subject = await rankedPlayer(c, 1000, { phone: m.phone });
    const other = await rankedPlayer(c, 2000);
    await journey(w, m, subject.id);
    const before = await asRole("public_rw", (tx) => tx<{ rank: number; masked_name: string }[]>`SELECT rank, masked_name FROM public.play_leaderboard(${c.programId}::uuid, 10)`);
    const userId = first(await sql<{ auth_user_id: string }[]>`SELECT auth_user_id FROM players WHERE id = ${subject.id}`).auth_user_id;
    await erase(await requestFor(m.phone));
    const after = await asRole("public_rw", (tx) => tx<{ rank: number; masked_name: string }[]>`SELECT rank, masked_name FROM public.play_leaderboard(${c.programId}::uuid, 10)`);
    // The subject keeps their place, masked as the placeholder; everyone else is as before.
    const masked = m.name.split(" ").map((word) => `${word.charAt(0)}***`).join(" ");
    expect(before.map((r) => r.masked_name)).toContain(masked);
    expect(after.map((r) => [r.rank, r.masked_name])).toEqual(before.map((r) => [r.rank, r.masked_name === masked ? "***" : r.masked_name]));
    expect(await asRole("public_rw", (tx) => tx`SELECT public.player_for_login(${userId}) AS p`)).toEqual([{ p: null }]);
    expect(await asRole("public_rw", (tx) => tx`SELECT public.prepare_player_login(${m.phone}) AS u`)).toEqual([{ u: null }]);
    expect(await sql`SELECT 1 FROM player_auth.session s JOIN player_auth.session_state st ON st.session_id = s.id WHERE s."userId" = ${userId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM magic_links WHERE player_id = ${subject.id}`).toHaveLength(0);
    expect(other.id).not.toBe(subject.id);
  });

  it("a later purchase with the same phone is a NEW subject: a new player, never linked to the anonymized rows", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    const old = await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    await erase(await requestFor(m.phone));
    // What payments' PAID effects do for a new paid order (apps/worker payments.ts): the player by phone, created if missing.
    await sql`INSERT INTO players (phone, name, email) VALUES (${m.phone}, 'Pembeli Baru', 'baru@example.test') ON CONFLICT (phone) DO NOTHING`;
    const fresh = first(await sql<Id[]>`SELECT id FROM players WHERE phone = ${m.phone}`);
    expect(fresh.id).not.toBe(old.playerId);
    expect(first(await sql`SELECT player_id, buyer_phone FROM orders WHERE id = ${old.orderId}`)).toEqual({ player_id: old.playerId, buyer_phone: null });
    expect(first(await sql`SELECT phone, anonymized_at IS NOT NULL AS gone FROM players WHERE id = ${old.playerId}`)).toEqual({ phone: null, gone: true });
    // An anonymized row never gets personal data back, for any writer (ET179), and only the erasure anonymizes.
    for (const stmt of [
      sql`UPDATE players SET phone = ${m.phone} WHERE id = ${old.playerId}`,
      sql`UPDATE players SET anonymized_at = NULL WHERE id = ${old.playerId}`,
      sql`UPDATE orders SET buyer_email = 'x@example.test' WHERE id = ${old.orderId}`,
    ]) {
      expect(await sqlState(stmt)).toBe("ET179");
    }
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE players SET anonymized_at = now(), phone = NULL, name = '', email = NULL WHERE id = ${fresh.id}`))).toBe("ET179");
    // ... while an anonymized order's money still moves (a refund later).
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${old.orderId}`;
  });

  it("decided requests never change, a request is completed only by the erasure, never deleted (ET176)", async () => {
    const m = markers();
    const requestId = await requestFor(m.phone);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE deletion_requests SET status = 'completed', completed_at = now(), decided_by_admin_user_id = 'x', subject_phone = NULL WHERE id = ${requestId}`))).toBe("ET176");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE deletion_requests SET subject_phone = '+6281200000000' WHERE id = ${requestId}`))).toBe("ET176");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM deletion_requests WHERE id = ${requestId}`))).toBe("42501");
    await erase(requestId);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE deletion_requests SET note = 'diubah' WHERE id = ${requestId}`))).toBe("ET176");
    await rolledBack("pii_eraser", async (tx) => {
      expect(await sqlState(tx`UPDATE deletion_requests SET status = 'pending', subject_phone = ${m.phone}, completed_at = NULL, decided_by_admin_user_id = NULL WHERE id = ${requestId}`)).toBe("ET176");
    });
  });

  it("keeps the webhook dedupe: a redelivered inbound message of the erased subject is not stored again", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    const messageId = `false_${m.jid}_ABCDEF${suffix().toUpperCase()}`;
    await asRole("public_rw", (tx) => tx`INSERT INTO waha_inbound (message_id, session_name, from_jid, raw) VALUES (${messageId}, 'default', ${m.jid}, '{}')`);
    await erase(await requestFor(m.phone));
    const redelivered = await asRole("public_rw", (tx) => tx`
      INSERT INTO waha_inbound (message_id, session_name, from_jid, raw) VALUES (${messageId}, 'default', ${m.jid}, ${sql.json({ notifyName: m.name })})
      ON CONFLICT (message_id) DO NOTHING RETURNING id`);
    expect(redelivered).toHaveLength(0);
    expect(await sql`SELECT 1 FROM waha_inbound WHERE message_id = ${`erased:${hex(sha256(messageId))}`}`).toHaveLength(1);
    expect(await scan(m)).toEqual({});
  });
});

describe("erase_data_subject: exact matching, sends in flight, races and what arrives later", () => {
  it("matches the outbox and alerts EXACTLY: another person's longer phone or e-mail that contains the subject's stays intact", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    const otherPhone = `${m.phone}1`;
    const otherEmail = `d${m.email}`;
    const [nearOtp, nearMail, exactOtp] = await sql<Id[]>`
      INSERT INTO outbox (topic, dedupe_key, payload, processed_at) VALUES
        ('otp.send', ${`near-otp-${suffix()}`}, ${sql.json({ phone: otherPhone, otp_id: "x" })}, NULL),
        ('template.test_send', ${`near-mail-${suffix()}`}, ${sql.json({ to: { email: otherEmail } })}, now()),
        ('otp.send', ${`exact-otp-${suffix()}`}, ${sql.json({ phone: m.phone, otp_id: "y" })}, now())
      RETURNING id`;
    const [nearAlert, wordAlert, freeText, sentenceEnd, nearFreeText] = await sql<Id[]>`
      INSERT INTO alerts (source, kind, severity, message, payload) VALUES
        ('worker', 'delivery_failed', 'warning', ${`send to ${otherPhone} failed`}, ${sql.json({ to: otherPhone, cc: otherEmail })}),
        ('worker', 'delivery_failed', 'warning', ${`send to ${m.phone} failed`}, '{}'),
        ('glitchtip', 'error', 'warning', 'an error', ${sql.json({ attachments: [{ text: `checkout failed for ${m.phone} at step 2` }], fields: [{ value: "x" }] })}),
        ('worker', 'delivery_failed', 'warning', ${`the last send went to ${m.phone}.`}, ${sql.json({ note: `mail ${m.email}.` })}),
        ('glitchtip', 'error', 'warning', ${`retry for ${m.email}.uk tomorrow.`}, ${sql.json({ attachments: [{ text: `checkout failed for ${otherPhone} at step 2, ${m.email}.uk` }] })})
      RETURNING id`;
    const before = await sql`SELECT id, payload, processed_at FROM outbox WHERE id IN (${nearOtp?.id ?? ""}, ${nearMail?.id ?? ""}) ORDER BY id`;
    await erase(await requestFor(m.phone));
    expect(await sql`SELECT id, payload, processed_at FROM outbox WHERE id IN (${nearOtp?.id ?? ""}, ${nearMail?.id ?? ""}) ORDER BY id`).toEqual(before);
    expect(first(await sql`SELECT payload FROM outbox WHERE id = ${exactOtp?.id ?? ""}`)).toEqual({ payload: { erased: true } });
    expect(first(await sql`SELECT message, payload FROM alerts WHERE id = ${nearAlert?.id ?? ""}`)).toEqual({ message: `send to ${otherPhone} failed`, payload: { to: otherPhone, cc: otherEmail } });
    expect(first(await sql`SELECT message FROM alerts WHERE id = ${wordAlert?.id ?? ""}`)).toEqual({ message: "erased" });
    // Free text inside an alert's payload (a GlitchTip attachment) is matched by whole word, and a sentence's full stop ends a word.
    expect(first(await sql`SELECT message, payload FROM alerts WHERE id = ${freeText?.id ?? ""}`)).toEqual({ message: "an error", payload: { erased: true } });
    expect(first(await sql`SELECT message, payload FROM alerts WHERE id = ${sentenceEnd?.id ?? ""}`)).toEqual({ message: "erased", payload: { erased: true } });
    // ... while a longer phone or address that merely contains the subject's stays, mid-sentence or not.
    expect(first(await sql`SELECT message, payload FROM alerts WHERE id = ${nearFreeText?.id ?? ""}`)).toEqual({
      message: `retry for ${m.email}.uk tomorrow.`,
      payload: { attachments: [{ text: `checkout failed for ${otherPhone} at step 2, ${m.email}.uk` }] },
    });
  });

  it("lets a dead OTP or login-link job (past its consumer's claim cap) not hold the erasure back; a live one does", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    const j = await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    const requestId = await requestFor(m.phone);
    const live = new Date(Date.now() + 300_000).toISOString();
    // Below the caps (OTP 6, login link 5, raised by deferrals): live.
    for (const [topic, payload, attempts, deferrals] of [
      ["otp.send", { phone: m.phone, expires_at: live }, 5, 0],
      ["magic_link.resend", { player_id: j.playerId }, 4, 0],
      ["magic_link.resend", { player_id: j.playerId }, 5, 1],
    ] as const) {
      const key = `cap-${topic}-${suffix()}`;
      await sql`INSERT INTO outbox (topic, dedupe_key, payload, attempts, deferrals) VALUES (${topic}, ${key}, ${sql.json(payload)}, ${attempts}, ${deferrals})`;
      expect(await sqlState(erase(requestId)), `${topic} ${String(attempts)}`).toBe("ET178");
      await sql`UPDATE outbox SET processed_at = now() WHERE dedupe_key = ${key}`;
    }
    // At the caps the consumer never claims them again: dead, so the erasure goes ahead.
    await sql`INSERT INTO outbox (topic, dedupe_key, payload, attempts) VALUES
      ('otp.send', ${`dead-otp-${suffix()}`}, ${sql.json({ phone: m.phone, expires_at: live })}, 6),
      ('magic_link.resend', ${`dead-ml-${suffix()}`}, ${sql.json({ player_id: j.playerId })}, 5)`;
    expect(await erase(requestId)).toMatchObject({ erased: true });
  });

  it("an OTP being enqueued holds the erasure until it commits; the erasure then finds the OTP job live and waits (ET178)", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    const requestId = await requestFor(m.phone);
    const otp = first(
      await sql<Id[]>`INSERT INTO player_otps (phone, mac, sealed_code, expires_at) VALUES (${m.phone}, ${randomBytes(32)}, ${randomBytes(54)}, now() + interval '5 minutes') RETURNING id`,
    );
    const otpTx = await sql.reserve();
    try {
      await otpTx`BEGIN`;
      await otpTx.unsafe("SET LOCAL ROLE public_rw");
      await otpTx`SELECT public.enqueue_otp(${otp.id}::uuid)`;
      const erasing = erase(requestId).then(
        () => "erased",
        (e: unknown) => (e as { code?: string }).code ?? "error",
      );
      // The erasure waits on the player row the enqueue holds FOR SHARE.
      const early = await Promise.race([
        erasing,
        new Promise((resolve) => {
          setTimeout(() => {
            resolve("waiting");
          }, 500);
        }),
      ]);
      expect(early).toBe("waiting");
      await otpTx`COMMIT`;
      expect(await erasing).toBe("ET178");
    } finally {
      otpTx.release();
    }
    expect(first(await sql<{ phone: string | null }[]>`SELECT phone FROM players WHERE phone = ${m.phone}`).phone).toBe(m.phone);
  });

  it("refuses while a send to the subject is in flight (ET178): a delivery, an opener, a CAPI event, an OTP or a login-link job", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    const j = await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    const requestId = await requestFor(m.phone);
    const wa = j.deliveryIds[1] ?? "";
    const states: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ["delivery", () => sql`UPDATE deliveries SET status = 'pending' WHERE id = ${wa}`.then(() => sql`UPDATE deliveries SET status = 'sending' WHERE id = ${wa}`),
       () => sql`UPDATE deliveries SET status = 'sent' WHERE id = ${wa}`],
      ["opener", () => sql`UPDATE delivery_openers SET status = 'sending' WHERE delivery_id = ${wa}`, () => sql`UPDATE delivery_openers SET status = 'sent' WHERE delivery_id = ${wa}`],
      ["capi", () => sql`UPDATE conversion_events SET status = 'sending' WHERE order_id = ${j.orderId} AND sink = 'meta'`,
       () => sql`UPDATE conversion_events SET status = 'pending' WHERE order_id = ${j.orderId} AND sink = 'meta'`],
      ["otp", () => sql`INSERT INTO outbox (topic, dedupe_key, payload) VALUES ('otp.send', ${`live-otp-${j.orderId}`}, ${sql.json({ phone: m.phone, expires_at: new Date(Date.now() + 300_000).toISOString() })})`,
       () => sql`UPDATE outbox SET processed_at = now() WHERE dedupe_key = ${`live-otp-${j.orderId}`}`],
      ["magic link", () => sql`INSERT INTO outbox (topic, dedupe_key, payload) VALUES ('magic_link.resend', ${`live-ml-${j.orderId}`}, ${sql.json({ player_id: j.playerId })})`,
       () => sql`UPDATE outbox SET processed_at = now() WHERE dedupe_key = ${`live-ml-${j.orderId}`}`],
    ];
    for (const [name, start, stop] of states) {
      await start();
      expect(await sqlState(erase(requestId)), name).toBe("ET178");
      await stop();
    }
    // An OTP job that expired unsent is never sent: it does not hold the erasure back.
    await sql`INSERT INTO outbox (topic, dedupe_key, payload) VALUES ('otp.send', ${`dead-otp-${j.orderId}`}, ${sql.json({ phone: m.phone, expires_at: new Date(Date.now() - 60_000).toISOString() })})`;
    expect(await erase(requestId)).toMatchObject({ erased: true });
    expect(await scan(m)).toEqual({});
  });

  it("serialises with a revoke and re-award under the contest lock: the next player is either erased (and skipped) or a winner (and the erasure refused)", async () => {
    for (let round = 0; round < 3; round++) {
      const c = await contest();
      await tier(c.programId, 1, 1);
      const top = await rankedPlayer(c, 1000);
      const m = markers();
      const next = await rankedPlayer(c, 2000, { phone: m.phone });
      const third = await rankedPlayer(c, 3000);
      await snapshot(c.programId);
      await confirm(c.programId);
      const winner = (await winnersOf(c.programId)).find((x) => x.player_id === top.id);
      await asRole("worker_rw", (tx) => tx`UPDATE winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE id = ${winner?.id ?? ""}`);
      const requestId = await requestFor(m.phone);
      const { owner } = await admins();
      const [revoked, erased] = await Promise.allSettled([
        asRole("admin_rw", (tx) => tx`SELECT public.revoke_winner(${winner?.id ?? ""}::uuid, 'Chargeback dari bank pembeli.', ${owner}, NULL, NULL)`),
        erase(requestId),
      ]);
      expect(revoked.status).toBe("fulfilled");
      const live = (await winnersOf(c.programId)).filter((x) => x.status !== "revoked").map((x) => x.player_id);
      const gone = first(await sql<{ gone: boolean }[]>`SELECT anonymized_at IS NOT NULL AS gone FROM players WHERE id = ${next.id}`).gone;
      if (erased.status === "fulfilled") {
        expect(gone).toBe(true);
        expect(live).toEqual([third.id]);
      } else {
        expect((erased.reason as { code?: string }).code).toBe("ET177");
        expect(gone).toBe(false);
        expect(live).toEqual([next.id]);
      }
    }
  });

  it("cuts what Midtrans sends after the erasure (a late notification, a refund re-query) down to the transaction's keys, for every writer", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    const j = await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    await erase(await requestFor(m.phone));
    const full = { transaction_id: "txn-late", order_id: `${j.publicId}-1`, transaction_status: "refund", gross_amount: "49000.00", customer_details: { first_name: m.name, email: m.email, phone: m.local } };
    await asRole("public_rw", (tx) => tx`
      INSERT INTO payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw)
      VALUES (${`${j.publicId}-1`}, 'refund', '200', ${suffix()}, ${sql.json(full)})`);
    await asRole("worker_rw", (tx) => tx`UPDATE payments SET raw = ${sql.json(full)} WHERE order_id = ${j.orderId}`);
    for (const row of await sql<{ raw: Record<string, unknown> }[]>`
      SELECT raw FROM payment_notifications WHERE midtrans_order_id = ${`${j.publicId}-1`} UNION ALL SELECT raw FROM payments WHERE order_id = ${j.orderId}`) {
      expect(row.raw).not.toHaveProperty("customer_details");
      expect(row.raw).toMatchObject({ erased: true });
    }
    expect(await scan(m)).toEqual({});
  });

  it("keeps an anonymized order's player for good, and refuses a resend or a re-fire for it (ET179)", async () => {
    const c = await contest(-10 * 86_400_000);
    const w = await world(c);
    const m = markers();
    const j = await journey(w, m, (await rankedPlayer(c, 1000, { phone: m.phone })).id);
    await erase(await requestFor(m.phone));
    const other = await rankedPlayer(c, 2000);
    expect(await sqlState(sql`UPDATE orders SET player_id = ${other.id} WHERE id = ${j.orderId}`)).toBe("ET179");
    // A failed e-mail delivery (an operator's hand edit, as a superuser may) would otherwise be resendable.
    const email = j.deliveryIds[0] ?? "";
    await sql`UPDATE deliveries SET status = 'failed' WHERE id = ${email}`;
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT public.resend_delivery(${email}::uuid, true)`))).toBe("ET179");
    const meta = first(await sql<Id[]>`SELECT id FROM conversion_events WHERE order_id = ${j.orderId} AND sink = 'meta'`);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`SELECT public.refire_conversion(${meta.id}::uuid, false)`))).toBe("ET179");
  });
});
