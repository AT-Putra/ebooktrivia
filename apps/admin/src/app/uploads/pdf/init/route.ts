// Chunked PDF upload, step "init" (lib/next/pdf-upload-routes.ts). Staff and Owner (product content).
import { pdfInit } from "../../../../lib/next/pdf-upload-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "product.content.edit" }, pdfInit);
