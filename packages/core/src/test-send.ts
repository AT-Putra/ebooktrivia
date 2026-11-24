// Template test-sends (AC-A10; US-017): the outbox topic the admin console writes and the worker
// consumes, and the sample values both the console's preview and the worker's test message use.
// {kode_otp} and {link_trivia} are always rendered redacted ([kode_otp] / [link_trivia]), so a test
// never carries a real login code or link.
import type { MessageVariable } from "./template.ts";

export const TEST_SEND_TOPIC = "template.test_send";

export const TEST_SEND_SAMPLE_VALUES: Readonly<Record<MessageVariable, string>> = Object.freeze({
  nama: "Budi Santoso",
  judul_ebook: "Contoh Ebook",
  order_id: "CONTOH0001",
  link_trivia: "https://play.invalid/",
  kode_otp: "000000",
  sapaan: "Selamat pagi",
  cs_whatsapp: "0812-3456-7890",
  cs_email: "cs@contoh.id",
});
