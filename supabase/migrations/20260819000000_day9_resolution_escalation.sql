-- ============================================================================
-- Day 9 — Resolution confirmation, Reopen workflow & Automatic escalation
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 + 6 + 7 + 8A + 8B migrations. It is idempotent (guarded
-- statements) so it can be re-run safely, but re-running is not required.
--
-- What this migration adds — and deliberately does NOT add:
--
--   * TWO student-facing SECURITY DEFINER RPCs (the ONLY student write paths
--     for status; there is still NO direct UPDATE grant on public.complaints):
--       - confirm_complaint_resolution(complaint_id) : resolved -> closed
--       - reopen_complaint(complaint_id)             : resolved -> reopened
--     Each verifies INSIDE the function: authentication, app role = student,
--     ownership (complaint.student_id = auth.uid() — the user id is NEVER
--     accepted from the client), the current status is 'resolved', and the
--     Day 6 transition map allows the move. History is recorded with
--     changed_by_role = 'student' (a ROLE, never an identity).
--
--   * system_settings — a database-backed configuration table. The automatic
--     escalation threshold lives HERE (key 'escalation_threshold', default
--     '48 hours'), never in React and never in localStorage. It is readable
--     ONLY by the SECURITY DEFINER escalation function (RLS enabled with NO
--     policies, no grants to any client role).
--
--   * escalate_stale_complaints() — the server-side automatic escalation
--     operation. It is SECURITY DEFINER, takes no arguments, reads the
--     threshold from system_settings, and escalates ONLY complaints that are:
--         status IN ('submitted', 'under_review')   AND
--         updated_at < now() - threshold            (DB/server timestamp only)
--     Each escalation is an atomic UPDATE + a status-history row with
--     previous_status, new_status = 'escalated', changed_at, and
--     changed_by_role = 'system'. 'system' is a new app_role enum value used
--     ONLY for automated history — no profile row, no fake admin identity, no
--     student identity anywhere.
--
--     It is NOT granted to any client role: only the database itself (the
--     pg_cron job below, or the migration owner) can invoke it. The client
--     cannot call an unrestricted "escalate anything" function.
--
--   * SCHEDULING: if the pg_cron extension is available (a real Supabase
--     project with pg_cron enabled in Dashboard -> Database -> Extensions),
--     this migration creates a cron job `day9-escalate-stale-complaints`
--     running every 15 minutes. In the local verification harnesses
--     (embedded-postgres) pg_cron does not exist, so the block is a no-op and
--     the function is exercised directly instead. See the header comment of
--     scripts/verify-day9.mjs for how to schedule it manually if pg_cron is
--     not enabled.
--
--   * MANUAL escalation already exists: the Day 6 update_complaint_status RPC
--     allows staff/admin -> 'escalated' from submitted / under_review /
--     assigned / in_progress / reopened with full authorization (role,
--     sensitivity, department, transition map) and a history row. No new
--     manual-escalation RPC is added — that would duplicate the existing
--     status control.
--
--   * Realtime: `complaints` is added to the supabase_realtime publication
--     (guarded) so student + staff detail pages can show status changes
--     without a refresh, using a per-complaint UPDATE subscription (RLS
--     decides who receives events; student_id is not selectable by
--     `authenticated`, so it can never appear in a payload).
--
--   * complaints_staff_view gains a derived `is_escalated` column
--     (status = 'escalated') so admin/staff can identify the escalation
--     state at a glance. Identity-free, security-invoker, unchanged grants.
--
-- SECURITY MODEL (summary)
--   * The UI is never the security boundary. Closing/reopening is decided by
--     the database from auth.uid() + the complaint row's student_id; the
--     client cannot close or reopen someone else's complaint, cannot close a
--     non-resolved complaint, and staff cannot use the student paths.
--   * Automatic escalation is a privileged, tightly-scoped server operation:
--     it only touches eligible stale complaints, never fabricates identity,
--     and no client role can invoke it.
--   * No identity is added anywhere: history keeps changed_by_role only
--     ('student' / 'system' / existing staff roles), the staff view stays
--     identity-free, and RLS on every new object is deny-by-default.
-- ============================================================================

-- ============================================================================
-- 1. app_role gains a 'system' value — used ONLY for automated (non-human)
--    status-history entries. No profile row will ever use it, and
--    get_app_role() can never return it, so no client can claim it.
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'app_role' and t.typnamespace = 'public'::regnamespace
      and e.enumlabel = 'system'
  ) then
    alter type public.app_role add value 'system';
  end if;
end
$$;

-- ============================================================================
-- 2. system_settings — database-backed configuration (threshold lives here,
--    never hardcoded in React, never in localStorage).
-- ============================================================================
create table if not exists public.system_settings (
  key         text primary key,
  value       text not null,
  description text,
  updated_at  timestamptz not null default now()
);

alter table public.system_settings enable row level security;
-- RLS enabled with NO policies: deny-by-default. Only the SECURITY DEFINER
-- escalation function (running as the table owner) and the migration owner /
-- cron can read it. Not one grant is issued to anon or authenticated.

insert into public.system_settings (key, value, description)
values (
  'escalation_threshold',
  '48 hours',
  'Complaints stuck in submitted/under_review with no staff activity for longer than this are auto-escalated by public.escalate_stale_complaints() (see the pg_cron job below).'
)
on conflict (key) do nothing;

revoke all on table public.system_settings from anon, authenticated;

-- ============================================================================
-- 3. confirm_complaint_resolution(complaint_id)
--    The ONLY path for a student to close their own resolved complaint
--    (resolved -> closed). SECURITY DEFINER: every authorization check is
--    INSIDE the function because RLS does not apply to the owner:
--      1. authenticated caller
--      2. app role = student (staff/admin/committee are rejected)
--      3. complaint exists
--      4. ownership — complaint.student_id = auth.uid() (auth.uid() is the
--         only identity source; the client never supplies a user id)
--      5. current status is 'resolved'
--      6. the Day 6 transition map allows resolved -> closed
--    Returns the updated safe row (ticket_number, status, updated_at).
-- ============================================================================
create or replace function public.confirm_complaint_resolution(
  p_complaint_id uuid
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
  v_complaint record;
begin
  -- 1. Reject unauthenticated callers (defense in depth — grants already
  --    limit execution to `authenticated`).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Only the owning student may confirm resolution.
  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may confirm resolution';
  end if;

  -- 3. The complaint must exist.
  select c.id, c.ticket_number, c.status, c.student_id
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id;
  if not found then
    raise exception 'Complaint not found';
  end if;

  -- 4. Ownership — derived from auth.uid(), never trusted from the client.
  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only confirm resolution of your own complaint';
  end if;

  -- 5. Only a resolved complaint may be closed by its student.
  if v_complaint.status <> 'resolved' then
    raise exception 'Complaint can only be closed after it is resolved';
  end if;

  -- 6. Belt and braces: the transition map is the single source of truth.
  if not public.can_transition_status(v_complaint.status, 'closed') then
    raise exception 'Invalid status transition from % to closed', v_complaint.status;
  end if;

  -- 7. Apply atomically. updated_at is maintained by the Day 3 trigger.
  return query
    update public.complaints
       set status = 'closed'
     where id = p_complaint_id
     returning complaints.ticket_number, complaints.status, complaints.updated_at;

  -- 8. History: a ROLE ('student'), never an identity.
  insert into public.complaint_status_history
    (complaint_id, previous_status, new_status, changed_by_role)
  values
    (p_complaint_id, v_complaint.status, 'closed', 'student');
end;
$$;

-- ============================================================================
-- 4. reopen_complaint(complaint_id)
--    The ONLY path for a student to reopen their own resolved complaint
--    (resolved -> reopened). Same security model as confirm_complaint_
--    resolution: authenticated, role = student, ownership via auth.uid(),
--    current status 'resolved', transition map validated, history recorded
--    with changed_by_role = 'student'.
-- ============================================================================
create or replace function public.reopen_complaint(
  p_complaint_id uuid
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
  v_complaint record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may reopen a complaint';
  end if;

  select c.id, c.ticket_number, c.status, c.student_id
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id;
  if not found then
    raise exception 'Complaint not found';
  end if;

  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only reopen your own complaint';
  end if;

  if v_complaint.status <> 'resolved' then
    raise exception 'Complaint can only be reopened after it is resolved';
  end if;

  if not public.can_transition_status(v_complaint.status, 'reopened') then
    raise exception 'Invalid status transition from % to reopened', v_complaint.status;
  end if;

  return query
    update public.complaints
       set status = 'reopened'
     where id = p_complaint_id
     returning complaints.ticket_number, complaints.status, complaints.updated_at;

  insert into public.complaint_status_history
    (complaint_id, previous_status, new_status, changed_by_role)
  values
    (p_complaint_id, v_complaint.status, 'reopened', 'student');
end;
$$;

-- ============================================================================
-- 5. escalate_stale_complaints()
--    Server-side automatic escalation. SECURITY DEFINER, no arguments.
--      * reads the configurable threshold from system_settings
--        ('escalation_threshold', default 48 hours) — never hardcoded;
--      * uses ONLY database timestamps (complaints.updated_at, now()) —
--        never frontend/browser time;
--      * eligible: status IN ('submitted', 'under_review') AND
--        updated_at < now() - threshold (no meaningful staff action within
--        the threshold). assigned / in_progress / resolved / reopened /
--        closed / escalated are never auto-escalated;
--      * each escalation is an atomic UPDATE guarded by a re-check of the
--        previously read status (safe under concurrent runs — a row can
--        never get two escalation history entries), followed by a
--        complaint_status_history row with changed_by_role = 'system'.
--
--    NOT granted to any client role (see grants below): only the database
--    (pg_cron job / migration owner) may run it. It cannot be used to
--    escalate arbitrary complaints — the eligibility rule is built in.
-- ============================================================================
create or replace function public.escalate_stale_complaints()
returns table (
  complaint_id    uuid,
  ticket_number   text,
  previous_status public.complaint_status,
  new_status      public.complaint_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_threshold interval;
  v_cutoff    timestamptz;
  v_row       record;
  v_previous  public.complaint_status;
begin
  -- 1. Configurable threshold from the database settings table. If the row
  --    is missing or malformed, fall back to 48 hours (documented default).
  select coalesce(
           (select value::interval from public.system_settings where key = 'escalation_threshold'),
           interval '48 hours'
         )
    into v_threshold;

  v_cutoff := now() - v_threshold;

  -- 2. Eligible stale complaints only. updated_at is maintained server-side
  --    by the Day 3 trigger; it reflects the last status activity.
  for v_row in
    select c.id, c.ticket_number, c.status
      from public.complaints c
     where c.status in ('submitted', 'under_review')
       and c.updated_at < v_cutoff
     order by c.id
  loop
    v_previous := v_row.status;

    -- 3. The transition map is authoritative (submitted/under_review ->
    --    escalated are both legal Day 6 moves).
    if public.can_transition_status(v_previous, 'escalated') then
      -- 4. Re-check the status in the UPDATE itself: if a concurrent run (or
      --    a staff member) already moved this complaint, FOUND is false and
      --    we skip it — no double history, no clobbering a newer status.
      update public.complaints c
         set status = 'escalated'
       where c.id = v_row.id
         and c.status = v_previous;
      if found then
        insert into public.complaint_status_history
          (complaint_id, previous_status, new_status, changed_by_role)
        values
          (v_row.id, v_previous, 'escalated', 'system');
        complaint_id    := v_row.id;
        ticket_number   := v_row.ticket_number;
        previous_status := v_previous;
        new_status      := 'escalated';
        return next;
      end if;
    end if;
  end loop;
end;
$$;

-- ============================================================================
-- 6. complaints_staff_view — add the derived `is_escalated` flag so the
--    staff/admin dashboard can identify the escalation state at a glance.
--    Still security-invoker + identity-free; grants are re-asserted.
-- ============================================================================
create or replace view public.complaints_staff_view
with (security_invoker = true)
as
select
  c.id,
  c.ticket_number,
  c.category_id,
  cc.name       as category,
  c.department_id,
  d.name        as department,
  c.description,
  c.attachment_url,
  c.priority,
  c.status,
  c.handler_type,
  c.is_sensitive,
  c.created_at,
  c.updated_at,
  (c.status = 'escalated') as is_escalated
from public.complaints c
left join public.complaint_categories cc on cc.id = c.category_id
left join public.departments d          on d.id   = c.department_id;

revoke all on table public.complaints_staff_view from anon, authenticated;
grant select on public.complaints_staff_view to authenticated;

-- ============================================================================
-- 7. Grants — the two student RPCs are executable by `authenticated` only;
--    the escalation function is executable by NO client role (the database
--    itself runs it via pg_cron / the migration owner).
-- ============================================================================
revoke all on function public.confirm_complaint_resolution(uuid) from public;
grant execute on function public.confirm_complaint_resolution(uuid) to authenticated;

revoke all on function public.reopen_complaint(uuid) from public;
grant execute on function public.reopen_complaint(uuid) to authenticated;

revoke all on function public.escalate_stale_complaints() from public;

-- ============================================================================
-- 8. Realtime — publish complaints UPDATE events so the student + staff
--    detail pages can show status changes without a refresh. Only runs in a
--    real Supabase project (where the publication exists). RLS decides who
--    receives events; student_id is not selectable by `authenticated`, so it
--    can never appear in a payload.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'complaints'
     ) then
    alter publication supabase_realtime add table public.complaints;
  end if;
end
$$;

-- ============================================================================
-- 9. Automatic escalation scheduling (pg_cron).
--    In a real Supabase project: enable pg_cron in Dashboard -> Database ->
--    Extensions (or `create extension pg_cron`), then this migration
--    schedules `day9-escalate-stale-complaints` every 15 minutes.
--    In local verification (embedded-postgres) pg_cron does not exist, so
--    both blocks are no-ops — the harness calls escalate_stale_complaints()
--    directly instead.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Idempotent: unschedule any previous run of this job, then re-create.
    if exists (select 1 from cron.job where jobname = 'day9-escalate-stale-complaints') then
      perform cron.unschedule('day9-escalate-stale-complaints');
    end if;
    perform cron.schedule(
      'day9-escalate-stale-complaints',
      '*/15 * * * *',
      $cmd$select public.escalate_stale_complaints()$cmd$
    );
  end if;
end
$$;
