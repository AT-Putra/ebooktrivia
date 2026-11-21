// The public legal pages (AC-A10): play.<DOMAIN>/legal/{program}/{kind}/{version}, the links of the SDK's
// consent checkbox (packages/sdk/src/legal.ts). Only a PUBLISHED version exists here: a draft, a version
// that was never written and a malformed address are the same 404. Older published versions stay
// readable, because a consent records the exact version a buyer accepted.
import { SDK_PATTERNS } from "@ebooktrivia/core/sdk-contract";
import type { Sql } from "./db.ts";

export const LEGAL_KINDS = ["terms", "privacy"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

const SLUG = new RegExp(SDK_PATTERNS.slug);
/** legal_pages_version_check (>= 1); at most seven digits, the SDK's policyVersionMax. */
const VERSION = /^[1-9][0-9]{0,6}$/;

export interface LegalRequest {
  readonly program: string;
  readonly kind: LegalKind;
  readonly version: number;
}

/** The request of a URL's three segments, or undefined when any of them cannot name a legal page. */
export function parseLegalRequest(program: string, kind: string, version: string): LegalRequest | undefined {
  if (!SLUG.test(program) || program.length > 64 || !(LEGAL_KINDS as readonly string[]).includes(kind) || !VERSION.test(version)) return undefined;
  return { program, kind: kind as LegalKind, version: Number(version) };
}

export interface LegalPage {
  readonly title: string;
  /** Plain text (core legalBlocks): never HTML. */
  readonly body: string;
  readonly version: number;
  readonly publishedAt: Date;
}

export async function publishedLegalPage(sql: Sql, request: LegalRequest): Promise<LegalPage | undefined> {
  const [row] = await sql<{ title: string; body: string; version: number; published_at: Date }[]>`
    SELECT l.title, l.body, l.version, l.published_at
      FROM public.legal_pages l
      JOIN public.programs p ON p.id = l.program_id
     WHERE p.slug = ${request.program} AND l.kind = ${request.kind} AND l.version = ${request.version} AND l.published_at IS NOT NULL`;
  return row === undefined ? undefined : { title: row.title, body: row.body, version: row.version, publishedAt: row.published_at };
}
