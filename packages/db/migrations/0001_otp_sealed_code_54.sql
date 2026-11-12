ALTER TABLE "player_otps" DROP CONSTRAINT "player_otps_sealed_code_check";--> statement-breakpoint
-- Intentional (security review US-011 #15): OTP rows sealed before US-011 may be 48..128 bytes.
-- They are short-lived (5 min, single use), so delete them rather than fail ADD CONSTRAINT on an
-- existing dev/staging database. test/migrations.int.test.ts covers this upgrade path.
DELETE FROM "player_otps" WHERE octet_length("sealed_code") <> 54;--> statement-breakpoint
ALTER TABLE "player_otps" ADD CONSTRAINT "player_otps_sealed_code_check" CHECK (octet_length("player_otps"."sealed_code") = 54);
