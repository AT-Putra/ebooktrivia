// Chunked PDF upload, step "complete" (lib/next/pdf-upload-routes.ts). Staff and Owner (product content).
import { pdfComplete } from "../../../../lib/next/pdf-upload-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "product.content.edit" }, pdfComplete);
