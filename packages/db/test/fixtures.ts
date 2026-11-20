// Fixture rows, inserted as the superuser (bypasses grants, not triggers).
import { bytes, first, sql, suffix, uniquePhone } from "./db.ts";

type Id = { id: string };

export const PRICE_IDR = 49000;

/** A product (PRICE_IDR) and a program on sale now (published, sales window around now). */
export async function createProgram(
  opts: { status?: string; priceIdr?: number } = {},
): Promise<{ productId: string; programId: string }> {
  const product = first(
    await sql<Id[]>`
      INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, ${opts.priceIdr ?? PRICE_IDR}) RETURNING id`,
  );
  const program = first(
    await sql<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`prog-${suffix()}`}, 'Program', ${opts.status ?? "published"},
              now() - interval '1 day', now() + interval '30 days', 30)
      RETURNING id`,
  );
  return { productId: product.id, programId: program.id };
}

/** A player with the given phone; `eligible` decides player_programs.eligible for `programId`. */
export async function createPlayer(opts: {
  programId: string;
  eligible: boolean;
  phone?: string;
}): Promise<{ playerId: string; phone: string }> {
  const phone = opts.phone ?? uniquePhone();
  const player = first(await sql<Id[]>`INSERT INTO players (phone, name) VALUES (${phone}, 'Pemain') RETURNING id`);
  await sql`
    INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible)
    VALUES (${player.id}, ${opts.programId}, ${opts.eligible ? new Date() : null}, ${opts.eligible})`;
  return { playerId: player.id, phone };
}

export interface Question {
  id: string;
  /** Option ids by position; position 1 is the correct one. */
  options: [string, string, string];
}

async function createQuestion(setId: string, position: number): Promise<Question> {
  const q = first(
    await sql<Id[]>`
      INSERT INTO questions (set_id, position, prompt, points, timer_seconds)
      VALUES (${setId}, ${position}, ${`Pertanyaan ${position.toString()}`}, 10, 20) RETURNING id`,
  );
  const [a, b, c] = await sql<Id[]>`
    INSERT INTO question_options (question_id, position, label, is_correct)
    VALUES (${q.id}, 1, 'A', true), (${q.id}, 2, 'B', false), (${q.id}, 3, 'C', false)
    RETURNING id`;
  if (!a || !b || !c) throw new Error("expected 3 options");
  return { id: q.id, options: [a.id, b.id, c.id] };
}

export async function createTriviaSet(
  programId: string,
  position = 1,
): Promise<{ setId: string; q1: Question; q2: Question }> {
  const set = first(
    await sql<Id[]>`
      INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, ${position}, 'Set') RETURNING id`,
  );
  return { setId: set.id, q1: await createQuestion(set.id, 1), q2: await createQuestion(set.id, 2) };
}

export async function createAttempt(playerId: string, setId: string): Promise<string> {
  const row = first(
    await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${playerId}, ${setId}) RETURNING id`,
  );
  return row.id;
}

export async function createLandingPage(programId: string): Promise<string> {
  const row = first(
    await sql<Id[]>`
      INSERT INTO landing_pages (lp_key, name, program_id)
      VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${programId}) RETURNING id`,
  );
  return row.id;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 10 Crockford base32 chars = 50 random bits. */
export const orderCode = (): string => Array.from(bytes(10), (b) => CROCKFORD.charAt(b % 32)).join("");
export const publicId = (): string => `${suffix()}${suffix()}${suffix()}`;

/** Column values public_rw may INSERT into orders (everything else defaults). */
export function orderRow(o: { landingPageId: string; programId: string; productId: string; status?: string }) {
  return {
    public_id: publicId(),
    order_code: orderCode(),
    landing_page_id: o.landingPageId,
    program_id: o.programId,
    product_id: o.productId,
    buyer_name: "Pembeli",
    buyer_phone: uniquePhone(),
    buyer_email: "buyer@example.invalid",
    // orders.buyer_key (US-020 D1): 32 bytes, required on every order.
    buyer_key: bytes(32),
    amount_idr: PRICE_IDR,
    status: o.status ?? "pending",
    // 23 h, inside the seeded 24 h orders.expiry_seconds even with some client/server clock skew.
    expires_at: new Date(Date.now() + 23 * 3_600_000),
  };
}
