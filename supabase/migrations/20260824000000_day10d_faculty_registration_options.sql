-- ============================================================================
-- Day 10D — Faculty Registration Options RPC (anonymous reference-data read)
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 .. Day 10C migrations. It is idempotent (create or replace) so it
-- can be re-run safely.
--
-- WHY THIS EXISTS
--   The /faculty/register page (Day 10C) must render "Department: ECS" and the
--   ECS complaint categories IMMEDIATELY when an anonymous visitor opens it —
--   before they have signed up, verified their email or signed in. But the
--   Day 3 grants make public.departments / public.complaint_categories /
--   public.category_department_map SELECT-only for `authenticated`, with RLS
--   policies scoped to authenticated too — so an anonymous visitor got a
--   permission error and the page showed "Could not load the registration
--   options."
--
--   This migration adds ONE new read-only SECURITY DEFINER RPC,
--   public.get_faculty_registration_options(), executable by anon AND
--   authenticated, that returns exactly the public reference data the
--   registration page needs: the departments and the complaint categories
--   mapped to each department via the existing category_department_map table
--   (id + name + is_sensitive). Nothing else — no identity, no registration
--   code/hash, no write path.
--
--   It is purely ADDITIVE: no existing grants, policies, tables or functions
--   are modified. The strict Day 3 grant model for the reference tables is
--   untouched — anonymous gains no table access at all, only the ability to
--   call this one function (which the migration deliberately grants).
--
--   The RPC is NOT authorization for anything: public.register_faculty (Day
--   10C) still re-validates the department and every category inside the
--   database before elevating a profile. The frontend displaying ECS is
--   purely presentational — the registration code gate, verified-email
--   requirement, role checks, sensitive-category rejection, department /
--   category_department_map validation and atomic assignment creation are all
--   unchanged.
-- ============================================================================

create or replace function public.get_faculty_registration_options()
returns table (
  department_id   uuid,
  department_name text,
  category_id     uuid,
  category_name   text,
  is_sensitive    boolean
)
language sql
security definer
set search_path = public
as $$
  select d.id, d.name, cc.id, cc.name, cc.is_sensitive
    from public.departments d
    join public.category_department_map m on m.department_id = d.id
    join public.complaint_categories cc on cc.id = m.category_id
   order by d.name, cc.name;
$$;

-- Executable by anon + authenticated ONLY. This is the same "public reference
-- data, no identity inside" the Day 3 migration already describes for these
-- tables — the RPC is simply the anonymous read path for the public
-- registration page. No client role gets write access through this function
-- (it is a SELECT-only RPC), and the registration code / hash is never
-- touched.
revoke all on function public.get_faculty_registration_options() from public;
grant execute on function public.get_faculty_registration_options() to anon, authenticated;
