-- ============================================================================
-- Day 8A — Chat message controls: edit, delete for me, delete for everyone
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3, Day 6 and Day 7 migrations. It is idempotent (guarded
-- statements) so it can be re-run safely, but re-running is not required.
--
-- What this migration adds — and deliberately does NOT add:
--
--   * NO new messages table. The Day 3 `messages` table gains three columns:
--       - edited_at   timestamptz NULL        (set by the edit RPC)
--       - is_deleted  boolean NOT NULL DEFAULT false
--       - deleted_at  timestamptz NULL        (set by the delete-for-everyone RPC)
--     Deleted rows are NEVER physically removed: delete-for-everyone is a
--     soft delete so the state can propagate through Realtime and both sides
--     show "This message was deleted".
--
--   * message_user_deletions — per-user "delete for me" records. Each row
--     hides ONE message from ONE user only. RLS restricts every policy to
--     the caller's own rows; the client is only granted SELECT (to restore
--     hidden state on load) — the delete-for-me RPC is the only writer.
--
--   * Three SECURITY DEFINER RPCs are the ONLY write paths (there is no
--     UPDATE or DELETE grant on public.messages and no INSERT/DELETE grant
--     on message_user_deletions for any client role):
--       - edit_complaint_message(message_id, new_body)
--       - delete_complaint_message_for_everyone(message_id)
--       - delete_complaint_message_for_me(message_id)
--     Each one: rejects unauthenticated callers, verifies complaint access
--     through the existing can_access_complaint() security model, verifies
--     message ownership (auth.uid() = sender_id) where required, validates
--     message state, performs the operation atomically and returns only safe
--     fields. sender_id / sender_role / user_id are NEVER accepted from the
--     client — auth.uid() is the only identity source inside the functions.
--
--   * messages_staff_view is extended with the new safe columns (edited_at,
--     is_deleted, deleted_at) so the chat can render edit/deleted states
--     through the same identity-free projection. No RLS or grants change.
--
--   * Realtime needs NO migration change: `messages` is already in the
--     supabase_realtime publication (Day 7), so UPDATE events flow too. The
--     client adds an UPDATE subscription with the same complaint_id filter
--     and safe column selection; row-level RLS and column-selectability
--     guarantees are unchanged (sender_id remains unselectable).
--
-- SECURITY MODEL (summary)
--   * Ownership is decided by the database: auth.uid() = messages.sender_id.
--     sessionStorage ("my message ids") is UI styling only and is never
--     consulted for authorization.
--   * Edit rules    : own message only, complaint access required, deleted
--                     messages cannot be edited, body trimmed + validated
--                     (1..2000 chars), edited_at set, created_at /
--                     sender_role / sender_id never change.
--   * Delete rules  : for-everyone — original sender only, one-shot
--                     (no repeated deletes), soft delete (is_deleted +
--                     deleted_at), body no longer rendered. For-me — any
--                     authorized participant may hide a message from
--                     themselves; other users are unaffected; delete-for-
--                     everyone always takes precedence (rendering checks
--                     is_deleted first).
-- ============================================================================

-- ============================================================================
-- 1. messages — edit / soft-delete columns (guarded, additive).
-- ============================================================================
alter table public.messages add column if not exists edited_at  timestamptz;
alter table public.messages add column if not exists is_deleted boolean not null default false;
alter table public.messages add column if not exists deleted_at timestamptz;

-- Expose the new SAFE columns to authenticated reads. sender_id remains
-- unselectable (Day 3 grants) — nothing here changes that.
grant select (edited_at, is_deleted, deleted_at)
  on public.messages to authenticated;

-- ============================================================================
-- 2. message_user_deletions — per-user "delete for me" records.
-- ============================================================================
create table if not exists public.message_user_deletions (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  deleted_at  timestamptz not null default now(),
  unique (message_id, user_id)
);

alter table public.message_user_deletions enable row level security;

-- Every policy is restricted to the caller's OWN rows — no user can ever
-- read, create or remove another user's deletion records. (The RPC below is
-- the actual writer; these policies are defense-in-depth so even a future
-- accidental grant stays self-scoped.)
drop policy if exists message_user_deletions_select_own on public.message_user_deletions;
create policy message_user_deletions_select_own
  on public.message_user_deletions
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists message_user_deletions_insert_own on public.message_user_deletions;
create policy message_user_deletions_insert_own
  on public.message_user_deletions
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists message_user_deletions_delete_own on public.message_user_deletions;
create policy message_user_deletions_delete_own
  on public.message_user_deletions
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on table public.message_user_deletions from anon, authenticated;
-- SELECT only: the client restores its own hidden set on load. user_id is
-- intentionally NOT granted — RLS already scopes rows to the caller and the
-- column is never needed by the UI. The RPC is the only writer.
grant select (id, message_id, deleted_at)
  on public.message_user_deletions to authenticated;

create index if not exists message_user_deletions_user_idx
  on public.message_user_deletions (user_id);

create index if not exists message_user_deletions_message_idx
  on public.message_user_deletions (message_id);

-- ============================================================================
-- 3. messages_staff_view — extended with the new safe columns (identity-free).
--    CREATE OR REPLACE preserves the existing grants; we re-assert them.
-- ============================================================================
create or replace view public.messages_staff_view
with (security_invoker = true)
as
select
  m.id,
  m.complaint_id,
  m.sender_role,
  m.body,
  m.created_at,
  m.edited_at,
  m.is_deleted,
  m.deleted_at
from public.messages m;

revoke all on table public.messages_staff_view from anon, authenticated;
grant select on public.messages_staff_view to authenticated;

-- ============================================================================
-- 4. RPCs — the only write paths. SECURITY DEFINER with every authorization
--    check INSIDE the function (RLS does not apply to the owner), following
--    the Day 6 update_complaint_status pattern. All column references are
--    table-qualified: the RETURNS TABLE output columns shadow table columns
--    in this scope (see the Day 6 lesson).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4.1 edit_complaint_message(message_id, new_body)
--     Only the original sender (auth.uid() = sender_id) may edit, and only
--     if they still have access to the complaint. Deleted messages cannot be
--     edited. Body is trimmed and validated (1..2000 chars, mirroring the
--     Day 7 CHECK). Returns the updated safe row.
-- ----------------------------------------------------------------------------
create or replace function public.edit_complaint_message(
  p_message_id uuid,
  p_new_body   text
)
returns table (
  id           uuid,
  complaint_id uuid,
  sender_role  public.sender_role,
  body         text,
  created_at   timestamptz,
  edited_at    timestamptz,
  is_deleted   boolean,
  deleted_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_body text;
  v_msg  record;
begin
  -- 1. Reject unauthenticated callers (defense in depth — grants already
  --    limit execution to `authenticated`).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  v_role := public.get_app_role();
  if v_role is null then
    raise exception 'Forbidden: no profile role';
  end if;

  -- 2. The message must exist.
  select m.id, m.complaint_id, m.sender_id, m.is_deleted
    into v_msg
    from public.messages m
   where m.id = p_message_id;
  if not found then
    raise exception 'Message not found';
  end if;

  -- 3. Complaint access through the existing security model.
  if not public.can_access_complaint(v_msg.complaint_id) then
    raise exception 'Forbidden: no access to this complaint';
  end if;

  -- 4. Ownership — auth.uid() = sender_id. Never trusted from the client.
  if v_msg.sender_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only edit your own messages';
  end if;

  -- 5. State validation: deleted messages are immutable.
  if v_msg.is_deleted then
    raise exception 'Cannot edit a deleted message';
  end if;

  -- 6. Body validation (mirrors the Day 7 CHECK constraint).
  v_body := regexp_replace(coalesce(p_new_body, ''), '^\s+|\s+$', '', 'g');
  if char_length(v_body) < 1 then
    raise exception 'Message body cannot be empty';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'Message body is too long (maximum 2000 characters)';
  end if;

  -- 7. Apply the edit atomically. Only body + edited_at change — created_at,
  --    sender_id and sender_role are untouched (they are not in the SET).
  return query
    update public.messages m
       set body = v_body,
           edited_at = now()
     where m.id = p_message_id
     returning m.id, m.complaint_id, m.sender_role, m.body, m.created_at,
               m.edited_at, m.is_deleted, m.deleted_at;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4.2 delete_complaint_message_for_everyone(message_id)
--     Soft delete by the ORIGINAL SENDER only (auth.uid() = sender_id) with
--     complaint access required. One-shot: an already-deleted message cannot
--     be deleted again. The row stays (id, complaint_id, sender_role,
--     created_at, deleted state) so the state can propagate through Realtime;
--     the UI never renders the original body for deleted messages.
-- ----------------------------------------------------------------------------
create or replace function public.delete_complaint_message_for_everyone(
  p_message_id uuid
)
returns table (
  id           uuid,
  complaint_id uuid,
  sender_role  public.sender_role,
  body         text,
  created_at   timestamptz,
  edited_at    timestamptz,
  is_deleted   boolean,
  deleted_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_msg  record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  v_role := public.get_app_role();
  if v_role is null then
    raise exception 'Forbidden: no profile role';
  end if;

  select m.id, m.complaint_id, m.sender_id, m.is_deleted
    into v_msg
    from public.messages m
   where m.id = p_message_id;
  if not found then
    raise exception 'Message not found';
  end if;

  if not public.can_access_complaint(v_msg.complaint_id) then
    raise exception 'Forbidden: no access to this complaint';
  end if;

  if v_msg.sender_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only delete your own messages';
  end if;

  if v_msg.is_deleted then
    raise exception 'Message is already deleted';
  end if;

  return query
    update public.messages m
       set is_deleted = true,
           deleted_at = now()
     where m.id = p_message_id
     returning m.id, m.complaint_id, m.sender_role, m.body, m.created_at,
               m.edited_at, m.is_deleted, m.deleted_at;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4.3 delete_complaint_message_for_me(message_id)
--     Any authorized participant may hide a message from themselves. Creates
--     (or idempotently keeps) the caller's OWN deletion record; the message
--     row and every other user's view are untouched. No ownership check —
--     this is a self-scoped preference, not a moderation action — but
--     complaint access IS required so an unrelated user cannot hide messages
--     they cannot even see.
-- ----------------------------------------------------------------------------
create or replace function public.delete_complaint_message_for_me(
  p_message_id uuid
)
returns table (
  message_id uuid,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text;
  v_cid   uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  v_role := public.get_app_role();
  if v_role is null then
    raise exception 'Forbidden: no profile role';
  end if;

  select m.complaint_id into v_cid
    from public.messages m
   where m.id = p_message_id;
  if not found then
    raise exception 'Message not found';
  end if;

  if not public.can_access_complaint(v_cid) then
    raise exception 'Forbidden: no access to this complaint';
  end if;

  -- `on conflict do nothing` (no column list): the OUT parameter `message_id`
  -- shadows the table column in this scope, so an unqualified conflict target
  -- would be ambiguous. The table has exactly one unique constraint
  -- (message_id, user_id), so the bare form is equivalent and safe.
  insert into public.message_user_deletions (message_id, user_id)
  values (p_message_id, auth.uid())
  on conflict do nothing;

  return query
    select mud.message_id, mud.deleted_at
      from public.message_user_deletions mud
     where mud.message_id = p_message_id
       and mud.user_id = auth.uid();
end;
$$;

-- ============================================================================
-- 5. Grants — RPCs are executable by `authenticated` only; anon gets nothing.
-- ============================================================================
revoke all on function public.edit_complaint_message(uuid, text) from public;
grant execute on function public.edit_complaint_message(uuid, text) to authenticated;

revoke all on function public.delete_complaint_message_for_everyone(uuid) from public;
grant execute on function public.delete_complaint_message_for_everyone(uuid) to authenticated;

revoke all on function public.delete_complaint_message_for_me(uuid) from public;
grant execute on function public.delete_complaint_message_for_me(uuid) to authenticated;
