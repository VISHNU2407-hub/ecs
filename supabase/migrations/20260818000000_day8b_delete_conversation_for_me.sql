-- ============================================================================
-- Day 8B — Delete conversation for me
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 + 6 + 7 + 8A migrations. It is idempotent (guarded statements).
--
-- What this migration adds — and deliberately does NOT add:
--
--   * conversation_user_state — a per-user, per-complaint CUTOFF record:
--       deleted_before timestamptz
--     When a user chooses "Delete conversation", their row records the
--     current time. Message reads filter to created_at > deleted_before, so:
--       - messages that existed BEFORE the deletion stay hidden for that
--         user only;
--       - messages created AFTER the deletion become visible again (a plain
--         boolean would wrongly hide everything forever);
--       - the complaint and the messages themselves are NEVER touched.
--
--   * The cutoff is an ADDITIONAL user-specific visibility filter layered on
--     top of the existing Day 8A behavior (delete for me, delete for
--     everyone, edits) — those all keep working exactly as before, and
--     delete-for-everyone always takes precedence.
--
--   * RLS: every policy is self-scoped to the caller (user_id = auth.uid()).
--     The client is granted SELECT only (to restore the cutoff on load), and
--     user_id is NOT included in that grant — it is an internal/security
--     field that must never appear in responses, Realtime payloads or UI.
--
--   * delete_complaint_conversation_for_me(complaint_id) — a SECURITY
--     DEFINER RPC, the ONLY write path (no INSERT/UPDATE grant on the table
--     for any client role). It verifies authentication + complaint access
--     via the existing can_access_complaint() model, derives user_id from
--     auth.uid() (never accepted from the client), and upserts
--     deleted_before = now(). Returns only the safe cutoff timestamp.
--
-- No changes to messages, messages_staff_view, can_access_complaint(),
-- messages_set_sender, the Day 8A RPCs, status RPCs or complaint RLS.
-- ============================================================================

-- ============================================================================
-- 1. conversation_user_state — per-user conversation cutoff.
-- ============================================================================
create table if not exists public.conversation_user_state (
  id             uuid primary key default gen_random_uuid(),
  complaint_id   uuid not null references public.complaints (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  deleted_before timestamptz not null,
  updated_at     timestamptz not null default now(),
  unique (complaint_id, user_id)
);

alter table public.conversation_user_state enable row level security;

-- Self-scoped policies: a user can only ever see / create / update their own
-- row. user_id is derived from auth.uid() in the RPC — these policies are
-- defense-in-depth so even a future accidental grant stays self-scoped.
drop policy if exists conversation_state_select_own on public.conversation_user_state;
create policy conversation_state_select_own
  on public.conversation_user_state
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists conversation_state_insert_own on public.conversation_user_state;
create policy conversation_state_insert_own
  on public.conversation_user_state
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists conversation_state_update_own on public.conversation_user_state;
create policy conversation_state_update_own
  on public.conversation_user_state
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on table public.conversation_user_state from anon, authenticated;
-- SELECT only, and WITHOUT user_id (internal field). The RPC is the only
-- writer; there is no INSERT/UPDATE grant for any client role.
grant select (id, complaint_id, deleted_before, updated_at)
  on public.conversation_user_state to authenticated;

create index if not exists conversation_user_state_user_idx
  on public.conversation_user_state (user_id);

create index if not exists conversation_user_state_complaint_idx
  on public.conversation_user_state (complaint_id);

-- ============================================================================
-- 2. delete_complaint_conversation_for_me(complaint_id)
--    SECURITY DEFINER, the ONLY write path. Authorization is checked INSIDE
--    (RLS does not apply to the owner):
--      1. reject unauthenticated callers
--      2. verify complaint access via the existing can_access_complaint()
--      3. user_id = auth.uid() — never accepted from the client
--      4. upsert deleted_before = now() (a cutoff, not a permanent flag)
--      5. return only the safe cutoff timestamp
--
--    NOTE: the function returns a single column named `deleted_before`, so
--    `complaint_id` is NOT an OUT parameter — an unqualified ON CONFLICT
--    target (complaint_id, user_id) resolves to table columns without
--    ambiguity (see the Day 8A lesson about OUT-parameter shadowing).
-- ============================================================================
create or replace function public.delete_complaint_conversation_for_me(
  p_complaint_id uuid
)
returns table (
  deleted_before timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  -- 1. Reject unauthenticated callers (grants already limit execution to
  --    `authenticated`; this is defense in depth).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  v_role := public.get_app_role();
  if v_role is null then
    raise exception 'Forbidden: no profile role';
  end if;

  -- 2. Complaint access through the existing security model.
  if not public.can_access_complaint(p_complaint_id) then
    raise exception 'Forbidden: no access to this complaint';
  end if;

  -- 3 + 4. Upsert the caller's cutoff. A user's state is strictly their
  -- own: user_id comes from auth.uid(), never from the client.
  insert into public.conversation_user_state (complaint_id, user_id, deleted_before)
  values (p_complaint_id, auth.uid(), now())
  on conflict (complaint_id, user_id)
  do update set deleted_before = excluded.deleted_before,
                updated_at     = now();

  -- 5. Return only the safe cutoff timestamp.
  return query
    select cs.deleted_before
      from public.conversation_user_state cs
     where cs.complaint_id = p_complaint_id
       and cs.user_id = auth.uid();
end;
$$;

-- ============================================================================
-- 3. Grants — RPC executable by `authenticated` only; anon gets nothing.
-- ============================================================================
revoke all on function public.delete_complaint_conversation_for_me(uuid) from public;
grant execute on function public.delete_complaint_conversation_for_me(uuid) to authenticated;
