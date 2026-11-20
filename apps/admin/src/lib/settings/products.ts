// Products (ebooks; AC-A3 "products (PDF upload)", US-017). Title and the PDF are content (Staff,
// product.content.edit); the price and whether it is on sale are Owner-only (product.price.edit,
// AC-A1 "prices"). The PDF goes up through the chunked upload (lib/settings/uploads.ts).
import { type FieldKind, type Tx, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { InvalidInput, singleLine, wholeNumber } from "./fields.ts";

export const PRODUCT_FIELDS: Readonly<Record<string, FieldKind>> = { title: "value", price_idr: "value", active: "value", pdf_upload_id: "value" };

export const MAX_PRICE_IDR = 100_000_000;

export const parseTitle = (raw: string): string => singleLine(raw, "Enter a title (up to 200 characters).", { max: 200 });
export const parsePrice = (raw: string): number =>
  wholeNumber(raw.replace(/[.\s]/g, ""), `Enter the price in whole rupiah (1 to ${MAX_PRICE_IDR.toLocaleString("id-ID")}).`, { min: 1, max: MAX_PRICE_IDR });

export async function createProduct(sql: Sql, input: { readonly title: string; readonly priceIdr: number }): Promise<string> {
  return withAudit(sql, async (tx, audit) => {
    const values = { title: input.title, price_idr: input.priceIdr, active: true };
    const [row] = await tx<{ id: string }[]>`INSERT INTO public.products ${tx(values)} RETURNING id`;
    const id = row?.id ?? "";
    audit({ action: "product.create", entityType: "product", entityId: id, fields: PRODUCT_FIELDS, after: values });
    return id;
  });
}

async function current(tx: Tx, id: string) {
  const [row] = await tx<{ title: string; price_idr: number; active: boolean }[]>`
    SELECT title, price_idr::float8 AS price_idr, active FROM public.products WHERE id = ${id} FOR UPDATE`;
  if (row === undefined) throw new InvalidInput("This product no longer exists.");
  return row;
}

/** Content: the title (Staff and Owner). */
export async function renameProduct(sql: Sql, id: string, title: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const before = await current(tx, id);
    await tx`UPDATE public.products SET title = ${title}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({ action: "product.update", entityType: "product", entityId: id, fields: PRODUCT_FIELDS, before: { title: before.title }, after: { title } });
  });
}

/** Owner: price and on-sale flag. Orders keep the amount they were created with (amount_idr). */
export async function updateProductCommerce(sql: Sql, id: string, input: { readonly priceIdr: number; readonly active: boolean }): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const before = await current(tx, id);
    await tx`UPDATE public.products SET price_idr = ${input.priceIdr}, active = ${input.active}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({
      action: "product.update_price",
      entityType: "product",
      entityId: id,
      fields: PRODUCT_FIELDS,
      before: { price_idr: before.price_idr, active: before.active },
      after: { price_idr: input.priceIdr, active: input.active },
    });
  });
}

export interface ProductRow {
  readonly id: string;
  readonly title: string;
  readonly priceIdr: number;
  readonly active: boolean;
  readonly pdfUploadId: string | null;
  readonly pdfBytes: number | null;
  readonly pdfUploadedAt: Date | null;
}

export async function listProducts(sql: Sql): Promise<ProductRow[]> {
  return sql<ProductRow[]>`
    SELECT p.id, p.title, p.price_idr::float8 AS "priceIdr", p.active, p.pdf_upload_id AS "pdfUploadId",
           u.size_bytes::float8 AS "pdfBytes", u.created_at AS "pdfUploadedAt"
      FROM public.products p LEFT JOIN public.uploads u ON u.id = p.pdf_upload_id
     ORDER BY p.created_at DESC`;
}
