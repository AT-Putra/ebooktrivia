-- US-027 (M9b, the trivia page and question flow):
--   - player_programs.unlock_floor, the unlock floor of core unlock.ts (the highest set count the schedule formula
--     has unlocked for the player so far, raised by public.play_note_unlocked in sql/play.sql), so an extend-only
--     reschedule never locks a set the player was already shown as open;
--   - outbox_magic_link_resend_created_at_idx: the login-link resend's global breaker (sql/functions.sql
--     enqueue_magic_link_resend) counts that topic's rows of the last 10 minutes;
--   - outbox.deferrals: the claims a consumer deferred (apps/worker outbox-consumer.ts OutboxDefer: a login link
--     that waits for a contact at its limit). The claim cap is raised by them, and attempts never goes down, so
--     every claim keeps a BullMQ job id and a fencing token of its own.
-- Every other US-027 object (the play functions, their owner trivia_play, the grants) is in the re-applied sql/
-- files.
ALTER TABLE "outbox" ADD COLUMN "deferrals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_programs" ADD COLUMN "unlock_floor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_magic_link_resend_created_at_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."topic" = 'magic_link.resend';--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_deferrals_check" CHECK ("outbox"."deferrals" >= 0);--> statement-breakpoint
ALTER TABLE "player_programs" ADD CONSTRAINT "player_programs_unlock_floor_check" CHECK ("player_programs"."unlock_floor" >= 0);
