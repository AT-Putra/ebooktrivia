import { createHash } from "node:crypto";

/** Midtrans signature_key: sha512hex(order_id + status_code + gross_amount + serverKey). */
export function midtransSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  serverKey: string,
): string {
  return createHash("sha512")
    .update(orderId + statusCode + grossAmount + serverKey)
    .digest("hex");
}

/** Basic auth header value: base64(serverKey + ":"). */
export function basicAuthHeader(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`;
}
