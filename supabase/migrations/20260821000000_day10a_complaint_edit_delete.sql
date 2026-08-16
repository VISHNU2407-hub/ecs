-- ============================================================================
-- Day 10A — Complaint Edit & Delete (student, own submitted complaints)
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 + 6 + 7 + 8A + 8B + 9 + 9B migrations. It is idempotent (guarded
-- statements) so it can be re-run safely, but re-running is not required.
--
-- WHAT THIS MIGRATION ADDS — and deliberately does NOT add:
--
--   * complaints columns (additive, guarded):
--       - title          text            (nullable — existing complaints keep
--                                          working; the edit RPC requires a
--                                          non-empty title when editing)
--       - deleted_at     timestamptz     (NULL = not deleted; soft delete)
--       - deleted_by_role public.app_role (audit role that soft-deleted;
--                                          never exposed to any client role)
--     deleted_at / deleted_by_role are NOT granted to any client role and are
--     NOT projected by complaints_staff_view, so nobody can even learn that a
--     complaint was deleted — it simply behaves like an inaccessible row.
--
--   * TWO SECURITY DEFINER RPCs — the ONLY complaint write paths for a
--     student (there is still NO UPDATE / DELETE grant on public.complaints
--     for any client role):
--       - edit_complaint(complaint_id, new_title, new_description,
--                        new_category_id, new_priority)
--       - delete_complaint(complaint_id)
--     Every authorization check happens INSIDE the function (RLS does not
--     apply to the owner): authentication, role = student (from
--     public.profiles via get_app_role() — never trusted from the client),
--     ownership (complaint.student_id = auth.uid() — the user id is NEVER
--     accepted from the client), complaint exists, not deleted, and current
--     status = 'submitted'. No other role (faculty / committee / admin) can
--     edit or delete through these RPCs, and anonymous callers are rejected.
--
--   * EDIT RULES (enforced in the database):
--       - the student may change ONLY title, description, category_id and
--         priority. The UPDATE statement sets exactly those four columns —
--         id / ticket_number / student_id / department_id / status /
--         created_at / updated_at / sensitivity / handler_type can never be
--         written by the client.
--       - input validation: title 1..200 chars, description 20..10000 chars,
--         priority must be a valid priority_level (the parameter type
--         enforces the enum), category must exist.
--       - category routing: the new category must be mapped to the
--         complaint's OWN department via category_department_map (the
--         student can never pick a department — the complaint's department
--         stays derived). category-derived routing fields (is_sensitive,
--         handler_type, department_id) are recalculated by the EXISTING
--         derive_complaint_defaults() trigger on category changes, exactly
--         like submission.
--       - sensitivity is immutable through the edit path: a non-sensitive
--         complaint cannot be moved to a sensitive category and a sensitive
--         complaint cannot be moved to a non-sensitive one (no flipping, no
--         "make it sensitive", no un-sensitizing a committee-handled
--         complaint). Faculty visibility continues to be decided by
--         faculty_can_access_complaint() / can_access_complaint() reading
--         the (possibly new) category_id live — there is NO frontend routing.
--       - updated_at is refreshed by the existing Day 3 trigger.
--       - returns ONLY safe fields (never student_id / deleted_at /
--         deleted_by_role).
--
--   * DELETE RULES (enforced in the database):
--       - SOFT DELETE only: the complaint row is never physically removed.
--         deleted_at = now() + deleted_by_role = 'student' are set
--         atomically in a single UPDATE.
--       - only the owning student, only while status = 'submitted', only
--         once (an already-deleted complaint reports "not found").
--       - resolved / closed / under_review / ... complaints can never be
--         deleted by the student.
--       - faculty / committee / admin / anon cannot call it at all.
--
--   * VISIBILITY AFTER DELETE (every read path):
--       - every complaints SELECT policy gains `deleted_at is null`, and
--         can_access_complaint() / faculty_can_access_complaint() gain the
--         same guard — so the deleted complaint disappears from the student
--         dashboard, the staff dashboard, detail pages (student + staff),
--         direct-URL lookups, chat reads, status history and message
--         access. It returns the same "not found / no access" empty result
--         as any other inaccessible complaint — nothing leaks.
--       - complaints_staff_view is security-invoker, so it automatically
--         stops returning the row; it does NOT gain a deleted_at column (no
--         leak).
--       - status-write RPCs (update_complaint_status, confirm_complaint_
--         resolution, reopen_complaint) and the automatic escalation
--         function now refuse deleted complaints ("Complaint not found" /
--         skipped), so no hidden write path can resurrect or mutate one.
--       - messages and complaint_status_history are NEVER physically
--         deleted — history stays intact for audit — they are simply no
--         longer reachable through the app (all their read paths go through
--         can_access_complaint). Identity protection is unchanged:
--         sender_id / student_id / email / name remain unselectable.
--
--   * REALTIME: the existing per-complaint UPDATE subscriptions are left
--     unchanged. Deleting a complaint produces NO Realtime event for any
--     authenticated client (RLS intentionally drops events for rows the
--     subscriber can no longer SELECT) — that is the security model working
--     as intended, and it also guarantees nobody is ever told a complaint
--     existed and was deleted. The deleting student's page navigates to the
--     dashboard immediately, and the dashboards refetch on focus, so a
--     deleted complaint disappears from open views without a manual refresh
--     (see src/pages/StudentPage.jsx / StaffPage.jsx).
--
-- NO CHANGES to: departments, complaint_categories, category_department_map,
-- messages, message_user_deletions, conversation_user_state, faculty_category_
-- assignments, the Day 6 transition map, the Day 9 RPCs' behavior (only the
-- deleted-complaint guard is added), or the anonymous chat security model.
-- ============================================================================

-- ============================================================================
-- 1. complaints — title + soft-delete columns (additive, guarded).
--    deleted_at / deleted_by_role are NOT granted to any client role.
-- ============================================================================
alter table public.complaints add column if not exists title          text;
alter table public.complaints add column if not exists deleted_at     timestamptz;
alter table public.complaints add column if not exists deleted_by_role public.app_role;

-- title is a SAFE field the owner may read (to prefill the edit form and
-- display on the detail page). deleted_at / deleted_by_role stay unselectable.
grant select (title) on public.complaints to authenticated;

create index if not exists complaints_deleted_at_idx
  on public.complaints (deleted_at)
  where deleted_at is not null;

-- ============================================================================
-- 2. Category-change trigger — re-derives is_sensitive / handler_type /
--    department_id from the NEW category using the EXACT same derivation as
--    submission (derive_complaint_defaults). Fires only when the UPDATE lists
--    category_id (which is all the edit RPC ever does for routing fields).
--    This keeps routing consistent after an edit with zero client input for
--    those fields.
-- ============================================================================
drop trigger if exists complaints_derive_defaults_on_category_update on public.complaints;
create trigger complaints_derive_defaults_on_category_update
  before update of category_id on public.complaints
  for each row execute function public.derive_complaint_defaults();

-- ============================================================================
-- 3. Visibility helpers — deleted complaints are indistinguishable from
--    inaccessible ones on EVERY path.
--    can_access_complaint() drives chat, status history and message access;
--    faculty_can_access_complaint() drives faculty visibility + the faculty
--    RLS policy + faculty status updates.
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
      and c.deleted_at is null
      and c.department_id = p.department_id
      and exists (
        select 1
        from public.faculty_category_assignments fca
        where fca.faculty_id = p.id
          and fca.category_id = c.category_id
      )
  )
$$;

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
      where c.id = p_complaint_id and c.student_id = auth.uid() and c.deleted_at is null
    )
    when 'faculty' then public.faculty_can_access_complaint(p_complaint_id)
    when 'admin' then exists (
      select 1 from public.complaints c
      where c.id = p_complaint_id and c.deleted_at is null
    )
    when 'committee' then exists (
      select 1 from public.complaints c
      where c.id = p_complaint_id and c.is_sensitive = true and c.deleted_at is null
    )
    else false
  end
$$;

-- ============================================================================
-- 4. Base-table RLS — every SELECT policy excludes soft-deleted complaints.
--    The base table remains the security boundary (not just the view), and
--    INSERT ... RETURNING keeps working for students exactly as before (the
--    brand-new row has deleted_at = null, and the student policy passes).
-- ============================================================================
drop policy if exists complaints_select_student on public.complaints;
create policy complaints_select_student
  on public.complaints
  for select to authenticated
  using (student_id = auth.uid() and deleted_at is null);

drop policy if exists complaints_select_faculty on public.complaints;
create policy complaints_select_faculty
  on public.complaints
  for select to authenticated
  using (public.faculty_can_access_complaint(id));

drop policy if exists complaints_select_admin on public.complaints;
create policy complaints_select_admin
  on public.complaints
  for select to authenticated
  using (public.get_app_role() = 'admin' and deleted_at is null);

drop policy if exists complaints_select_committee on public.complaints;
create policy complaints_select_committee
  on public.complaints
  for select to authenticated
  using (public.get_app_role() = 'committee' and is_sensitive = true and deleted_at is null);

-- ============================================================================
-- 5. Status-write RPCs — refuse deleted complaints so no hidden write path
--    can mutate or resurrect one. Behavior for live complaints is UNCHANGED
--    (same authorization, same transition map, same history entries).
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

  -- 2. The complaint must exist AND must not be soft-deleted.
  select c.id, c.ticket_number, c.status, c.is_sensitive, c.department_id
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id
     and c.deleted_at is null;
  if not found then
    raise exception 'Complaint not found';
  end if;

  -- 3. Authorization (Day 9B): faculty -> the assignment rule; committee ->
  --    sensitive only; admin -> all.
  if v_role = 'faculty' then
    if not public.faculty_can_access_complaint(p_complaint_id) then
      raise exception 'Forbidden: you are not assigned to this complaint category';
    end if;
  elsif v_role = 'committee' and not v_complaint.is_sensitive then
    raise exception 'Forbidden: committee can only modify sensitive complaints';
  end if;

  -- 4. Department authorization (defense in depth).
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
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may confirm resolution';
  end if;

  select c.id, c.ticket_number, c.status, c.student_id
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id
     and c.deleted_at is null;
  if not found then
    raise exception 'Complaint not found';
  end if;

  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only confirm resolution of your own complaint';
  end if;

  if v_complaint.status <> 'resolved' then
    raise exception 'Complaint can only be closed after it is resolved';
  end if;

  if not public.can_transition_status(v_complaint.status, 'closed') then
    raise exception 'Invalid status transition from % to closed', v_complaint.status;
  end if;

  return query
    update public.complaints
       set status = 'closed'
     where id = p_complaint_id
     returning complaints.ticket_number, complaints.status, complaints.updated_at;

  insert into public.complaint_status_history
    (complaint_id, previous_status, new_status, changed_by_role)
  values
    (p_complaint_id, v_complaint.status, 'closed', 'student');
end;
$$;

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
   where c.id = p_complaint_id
     and c.deleted_at is null;
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
-- 6. Automatic escalation — never touches soft-deleted complaints.
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
  select coalesce(
           (select value::interval from public.system_settings where key = 'escalation_threshold'),
           interval '48 hours'
         )
    into v_threshold;

  v_cutoff := now() - v_threshold;

  for v_row in
    select c.id, c.ticket_number, c.status
      from public.complaints c
     where c.status in ('submitted', 'under_review')
       and c.deleted_at is null
       and c.updated_at < v_cutoff
     order by c.id
  loop
    v_previous := v_row.status;

    if public.can_transition_status(v_previous, 'escalated') then
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
-- 7. complaints_staff_view — gains the safe `title` column (identity-free).
--    No deleted_at / deleted_by_role columns, so the view never leaks that a
--    complaint was deleted. Security-invoker: the RLS above automatically
--    excludes deleted rows. Grants re-asserted.
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
  (c.status = 'escalated') as is_escalated,
  -- Day 10A: appended LAST so CREATE OR REPLACE VIEW stays legal (new
  -- columns can only be added at the end). The frontend selects by name.
  c.title
from public.complaints c
left join public.complaint_categories cc on cc.id = c.category_id
left join public.departments d          on d.id   = c.department_id;

revoke all on table public.complaints_staff_view from anon, authenticated;
grant select on public.complaints_staff_view to authenticated;

-- ============================================================================
-- 8. edit_complaint(complaint_id, new_title, new_description, new_category_id,
--    new_priority) — the ONLY student edit path.
--
--    SECURITY DEFINER: every check is INSIDE the function (RLS does not apply
--    to the owner). The client sends ONLY the four editable values; identity,
--    ownership, department and status are derived/verified server-side from
--    auth.uid() and the existing row. Only title / description / category_id /
--    priority are ever written; everything else is derived by the existing
--    triggers (category derivation + updated_at). Returns only safe fields.
-- ============================================================================
create or replace function public.edit_complaint(
  p_complaint_id    uuid,
  p_new_title       text,
  p_new_description text,
  p_new_category_id uuid,
  p_new_priority    public.priority_level
)
returns table (
  id             uuid,
  ticket_number  text,
  category_id    uuid,
  department_id  uuid,
  title          text,
  description    text,
  priority       public.priority_level,
  status         public.complaint_status,
  handler_type   public.handler_type,
  is_sensitive   boolean,
  created_at     timestamptz,
  updated_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role          text;
  v_complaint     record;
  v_title         text;
  v_description   text;
  v_is_sensitive  boolean;
  v_department_id uuid;
begin
  -- 1. Reject unauthenticated callers (defense in depth — grants already
  --    limit execution to `authenticated`).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Only the owning student may edit. The role comes from
  --    public.profiles.role via get_app_role() — never from the client.
  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may edit a complaint';
  end if;

  -- 3. The complaint must exist and must not be soft-deleted. A deleted
  --    complaint behaves exactly like a missing one ("not found").
  select c.id, c.ticket_number, c.student_id, c.status, c.is_sensitive,
         c.department_id, c.deleted_at
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id;
  if not found or v_complaint.deleted_at is not null then
    raise exception 'Complaint not found';
  end if;

  -- 4. Ownership — derived from auth.uid(), never accepted from the client.
  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only edit your own complaint';
  end if;

  -- 5. Only while the complaint is still submitted. Once staff have picked
  --    it up (or it is resolved/closed/escalated), the record is frozen.
  if v_complaint.status is distinct from 'submitted' then
    raise exception 'Complaint can only be edited while it is submitted';
  end if;

  -- 6. Validate inputs (mirrors the complaint-creation rules; title is new).
  v_title := regexp_replace(coalesce(p_new_title, ''), '^\s+|\s+$', '', 'g');
  if char_length(v_title) < 1 then
    raise exception 'Title cannot be empty';
  end if;
  if char_length(v_title) > 200 then
    raise exception 'Title is too long (maximum 200 characters)';
  end if;

  v_description := regexp_replace(coalesce(p_new_description, ''), '^\s+|\s+$', '', 'g');
  if char_length(v_description) < 20 then
    raise exception 'Description must be at least 20 characters';
  end if;
  if char_length(v_description) > 10000 then
    raise exception 'Description is too long (maximum 10000 characters)';
  end if;

  if p_new_priority is null then
    raise exception 'Priority is required';
  end if;

  -- 7. Validate the category: it must exist, must be non-sensitive when the
  --    complaint is non-sensitive (and vice versa — sensitivity can never be
  --    flipped through the edit path), and must belong to the complaint's OWN
  --    department via category_department_map. The student can never pick a
  --    department; the complaint's department stays the derived one.
  if p_new_category_id is null then
    raise exception 'Category is required';
  end if;

  -- The RETURNS TABLE output column `is_sensitive` shadows the table column
  -- in this scope, so the source column is table-qualified (Day 6 lesson).
  select cc.is_sensitive into v_is_sensitive
    from public.complaint_categories cc
   where cc.id = p_new_category_id;
  if not found then
    raise exception 'Invalid category';
  end if;

  if v_is_sensitive is distinct from v_complaint.is_sensitive then
    raise exception 'Forbidden: changing the sensitivity of a complaint is not allowed';
  end if;

  select m.department_id into v_department_id
    from public.category_department_map m
   where m.category_id = p_new_category_id
     and m.department_id = v_complaint.department_id
   limit 1;
  if v_department_id is null then
    raise exception 'Category does not belong to this complaint department';
  end if;

  -- 8. Update ONLY the permitted fields. The Day 10A category-update trigger
  --    re-derives is_sensitive / handler_type / department_id from the new
  --    category (identical derivation to submission), and the Day 3 trigger
  --    refreshes updated_at. No identity/routing/status column is writable.
  return query
    update public.complaints c
       set title       = v_title,
           description = v_description,
           category_id = p_new_category_id,
           priority    = p_new_priority
     where c.id = p_complaint_id
     returning c.id, c.ticket_number, c.category_id, c.department_id, c.title,
               c.description, c.priority, c.status, c.handler_type, c.is_sensitive,
               c.created_at, c.updated_at;
end;
$$;

-- ============================================================================
-- 9. delete_complaint(complaint_id) — the ONLY student delete path.
--    SOFT DELETE: sets deleted_at + deleted_by_role atomically; the row and
--    its messages/history are never physically removed. Same authorization
--    model as the edit RPC (authenticated, role = student, ownership via
--    auth.uid(), exists, not already deleted, status = 'submitted').
-- ============================================================================
create or replace function public.delete_complaint(
  p_complaint_id uuid
)
returns table (
  ticket_number text,
  status        public.complaint_status,
  deleted_at    timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role      text;
  v_complaint record;
begin
  -- 1. Reject unauthenticated callers (defense in depth).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Only the owning student may delete. Role from public.profiles.role.
  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may delete a complaint';
  end if;

  -- 3. The complaint must exist and must not already be deleted.
  select c.id, c.ticket_number, c.student_id, c.status, c.deleted_at
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id;
  if not found or v_complaint.deleted_at is not null then
    raise exception 'Complaint not found';
  end if;

  -- 4. Ownership — derived from auth.uid(), never accepted from the client.
  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only delete your own complaint';
  end if;

  -- 5. Only while submitted. Resolved / closed / in-progress / escalated /
  --    reopened / under-review / assigned complaints cannot be deleted.
  if v_complaint.status is distinct from 'submitted' then
    raise exception 'Complaint can only be deleted while it is submitted';
  end if;

  -- 6. Atomic soft delete. updated_at is refreshed by the Day 3 trigger.
  --    deleted_by_role records the acting ROLE (student) for audit only and
  --    is never exposed to any client role.
  return query
    update public.complaints c
       set deleted_at     = now(),
           deleted_by_role = 'student'
     where c.id = p_complaint_id
     returning c.ticket_number, c.status, c.deleted_at;
end;
$$;

-- ============================================================================
-- 10. Grants — the two RPCs are executable by `authenticated` only; anon
--     gets nothing. The role checks inside decide who may actually use them.
--     There is still NO UPDATE / DELETE grant on public.complaints for any
--     client role, so the RPCs are the only complaint write paths.
-- ============================================================================
revoke all on function public.edit_complaint(uuid, text, text, uuid, public.priority_level) from public;
grant execute on function public.edit_complaint(uuid, text, text, uuid, public.priority_level) to authenticated;

revoke all on function public.delete_complaint(uuid) from public;
grant execute on function public.delete_complaint(uuid) to authenticated;
