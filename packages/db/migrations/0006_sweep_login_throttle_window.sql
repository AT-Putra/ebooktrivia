-- US-016 code review F6: public.sweep_login_throttle now takes the throttle window as an argument
-- (sql/functions.sql re-creates it after the migrations). Drop the argument-less version, which
-- hardcoded 15 minutes, so no second overload stays executable.
DROP FUNCTION IF EXISTS public.sweep_login_throttle();
