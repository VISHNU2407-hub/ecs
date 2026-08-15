-- ============================================================================
-- Day 9B — Faculty-level category assignment & complaint routing
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 + 6 + 7 + 8A + 8B + 9 migrations. It is idempotent (guarded
-- statements) so it can be re-run safely, but re-running is not required.
--
-- PROBLEM THIS SOLVES
--   A faculty member today sees every non-sensitive ECS complaint. Day 9B
--   narrows that to: their OWN department + the CATEGORIES an admin has
--   assigned them + non-sensitive + department-handled complaints only.
--   Example: a faculty member assigned only "Labs" sees ECS Labs complaints
--   and nothing else (no Academics, Equipment, IT/Network, ...).
--
--   This is enforced ENTIRELY at the database level (RLS + the existing
--   SECURITY DEFINER helpers). The frontend never filters for security: an
--   unauthorized complaint never arrives in a response, never opens on
--   /staff/complaints/:id, never appears in chat or history, and can never
--   be status-updated — no matter what a malicious client does.
--
-- WHAT THIS MIGRATION ADDS — and deliberately does NOT add:
--
--   * table  : faculty_category_assignments — one row per (faculty, category)
--              with UNIQUE(faculty_id, category_id). No new departments, no
--              new categories, no fake users (the ECS pilot stays ECS).
--
--   * helper : faculty_can_access_complaint(complaint_id) — the single,
--              authoritative faculty visibility rule (SECURITY DEFINER):
--                caller role = faculty
--                complaint is non-sensitive
--                complaint.handler_type = 'department'
--                caller has a department_id
--                caller.department_id = complaint.department_id
--                an assignment exists: faculty_id = auth.uid() AND
--                  category_id = complaint.category_id
--              Sensitive complaints can NEVER become visible through an
--              assignment — is_sensitive = false is unconditional, so even a
--              hand-inserted "Harassment / Ragging" assignment grants
--              nothing. Committee routing stays controlled by
--              handler_type = 'committee' and the existing sensitive rules.
--
--   * UPDATES (create or replace / drop + create — previous migration files
--     are never modified):
--       - public.can_access_complaint()        : faculty branch -> the helper.
--         Student / admin / committee behavior is unchanged.
--       - complaints_select_faculty RLS policy : base-table SELECT now uses
--         the helper too. The base table IS the security boundary; the staff
--         view is not the only protection. (The view is security-invoker, so
--         it automatically returns only rows the updated RLS authorizes.)
--       - update_complaint_status()            : faculty authorization now
--         requires faculty_can_access_complaint(), so an assigned-category
--         check is added server-side to status updates.
--     Because chat, history and message access already go through
--     can_access_complaint(), updating that function restricts them all.
--
--   * ADMIN RPCs (SECURITY DEFINER, the ONLY write path to assignments —
--     there is no INSERT/UPDATE/DELETE grant on the table for any client
--     role):
--       - set_faculty_category_assignments(target_faculty_id, category_ids)
--         Verifies: authenticated caller, caller role = admin (from
--         public.profiles.role — never trusted from the client), target
--         exists with role = 'faculty', target has a department, every
--         category is non-sensitive AND mapped to the target's department via
--         category_department_map. Then it atomically replaces the target's
--         assignments (all-or-nothing: nothing is written if any input is
--         invalid) and returns only safe rows.
--       - list_faculty_category_assignments()
--         Admin-only read for the management UI: one row per (faculty,
--         assignment), including faculty with no assignments. Returns only
--         faculty (never students) with their department and assigned
--         categories.
--
--   * RLS on faculty_category_assignments:
--       - faculty  : SELECT own rows only (faculty_id = auth.uid())
--       - admin    : SELECT all rows (defense in depth for the UI; the RPC is
--                    the real read path)
--       - admin    : INSERT/UPDATE/DELETE policies as defense-in-depth only —
--                    no client grants exist for those operations, so the RPC
--                    remains the only writer
--       - students : no access
--     The client is granted SELECT (id, faculty_id, category_id, created_at)
--     only. faculty_id here is a staff-management field (admin UI / a
--     faculty member's own row); it is NEVER part of any complaint-facing
--     response (complaints_staff_view stays identity-free).
--
-- NO CHANGES to: departments, complaint_categories, category_department_map,
-- complaints columns, messages, escalation (Day 9), resolution/reopen
-- (Day 9), chat controls (Day 8), or the Realtime publication.
-- ============================================================================

-- ============================================================================
-- 1. faculty_category_assignments
-- ============================================================================
create table if not exists public.faculty_category_assignments (
  id          uuid primary key default gen_random_uuid(),
  faculty_id  uuid not null references public.profiles (id) on delete cascade,
  category_id uuid not null references public.complaint_categories (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (faculty_id, category_id)
);

alter table public.faculty_category_assignments enable row level security;

-- Faculty may read their OWN rows only (needed if a UI ever shows the
-- caller their assignments). Admin may read all rows (management UI;
-- the list RPC is the actual read path). Students have no SELECT policy.
drop policy if exists faculty_category_assignments_select_own on public.faculty_category_assignments;
create policy faculty_category_assignments_select_own
  on public.faculty_category_assignments
  for select to authenticated
  using (faculty_id = auth.uid());

drop policy if exists faculty_category_assignments_select_admin on public.faculty_category_assignments;
create policy faculty_category_assignments_select_admin
  on public.faculty_category_assignments
  for select to authenticated
  using (public.get_app_role() = 'admin');

-- Defense-in-depth admin DML policies: the client has NO INSERT/UPDATE/DELETE
-- grants on this table, so these only matter if a future grant is added —
-- and then it would still be admin-scoped. The RPC is the only writer.
drop policy if exists faculty_category_assignments_insert_admin on public.faculty_category_assignments;
create policy faculty_category_assignments_insert_admin
  on public.faculty_category_assignments
  for insert to authenticated
  with check (public.get_app_role() = 'admin');

drop policy if exists faculty_category_assignments_update_admin on public.faculty_category_assignments;
create policy faculty_category_assignments_update_admin
  on public.faculty_category_assignments
  for update to authenticated
  using (public.get_app_role() = 'admin')
  with check (public.get_app_role() = 'admin');

drop policy if exists faculty_category_assignments_delete_admin on public.faculty_category_assignments;
create policy faculty_category_assignments_delete_admin
  on public.faculty_category_assignments
  for delete to authenticated
  using (public.get_app_role() = 'admin');

revoke all on table public.faculty_category_assignments from anon, authenticated;
grant select (id, faculty_id, category_id, created_at)
  on public.faculty_category_assignments to authenticated;

create index if not exists faculty_category_assignments_faculty_idx
  on public.faculty_category_assignments (faculty_id);

create index if not exists faculty_category_assignments_category_idx
  on public.faculty_category_assignments (category_id);

-- ============================================================================
-- 2. faculty_can_access_complaint(complaint_id)
--    The single authoritative faculty visibility rule, used by BOTH the base
--    complaints RLS policy and can_access_complaint(). SECURITY DEFINER so
--    the policy can read profiles / assignments without RLS recursion (the
--    function runs as the owner and only ever inspects the CALLER's own
--    profile row — p.id = auth.uid()).
-- ============================================================================
create or replace function public.faculty_can_access_complaint(p_complaint_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.complaints c
    join public.profiles p on p.id = auth.uid()
    where c.id = p_complaint_id
      and p.role = 'faculty'
      and p.department_id is not null
      and c.is_sensitive = false
      and c.handler_type = 'department'
      and c.department_id = p.department_id
      and exists (
        select 1
        from public.faculty_category_assignments fca
        where fca.faculty_id = p.id
          and fca.category_id = c.category_id
      )
  )
$$;

-- ============================================================================
-- 3. can_access_complaint() — faculty branch narrowed to the assignment rule.
--    Student / admin / committee behavior is UNCHANGED.
-- ============================================================================
create or replace function public.can_access_complaint(p_complaint_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case public.get_app_role()
    when 'student' then exists (
      select 1 from public.complaints c
      where c.id = p_complaint_id and c.student_id = auth.uid()
    )
    when 'faculty' then public.faculty_can_access_complaint(p_complaint_id)
    when 'admin' then exists (
      select 1 from public.complaints c
      where c.id = p_complaint_id
    )
    when 'committee' then exists (
      select 1 from public.complaints c
      where c.id = p_complaint_id and c.is_sensitive = true
    )
    else false
  end
$$;

-- ============================================================================
-- 4. Base-table RLS — faculty SELECT policy now uses the assignment rule.
--    The base table is the security boundary, not just the view. For student
--    INSERT ... RETURNING this policy evaluates false on the brand-new row
--    (self-lookup), but the student policy (student_id = auth.uid()) still
--    passes, so submission keeps working — exactly the Day 3 model.
-- ============================================================================
drop policy if exists complaints_select_faculty on public.complaints;
create policy complaints_select_faculty
  on public.complaints
  for select to authenticated
  using (public.faculty_can_access_complaint(id));

-- ============================================================================
-- 5. update_complaint_status() — faculty authorization now requires the
--    assignment rule (non-sensitive + department-handled + own department +
--    assigned category), checked server-side. Committee / admin checks are
--    unchanged, as is the department check and the transition map.
-- ============================================================================
create or replace function public.update_complaint_status(
  p_complaint_id uuid,
  p_new_status public.complaint_status
)
returns table (
  ticket_number text,
  status public.complaint_status,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_caller_department uuid;
  v_complaint record;
begin
  -- 1. Only staff-like roles may update status. Students never can.
  v_role := public.get_app_role();
  if v_role not in ('faculty', 'admin', 'committee') then
    raise exception 'Forbidden: only staff roles may update complaint status';
  end if;

  -- 2. The complaint must exist. (Column names are qualified: the function's
  --    RETURN TABLE output columns shadow the table columns in this scope.)
  select c.id, c.ticket_number, c.status, c.is_sensitive, c.department_id
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id;
  if not found then
    raise exception 'Complaint not found';
  end if;

  -- 3. Authorization (Day 9B): faculty -> the assignment rule
  --    (non-sensitive + department-handled + own department + assigned
  --    category); committee -> sensitive only; admin -> all.
  if v_role = 'faculty' then
    if not public.faculty_can_access_complaint(p_complaint_id) then
      raise exception 'Forbidden: you are not assigned to this complaint category';
    end if;
  elsif v_role = 'committee' and not v_complaint.is_sensitive then
    raise exception 'Forbidden: committee can only modify sensitive complaints';
  end if;

  -- 4. Department authorization: a caller whose profile has a department may
  --    only manage complaints routed to that department. In the ECS pilot
  --    faculty now carry department_id (required by the assignment rule), so
  --    this is a real second layer; it also guards committee/admin if a
  --    department is ever assigned to them.
  select department_id into v_caller_department
    from public.profiles
   where id = auth.uid();
  if v_caller_department is not null
     and v_complaint.department_id is distinct from v_caller_department then
    raise exception 'Forbidden: complaint belongs to another department';
  end if;

  -- 5. No-op guard + transition validation (the database is authoritative).
  if v_complaint.status = p_new_status then
    raise exception 'Status is already %', p_new_status;
  end if;
  if not public.can_transition_status(v_complaint.status, p_new_status) then
    raise exception 'Invalid status transition from % to %', v_complaint.status, p_new_status;
  end if;

  -- 6. Apply the update atomically. updated_at is maintained by the Day 3
  --    before-update trigger.
  return query
    update public.complaints
       set status = p_new_status
     where id = p_complaint_id
     returning complaints.ticket_number, complaints.status, complaints.updated_at;

  -- 7. Record history. changed_by_role is a ROLE, never an identity.
  insert into public.complaint_status_history
    (complaint_id, previous_status, new_status, changed_by_role)
  values
    (p_complaint_id, v_complaint.status, p_new_status, v_role::public.app_role);
end;
$$;

-- ============================================================================
-- 6. Admin RPCs — the ONLY way assignments are created / replaced / removed.
--    SECURITY DEFINER with every check INSIDE the function. The role comes
--    from public.profiles.role via get_app_role() — never from the client.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 6.1 set_faculty_category_assignments(target_faculty_id, category_ids)
--     Validates EVERYTHING before writing anything (all-or-nothing):
--       1. authenticated caller
--       2. caller role = admin
--       3. target exists, role = faculty, has a department
--       4. each category: exists, is non-sensitive, and is mapped to the
--          target's department via category_department_map
--     Then atomically replaces the target's assignments (delete + insert in
--     the same transaction). Returns the target's safe assignment rows.
-- ----------------------------------------------------------------------------
create or replace function public.set_faculty_category_assignments(
  p_target_faculty_id uuid,
  p_category_ids uuid[]
)
returns table (
  faculty_id    uuid,
  faculty_email text,
  department_id uuid,
  department    text,
  category_id   uuid,
  category      text,
  assigned_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_target  record;
  v_dept    text;
  v_cid     uuid;
begin
  -- 1. Reject unauthenticated callers (grants already limit execution to
  --    `authenticated`; defense in depth).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Only admin may manage assignments. The role is read from
  --    public.profiles.role — never accepted from the client.
  v_role := public.get_app_role();
  if v_role is distinct from 'admin' then
    raise exception 'Forbidden: only admin may manage faculty category assignments';
  end if;

  -- 3. The target must exist, be a faculty account, and belong to a
  --    department (an assignment without a department could never match a
  --    complaint).
  select p.id, p.role, p.email, p.department_id, d.name as dept_name
    into v_target
    from public.profiles p
    left join public.departments d on d.id = p.department_id
   where p.id = p_target_faculty_id;
  if not found then
    raise exception 'Faculty not found';
  end if;
  if v_target.role is distinct from 'faculty' then
    raise exception 'Forbidden: assignments can only target faculty accounts';
  end if;
  if v_target.department_id is null then
    raise exception 'Forbidden: target faculty has no department';
  end if;
  v_dept := v_target.dept_name;

  -- 4. Validate every category BEFORE any write: it must exist, must NOT be
  --    sensitive (faculty can never be assigned sensitive categories), and
  --    must be mapped to the target's department. Any invalid input aborts
  --    the whole call — nothing is partially written.
  if p_category_ids is not null then
    foreach v_cid in array p_category_ids loop
      if v_cid is null then
        continue;
      end if;
      if not exists (
        select 1 from public.complaint_categories cc
        where cc.id = v_cid and cc.is_sensitive = false
      ) then
        raise exception 'Invalid or sensitive category cannot be assigned to faculty: %', v_cid;
      end if;
      if not exists (
        select 1 from public.category_department_map m
        where m.category_id = v_cid
          and m.department_id = v_target.department_id
      ) then
        raise exception 'Category % does not belong to the target department', v_cid;
      end if;
    end loop;
  end if;

  -- 5. Atomically replace the target's assignments (dedupe + drop nulls).
  --    The RETURN TABLE output column `faculty_id` shadows the table column
  --    in this scope, so the DELETE's WHERE is table-qualified.
  delete from public.faculty_category_assignments
   where faculty_category_assignments.faculty_id = p_target_faculty_id;

  insert into public.faculty_category_assignments (faculty_id, category_id)
  select p_target_faculty_id, uniq.category_id
    from (
      select distinct v.cid as category_id
      from unnest(coalesce(p_category_ids, '{}'::uuid[])) as v(cid)
      where v.cid is not null
    ) uniq;

  -- 6. Return only safe rows (the target's current assignments).
  return query
    select
      p.id,
      p.email,
      p.department_id,
      v_dept,
      fca.category_id,
      cc.name,
      fca.created_at
    from public.profiles p
    left join public.faculty_category_assignments fca on fca.faculty_id = p.id
    left join public.complaint_categories cc on cc.id = fca.category_id
   where p.id = p_target_faculty_id
   order by cc.name nulls last;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6.2 list_faculty_category_assignments()
--     Admin-only read for the management UI: one row per (faculty,
--     assignment), including faculty with no assignments (category null).
--     Returns faculty accounts only — never students. Faculty identity is
--     shown to the admin managing them; student identity never appears.
-- ----------------------------------------------------------------------------
create or replace function public.list_faculty_category_assignments()
returns table (
  faculty_id    uuid,
  faculty_email text,
  department_id uuid,
  department    text,
  category_id   uuid,
  category      text,
  assigned_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.get_app_role() is distinct from 'admin' then
    raise exception 'Forbidden: only admin may view faculty assignments';
  end if;

  return query
    select
      p.id,
      p.email,
      p.department_id,
      d.name,
      fca.category_id,
      cc.name,
      fca.created_at
    from public.profiles p
    left join public.departments d on d.id = p.department_id
    left join public.faculty_category_assignments fca on fca.faculty_id = p.id
    left join public.complaint_categories cc on cc.id = fca.category_id
   where p.role = 'faculty'
   order by p.email, cc.name nulls last;
end;
$$;

-- ============================================================================
-- 7. Grants — RPCs are executable by `authenticated` only; anon gets nothing.
--    The role checks inside each RPC decide WHO may actually use them.
-- ============================================================================
revoke all on function public.set_faculty_category_assignments(uuid, uuid[]) from public;
grant execute on function public.set_faculty_category_assignments(uuid, uuid[]) to authenticated;

revoke all on function public.list_faculty_category_assignments() from public;
grant execute on function public.list_faculty_category_assignments() to authenticated;

-- faculty_can_access_complaint is invoked BY the complaints RLS policy, and
-- policy expressions run with the querying user's privileges — so
-- `authenticated` needs EXECUTE on it (same as can_access_complaint, which
-- the messages policies call). It only ever answers about the CALLER's own
-- access (it reads auth.uid()'s profile + assignments), so executing it is
-- not a leak: anon gets nothing, and a faculty member can only ever learn
-- whether THEY may access a complaint — the same boolean RLS already uses.
revoke all on function public.faculty_can_access_complaint(uuid) from public;
grant execute on function public.faculty_can_access_complaint(uuid) to authenticated;
