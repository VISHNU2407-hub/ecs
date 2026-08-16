-- ============================================================================
-- Day 10B — Complaint Attachments (images + optional video)
-- College Complaint Management System (ECS MVP pilot)
--
-- Run this ONCE in the Supabase SQL editor (or via `supabase db push`), after
-- the Day 3 + 6 + 7 + 8A + 8B + 9 + 9B + 10A migrations. It is idempotent
-- (guarded statements) so it can be re-run safely, but re-running is not
-- required.
--
-- WHAT THIS MIGRATION ADDS — and deliberately does NOT add:
--
--   * PRIVATE Storage bucket `complaint-attachments` (public = false, so no
--     public URLs exist; getPublicUrl() is never used anywhere). The bucket
--     carries a 50 MB file_size_limit and the allowed MIME types as
--     defense-in-depth; the RPCs below remain the authoritative validators.
--
--   * public.complaint_attachments — METADATA ONLY (never file bytes):
--       id           uuid PK
--       complaint_id uuid NOT NULL -> public.complaints(id) on delete cascade
--       storage_path text NOT NULL UNIQUE   (random, identity-free path)
--       file_name    text NOT NULL          (sanitized display name)
--       media_type   text NOT NULL          (whitelisted MIME)
--       file_size    bigint NOT NULL        (actual uploaded bytes)
--       created_at   timestamptz NOT NULL
--     No identity columns exist at all (no student_id / sender_id / email /
--     name / profile id), so the table cannot leak identity by construction.
--     CHECK constraints re-assert the MIME whitelist, positive size and the
--     storage-path shape (complaints/<uuid>/<random-uuid>.<allowed-ext>).
--
--   * RLS on complaint_attachments: SELECT only, using the EXISTING
--     authoritative rule can_access_complaint(complaint_id) — the same rule
--     that gates chat/history/messages and which (since Day 10A) already
--     returns false for soft-deleted complaints. There are NO INSERT /
--     UPDATE / DELETE policies and NO grants for them — the two SECURITY
--     DEFINER RPCs are the only write paths.
--
--   * Storage policies on storage.objects for the bucket (the storage
--     service enforces these for uploads / downloads / signed URLs):
--       SELECT  — path under complaints/<complaint_id>/... AND
--                 can_access_complaint(complaint_id) — i.e. the owning
--                 student, faculty via faculty_can_access_complaint(),
--                 committee for sensitive, admin for all; soft-deleted
--                 complaints are excluded by can_access_complaint, so a
--                 deleted complaint's files are unreachable (and never
--                 reveal that they existed).
--       INSERT  — the OWNING student, complaint submitted + not deleted,
--                 allowed extension, size cap (defense-in-depth; the RPC is
--                 authoritative).
--       DELETE  — the OWNING student, submitted + not deleted (used for
--                 remove-attachment and orphan cleanup). Staff/committee/
--                 admin have no storage write access at all.
--     The complaint id is parsed from the path (never from the client as an
--     identity — it is a public, random complaint uuid).
--
--   * TWO SECURITY DEFINER RPCs — the ONLY attachment write paths (there is
--     no INSERT/UPDATE/DELETE grant on complaint_attachments for any client
--     role):
--       - create_complaint_attachment(complaint_id, storage_path, file_name,
--                                     media_type, file_size)
--         Verifies INSIDE the function: authenticated caller, role =
--         student (from public.profiles via get_app_role() — never from the
--         client), complaint exists, not soft-deleted, ownership
--         (student_id = auth.uid() — never accepted from the client), status
--         = 'submitted', storage-path shape + folder == complaint id,
--         media-type whitelist + extension match, per-type size limits
--         (image 5 MB / video 50 MB), total-size limit (60 MB per
--         complaint), image count (max 5) and video count (max 1), and —
--         critically — that the uploaded object actually exists in the
--         bucket, was uploaded by the caller (storage.objects.owner =
--         auth.uid()) and its server-recorded byte size matches the claimed
--         file_size, so a client cannot bypass the size limits by lying
--         about metadata. Returns ONLY safe fields (never an identity).
--       - delete_complaint_attachment(attachment_id)
--         Same authorization model (authenticated, student, ownership of
--         the PARENT complaint, not deleted, status submitted, and the
--         attachment must belong to that complaint). Deletes the METADATA
--         row (never the complaint, never messages/history) and returns the
--         storage_path so the client can remove the file object.
--
--   * Realtime: complaint_attachments is intentionally NOT added to the
--     supabase_realtime publication — attachments need no global Realtime;
--     the existing per-complaint status subscriptions are untouched.
--
-- NO CHANGES to: departments, complaint_categories, category_department_map,
-- complaints (columns/policies/RPCs), messages, chat controls, conversation
-- state, resolution/reopen/escalation, faculty assignments, the Day 10A
-- soft-delete model, or any existing RLS policy. All existing features keep
-- their exact behavior; Day 10B only ADDS attachment storage + metadata.
-- ============================================================================

-- ============================================================================
-- 1. PRIVATE storage bucket.
--    public = false: no public URLs, ever. The storage service enforces the
--    bucket-level size cap and MIME whitelist as a first layer; the RPCs and
--    the storage policies below are the real security boundary.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'complaint-attachments',
  'complaint-attachments',
  false,
  52428800, -- 50 MB (the video cap; the tighter 5 MB image cap is enforced by the RPC)
  array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']::text[]
)
on conflict (id) do update
  set public = false,
      file_size_limit = 52428800,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']::text[];

-- ============================================================================
-- 2. public.complaint_attachments — METADATA ONLY.
--    Identity-free by construction: no student/sender/profile columns exist.
-- ============================================================================
create table if not exists public.complaint_attachments (
  id            uuid primary key default gen_random_uuid(),
  complaint_id  uuid not null references public.complaints (id) on delete cascade,
  storage_path  text not null unique,
  file_name     text not null,
  media_type    text not null,
  file_size     bigint not null,
  created_at    timestamptz not null default now(),
  constraint complaint_attachments_media_type_check check (
    media_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime')
  ),
  constraint complaint_attachments_file_size_positive check (file_size > 0),
  constraint complaint_attachments_storage_path_shape check (
    storage_path ~ '^complaints/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|mp4|webm|mov)$'
  )
);

create index if not exists complaint_attachments_complaint_idx
  on public.complaint_attachments (complaint_id);

alter table public.complaint_attachments enable row level security;

-- The ONLY read policy: the same authoritative access rule that gates chat,
-- history and messages (can_access_complaint). Since Day 10A that rule also
-- requires deleted_at is null, so a soft-deleted complaint's attachments are
-- invisible to every role — and the metadata never leaks that the complaint
-- existed. There are deliberately NO INSERT/UPDATE/DELETE policies: the
-- SECURITY DEFINER RPCs are the only write paths.
drop policy if exists complaint_attachments_select_accessible on public.complaint_attachments;
create policy complaint_attachments_select_accessible
  on public.complaint_attachments
  for select to authenticated
  using (public.can_access_complaint(complaint_id));

-- Strip the broad default grants, then grant SELECT of the safe, identity-
-- free columns only. storage_path is a randomized, identity-free path the
-- client needs to request short-lived signed URLs; it is never rendered in
-- the UI.
revoke all on table public.complaint_attachments from anon, authenticated;
grant select (id, complaint_id, storage_path, file_name, media_type, file_size, created_at)
  on public.complaint_attachments to authenticated;

-- ============================================================================
-- 3. Storage object policies (bucket 'complaint-attachments').
--    The storage service enforces these for every upload / download /
--    signed-URL request. All authorization derives from the complaint id
--    parsed out of the path — never from identity.
--
--    NOTE: policy expressions run with the QUERYING user's privileges, and
--    Day 3 hides complaints.student_id from `authenticated` via column
--    grants — so the INSERT/DELETE policies cannot reference student_id
--    directly. They call the SECURITY DEFINER helper below instead, exactly
--    like the existing can_access_complaint() / faculty_can_access_
--    complaint() helpers used by other policies.
-- ============================================================================

-- can_student_manage_attachments(complaint_id) — true only when the caller
-- is a STUDENT who OWNS the complaint (student_id = auth.uid()), the
-- complaint is not soft-deleted and its status is 'submitted'. SECURITY
-- DEFINER so the storage policies can check ownership without being blocked
-- by the student_id column grant; it only ever answers about the CALLER's
-- own complaint, so executing it leaks nothing (anon gets no grant).
create or replace function public.can_student_manage_attachments(p_complaint_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.get_app_role() = 'student' and exists (
    select 1 from public.complaints c
    where c.id = p_complaint_id
      and c.student_id = auth.uid()
      and c.deleted_at is null
      and c.status = 'submitted'
  )
$$;

revoke all on function public.can_student_manage_attachments(uuid) from public;
grant execute on function public.can_student_manage_attachments(uuid) to authenticated;

-- 3.1 SELECT — anyone who can access the complaint (via the authoritative
--     rule) can read the files. Deleted complaints are excluded because
--     can_access_complaint() requires deleted_at is null.
drop policy if exists complaint_attachments_storage_select on storage.objects;
create policy complaint_attachments_storage_select
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'complaint-attachments'
    and (storage.foldername(name))[1] = 'complaints'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_access_complaint((storage.foldername(name))[2]::uuid)
  );

-- 3.2 INSERT — only the OWNING student, only while the complaint is
--     submitted and not soft-deleted (via can_student_manage_attachments),
--     only allowed extensions, and a defense-in-depth size cap (the RPC
--     re-verifies the real byte size from storage.objects.metadata and is
--     the authoritative validator).
drop policy if exists complaint_attachments_storage_insert on storage.objects;
create policy complaint_attachments_storage_insert
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'complaint-attachments'
    and (storage.foldername(name))[1] = 'complaints'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_student_manage_attachments((storage.foldername(name))[2]::uuid)
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm', 'mov')
    and coalesce((metadata ->> 'size')::bigint, 0) <= 52428800
  );

-- 3.3 DELETE — only the OWNING student, submitted + not deleted. Used by the
--     remove-attachment flow (after the RPC deletes the metadata) and by
--     orphan cleanup. Staff / committee / admin have no storage write access.
drop policy if exists complaint_attachments_storage_delete on storage.objects;
create policy complaint_attachments_storage_delete
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'complaint-attachments'
    and (storage.foldername(name))[1] = 'complaints'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_student_manage_attachments((storage.foldername(name))[2]::uuid)
  );

-- ============================================================================
-- 4. create_complaint_attachment(complaint_id, storage_path, file_name,
--    media_type, file_size) — the ONLY way attachment metadata is created.
--
--    SECURITY DEFINER: every authorization check happens INSIDE the function
--    (RLS does not apply to the owner). The client sends only the storage
--    path / display name / media type / size; identity, ownership and status
--    are derived/verified server-side from auth.uid() and the existing rows.
--    The uploaded object must exist, be owned by the caller and its
--    server-recorded byte size must match, so clients cannot bypass the
--    limits by lying about the metadata. Returns only safe fields.
-- ============================================================================
create or replace function public.create_complaint_attachment(
  p_complaint_id uuid,
  p_storage_path text,
  p_file_name    text,
  p_media_type   text,
  p_file_size    bigint
)
returns table (
  id           uuid,
  complaint_id uuid,
  storage_path text,
  file_name    text,
  media_type   text,
  file_size    bigint,
  created_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_complaint   record;
  v_file_name   text;
  v_ext         text;
  v_stored_size bigint;
  v_images      int;
  v_videos      int;
  v_total       bigint;
begin
  -- 1. Reject unauthenticated callers (defense in depth — grants already
  --    limit execution to `authenticated`).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Only the owning student may attach files. The role comes from
  --    public.profiles.role via get_app_role() — never from the client.
  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may add attachments';
  end if;

  -- 3. The complaint must exist and must not be soft-deleted.
  select c.id, c.student_id, c.status, c.deleted_at
    into v_complaint
    from public.complaints c
   where c.id = p_complaint_id;
  if not found or v_complaint.deleted_at is not null then
    raise exception 'Complaint not found';
  end if;

  -- 4. Ownership — derived from auth.uid(), never accepted from the client.
  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only attach files to your own complaint';
  end if;

  -- 5. Only while the complaint is still submitted. Once staff pick it up
  --    (or it is resolved/closed/escalated), attachments are frozen.
  if v_complaint.status is distinct from 'submitted' then
    raise exception 'Attachments can only be added while the complaint is submitted';
  end if;

  -- 6. Storage path: must have the exact shape complaints/<complaint_uuid>/
  --    <random-uuid>.<allowed-ext>, and the folder must be THIS complaint
  --    (the client can never write into another complaint's folder).
  if p_storage_path is null
     or p_storage_path !~ '^complaints/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|mp4|webm|mov)$'
  then
    raise exception 'Invalid storage path';
  end if;
  if split_part(p_storage_path, '/', 2) <> p_complaint_id::text then
    raise exception 'Storage path does not belong to this complaint';
  end if;
  v_ext := lower(split_part(p_storage_path, '.', -1));

  -- 7. Media-type whitelist + extension match (never trust the client's
  --    declared type alone; the extension and the whitelist must agree).
  if not (
       (p_media_type = 'image/jpeg'      and v_ext in ('jpg', 'jpeg'))
    or (p_media_type = 'image/png'       and v_ext = 'png')
    or (p_media_type = 'image/webp'      and v_ext = 'webp')
    or (p_media_type = 'video/mp4'       and v_ext = 'mp4')
    or (p_media_type = 'video/webm'      and v_ext = 'webm')
    or (p_media_type = 'video/quicktime' and v_ext = 'mov')
  ) then
    raise exception 'Unsupported media type for this file';
  end if;

  -- 8. Size limits per type (server-side — never only in React).
  if p_file_size is null or p_file_size <= 0 then
    raise exception 'File size must be positive';
  end if;
  if p_media_type like 'image/%' and p_file_size > 5242880 then
    raise exception 'Image is too large (maximum 5 MB)';
  end if;
  if p_media_type like 'video/%' and p_file_size > 52428800 then
    raise exception 'Video is too large (maximum 50 MB)';
  end if;

  -- 9. The uploaded object must actually exist in the bucket, must have been
  --    uploaded by the caller (owner = auth.uid()), and its server-recorded
  --    byte size (storage.objects.metadata, set by the storage service from
  --    the real bytes) must match the claimed file_size. This closes the
  --    "lie about the size in the RPC call" bypass: a client that uploaded a
  --    100 MB file cannot claim it is 1 byte.
  select (o.metadata ->> 'size')::bigint
    into v_stored_size
    from storage.objects o
   where o.bucket_id = 'complaint-attachments'
     and o.name = p_storage_path
     and o.owner = auth.uid();
  if not found then
    raise exception 'Storage object not found for this attachment';
  end if;
  if v_stored_size is null or v_stored_size is distinct from p_file_size then
    raise exception 'File size does not match the uploaded storage object';
  end if;

  -- 10. Per-complaint limits: max 5 images, max 1 video, 60 MB total
  --     (counted from existing metadata rows, so the frontend cannot
  --     bypass them by re-ordering or lying).
  -- The RETURNS TABLE output columns (media_type / file_size) shadow the
  -- table columns in this scope, so the source columns are table-qualified
  -- (the Day 6 lesson).
  select
    count(*) filter (where complaint_attachments.media_type in ('image/jpeg', 'image/png', 'image/webp')),
    count(*) filter (where complaint_attachments.media_type in ('video/mp4', 'video/webm', 'video/quicktime')),
    coalesce(sum(complaint_attachments.file_size), 0)
    into v_images, v_videos, v_total
    from public.complaint_attachments
   where complaint_attachments.complaint_id = p_complaint_id;

  if p_media_type like 'image/%' and v_images >= 5 then
    raise exception 'Maximum 5 images per complaint';
  end if;
  if p_media_type like 'video/%' and v_videos >= 1 then
    raise exception 'Maximum 1 video per complaint';
  end if;
  if v_total + p_file_size > 62914560 then
    raise exception 'Total attachment size limit (60 MB) exceeded';
  end if;

  -- 11. Sanitize the DISPLAY file name (strip path separators / control
  --     characters so it can never be a path or a weird render, cap length).
  --     The real on-disk name is always the random path above — never the
  --     original file name — so no identity can leak through storage paths.
  v_file_name := regexp_replace(coalesce(p_file_name, ''), '[/\\]', '', 'g');
  v_file_name := regexp_replace(v_file_name, '[[:cntrl:]]', '', 'g');
  v_file_name := btrim(v_file_name);
  if v_file_name = '' or char_length(v_file_name) > 255 then
    raise exception 'Invalid file name';
  end if;

  -- 12. Insert the metadata row. complaint_id is the caller's own (verified
  --     above); no identity column exists on this table.
  return query
    insert into public.complaint_attachments
      (complaint_id, storage_path, file_name, media_type, file_size)
    values
      (p_complaint_id, p_storage_path, v_file_name, p_media_type, p_file_size)
    returning complaint_attachments.id, complaint_attachments.complaint_id,
              complaint_attachments.storage_path, complaint_attachments.file_name,
              complaint_attachments.media_type, complaint_attachments.file_size,
              complaint_attachments.created_at;
end;
$$;

-- ============================================================================
-- 5. delete_complaint_attachment(attachment_id) — the ONLY way attachment
--    metadata is removed. Same authorization model as create: authenticated,
--    role = student, parent-complaint ownership via auth.uid(), complaint
--    not soft-deleted, status submitted, and the attachment must belong to
--    that complaint. Deletes ONLY the metadata row (never the complaint,
--    messages or history) and returns the storage_path so the client can
--    remove the file object afterwards.
-- ============================================================================
create or replace function public.delete_complaint_attachment(
  p_attachment_id uuid
)
returns table (
  id           uuid,
  complaint_id uuid,
  storage_path text,
  file_name    text,
  media_type   text,
  file_size    bigint,
  created_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role      text;
  v_attach    record;
  v_complaint record;
begin
  -- 1. Reject unauthenticated callers (defense in depth).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Only the owning student may remove attachments. Role from profiles.
  v_role := public.get_app_role();
  if v_role is distinct from 'student' then
    raise exception 'Forbidden: only the owning student may remove attachments';
  end if;

  -- 3. The attachment must exist.
  select a.id, a.complaint_id, a.storage_path, a.file_name, a.media_type,
         a.file_size, a.created_at
    into v_attach
    from public.complaint_attachments a
   where a.id = p_attachment_id;
  if not found then
    raise exception 'Attachment not found';
  end if;

  -- 4. The parent complaint must exist, must not be soft-deleted, must be
  --    owned by the caller, and must still be submitted.
  select c.student_id, c.status, c.deleted_at
    into v_complaint
    from public.complaints c
   where c.id = v_attach.complaint_id;
  if not found or v_complaint.deleted_at is not null then
    raise exception 'Complaint not found';
  end if;
  if v_complaint.student_id is distinct from auth.uid() then
    raise exception 'Forbidden: you can only remove attachments from your own complaint';
  end if;
  if v_complaint.status is distinct from 'submitted' then
    raise exception 'Attachments can only be removed while the complaint is submitted';
  end if;

  -- 5. Delete ONLY the metadata row; return the safe fields + storage_path
  --    so the client can remove the file object (best-effort cleanup).
  return query
    delete from public.complaint_attachments a
     where a.id = p_attachment_id
     returning a.id, a.complaint_id, a.storage_path, a.file_name, a.media_type,
               a.file_size, a.created_at;
end;
$$;

-- ============================================================================
-- 6. Grants — the two RPCs are executable by `authenticated` only; anon gets
--    nothing. The role checks inside decide who may actually use them. There
--    is still NO INSERT/UPDATE/DELETE grant on public.complaint_attachments
--    for any client role, so the RPCs are the only attachment write paths.
-- ============================================================================
revoke all on function public.create_complaint_attachment(uuid, text, text, text, bigint) from public;
grant execute on function public.create_complaint_attachment(uuid, text, text, text, bigint) to authenticated;

revoke all on function public.delete_complaint_attachment(uuid) from public;
grant execute on function public.delete_complaint_attachment(uuid) to authenticated;
