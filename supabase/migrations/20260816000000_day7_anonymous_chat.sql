-- ============================================================================
-- Day 7 — Anonymous complaint chat + Supabase Realtime
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 and Day 6 migrations. It is idempotent (guarded statements).
--
-- What this migration adds — and deliberately does NOT add:
--
--   * NO new table. The existing Day 3 `messages` table is the conversation
--     store: id, complaint_id, sender_id, sender_role, body, created_at.
--   * NO RLS changes. The Day 3 policies already satisfy Day 7 exactly:
--       - SELECT via public.can_access_complaint(complaint_id): student ->
--         own complaints, faculty -> non-sensitive, committee -> sensitive,
--         admin -> all. No broad "any authenticated user" policy exists.
--       - INSERT with the same authorization check; the client may only
--         write (complaint_id, body) — sender_id and sender_role are set by
--         the Day 3 messages_set_sender trigger from auth.uid() and the
--         caller's app role, so the client can never forge them.
--       - Column grants hide sender_id from every authenticated read, and
--         messages_staff_view projects only identity-free fields.
--
--   * One validation constraint on messages.body (mirrors the client):
--       - empty / whitespace-only bodies are rejected
--       - bodies longer than 2000 characters are rejected
--
--   * Realtime wiring: adds `messages` to the `supabase_realtime`
--     publication (guarded — the publication only exists in a real Supabase
--     project, so this is a no-op in the local verification harnesses).
--
-- Realtime security note: the client subscribes to postgres_changes with an
-- explicit column selection (id, complaint_id, sender_role, body, created_at)
-- and a complaint_id filter. Supabase Realtime (a) applies row-level RLS so
-- unauthorized clients receive no events, and (b) only allows selecting
-- columns the subscribing role can read — sender_id is NOT selectable by
-- `authenticated`, so it can never appear in a payload.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. messages.body validation (guarded, idempotent)
-- ----------------------------------------------------------------------------
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages
  add constraint messages_body_check
  check (char_length(regexp_replace(body, '^\s+|\s+$', '', 'g')) between 1 and 2000);

-- ----------------------------------------------------------------------------
-- 2. Realtime: publish INSERT events for messages.
--    Only runs in a real Supabase project (where the publication exists).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'messages'
     ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;
