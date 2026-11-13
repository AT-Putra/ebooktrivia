-- US-013: the internal process (apps/worker --role=internal) serves Caddy's on-demand TLS `ask`
-- from an in-memory set of lp_domains hosts. Every committed write to lp_domains NOTIFYs
-- lp_domains_changed (payload = TG_OP) so it reloads the set; NOTIFY is delivered on commit only
-- and identical notifications of one transaction are folded into one.
-- Statement level, so a bulk change costs one notification. SECURITY INVOKER: pg_notify needs no
-- extra rights, so the function runs as the writer. Same rules as sql/functions.sql: pinned
-- search_path, no EXECUTE for PUBLIC, and the trigger fires ALWAYS (also under
-- session_replication_role = replica), like the guard triggers in sql/triggers.sql.
CREATE OR REPLACE FUNCTION public.lp_domains_notify()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM pg_notify('lp_domains_changed', TG_OP);
  RETURN NULL;
END
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lp_domains_notify() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER lp_domains_notify
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.lp_domains
  FOR EACH STATEMENT EXECUTE FUNCTION public.lp_domains_notify();--> statement-breakpoint
ALTER TABLE public.lp_domains ENABLE ALWAYS TRIGGER lp_domains_notify;
