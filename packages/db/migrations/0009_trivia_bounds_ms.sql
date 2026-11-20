-- US-018: answer and finish timestamps hold whole milliseconds (the override's SQL and
-- @ebooktrivia/core score in milliseconds). Rows written before this migration are truncated first;
-- a question, program default or setting outside the new bounds makes the migration fail loudly.
UPDATE "attempt_questions"
   SET "served_at" = date_trunc('milliseconds', "served_at"), "deadline_at" = date_trunc('milliseconds', "deadline_at"),
       "answered_at" = date_trunc('milliseconds', "answered_at")
 WHERE "served_at" <> date_trunc('milliseconds', "served_at") OR "deadline_at" <> date_trunc('milliseconds', "deadline_at")
    OR "answered_at" <> date_trunc('milliseconds', "answered_at");--> statement-breakpoint
UPDATE "set_attempts" SET "finished_at" = date_trunc('milliseconds', "finished_at") WHERE "finished_at" <> date_trunc('milliseconds', "finished_at");--> statement-breakpoint
UPDATE "player_program_stats" SET "finished_at" = date_trunc('milliseconds', "finished_at") WHERE "finished_at" <> date_trunc('milliseconds', "finished_at");--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT "programs_default_points_check";--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT "programs_default_timer_check";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_points_check";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_timer_seconds_check";--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_default_points_check" CHECK ("programs"."default_points" BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_default_timer_check" CHECK ("programs"."default_timer_seconds" BETWEEN 5 AND 600);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_points_check" CHECK ("questions"."points" BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_timer_seconds_check" CHECK ("questions"."timer_seconds" BETWEEN 5 AND 600);--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_bounds_check" CHECK (CASE WHEN "app_settings"."key" NOT IN ('otp.code_ttl_seconds', 'otp.max_attempts', 'otp.phone_cap', 'otp.phone_window_seconds', 'otp.ip_cap', 'otp.ip_window_seconds', 'otp.cooldown_seconds', 'orders.expiry_seconds') THEN true WHEN jsonb_typeof("app_settings"."value") <> 'number' THEN false ELSE CASE "app_settings"."key" WHEN 'otp.code_ttl_seconds' THEN (value #>> '{}')::numeric BETWEEN 60 AND 900 WHEN 'otp.max_attempts' THEN (value #>> '{}')::numeric BETWEEN 1 AND 5 WHEN 'otp.phone_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 10 WHEN 'otp.phone_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 3600 AND 86400 WHEN 'otp.ip_cap' THEN (value #>> '{}')::numeric BETWEEN 1 AND 100 WHEN 'otp.ip_window_seconds' THEN (value #>> '{}')::numeric BETWEEN 600 AND 86400 WHEN 'otp.cooldown_seconds' THEN (value #>> '{}')::numeric BETWEEN 15 AND 600 WHEN 'orders.expiry_seconds' THEN (value #>> '{}')::numeric BETWEEN 900 AND 86400 END END);--> statement-breakpoint
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_served_at_ms_check" CHECK ("attempt_questions"."served_at" = date_trunc('milliseconds', "attempt_questions"."served_at"));--> statement-breakpoint
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_deadline_at_ms_check" CHECK ("attempt_questions"."deadline_at" = date_trunc('milliseconds', "attempt_questions"."deadline_at"));--> statement-breakpoint
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_answered_at_ms_check" CHECK ("attempt_questions"."answered_at" = date_trunc('milliseconds', "attempt_questions"."answered_at"));--> statement-breakpoint
ALTER TABLE "player_program_stats" ADD CONSTRAINT "player_program_stats_score_check" CHECK ("player_program_stats"."score" >= 0);--> statement-breakpoint
ALTER TABLE "player_program_stats" ADD CONSTRAINT "player_program_stats_total_ms_check" CHECK ("player_program_stats"."total_ms" >= 0);--> statement-breakpoint
ALTER TABLE "player_program_stats" ADD CONSTRAINT "player_program_stats_sets_completed_check" CHECK ("player_program_stats"."sets_completed" >= 0);--> statement-breakpoint
ALTER TABLE "player_program_stats" ADD CONSTRAINT "player_program_stats_finished_at_ms_check" CHECK ("player_program_stats"."finished_at" = date_trunc('milliseconds', "player_program_stats"."finished_at"));--> statement-breakpoint
ALTER TABLE "set_attempts" ADD CONSTRAINT "set_attempts_finished_at_ms_check" CHECK ("set_attempts"."finished_at" = date_trunc('milliseconds', "set_attempts"."finished_at"));