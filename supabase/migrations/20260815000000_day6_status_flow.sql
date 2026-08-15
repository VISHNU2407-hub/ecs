-- ============================================================================
-- Day 6 — Status Flow: complaint status updates + status history
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 migration. It is idempotent like Day 3 (guarded statements) so it
-- can be re-run safely, but re-running is not required.
--
-- What this migration adds:
--   * table     : complaint_status_history — previous/new status, changed_at,
--                 changed_by_role (a ROLE, never an identity). No student or
--                 staff identity is stored anywhere in it.
--   * function  : can_transition_status(old, new) — the only allowed status
--                 transitions (immutable, internal helper).
--   * function  : update_complaint_status(complaint_id, new_status) — the
--                 single, database-enforced write path for status changes.
--                 SECURITY DEFINER with authorization checked INSIDE the
--                 function: role check, sensitivity check, department check,
--                 transition validation, then one atomic UPDATE + history
--                 INSERT. The client has no direct UPDATE grant on
--                 public.complaints, so this RPC is the only way to change
--                 status.
--   * RLS       : complaint_status_history is read-only to authenticated users
--                 via the existing can_access_complaint() visibility rule
--                 (student -> own, faculty -> non-sensitive, committee ->
--                 sensitive, admin -> all). No insert/update/delete policies:
--                 the RPC is the only writer.
--
-- SECURITY MODEL (summary)
--   * The UI is NOT the security boundary. A staff member can only update a
--     complaint they are authorized to handle:
--       - role:        faculty / committee / admin only (students never)
--       - sensitivity: faculty -> non-sensitive; committee -> sensitive;
--                      admin -> all (mirrors complaints_staff_view exactly)
--       - department:  if the caller's profile has a department_id, they may
--                      only manage complaints routed to that department. In
--                      the ECS pilot every profile's department_id is NULL
--                      (implicit ECS membership) so this is a no-op today, but
--                      it prevents cross-department writes later.
--   * Status changes go through a strict transition map — no arbitrary
--     jumping, no invalid enum values, no self-transitions.
--   * Status history records changed_by_role only (faculty/committee/admin) —
--     staff and student identities are never stored or exposed.
-- ============================================================================

-- ============================================================================
-- 1. complaint_status_history
--    Read-only to authenticated users; only the update RPC ever writes.
--    Contains NO identity columns.
-- ============================================================================
create table if not exists public.complaint_status_history (
  id              uuid primary key default gen_random_uuid(),
  complaint_id    uuid not null references public.complaints (id) on delete cascade,
  previous_status public.complaint_status not null,
  new_status      public.complaint_status not null,
  changed_by_role public.app_role not null,
  changed_at      timestamptz not null default now(),
  check (previous_status <> new_status)
);

alter table public.complaint_status_history enable row level security;

-- Visibility mirrors the parent complaint via the existing Day 3 helper:
--   student -> own complaints; faculty -> non-sensitive; committee ->
--   sensitive; admin -> all. No identity is involved.
drop policy if exists complaint_status_history_select on public.complaint_status_history;
create policy complaint_status_history_select
  on public.complaint_status_history
  for select to authenticated
  using (public.can_access_complaint(complaint_id));

revoke all on table public.complaint_status_history from anon, authenticated;
grant select (id, complaint_id, previous_status, new_status, changed_by_role, changed_at)
  on public.complaint_status_history to authenticated;

create index if not exists complaint_status_history_complaint_changed_idx
  on public.complaint_status_history (complaint_id, changed_at);

-- ============================================================================
-- 2. can_transition_status(old, new) — the ONLY allowed transitions.
--    Primary lifecycle: Submitted -> Under Review -> Assigned -> In Progress
--    -> Resolved -> Closed, plus the additional Reopened / Escalated states.
--    Kept strict enough to prevent random jumping between every state.
--    Internal helper: not granted to any client role (the SECURITY DEFINER
--    update RPC calls it as the function owner).
-- ============================================================================
create or replace function public.can_transition_status(
  p_old_status public.complaint_status,
  p_new_status public.complaint_status
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case p_old_status
    when 'submitted'    then p_new_status in ('under_review', 'escalated')
    when 'under_review' then p_new_status in ('assigned', 'in_progress', 'escalated', 'resolved')
    when 'assigned'     then p_new_status in ('in_progress', 'escalated', 'resolved')
    when 'in_progress'  then p_new_status in ('resolved', 'escalated')
    when 'resolved'     then p_new_status in ('closed', 'reopened')
    when 'reopened'     then p_new_status in ('under_review', 'in_progress', 'resolved', 'escalated')
    when 'escalated'    then p_new_status in ('under_review', 'in_progress', 'resolved')
    when 'closed'       then p_new_status in ('reopened')
    else false
  end
$$;

-- ============================================================================
-- 3. update_complaint_status(complaint_id, new_status)
--    The single database-enforced write path for status changes.
--
--    SECURITY DEFINER: runs as the migration owner (postgres), so RLS does
--    not apply — therefore EVERY authorization check is done inside the
--    function. It never touches student_id / sender_id and never exposes
--    identity. Returns the updated safe row (ticket_number, status,
--    updated_at) so the client can refresh without a second query.
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

  -- 3. Sensitivity authorization — mirrors complaints_staff_view visibility:
  --    faculty -> non-sensitive only; committee -> sensitive only; admin -> all.
  if v_role = 'faculty' and v_complaint.is_sensitive then
    raise exception 'Forbidden: faculty cannot modify sensitive complaints';
  end if;
  if v_role = 'committee' and not v_complaint.is_sensitive then
    raise exception 'Forbidden: committee can only modify sensitive complaints';
  end if;

  -- 4. Department authorization: a caller whose profile has a department may
  --    only manage complaints routed to that department. In the ECS pilot
  --    profiles.department_id is NULL (implicit ECS membership) so this is a
  --    no-op today, but it blocks cross-department writes if departments are
  --    assigned later.
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
-- 4. Grants — the RPC is the only client-facing status write path.
--    Functions get EXECUTE on PUBLIC by default; strip that so only
--    `authenticated` may call the RPC and `anon` has nothing.
-- ============================================================================
revoke all on function public.update_complaint_status(uuid, public.complaint_status) from public;
grant execute on function public.update_complaint_status(uuid, public.complaint_status) to authenticated;

-- Internal helper: no client role may call it directly.
revoke all on function public.can_transition_status(public.complaint_status, public.complaint_status) from public;
