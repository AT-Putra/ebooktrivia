// Chunked PDF upload, step "chunk" (lib/next/pdf-upload-routes.ts). Staff and Owner (product content).
import { pdfChunk } from "../../../../lib/next/pdf-upload-routes.ts";
import { adminRoute } from "../../../../lib/next/route.ts";

export const POST = adminRoute({ permission: "product.content.edit" }, pdfChunk);
