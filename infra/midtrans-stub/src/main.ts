import { serve } from "@hono/node-server";
import { createMidtransStubApp } from "./app.ts";

// DEV ONLY default; override via environment.
const app = createMidtransStubApp({
  serverKey: process.env["MIDTRANS_STUB_SERVER_KEY"] ?? "SB-Mid-server-DEVONLY",
});
const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`midtrans-stub listening on :${port}`);
