-- fulfillment.sql: the Owner's prize fulfilment (US-030; plan M10 item 2, the Owner decision under M5a: prize fulfilment is
-- Owner-only; spec AC-A9).
--
-- Applied by src/migrate.ts after play.sql, as the connecting role (a superuser), like contest.sql: every function here is owned
-- by prize_fulfillment (roles.sql: NOLOGIN, no members, member of nothing), which only a superuser can arrange without making
-- migrator a member of it. Re-runnable: roles.sql drops these functions (every signature) at the start of every run, and this
-- file creates them again with their owner and grants.
--
-- Why a dedicated owner: the fulfilment guard (triggers.sql fulfillments_machine_guard, ET175) lets ONLY current_user =
-- 'prize_fulfillment' move a fulfilment, which holds inside these SECURITY DEFINER functions and nowhere else; admin_rw holds no
-- INSERT, UPDATE or DELETE on fulfillments (grants.sql). So the machine below is the database's, not only the console's:
--   - a fulfilment exists for a confirmed winner of a finalized program (sql/contest.sql creates it pending);
--   - pending -> contacted -> sent -> done, EXACTLY one step forward at a time, each stamping the actor and the time;
--   - a correction goes back EXACTLY one step, with a written reason (10-500 characters, no contact details), and clears the
--     stamps of the step it undoes (the audit log keeps the history). Why allow it at all: a click on the wrong row or a step
--     marked before it really happened is a real mistake the Owner must be able to fix without a database session, and one
--     audited, reasoned step back cannot skip, hide or rewrite anything else;
--   - done is final (the prize was delivered): no correction out of it;
--   - a flagged or revoked winner (a chargeback, a revoke) is halted (ET082, as fulfillments_halt_guard): no step and no proof
--     until the Owner reinstates or re-awards (sql/contest.sql); notes stay editable;
--   - the caller passes the status it saw (p_from): a stale one is refused (ET172), and a repeat of a step already made changes
--     nothing (idempotent, `changed` false), so two clicks or two Owners never move a fulfilment twice.
-- Notes are plain text (at most 2000 characters; the console renders them as text, never HTML) and may name the winner: the
-- audit row records only that they changed (pii_refs). The proof is an upload of kind proof (@ebooktrivia/uploads policy: JPEG,
-- PNG, WebP or PDF; the console caps a proof at 4 MiB, one request under Caddy's 30 s body timeout), stored privately by the
-- admin app under its data directory (proofs/), never served publicly.
-- REPLACING A PROOF DELETES THE OLD ONE (its uploads row here, its file by the admin app right after the commit; the upload
-- sweeper removes a proof file left without a row): one current proof per fulfilment, and no stale photo of a winner is kept.
-- The audit row names both upload ids.
--
-- Every function: SET search_path = pg_catalog, pg_temp with every object of ours schema-qualified; EXECUTE revoked from PUBLIC
-- and granted to admin_rw only (Owner-only in the console, policy prize_fulfillment.update, and checked here: the actor must be
-- an active Owner, ET171); time from clock_timestamp(); READ COMMITTED (ET170). Locks: the fulfilment FOR UPDATE, then its
-- winner FOR SHARE, so a chargeback flag (US-021) or a revoke either commits first (and halts this) or waits for it.

SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false);

CREATE OR REPLACE FUNCTION public.fulfillment_step(
  p_fulfillment_id uuid,
  p_from text,
  p_to text,
  p_reason text,
  p_actor_admin_user_id text,
  p_request_id text,
  p_ip inet
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_steps CONSTANT text[] := ARRAY['pending', 'contacted', 'sent', 'done'];
  v_from integer := array_position(v_steps, p_from);
  v_to integer := array_position(v_steps, p_to);
  v_back boolean;
  v_winner uuid;
  v_current public.fulfillment_status;
  v_winner_status public.winner_status;
  v_program uuid;
  v_program_status public.program_status;
  v_now timestamptz := clock_timestamp();
  v_changes jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a fulfilment step must run under READ COMMITTED' USING ERRCODE = 'ET170';
  END IF;
  IF p_fulfillment_id IS NULL OR v_from IS NULL OR v_to IS NULL THEN
    RAISE EXCEPTION 'fulfillment_step: the fulfilment and two of pending, contacted, sent, done are required' USING ERRCODE = 'ET171';
  END IF;
  IF abs(v_to - v_from) <> 1 OR p_from = 'done' THEN
    RAISE EXCEPTION 'a fulfilment moves exactly one step, and done is final: % -> % refused', p_from, p_to USING ERRCODE = 'ET172';
  END IF;
  v_back := v_to < v_from;
  IF v_back AND (p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 10 AND 500
                 OR p_reason ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
                 OR p_reason ~ '(\+?62[[:space:].-]?|\m0)8[0-9[:space:].-]{7,}|[0-9]{10,}') THEN
    RAISE EXCEPTION 'a correction one step back needs a reason of 10-500 characters without contact details' USING ERRCODE = 'ET171';
  END IF;
  IF p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'fulfillment_step: the actor must be an active Owner' USING ERRCODE = 'ET171';
  END IF;

  SELECT f.winner_id, f.status INTO v_winner, v_current FROM public.fulfillments f WHERE f.id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_step: unknown fulfilment' USING ERRCODE = 'ET171';
  END IF;
  SELECT w.status, w.program_id INTO v_winner_status, v_program FROM public.winners w WHERE w.id = v_winner FOR SHARE;
  SELECT p.status INTO v_program_status FROM public.programs p WHERE p.id = v_program;
  IF v_winner_status IN ('flagged', 'revoked') THEN
    RAISE EXCEPTION 'fulfillment is halted: the winner is flagged or revoked' USING ERRCODE = 'ET082';
  END IF;
  IF v_winner_status IS DISTINCT FROM 'confirmed' OR v_program_status IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'only a confirmed winner of a finalized program is fulfilled' USING ERRCODE = 'ET172';
  END IF;
  IF v_current::text = p_to THEN
    RETURN jsonb_build_object('fulfillment_id', p_fulfillment_id, 'winner_id', v_winner, 'status', v_current, 'changed', false);
  END IF;
  IF v_current::text <> p_from THEN
    RAISE EXCEPTION 'the fulfilment is % now, not %: reload and try again', v_current, p_from USING ERRCODE = 'ET172';
  END IF;

  UPDATE public.fulfillments f
     SET status = p_to::public.fulfillment_status,
         contacted_at = CASE WHEN p_to = 'contacted' AND NOT v_back THEN v_now WHEN p_to = 'pending' THEN NULL ELSE f.contacted_at END,
         contacted_by_admin_user_id = CASE WHEN p_to = 'contacted' AND NOT v_back THEN p_actor_admin_user_id WHEN p_to = 'pending' THEN NULL
                                          ELSE f.contacted_by_admin_user_id END,
         sent_at = CASE WHEN p_to = 'sent' THEN v_now WHEN p_to = 'contacted' AND v_back THEN NULL ELSE f.sent_at END,
         sent_by_admin_user_id = CASE WHEN p_to = 'sent' THEN p_actor_admin_user_id WHEN p_to = 'contacted' AND v_back THEN NULL
                                     ELSE f.sent_by_admin_user_id END,
         done_at = CASE WHEN p_to = 'done' THEN v_now ELSE f.done_at END,
         done_by_admin_user_id = CASE WHEN p_to = 'done' THEN p_actor_admin_user_id ELSE f.done_by_admin_user_id END,
         correction_reason = CASE WHEN v_back THEN btrim(p_reason) ELSE f.correction_reason END,
         updated_at = v_now
   WHERE f.id = p_fulfillment_id;

  v_changes := jsonb_build_object('program_id', v_program, 'winner_id', v_winner,
                                  'status', jsonb_build_object('before', v_current, 'after', p_to));
  -- A correction's reason is free text that may name the winner: it is kept on the row (correction_reason, above; an erasure
  -- blanks it) and the append-only audit only records that one was given.
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, CASE WHEN v_back THEN 'fulfillment.correct' ELSE 'fulfillment.advance' END, 'fulfillment',
          p_fulfillment_id::text, v_changes,
          CASE WHEN v_back THEN ARRAY['fulfillment:' || p_fulfillment_id::text || '.correction_reason set'] ELSE '{}'::text[] END,
          p_request_id, p_ip);
  RETURN jsonb_build_object('fulfillment_id', p_fulfillment_id, 'winner_id', v_winner, 'status', p_to, 'changed', true);
END
$fn$;

-- The Owner's notes on a fulfilment: plain text, trimmed, at most 2000 characters; empty clears them. Editable while the winner is
-- halted (a chargeback is exactly when notes matter). The audit row records that they changed, never what they say.
CREATE OR REPLACE FUNCTION public.fulfillment_set_notes(
  p_fulfillment_id uuid,
  p_notes text,
  p_actor_admin_user_id text,
  p_request_id text,
  p_ip inet
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_old text;
  v_winner uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'fulfilment notes must be saved under READ COMMITTED' USING ERRCODE = 'ET170';
  END IF;
  IF p_fulfillment_id IS NULL OR char_length(v_notes) > 2000 OR v_notes ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
    RAISE EXCEPTION 'fulfillment_set_notes: the fulfilment and plain-text notes of at most 2000 characters are required' USING ERRCODE = 'ET171';
  END IF;
  IF p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'fulfillment_set_notes: the actor must be an active Owner' USING ERRCODE = 'ET171';
  END IF;
  SELECT f.notes, f.winner_id INTO v_old, v_winner FROM public.fulfillments f WHERE f.id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_set_notes: unknown fulfilment' USING ERRCODE = 'ET171';
  END IF;
  IF v_old IS NOT DISTINCT FROM v_notes THEN
    RETURN jsonb_build_object('fulfillment_id', p_fulfillment_id, 'changed', false);
  END IF;
  UPDATE public.fulfillments SET notes = v_notes, updated_at = clock_timestamp() WHERE id = p_fulfillment_id;
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'fulfillment.notes', 'fulfillment', p_fulfillment_id::text,
          jsonb_build_object('winner_id', v_winner, 'notes_length', coalesce(char_length(v_notes), 0)),
          ARRAY['fulfillment:' || p_fulfillment_id::text || '.notes ' || CASE WHEN v_old IS NULL THEN 'set' WHEN v_notes IS NULL THEN 'cleared' ELSE 'changed' END],
          p_request_id, p_ip);
  RETURN jsonb_build_object('fulfillment_id', p_fulfillment_id, 'changed', true);
END
$fn$;

-- The proof of a fulfilment (a photo, a screenshot or a PDF receipt): the admin app checks the bytes with the upload policy, writes
-- the file under proofs/ and inserts its uploads row (kind proof) in the transaction that calls this. Halted for a flagged or
-- revoked winner (ET082); only for a confirmed winner of a finalized program (ET172). The previous proof, if any, is deleted
-- (see the header): its storage path is returned so the app removes the file after the commit.
CREATE OR REPLACE FUNCTION public.fulfillment_set_proof(
  p_fulfillment_id uuid,
  p_upload_id uuid,
  p_actor_admin_user_id text,
  p_request_id text,
  p_ip inet
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_winner uuid;
  v_old uuid;
  v_old_path text;
  v_winner_status public.winner_status;
  v_program_status public.program_status;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a fulfilment proof must be set under READ COMMITTED' USING ERRCODE = 'ET170';
  END IF;
  IF p_fulfillment_id IS NULL OR p_upload_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.uploads u WHERE u.id = p_upload_id AND u.kind = 'proof' AND u.storage_path ~ '^proofs/[0-9a-f-]{36}\.(webp|pdf)$'
  ) THEN
    RAISE EXCEPTION 'fulfillment_set_proof: the fulfilment and an upload of kind proof are required' USING ERRCODE = 'ET171';
  END IF;
  IF p_actor_admin_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_profiles ap
     WHERE ap.auth_user_id = p_actor_admin_user_id AND ap.role = 'owner' AND ap.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'fulfillment_set_proof: the actor must be an active Owner' USING ERRCODE = 'ET171';
  END IF;
  SELECT f.winner_id, f.proof_upload_id INTO v_winner, v_old FROM public.fulfillments f WHERE f.id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_set_proof: unknown fulfilment' USING ERRCODE = 'ET171';
  END IF;
  SELECT w.status, p.status INTO v_winner_status, v_program_status
    FROM public.winners w JOIN public.programs p ON p.id = w.program_id WHERE w.id = v_winner FOR SHARE OF w;
  IF v_winner_status IN ('flagged', 'revoked') THEN
    RAISE EXCEPTION 'fulfillment is halted: the winner is flagged or revoked' USING ERRCODE = 'ET082';
  END IF;
  IF v_winner_status IS DISTINCT FROM 'confirmed' OR v_program_status IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'only a confirmed winner of a finalized program is fulfilled' USING ERRCODE = 'ET172';
  END IF;
  IF v_old IS NOT DISTINCT FROM p_upload_id THEN
    RETURN jsonb_build_object('fulfillment_id', p_fulfillment_id, 'changed', false, 'replaced_storage_path', NULL);
  END IF;
  UPDATE public.fulfillments SET proof_upload_id = p_upload_id, updated_at = clock_timestamp() WHERE id = p_fulfillment_id;
  IF v_old IS NOT NULL THEN
    DELETE FROM public.uploads u WHERE u.id = v_old AND u.kind = 'proof' RETURNING u.storage_path INTO v_old_path;
  END IF;
  INSERT INTO public.audit_log (actor_kind, actor_admin_user_id, action, entity_type, entity_id, changes, pii_refs, request_id, ip)
  VALUES ('admin', p_actor_admin_user_id, 'fulfillment.proof', 'fulfillment', p_fulfillment_id::text,
          jsonb_build_object('winner_id', v_winner, 'upload_id', p_upload_id, 'replaced_upload_id', v_old),
          ARRAY['fulfillment:' || p_fulfillment_id::text || '.proof ' || CASE WHEN v_old IS NULL THEN 'set' ELSE 'changed' END],
          p_request_id, p_ip);
  RETURN jsonb_build_object('fulfillment_id', p_fulfillment_id, 'changed', true, 'replaced_storage_path', v_old_path);
END
$fn$;

ALTER FUNCTION public.fulfillment_step(uuid, text, text, text, text, text, inet) OWNER TO prize_fulfillment;
ALTER FUNCTION public.fulfillment_set_notes(uuid, text, text, text, inet) OWNER TO prize_fulfillment;
ALTER FUNCTION public.fulfillment_set_proof(uuid, uuid, text, text, inet) OWNER TO prize_fulfillment;

REVOKE ALL ON FUNCTION public.fulfillment_step(uuid, text, text, text, text, text, inet) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.fulfillment_set_notes(uuid, text, text, text, inet) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;
REVOKE ALL ON FUNCTION public.fulfillment_set_proof(uuid, uuid, text, text, inet) FROM PUBLIC, public_rw, admin_rw, worker_rw, internal_rw, migrator;

GRANT EXECUTE ON FUNCTION public.fulfillment_step(uuid, text, text, text, text, text, inet),
  public.fulfillment_set_notes(uuid, text, text, text, inet),
  public.fulfillment_set_proof(uuid, uuid, text, text, inet)
  TO admin_rw;
