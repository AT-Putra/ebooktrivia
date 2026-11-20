"use server";
// Title: Staff and Owner (product.content.edit). Creating a product and its price / on-sale flag:
// Owner only (product.price.edit, AC-A1 "prices"). The PDF goes up through /uploads/pdf/*.
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { checkbox, formValue, uuid } from "../../../../lib/settings/fields.ts";
import { createProduct, parsePrice, parseTitle, renameProduct, updateProductCommerce } from "../../../../lib/settings/products.ts";

const PATH = "/settings/products";

export const createProductAction = adminAction({ permission: "product.price.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await createProduct(rt.sql, { title: parseTitle(formValue(form, "title")), priceIdr: parsePrice(formValue(form, "priceIdr")) });
    return "Product created. Upload its PDF next.";
  }),
);

export const renameProductAction = adminAction({ permission: "product.content.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await renameProduct(rt.sql, uuid(formValue(form, "productId")), parseTitle(formValue(form, "title")));
    return "Title saved.";
  }),
);

export const updateProductCommerceAction = adminAction({ permission: "product.price.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await updateProductCommerce(rt.sql, uuid(formValue(form, "productId")), { priceIdr: parsePrice(formValue(form, "priceIdr")), active: checkbox(form, "active") });
    return "Price saved.";
  }),
);
