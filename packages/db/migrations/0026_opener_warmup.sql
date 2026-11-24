-- Opener variety and warm-up for new WhatsApp numbers (Owner decision 2026-11-24). Additive: two nullable columns and seven more opener wordings.
--   - delivery_openers.variant_key: the key of the wording (message_templates.key) an opener was claimed with, so a number does not repeat the wordings of its last 3
--     openers. Text without a foreign key: the Owner may remove a wording, and old rows keep saying which one they used. NULL on the rows that exist now.
--   - waha_sessions.warmup_started_at: when a number's warm-up began (its daily budget of NEW contacts is held down for 21 WIB days, core delivery-pool). NULL = an
--     established number. The numbers that exist now are NEW numbers (Owner), so their warm-up starts now, at go-live.
--   - delivery_opener_4 .. delivery_opener_10: seven more wordings (Owner-approved text), added only where wordings already exist (a database that is only now being
--     seeded gets all ten from sql/seed.sql) and never over a wording that is there: 1 .. 3 and every edit of the Owner are untouched. A wording the Owner removes
--     later is not put back (sql/seed.sql seeds only while there is no wording at all).
ALTER TABLE "delivery_openers" ADD COLUMN "variant_key" text;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD COLUMN "warmup_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "waha_sessions" SET "warmup_started_at" = now();--> statement-breakpoint
INSERT INTO "message_templates" ("key", "channel", "locale", "subject", "body")
SELECT v."key", 'whatsapp', 'id', NULL, v."body"
  FROM (VALUES
    ('delivery_opener_4', '{sapaan} {nama}, ebook {judul_ebook} pesanan Anda sudah siap. Cukup balas pesan ini, nanti filenya kami kirim langsung di chat ini ya.'),
    ('delivery_opener_5', '[[Halo|Hai]] {nama}, pembayaran {judul_ebook} sudah masuk. Boleh balas "ok" supaya ebooknya kami kirim di sini?'),
    ('delivery_opener_6', '{sapaan} {nama}! Terima kasih atas pembelian {judul_ebook}. Balas chat ini kapan saja, ebooknya akan kami kirim ke nomor ini.'),
    ('delivery_opener_7', 'Hai {nama}, pesanan {judul_ebook} Anda sudah lunas. Supaya ebooknya bisa kami kirim lewat WhatsApp, [[cukup|tinggal]] balas pesan ini ya.'),
    ('delivery_opener_8', '{sapaan} {nama}, kami mau kirim ebook {judul_ebook} yang Anda beli. Balas pesan ini dulu ya, setelah itu filenya langsung kami kirim.'),
    ('delivery_opener_9', 'Halo {nama}, terima kasih sudah berbelanja. Ebook {judul_ebook} siap dikirim, [[balas|jawab]] pesan ini dengan kata apa saja ya.'),
    ('delivery_opener_10', '{sapaan} {nama}. Pembayaran untuk {judul_ebook} sudah kami terima, terima kasih! Silakan balas chat ini, ebooknya segera kami kirim.')
  ) AS v("key", "body")
 WHERE EXISTS (SELECT 1 FROM "message_templates" WHERE "key" LIKE 'delivery\_opener\_%' AND "channel" = 'whatsapp' AND "locale" = 'id')
ON CONFLICT ("key", "channel", "locale") DO NOTHING;
