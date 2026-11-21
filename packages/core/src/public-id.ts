// The shape of an order's public id (orders_public_id_check): the one definition, in a leaf module with no
// imports, so browser code (the order page's script) and the proxy can use it without pulling in node:crypto
// (ids.ts, which draws new ids) or the rest of the core. `@ebooktrivia/core/public-id`.
/** The characters of a public id, as a RegExp source with no anchors (to build other patterns from). */
export const PUBLIC_ID_BODY = "[0-9A-Za-z]{16,40}";
export const PUBLIC_ID_PATTERN = new RegExp(`^${PUBLIC_ID_BODY}$`);
