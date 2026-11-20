-- US-019: no personal-data word in an adnet's click-id parameter name: the landing-page SDK captures, stores
-- and sends whatever that parameter carries (a parameter named "email" would put the buyer's address in the
-- click id). WHOLE words only, delimited by _ . - or the ends of the name ("no_hp" and "session_id" are
-- refused, "swap_id" and "hpid" are not); the delimiters are spelled out because \b and \m differ between
-- PostgreSQL and JavaScript, and SDK_PATTERNS.personalParamName is the same pattern. ADD CONSTRAINT fails
-- loudly when an existing adnet already uses such a name: rename its clickid_param first (pre-check in
-- docs/runbooks/staging-provision.md).
ALTER TABLE "adnets" ADD CONSTRAINT "adnets_clickid_param_personal_check" CHECK ("adnets"."clickid_param" !~* '(^|[_.-])(phone|hp|wa|whatsapp|nama|name|email|mail|token|otp|kode|nik|ktp|card|kartu|pass|password|pwd|secret|auth|session)($|[_.-])');