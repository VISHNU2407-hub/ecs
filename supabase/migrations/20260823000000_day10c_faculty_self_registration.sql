-- ============================================================================
-- Day 10C — Faculty Self-Registration (private registration code + department
--            + category selection)
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 + 6 + 7 + 8A + 8B + 9 + 9B + 10A + 10B migrations. It is
-- idempotent (guarded statements) so it can be re-run safely, but re-running
-- is not required.
--
-- WHAT THIS MIGRATION ADDS — and deliberately does NOT add:
--
--   * public.faculty_registration_codes — stores ONLY a bcrypt HASH of the
--     private faculty registration code (never the plaintext). There are NO
--     RLS policies and NO grants on this table for anon/authenticated: not a
--     single client role can read or modify the code through the API. The
--     plaintext code is never in the frontend, never in a JS bundle, never
--     in an env file, never emailed, never rendered — it is a secret known
--     privately by faculty/admin and entered only into the /faculty/register
--     form, which submits it to a SECURITY DEFINER RPC. The DATABASE does the
--     validation (bcrypt verify via pgcrypto).
--
--     The migration seeds NO code (keeping the plaintext out of the repo).
--     An admin sets/rotates it ONCE through the admin-only RPC:
--         select public.set_faculty_registration_code('your-code');
--     (see README — Day 10C). Until a code is set, registration is refused
--     with "Registration code is not configured".
--
--   * set_faculty_registration_code(p_code) — the ONE-TIME configuration
--     mechanism, executable ONLY by the database/dashboard owner (postgres,
--     i.e. the Supabase SQL Editor): its EXECUTE grant is scoped to postgres,
--     so anon/authenticated (the app's client roles) cannot even invoke it —
--     this works from the SQL Editor where auth.uid() is NULL by design. A
--     defense-in-depth guard refuses non-superuser sessions. Validates code
--     length (8..128 chars), hashes with bcrypt (crypt(p_code,
--     gen_salt('bf'))), upserts the 'default' row. Returns a boolean only —
--     the hash is never returned by any API.
--
--   * register_faculty(p_registration_code, p_department_id, p_category_ids)
--     — SECURITY DEFINER, the ONLY path that elevates a profile to faculty.
--     Verifies INSIDE the database, atomically, before writing anything:
--       1. authenticated caller (auth.uid() is never accepted from the
--          client; the operation always targets the CALLER's own profile)
--       2. caller's profile exists and role = 'student' (an existing
--          faculty/admin/committee account is NEVER touched — existing
--          faculty accounts and their assignments stay intact)
--       3. the caller's auth email is verified (auth.users.email_confirmed_at
--          is not null) — the same email-verification behavior the rest of
--          the project relies on; the frontend shows the "verify your email"
--          message first and this check is defense in depth
--       4. the submitted registration code matches the stored bcrypt hash
--       5. the department exists (public.departments — no fake departments)
--       6. at least one category, after dedupe, and every category exists,
--          is non-sensitive (faculty can never take Harassment / Ragging)
--          and is mapped to the selected department via
--          category_department_map (the exact Day 9B routing rule)
--     Then, in ONE transaction: profiles.role = 'faculty',
--     profiles.department_id = the validated department, and the selected
--     categories become faculty_category_assignments rows (deduped, nulls
--     dropped). There is still NO UPDATE grant on public.profiles for any
--     client role, so `UPDATE profiles SET role = 'faculty'` directly is
--     impossible — this RPC is the only role-elevation path, and it is
--     gated by the private code.
--
--   * pgcrypto extension is ensured in the canonical `extensions` schema
--     (enabled if missing, moved there if an earlier run installed it
--     elsewhere), and both RPCs call its functions FULLY schema-qualified
--     (`extensions.crypt` / `extensions.gen_salt`) so they resolve in the
--     live Supabase project where `extensions` is not on the SECURITY
--     DEFINER search_path.
--
-- NO CHANGES to: departments, complaint_categories, category_department_map,
-- complaints, messages, chat controls, resolution/reopen/escalation,
-- faculty_category_assignments (same table, same RLS — assignments created
-- here are exactly the rows the admin UI manages), the Day 9B admin RPCs,
-- the Day 10A soft-delete model, or the Day 10B attachments. Student signup
-- behavior is untouched (the Day 3 trigger still creates role 'student').
-- ============================================================================

-- ============================================================================
-- 1. pgcrypto (bcrypt) — ensured in the canonical `extensions` schema.
--
--    Supabase installs extensions into an `extensions` schema that is NOT
--    part of the SECURITY DEFINER search_path below (set to public for
--    hijack safety), so unqualified `crypt(...)` / `gen_salt(...)` calls can
--    fail with 42883 in a live project. This block guarantees the functions
--    exist at `extensions.crypt(...)` / `extensions.gen_salt('bf')` in every
--    scenario:
--      * pgcrypto NOT enabled yet      -> enable it INTO the extensions schema
--      * pgcrypto already enabled in   -> move it to extensions (idempotent
--        another schema (e.g. public     re-runs; also fixes databases where
--        from an earlier migration run)  an older run installed it into public)
--      * pgcrypto already in extensions -> no-op
--    The RPCs below then call the functions FULLY schema-qualified, so they
--    resolve regardless of search_path.
-- ============================================================================
do $$
declare
  v_ext_schema text;
begin
  create schema if not exists extensions;

  if exists (select 1 from pg_extension where extname = 'pgcrypto') then
    select n.nspname into v_ext_schema
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'pgcrypto';
    if v_ext_schema is distinct from 'extensions' then
      alter extension pgcrypto set schema extensions;
    end if;
  else
    if exists (select 1 from pg_available_extensions where name = 'pgcrypto') then
      create extension pgcrypto with schema extensions;
    end if;
  end if;
end
$$;

-- ============================================================================
-- 2. faculty_registration_codes — hashed code storage ONLY.
--    No RLS policies and no grants at all: anon and authenticated can neither
--    read nor modify the code through the API. The only access paths are the
--    two SECURITY DEFINER functions below (owner-level, RLS bypassed by
--    design — the role checks happen inside the functions).
-- ============================================================================
create table if not exists public.faculty_registration_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null,
  label      text not null default 'default' unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.faculty_registration_codes enable row level security;

-- Deliberately NO policies: not even a SELECT-own. Defense in depth — even if
-- a grant were ever added later, there is no policy that would permit reads,
-- and the table is never exposed to any client role.
revoke all on table public.faculty_registration_codes from anon, authenticated;

-- ============================================================================
-- 3. set_faculty_registration_code(p_code) — SQL-editor/dashboard-owner code
--    management. This function deliberately does NOT check auth.uid()/admin:
--    the Supabase SQL Editor runs as the database owner (postgres) with no
--    JWT, so auth.uid() is NULL there by design. Authorization is instead
--    enforced by the EXECUTE grant (section 5), which is scoped to postgres
--    ONLY — anon/authenticated (the app's client roles) cannot invoke the
--    function at all, so students can never call this setup mechanism. A
--    defense-in-depth guard below refuses non-superuser sessions even if a
--    future grant were ever added. The hash is what gets stored; the
--    plaintext code is never written to the database and never returned.
-- ============================================================================
create or replace function public.set_faculty_registration_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  -- 1. Defense in depth: only the database/dashboard owner (postgres) or any
  --    superuser session may configure the code. session_user is the role
  --    that opened the connection (unaffected by SECURITY DEFINER), so this
  --    distinguishes the SQL editor (postgres) from a client request
  --    (authenticated/anon). The EXECUTE grant is the real gate.
  if session_user <> 'postgres'
     and not exists (select 1 from pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'Forbidden: only the database owner may configure the faculty registration code';
  end if;

  -- 2. Validate length (a shared secret, so a sane minimum; never the
  --    plaintext in any client-visible output).
  v_code := btrim(coalesce(p_code, ''));
  if char_length(v_code) < 8 then
    raise exception 'Registration code must be at least 8 characters';
  end if;
  if char_length(v_code) > 128 then
    raise exception 'Registration code is too long (maximum 128 characters)';
  end if;

  -- 3. Store ONLY the bcrypt hash (pgcrypto, schema-qualified — see section
  --    1: the extension lives in the `extensions` schema). gen_salt('bf')
  --    embeds a random salt, so two calls with the same code produce
  --    different hashes — no plaintext ever lands in the table, and the hash
  --    cannot be reversed.
  insert into public.faculty_registration_codes (code_hash, label)
  values (extensions.crypt(v_code, extensions.gen_salt('bf')), 'default')
  on conflict (label) do update
    set code_hash  = excluded.code_hash,
        updated_at = now();

  return true;
end;
$$;

-- ============================================================================
-- 4. register_faculty(p_registration_code, p_department_id, p_category_ids)
--    — the ONLY faculty role-elevation path.
--
--    SECURITY DEFINER: every authorization check happens INSIDE the function
--    (RLS does not apply to the owner). The client sends only the code, the
--    chosen department and the chosen category ids; identity, ownership,
--    role, email verification and routing are derived/verified server-side
--    from auth.uid() and the existing rows. The operation is atomic: if ANY
--    input is invalid, nothing is written at all.
--
--    Returns one safe row per created assignment (profile fields repeated),
--    so the caller can confirm the role flip and the assignments.
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
  --    cannot reset their role or assignments through this path — the admin
  --    manages those via the Day 9B page).
  if v_profile.role is distinct from 'student' then
    raise exception 'Forbidden: this account is already registered';
  end if;

  -- 4. Email verification (defense in depth — the frontend already blocks
  --    unverified sign-ups and shows the verification message). The same
  --    auth.users.email_confirmed_at the project's Supabase configuration
  --    maintains; faculty accounts must have a verified email.
  if not exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  ) then
    raise exception 'Please verify your email before registering as faculty';
  end if;

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

  -- bcrypt verify (pgcrypto lives in the `extensions` schema — section 1).
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
  --    sensitive (faculty can never be assigned Harassment / Ragging — even
  --    a hand-crafted call cannot), and must be mapped to the SELECTED
  --    department via category_department_map (cross-department categories
  --    are rejected). All-or-nothing.
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
  --    that were just created. No identity beyond the caller's own is ever
  --    returned, and the registration code/hash never appears anywhere.
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

-- ============================================================================
-- 5. Grants.
--    register_faculty() is executable by `authenticated` only (anon gets
--    nothing) — it is the app's registration RPC and keeps ALL its
--    in-function authorization checks (auth.uid(), role, email, code,
--    department, categories).
--
--    set_faculty_registration_code() is executable by `postgres` ONLY — the
--    database/dashboard owner, i.e. the Supabase SQL Editor. Normal client
--    roles (anon/authenticated) cannot even invoke it (permission denied),
--    so students can never call the setup mechanism; the in-function
--    session_user guard is defense in depth.
--
--    There are still NO grants of any kind on faculty_registration_codes and
--    NO UPDATE grant on public.profiles, so these RPCs are the only
--    code-management and role-elevation paths.
-- ============================================================================
revoke all on function public.set_faculty_registration_code(text) from public;
grant execute on function public.set_faculty_registration_code(text) to postgres;

revoke all on function public.register_faculty(text, uuid, uuid[]) from public;
grant execute on function public.register_faculty(text, uuid, uuid[]) to authenticated;
