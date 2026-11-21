-- US-030 (M10b, prize fulfilment and UU PDP deletion = anonymization):
--   - fulfillments: who and when of each step (contacted / sent / done), a length cap on the notes, the last correction's
--     reason, one fulfilment per proof upload; the steps check holds the stamps to the status (sql/fulfillment.sql moves it,
--     one step at a time);
--   - winners.replaces_winner_id: the revoked winner a re-award replaces (sql/contest.sql revoke_winner), at most once;
--     winners.decision_reason: the reason of the last revoke or reinstatement (free text stays out of the append-only audit log);
--   - orders.anonymized_at, buyer_phone nullable for anonymized rows only, the anonymized-row check, and an index on
--     buyer_phone (a deletion request finds the subject's orders by phone; the stranger retention of wa_contacts);
--   - players_anonymized_check: an anonymized player keeps only its id;
--   - deliveries_wa_chat_id_check: the chat id has the shape the erasure matches; deliveries_reply_chat_id_check re-added with the
--     same pattern (0018's lacked the `\.` escape, so `c.us` matched any character);
--   - deletion_requests: the request's lookup kind, the subject's phone while pending, the decision (completed by
--     sql/privacy.sql erase_data_subject, or rejected with a reason) and the erasure's summary.
-- Backfills before the new checks: stamps for a fulfilment row that is already past pending (none is expected: nothing
-- wrote them before US-030), and a pending fulfilment for every confirmed winner of a finalized program (US-028
-- confirmations made before US-030 created none). Every other US-030 object (the functions, their owners prize_fulfillment
-- and pii_eraser, the guards, the grants) is in the re-applied sql/ files.
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_reply_chat_id_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "buyer_phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_requests" ALTER COLUMN "player_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "lookup_kind" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "subject_phone" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "decided_by_admin_user_id" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "summary" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "contacted_by_admin_user_id" text;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "sent_by_admin_user_id" text;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "done_by_admin_user_id" text;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "winners" ADD COLUMN "replaces_winner_id" uuid;--> statement-breakpoint
ALTER TABLE "winners" ADD COLUMN "decision_reason" text;--> statement-breakpoint
UPDATE "fulfillments" SET "contacted_at" = "updated_at", "contacted_by_admin_user_id" = 'unknown' WHERE "status" IN ('contacted', 'sent', 'done');--> statement-breakpoint
UPDATE "fulfillments" SET "sent_at" = "updated_at", "sent_by_admin_user_id" = 'unknown' WHERE "status" IN ('sent', 'done');--> statement-breakpoint
UPDATE "fulfillments" SET "done_at" = "updated_at", "done_by_admin_user_id" = 'unknown' WHERE "status" = 'done';--> statement-breakpoint
INSERT INTO "fulfillments" ("winner_id") SELECT w."id" FROM "winners" w JOIN "programs" p ON p."id" = w."program_id" WHERE w."status" = 'confirmed' AND p."status" = 'finalized' ON CONFLICT ("winner_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_replaces_winner_id_winners_id_fk" FOREIGN KEY ("replaces_winner_id") REFERENCES "public"."winners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_buyer_phone_idx" ON "orders" USING btree ("buyer_phone");--> statement-breakpoint
CREATE INDEX "deletion_requests_status_idx" ON "deletion_requests" USING btree ("status","requested_at");--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_proof_upload_id_key" UNIQUE("proof_upload_id");--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_replaces_winner_id_key" UNIQUE("replaces_winner_id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_wa_chat_id_check" CHECK ("deliveries"."wa_chat_id" IS NULL OR "deliveries"."wa_chat_id" ~ '^[0-9]{5,20}@(c\.us|lid)$');--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reply_chat_id_check" CHECK ("deliveries"."reply_chat_id" IS NULL OR "deliveries"."reply_chat_id" ~ '^[0-9]{5,20}@(c\.us|lid)$');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_phone_present_check" CHECK ("orders"."buyer_phone" IS NOT NULL OR "orders"."anonymized_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_anonymized_check" CHECK ("orders"."anonymized_at" IS NULL OR ("orders"."buyer_phone" IS NULL AND "orders"."buyer_name" = '' AND "orders"."buyer_email" = '' AND "orders"."ip" IS NULL AND "orders"."ua_hash" IS NULL
          AND "orders"."fbclid" IS NULL AND "orders"."fbp" IS NULL AND "orders"."fbc" IS NULL AND "orders"."ttclid" IS NULL AND "orders"."gclid" IS NULL));--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_lookup_kind_check" CHECK ("deletion_requests"."lookup_kind" IS NULL OR "deletion_requests"."lookup_kind" IN ('phone', 'email', 'order'));--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_subject_phone_check" CHECK ("deletion_requests"."subject_phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_state_check" CHECK (("deletion_requests"."status" = 'pending') = ("deletion_requests"."subject_phone" IS NOT NULL) AND ("deletion_requests"."status" = 'completed') = ("deletion_requests"."completed_at" IS NOT NULL)
          AND ("deletion_requests"."status" = 'rejected') = ("deletion_requests"."rejected_at" IS NOT NULL AND "deletion_requests"."decision_note" IS NOT NULL)
          AND ("deletion_requests"."status" = 'pending') = ("deletion_requests"."decided_by_admin_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_note_check" CHECK ("deletion_requests"."note" IS NULL OR char_length("deletion_requests"."note") BETWEEN 1 AND 500);--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_decision_note_check" CHECK ("deletion_requests"."decision_note" IS NULL OR char_length("deletion_requests"."decision_note") BETWEEN 10 AND 500);--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_summary_check" CHECK (jsonb_typeof("deletion_requests"."summary") = 'object');--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_notes_check" CHECK ("fulfillments"."notes" IS NULL OR char_length("fulfillments"."notes") BETWEEN 1 AND 2000);--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_correction_reason_check" CHECK ("fulfillments"."correction_reason" IS NULL OR char_length("fulfillments"."correction_reason") BETWEEN 10 AND 500);--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_steps_check" CHECK (("fulfillments"."status" IN ('contacted', 'sent', 'done')) = ("fulfillments"."contacted_at" IS NOT NULL) AND ("fulfillments"."contacted_at" IS NULL) = ("fulfillments"."contacted_by_admin_user_id" IS NULL)
          AND ("fulfillments"."status" IN ('sent', 'done')) = ("fulfillments"."sent_at" IS NOT NULL) AND ("fulfillments"."sent_at" IS NULL) = ("fulfillments"."sent_by_admin_user_id" IS NULL)
          AND ("fulfillments"."status" = 'done') = ("fulfillments"."done_at" IS NOT NULL) AND ("fulfillments"."done_at" IS NULL) = ("fulfillments"."done_by_admin_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_decision_reason_check" CHECK ("winners"."decision_reason" IS NULL OR char_length("winners"."decision_reason") BETWEEN 10 AND 500);--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_anonymized_check" CHECK ("players"."anonymized_at" IS NULL OR ("players"."phone" IS NULL AND "players"."email" IS NULL AND "players"."auth_user_id" IS NULL AND "players"."name" = ''));