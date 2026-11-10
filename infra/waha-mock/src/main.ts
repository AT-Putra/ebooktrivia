import { serve } from "@hono/node-server";
import { createWahaMockApp } from "./app.ts";

// DEV ONLY defaults; override via environment.
const app = createWahaMockApp({
  apiKey: process.env["WAHA_MOCK_API_KEY"] ?? "devonly-waha-key",
  webhookHmacSecret: process.env["WAHA_MOCK_WEBHOOK_HMAC_SECRET"] ?? "devonly-waha-hmac",
});
const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`waha-mock listening on :${port}`);
