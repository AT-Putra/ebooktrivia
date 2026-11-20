import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { CheckboxField, PageHeading, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { PDF_WARN_BYTES } from "../../../../lib/settings/env.ts";
import { listProducts } from "../../../../lib/settings/products.ts";
import { createProductAction, renameProductAction, updateProductCommerceAction } from "./actions.ts";
import { PdfUpload } from "./pdf-upload.tsx";

export const metadata: Metadata = { title: "Products | Admin Console" };

const IDR = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const MB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Products (ebooks): title and PDF for Staff and Owner; price and on-sale for the Owner only. */
export default async function ProductsPage() {
  const admin = await requireAdmin({ permission: "product.content.edit" });
  const rt = await getRuntime();
  const products = await listProducts(rt.sql);
  const ownerPrices = can(admin.role, "product.price.edit");
  const uploads = rt.settings.dataDir !== null;
  return (
    <>
      <PageHeading title="Products" description="Ebooks: title, price and the PDF buyers receive. PDFs over 20 MB need a confirmation; the limit is set on the server." />
      {ownerPrices ? (
        <Card>
          <CardTitle className="text-base">New product</CardTitle>
          <ActionForm action={createProductAction} submitLabel="Create product" testId="product-create" className="grid gap-3 sm:grid-cols-2">
            <TextField id="new-title" name="title" label="Title" maxLength={200} />
            <TextField id="new-price" name="priceIdr" label="Price (IDR)" inputMode="numeric" maxLength={14} />
          </ActionForm>
        </Card>
      ) : null}
      {products.map((product) => (
        <Card key={product.id} data-testid={`product-${product.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{product.title}</CardTitle>
            <Badge variant="secondary">{IDR.format(product.priceIdr)}</Badge>
            {product.active ? <Badge variant="success">On sale</Badge> : <Badge variant="warning">Not on sale</Badge>}
            {product.pdfUploadId === null ? (
              <Badge variant="destructive" data-testid="pdf-status">
                No PDF yet
              </Badge>
            ) : (
              <Badge variant="info" data-testid="pdf-status">
                PDF {MB(product.pdfBytes ?? 0)}
              </Badge>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <ActionForm action={renameProductAction} submitLabel="Save title" variant="secondary">
              <input type="hidden" name="productId" value={product.id} />
              <TextField id={`title-${product.id}`} name="title" label="Title" defaultValue={product.title} maxLength={200} />
            </ActionForm>
            {ownerPrices ? (
              <ActionForm action={updateProductCommerceAction} submitLabel="Save price" variant="secondary">
                <input type="hidden" name="productId" value={product.id} />
                <TextField id={`price-${product.id}`} name="priceIdr" label="Price (IDR)" inputMode="numeric" defaultValue={product.priceIdr} maxLength={14} />
                <CheckboxField id={`active-${product.id}`} name="active" label="On sale" defaultChecked={product.active} />
              </ActionForm>
            ) : null}
            {uploads ? (
              <PdfUpload productId={product.id} warnBytes={PDF_WARN_BYTES} maxBytes={rt.settings.pdfMaxBytes} />
            ) : (
              <CardDescription>PDF uploads are not configured on this server.</CardDescription>
            )}
          </div>
        </Card>
      ))}
    </>
  );
}
