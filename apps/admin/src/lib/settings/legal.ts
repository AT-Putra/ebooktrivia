// Versioned legal pages per program (spec AC-A10; US-018): "terms" (S&K, Terms & Prize Rules) and
// "privacy" (Privacy Policy). Owner only (legal_page.edit, owner decision 2026-11-18), audited.
//   - every save inserts a NEW draft version (version = latest + 1); nothing is edited in place;
//   - publishing stamps published_at on the latest version, which must be a draft; the newest
//     published version is the one checkout shows and the UU PDP consent references (M6);
//   - the database makes a saved version immutable (only a draft's publication may change it) and
//     refuses deleting any version (sql/triggers.sql legal_pages_guard, ET073 / ET074).
// The body is plain text (core legalBlocks: blank lines separate paragraphs, "# " starts a
// heading), rendered as text nodes, never as HTML. Its language is the Owner's choice. The audit
// entry records the version, title and the body's length and SHA-256 (the version row itself keeps
// the full text forever).
import { createHash } from "node:crypto";
import type { FieldKind } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import { InvalidInput, multiLine, singleLine } from "./fields.ts";

export const LEGAL_KINDS = ["terms", "privacy"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];
export const LEGAL_LABEL: Readonly<Record<LegalKind, string>> = { terms: "Terms & Prize Rules (S&K)", privacy: "Privacy Policy" };
export const LEGAL_BODY_MAX = 60_000;

const LEGAL_FIELDS: Readonly<Record<string, FieldKind>> = { version: "value", title: "value", body_chars: "value", body_sha256: "value" };
const MESSAGES: Readonly<Record<string, string>> = {
  "23505": CONCURRENT_SAVE,
  ET073: "A saved version never changes: save a new version instead.",
  ET074: "Legal page versions are never deleted.",
};

export const parseKind = (raw: string): LegalKind => {
  const kind = LEGAL_KINDS.find((k) => k === raw);
  if (kind === undefined) throw new InvalidInput("Choose the page (terms or privacy).");
  return kind;
};
export const parseLegalTitle = (raw: string): string => singleLine(raw, "Enter a title (up to 120 characters).", { max: 120 });
export const parseLegalBody = (raw: string): string => multiLine(raw, `Enter the text (up to ${LEGAL_BODY_MAX.toLocaleString("en-US")} characters).`, { max: LEGAL_BODY_MAX });

const digest = (body: string) => ({ body_chars: Array.from(body).length, body_sha256: createHash("sha256").update(body, "utf8").digest("hex") });

export async function saveLegalDraft(sql: Sql, programId: string, kind: LegalKind, input: { readonly title: string; readonly body: string }): Promise<number> {
  return auditedChange(
    sql,
    async (tx, audit) => {
      const [program] = await tx`SELECT 1 FROM public.programs WHERE id = ${programId}`;
      if (program === undefined) throw new InvalidInput("This program no longer exists.");
      const [latest] = await tx<{ id: string; version: number; title: string; body: string }[]>`
        SELECT id, version, title, body FROM public.legal_pages WHERE program_id = ${programId} AND kind = ${kind} ORDER BY version DESC LIMIT 1`;
      if (latest !== undefined && latest.title === input.title && latest.body === input.body) throw new InvalidInput("Nothing changed since the latest version.");
      const version = (latest?.version ?? 0) + 1;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.legal_pages (program_id, kind, version, title, body) VALUES (${programId}, ${kind}, ${version}, ${input.title}, ${input.body}) RETURNING id`;
      audit({
        action: "legal_page.save",
        entityType: "legal_page",
        entityId: row?.id ?? null,
        fields: LEGAL_FIELDS,
        before: latest === undefined ? null : { version: latest.version, title: latest.title, ...digest(latest.body) },
        after: { version, title: input.title, ...digest(input.body) },
        facts: { program_id: programId, kind },
      });
      return version;
    },
    MESSAGES,
  );
}

export async function publishLegalPage(sql: Sql, programId: string, kind: LegalKind, pageId: string): Promise<number> {
  return auditedChange(
    sql,
    async (tx, audit) => {
      const [latest] = await tx<{ id: string; version: number; published_at: Date | null }[]>`
        SELECT id, version, published_at FROM public.legal_pages WHERE program_id = ${programId} AND kind = ${kind} ORDER BY version DESC LIMIT 1 FOR UPDATE`;
      if (latest?.id !== pageId) throw new InvalidInput("Only the latest version can be published. Reload the page.");
      if (latest.published_at !== null) throw new InvalidInput("This version is already published.");
      const [row] = await tx<{ published_at: Date }[]>`
        UPDATE public.legal_pages SET published_at = clock_timestamp() WHERE id = ${pageId} AND program_id = ${programId} AND kind = ${kind} RETURNING published_at`;
      audit({
        action: "legal_page.publish",
        entityType: "legal_page",
        entityId: pageId,
        fields: { published_at: "value" },
        before: { published_at: null },
        after: { published_at: row?.published_at ?? null },
        facts: { program_id: programId, kind, version: latest.version },
      });
      return latest.version;
    },
    MESSAGES,
  );
}

export interface LegalVersion {
  readonly id: string;
  readonly kind: LegalKind;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export async function listLegalVersions(sql: Sql, programId: string): Promise<LegalVersion[]> {
  return sql<LegalVersion[]>`
    SELECT id, kind, version, title, body, created_at AS "createdAt", published_at AS "publishedAt"
      FROM public.legal_pages WHERE program_id = ${programId} ORDER BY kind, version DESC`;
}

export interface LegalProgram {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** The newest published version per kind. */
  readonly published: Partial<Record<LegalKind, number>>;
}

export async function listLegalPrograms(sql: Sql): Promise<LegalProgram[]> {
  const rows = await sql<(Omit<LegalProgram, "published"> & { published: Partial<Record<LegalKind, number>> | null })[]>`
    SELECT p.id, p.name, p.slug,
           (SELECT json_object_agg(l.kind, l.version) FROM (
              SELECT DISTINCT ON (kind) kind, version FROM public.legal_pages
               WHERE program_id = p.id AND published_at IS NOT NULL ORDER BY kind, version DESC) l) AS published
      FROM public.programs p ORDER BY p.created_at DESC`;
  return rows.map((r) => ({ ...r, published: r.published ?? {} }));
}

export async function getLegalProgram(sql: Sql, programId: string): Promise<{ readonly name: string } | null> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM public.programs WHERE id = ${programId}`;
  return row ?? null;
}
