-- ============================================================================
-- Day 10E — Faculty registration without email confirmation
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 .. Day 10D migrations. It is idempotent (create or replace) so it
-- can be re-run safely; it does NOT edit any previous migration.
--
-- WHY THIS EXISTS
--   Supabase Email Confirmation is intentionally OFF for this MVP. The Day 10C
--   register_faculty() RPC still required auth.users.email_confirmed_at to be
--   non-null, which would reject every new signup (with confirmation off,
--   sign-up returns an authenticated session immediately and there is no
--   email-verification step). This migration re-creates register_faculty()
--   WITHOUT that requirement.
--
--   What changes: the email-confirmation check is removed. Nothing else.
--   The private registration code remains the authorization gate for faculty
--   elevation, and every other validation is unchanged and still enforced
--   inside the SECURITY DEFINER function:
--     1. authenticated caller (auth.uid())
--     2. caller's profile exists
--     3. caller's profile role = 'student' (faculty/admin/committee are never
--        touched — already-registered protection unchanged)
--     4. private registration code matches the stored bcrypt hash (empty /
--        unconfigured codes rejected)
--     5. department exists (public.departments — no fake departments)
--     6. at least one category after dedupe; every category exists, is
--        non-sensitive, and is mapped to the selected department via
--        category_department_map (cross-department / sensitive rejected)
--     7. atomic write: profiles.role = 'faculty', profiles.department_id,
--        faculty_category_assignments rows — all or nothing
--     8. returns ONLY safe rows (profile id, role, department, category) —
--        never the code/hash, password, tokens or identity
--
--   NOT touched: faculty_category_assignments schema/RLS, complaint RLS and
--   routing, message/attachment security, registration-code storage
--   (faculty_registration_codes + set_faculty_registration_code), the Day 9B
--   admin RPCs, the Day 10A edit/delete model, the Day 10B attachments, or
--   the Day 10D get_faculty_registration_options() RPC.
-- ============================================================================

create or replace function public.register_faculty(
  p_registration_code text,
  p_department_id      uuid,
  p_category_ids       uuid[]
)
returns table (
  profile_id    uuid,
  role          text,
  department_id uuid,
  department    text,
  category_id   uuid,
  category      text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_profile     record;
  v_dept_name   text;
  v_code_hash   text;
  v_code        text;
  v_cid         uuid;
  v_categories  uuid[];
  v_count       int;
begin
  -- 1. Reject unauthenticated callers (defense in depth — grants already
  --    limit execution to `authenticated`).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. The caller's profile must exist. The Day 3 trigger creates one at
  --    sign-up, so a missing row means the caller never signed up.
  select p.id, p.role, p.department_id, p.email
    into v_profile
    from public.profiles p
   where p.id = auth.uid();
  if not found then
    raise exception 'Profile not found — please create an account first';
  end if;

  -- 3. Only a 'student' profile may be elevated. Existing faculty / admin /
  --    committee accounts are NEVER touched (an already-faculty caller
  --    cannot reset their role or assignments through this path).
  if v_profile.role is distinct from 'student' then
    raise exception 'Forbidden: this account is already registered';
  end if;

  -- 4. (REMOVED in Day 10E) The Day 10C email-confirmation requirement
  --    (auth.users.email_confirmed_at is not null) is gone: Supabase Email
  --    Confirmation is intentionally OFF for this MVP. The private
  --    registration code below is the authorization gate for elevation.

  -- 5. Registration code — the private gate. The submitted code is verified
  --    against the stored bcrypt hash; the plaintext is never compared or
  --    stored, and empty codes are rejected explicitly.
  v_code := coalesce(p_registration_code, '');
  if btrim(v_code) = '' then
    raise exception 'Registration code is required';
  end if;

  select f.code_hash into v_code_hash
    from public.faculty_registration_codes f
   where f.label = 'default';
  if not found or v_code_hash is null or btrim(v_code_hash) = '' then
    raise exception 'Registration code is not configured';
  end if;

  -- bcrypt verify (pgcrypto lives in the `extensions` schema — Day 10C).
  if v_code_hash <> extensions.crypt(v_code, v_code_hash) then
    raise exception 'Invalid registration code';
  end if;

  -- 6. Department must exist (public.departments is the source of truth —
  --    the frontend just renders it; the database re-validates).
  select d.name into v_dept_name
    from public.departments d
   where d.id = p_department_id;
  if not found then
    raise exception 'Department not found';
  end if;

  -- 7. Categories: dedupe + drop nulls (duplicate ids are handled safely —
  --    they collapse to one assignment), require at least one, and validate
  --    EVERY one before writing anything: it must exist, must NOT be
  --    sensitive, and must be mapped to the SELECTED department via
  --    category_department_map. All-or-nothing.
  select coalesce(array_agg(DISTINCT v.cid), '{}'::uuid[])
    into v_categories
    from unnest(coalesce(p_category_ids, '{}'::uuid[])) as v(cid)
   where v.cid is not null;

  v_count := array_length(v_categories, 1);
  if v_count is null or v_count = 0 then
    raise exception 'At least one category must be selected';
  end if;

  foreach v_cid in array v_categories loop
    if not exists (
      select 1 from public.complaint_categories cc
      where cc.id = v_cid and cc.is_sensitive = false
    ) then
      raise exception 'Invalid or sensitive category cannot be assigned to faculty: %', v_cid;
    end if;
    if not exists (
      select 1 from public.category_department_map m
      where m.category_id = v_cid
        and m.department_id = p_department_id
    ) then
      raise exception 'Category % does not belong to the selected department', v_cid;
    end if;
  end loop;

  -- 8. Atomic write (single transaction): elevate the role, set the
  --    department, then create the assignments. If any statement failed, the
  --    whole call rolls back — no half-registered faculty accounts.
  update public.profiles
     set role          = 'faculty',
         department_id = p_department_id
   where id = auth.uid();

  insert into public.faculty_category_assignments (faculty_id, category_id)
  select auth.uid(), uniq.category_id
    from (select unnest(v_categories) as category_id) uniq;

  -- 9. Return ONLY safe rows: the caller's own profile + the assignments
  --    that were just created. The registration code/hash never appears
  --    anywhere, and no identity beyond the caller's own is returned.
  return query
    select
      v_profile.id,
      'faculty'::text,
      p.department_id,
      v_dept_name,
      fca.category_id,
      cc.name
    from public.profiles p
    join public.faculty_category_assignments fca on fca.faculty_id = p.id
    join public.complaint_categories cc on cc.id = fca.category_id
   where p.id = auth.uid()
   order by cc.name;
end;
$$;

-- Grants are unchanged from Day 10C (re-asserted for idempotency): executable
-- by `authenticated` only; anon gets nothing. The function keeps ALL of its
-- in-function authorization checks (auth.uid(), role, code, department,
-- categories) and there is still no UPDATE grant on public.profiles.
revoke all on function public.register_faculty(text, uuid, uuid[]) from public;
grant execute on function public.register_faculty(text, uuid, uuid[]) to authenticated;
