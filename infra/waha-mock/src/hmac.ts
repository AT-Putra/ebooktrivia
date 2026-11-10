import { createHmac } from "node:crypto";

/** Hex HMAC-SHA512 of the exact raw webhook body, as sent in X-Webhook-Hmac. */
export function webhookHmacSha512(rawBody: string, secret: string): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}
