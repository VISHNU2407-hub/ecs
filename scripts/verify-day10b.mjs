/**
 * Day 10B local verification harness — Complaint Attachments (images + video).
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` AND
 * `storage` schemas (buckets / objects / foldername / extension), applies ALL
 * migrations (Day 3 .. Day 10B), and exercises the attachment security model
 * the frontend relies on (src/lib/complaintService.js + SubmitComplaintPage +
 * StudentComplaintDetailPage + StaffComplaintDetailPage). Runs 102 checks:
 *
 *
 * SCHEMA / BUCKET (1-4)
 *   1.  complaint_attachments table exists with the exact safe columns
 *   2.  RLS enabled on the table
 *   3.  'complaint-attachments' bucket is PRIVATE (public = false), with the
 *       file_size_limit and allowed_mime_types set
 *   4.  metadata contains no identity fields; storage paths are random
 *       UUIDs under complaints/<complaint_id>/ (no emails/names/ids)
 *
 * READ ACCESS (5-12)
 *   5.  owning student can read their own complaint's attachments (metadata)
 *   6.  student cannot read another student's attachments (0 rows)
 *   7.  faculty sees attachments of assigned-category complaints
 *   8.  faculty cannot see unassigned-category attachments
 *   9.  cross-department faculty cannot see ECS attachments
 *  10.  committee sees sensitive-only attachments; admin sees all
 *  11.  unauthorized users (faculty w/o dept, anon) get nothing / denied
 *  12.  storage.objects SELECT follows the same rule (signed-URL boundary)
 *
 * CREATE (13-27)
 *  13.  student can add an attachment to their OWN submitted complaint
 *  14.  student cannot add to another student's complaint
 *  15.  student cannot add after Under Review (and later statuses)
 *  16.  student cannot add to a soft-deleted complaint
 *  17.  non-student roles cannot add (faculty/committee/admin/anon)
 *  18.  max 5 images per complaint
 *  19.  max 1 video per complaint
 *  20.  invalid MIME rejected; extension/media-type mismatch rejected
 *  21.  oversized image rejected (RPC) and oversized video rejected (policy
 *       AND RPC)
 *  22.  total-size limit (60 MB) enforced
 *  23.  storage-path shape / wrong-folder / missing-object / size-mismatch /
 *       wrong-owner rejected (server-side verification of the real bytes)
 *  24.  file name sanitized (no path separators / control chars, capped)
 *  25.  RPC returns only safe fields (no identity)
 *  26.  direct INSERT / UPDATE / DELETE on complaint_attachments rejected
 *  27.  storage INSERT policy: own submitted folder ok; other's folder,
 *       non-submitted complaint, disallowed extension, >50 MB rejected
 *
 * DELETE (28-31)
 *  28.  student can delete their own attachment while Submitted
 *  29.  student cannot delete after the status leaves submitted
 *  30.  faculty/committee/admin/anon cannot delete attachments
 *  31.  storage DELETE policy follows the same student-only rule
 *
 * SOFT-DELETED COMPLAINT (32-35)
 *  32.  after Day 10A soft-delete, attachment metadata invisible to every role
 *  33.  storage objects of a deleted complaint invisible to every role
 *  34.  create/delete RPCs refuse attachments on the deleted complaint
 *  35.  metadata + objects are NOT physically removed (audit preserved)
 *
 * REGRESSIONS (36-48)
 *  36.  Day 10A edit still works; 37. Day 10A delete still works
 *  38.  Day 9B routing still works (faculty isolation + assignment RPC)
 *  39.  Day 7 chat still works; 40. Day 8A message controls still work
 *  41.  Day 8B conversation deletion still works
 *  42.  Day 9 confirm-resolution still works; 43. Day 9 reopen still works
 *  44.  Day 9 automatic escalation still works (and skips deleted)
 *  45.  anon blocked on every attachment/storage path
 *  46.  Realtime publication: complaints+messages present, complaint_
 *       attachments NOT added (no global Realtime)
 *  47.  Day 10B migration re-runnable (idempotent)
 *  48.  identity columns stay hidden everywhere
 *
 * Usage:  node scripts/verify-day10b.mjs
 * Exit code is non-zero if any check fails.
 */
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const MIGRATIONS = [
  path.join(root, 'supabase', 'migrations', '20260814000000_day3_database_security_foundation.sql'),
  path.join(root, 'supabase', 'migrations', '20260815000000_day6_status_flow.sql'),
  path.join(root, 'supabase', 'migrations', '20260816000000_day7_anonymous_chat.sql'),
  path.join(root, 'supabase', 'migrations', '20260817000000_day8_message_controls.sql'),
  path.join(root, 'supabase', 'migrations', '20260818000000_day8b_delete_conversation_for_me.sql'),
  path.join(root, 'supabase', 'migrations', '20260819000000_day9_resolution_escalation.sql'),
  path.join(root, 'supabase', 'migrations', '20260820000000_day9b_faculty_category_assignment.sql'),
  path.join(root, 'supabase', 'migrations', '20260821000000_day10a_complaint_edit_delete.sql'),
  path.join(root, 'supabase', 'migrations', '20260822000000_day10b_complaint_attachments.sql'),
]
const DB_DIR = path.join(root, '.tmp', 'day10b-pgdata')
const PORT = 55494

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  otherStudent: '22222222-2222-2222-2222-222222222222',
  facultyA: '33333333-3333-3333-3333-333333333333', // ECS + Labs
  facultyB: '44444444-4444-4444-4444-444444444444', // ECS + Academics
  facultyNoDept: '55555555-5555-5555-5555-555555555555', // faculty, no department
  facultyCse: '66666666-6666-6666-6666-666666666666', // CSE (fixture) + CSE Electives
  admin: '77777777-7777-7777-7777-777777777777',
  committee: '88888888-8888-8888-8888-888888888888',
}

// Complaints (all owned by U.student unless named otherwise).
const C = {
  ownLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', // CMP-1101 Labs submitted (attachments)
  otherLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02', // CMP-1102 Labs otherStudent (attachment)
  sensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03', // CMP-1103 Harassment submitted (attachment)
  underReview: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa04', // CMP-1104 Labs under_review
  resolved: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa05', // CMP-1105 Labs resolved
  resolved2: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa06', // CMP-1106 Labs resolved (reopen)
  deleted: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa07', // CMP-1107 Labs submitted (soft-deleted later)
  academics: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa08', // CMP-1108 Academics submitted (attachment)
  chat: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa09', // CMP-1109 Labs submitted (chat)
  flow: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0a', // CMP-1110 Labs submitted (status flow)
  count: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0b', // CMP-1111 Labs submitted (count limits)
  total: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0c', // CMP-1112 Labs submitted (total limit)
  edit: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0d', // CMP-1113 Labs submitted (Day 10A edit)
  del: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0e', // CMP-1114 Labs submitted (Day 10A delete)
  stale: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0f', // CMP-1115 Labs submitted stale (escalation)
}

const FORBIDDEN_IDENTITY = ['student_id', 'sender_id', 'user_id', 'email', 'name']
const IMG = ['image/jpeg', 'image/png', 'image/webp']
const VID = ['video/mp4', 'video/webm', 'video/quicktime']

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${extra ? `  [${extra}]` : ''}`)
  }
}

async function asUser(client, userId, fn) {
  await client.query('set role authenticated')
  await client.query('select set_config($1, $2, false)', ['app.uid', userId])
  try {
    return await fn()
  } finally {
    await client.query('reset role')
    await client.query("select set_config('app.uid', '', false)")
  }
}

async function expectFailure(client, label, run) {
  try {
    await run()
    check(`${label} — expected to fail, but query succeeded`, false)
    return null
  } catch (err) {
    const msg = String(err?.message ?? err)
    check(`${label} — rejected`, true, msg.split('\n')[0])
    return msg
  }
}

function randomUuid() {
  return 'b0000000-0000-4000-8000-000000000000'.replace('000000000000', Math.random().toString(16).slice(2, 14).padEnd(12, '0'))
}

// Simulates the storage service writing an uploaded file: the object row is
// created AS the acting user, so the storage INSERT policy is exercised for
// real. Returns the randomized storage path.
async function uploadObjectAs(client, userId, complaintId, ext, size, mime) {
  const name = `complaints/${complaintId}/${randomUuid()}.${ext}`
  await asUser(client, userId, () =>
    client.query(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
      [name, JSON.stringify({ size, mimetype: mime })],
    ),
  )
  return name
}

// Full happy-path: upload the object through the storage INSERT policy, then
// create the metadata row through the RPC. Returns the RPC row.
async function addAttachment(client, userId, complaintId, ext, size, mime, fileName) {
  const storagePath = await uploadObjectAs(client, userId, complaintId, ext, size, mime)
  let row = null
  await asUser(client, userId, async () => {
    const { rows } = await client.query(
      `select * from public.create_complaint_attachment($1, $2, $3, $4, $5)`,
      [complaintId, storagePath, fileName ?? `evidence-${Date.now()}.${ext}`, mime, size],
    )
    row = rows[0]
  })
  return { row, storagePath }
}

async function getAttachmentPaths(client, complaintId) {
  const { rows } = await client.query(
    `select storage_path from public.complaint_attachments where complaint_id = $1 order by created_at, id`,
    [complaintId],
  )
  return rows.map((r) => r.storage_path)
}

fs.rmSync(DB_DIR, { recursive: true, force: true })

const pgEmbed = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
  onLog: () => {},
  onError: () => {},
})

await pgEmbed.initialise()
await pgEmbed.start()

const client = new pg.Client({
  host: '127.0.0.1',
  port: PORT,
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
})
await client.connect()

try {
  // --------------------------------------------------------------------------
  // Stub the Supabase auth + storage schemas and the roles. storage.objects
  // mirrors the real schema closely enough for the policies and the RPCs'
  // server-side verification of the actual stored bytes.
  // --------------------------------------------------------------------------
  await client.query(`
    create role anon nologin;
    create role authenticated nologin;

    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create table auth.users (id uuid primary key, email text);
    create or replace function auth.uid()
      returns uuid language sql stable
      as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;

    create publication supabase_realtime;

    create schema storage;
    grant usage on schema storage to anon, authenticated;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table storage.buckets enable row level security;

    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null,
      name text not null,
      owner uuid,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_accessed_at timestamptz,
      version text,
      unique (bucket_id, name)
    );
    alter table storage.objects enable row level security;

    create or replace function storage.foldername(name text)
    returns text[] language sql immutable
    as $$
      select parts[1 : array_length(parts, 1) - 1]
      from (select regexp_split_to_array(name, '/') as parts) s
    $$;

    create or replace function storage.extension(name text)
    returns text language sql immutable
    as $$ select lower(split_part(name, '.', -1)) $$;

    -- Mirror real Supabase: storage grants table privileges to anon and
    -- authenticated, and RLS policies are the actual gate.
    grant all on table storage.buckets to anon, authenticated;
    grant all on table storage.objects to anon, authenticated;
    grant execute on function storage.foldername(text) to anon, authenticated;
    grant execute on function storage.extension(text) to anon, authenticated;
  `)

  // --------------------------------------------------------------------------
  // 1. Migrations.
  // --------------------------------------------------------------------------
  console.log('\n== 1. Migrations ==')
  try {
    for (const m of MIGRATIONS) await client.query(fs.readFileSync(m, 'utf8'))
    check('all migrations (Day 3 .. Day 10B) applied cleanly', true)
  } catch (err) {
    check('all migrations (Day 3 .. Day 10B) applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[8], 'utf8'))
    check('47. Day 10B migration is re-runnable', true)
  } catch (err) {
    check('47. Day 10B migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // 2. Seed users, roles, departments, categories, complaints.
  // --------------------------------------------------------------------------
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'student@example.com'), ($2, 'other@example.com'),
       ($3, 'faculty-a@example.com'), ($4, 'faculty-b@example.com'),
       ($5, 'faculty-nodept@example.com'), ($6, 'faculty-cse@example.com'),
       ($7, 'admin@example.com'), ($8, 'committee@example.com')`,
    [U.student, U.otherStudent, U.facultyA, U.facultyB, U.facultyNoDept, U.facultyCse, U.admin, U.committee],
  )
  await client.query(`update public.profiles set role = 'faculty' where id in ($1, $2, $3, $4)`, [U.facultyA, U.facultyB, U.facultyNoDept, U.facultyCse])
  await client.query(`update public.profiles set role = 'admin' where id = $1`, [U.admin])
  await client.query(`update public.profiles set role = 'committee' where id = $1`, [U.committee])

  // Fixture department + category (throwaway DB only) for cross-department tests.
  await client.query(`insert into public.departments (name) values ('CSE') on conflict (name) do nothing`)
  await client.query(
    `insert into public.complaint_categories (name, is_sensitive) values ('CSE Electives', false)
     on conflict (name) do nothing`,
  )
  await client.query(
    `insert into public.category_department_map (category_id, department_id)
     select cc.id, d.id
     from public.complaint_categories cc cross join public.departments d
     where cc.name = 'CSE Electives' and d.name = 'CSE'
     on conflict do nothing`,
  )

  const { rows: cats } = await client.query(`select id, name, is_sensitive from public.complaint_categories order by name`)
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  await client.query(
    `update public.profiles set department_id = (select id from public.departments where name = 'ECS') where id in ($1, $2)`,
    [U.facultyA, U.facultyB],
  )
  await client.query(
    `update public.profiles set department_id = (select id from public.departments where name = 'CSE') where id = $1`,
    [U.facultyCse],
  )

  await client.query(
    `insert into public.complaints
       (id, ticket_number, student_id, category_id, description, priority, status, updated_at)
     values
       ($1,  'CMP-1101', $2,  $3,  'Labs complaint with attachments.', 'medium', 'submitted', now()),
       ($4,  'CMP-1102', $5,  $6,  'Labs complaint owned by another student.', 'medium', 'submitted', now()),
       ($7,  'CMP-1103', $8,  $9,  'Sensitive harassment report with attachment.', 'urgent', 'submitted', now()),
       ($10, 'CMP-1104', $11, $12, 'Labs complaint under review.', 'medium', 'under_review', now()),
       ($13, 'CMP-1105', $14, $15, 'Resolved Labs complaint.', 'low', 'resolved', now()),
       ($16, 'CMP-1106', $17, $18, 'Resolved Labs complaint for reopen.', 'low', 'resolved', now()),
       ($19, 'CMP-1107', $20, $21, 'Labs complaint to be soft-deleted.', 'high', 'submitted', now()),
       ($22, 'CMP-1108', $23, $24, 'Academics complaint with attachment.', 'high', 'submitted', now()),
       ($25, 'CMP-1109', $26, $27, 'Labs complaint with a conversation.', 'medium', 'submitted', now()),
       ($28, 'CMP-1110', $29, $30, 'Labs complaint for status-flow regression.', 'medium', 'submitted', now()),
       ($31, 'CMP-1111', $32, $33, 'Labs complaint for attachment count limits.', 'medium', 'submitted', now()),
       ($34, 'CMP-1112', $35, $36, 'Labs complaint for total-size limit.', 'medium', 'submitted', now()),
       ($37, 'CMP-1113', $38, $39, 'Labs complaint for Day 10A edit regression.', 'medium', 'submitted', now()),
       ($40, 'CMP-1114', $41, $42, 'Labs complaint for Day 10A delete regression.', 'medium', 'submitted', now()),
       ($43, 'CMP-1115', $44, $45, 'Stale Labs complaint for escalation.', 'high', 'submitted', now() - interval '3 hours')`,
    [
      C.ownLabs, U.student, catId['Labs'],
      C.otherLabs, U.otherStudent, catId['Labs'],
      C.sensitive, U.student, catId['Harassment / Ragging'],
      C.underReview, U.student, catId['Labs'],
      C.resolved, U.student, catId['Labs'],
      C.resolved2, U.student, catId['Labs'],
      C.deleted, U.student, catId['Labs'],
      C.academics, U.student, catId['Academics'],
      C.chat, U.student, catId['Labs'],
      C.flow, U.student, catId['Labs'],
      C.count, U.student, catId['Labs'],
      C.total, U.student, catId['Labs'],
      C.edit, U.student, catId['Labs'],
      C.del, U.student, catId['Labs'],
      C.stale, U.student, catId['Labs'],
    ],
  )

  await asUser(client, U.admin, async () => {
    await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs']]])
    await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyB, [catId['Academics']]])
    await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyCse, [catId['CSE Electives']]])
  })

  // --------------------------------------------------------------------------
  // 3. Schema + bucket.
  // --------------------------------------------------------------------------
  console.log('\n== Schema & bucket ==')
  const { rows: cols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaint_attachments' order by ordinal_position`,
  )
  const colNames = cols.map((r) => r.column_name)
  check('1. complaint_attachments table exists with exact safe columns', ['id', 'complaint_id', 'storage_path', 'file_name', 'media_type', 'file_size', 'created_at'].every((c) => colNames.includes(c)) && colNames.length === 7, colNames.join(','))
  check('27b. attachment metadata contains no identity fields', !FORBIDDEN_IDENTITY.some((f) => colNames.includes(f)), colNames.join(','))
  const { rows: tbl } = await client.query(
    `select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'complaint_attachments'`,
  )
  check('2. RLS enabled on complaint_attachments', tbl[0]?.rowsecurity === true)
  const { rows: bucket } = await client.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'complaint-attachments'`)
  check(
    '3. complaint-attachments bucket is PRIVATE with size + MIME limits',
    bucket.length === 1 && bucket[0].public === false && String(bucket[0].file_size_limit) === '52428800' &&
      (bucket[0].allowed_mime_types ?? []).includes('image/jpeg') && (bucket[0].allowed_mime_types ?? []).includes('video/mp4'),
    JSON.stringify(bucket),
  )

  // --------------------------------------------------------------------------
  // 4. Attachments happy paths (also seeds the fixtures used by later checks).
  // --------------------------------------------------------------------------
  console.log('\n== Create (happy paths) ==')
  const ownLabs = await addAttachment(client, U.student, C.ownLabs, 'jpg', 51200, 'image/jpeg', 'evidence-1.jpg')
  const ownLabs2 = await addAttachment(client, U.student, C.ownLabs, 'png', 30720, 'image/png', 'evidence-2.png')
  const ownLabsVid = await addAttachment(client, U.student, C.ownLabs, 'mp4', 204800, 'video/mp4', 'evidence-video.mp4')
  check('13a. student adds own-complaint attachments (2 images + 1 video)', !!ownLabs.row && !!ownLabs2.row && !!ownLabsVid.row && ownLabs.row.media_type === 'image/jpeg' && ownLabsVid.row.media_type === 'video/mp4', JSON.stringify({ a: ownLabs.row, v: ownLabsVid.row }))
  check('25. create RPC returns ONLY safe fields (no identity)', !FORBIDDEN_IDENTITY.some((f) => f in (ownLabs.row ?? {})), Object.keys(ownLabs.row ?? {}).join(','))

  const otherLabs = await addAttachment(client, U.otherStudent, C.otherLabs, 'jpg', 40960, 'image/jpeg', 'other-evidence.jpg')
  check('13b. other student adds their own complaint attachment', !!otherLabs.row && otherLabs.row.complaint_id === C.otherLabs)

  const sensitive = await addAttachment(client, U.student, C.sensitive, 'webp', 20480, 'image/webp', 'sensitive-evidence.webp')
  const academics = await addAttachment(client, U.student, C.academics, 'jpg', 61440, 'image/jpeg', 'academics-evidence.jpg')
  check('13c. sensitive + academics attachments created', !!sensitive.row && !!academics.row)

  const deletedAtt = await addAttachment(client, U.student, C.deleted, 'jpg', 25600, 'image/jpeg', 'to-be-deleted.jpg')
  check('13d. attachment created on the complaint that will be soft-deleted', !!deletedAtt.row)

  // Storage-path anonymity.
  const allPaths = await getAttachmentPaths(client, C.ownLabs)
  const shapeOk = (p) => /^complaints\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|mp4|webm|mov)$/.test(p)
  check('4. storage paths are randomized and identity-free', [ownLabs.storagePath, ownLabs2.storagePath, ownLabsVid.storagePath, otherLabs.storagePath, sensitive.storagePath, academics.storagePath, deletedAtt.storagePath].every(shapeOk) && allPaths.length === 3 && !allPaths.some((p) => /student|email|example|profile/i.test(p)), allPaths.join(','))

  // --------------------------------------------------------------------------
  // 5. Read access (RLS on metadata).
  // --------------------------------------------------------------------------
  console.log('\n== Read access ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select id, file_name from public.complaint_attachments where complaint_id = $1 order by created_at`, [C.ownLabs])
    check('5. owning student reads own attachments (3 rows, names safe)', rows.length === 3 && rows.every((r) => !FORBIDDEN_IDENTITY.some((f) => f in r)), JSON.stringify(rows))
    const { rows: other } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.otherLabs])
    check('6. student cannot read another student\'s attachments (0 rows)', other.length === 0, JSON.stringify(other))
  })
  await asUser(client, U.facultyA, async () => {
    const { rows: mine } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.ownLabs])
    check('7. faculty sees assigned-category (Labs) attachments', mine.length === 3, JSON.stringify(mine))
    const { rows: unassigned } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.academics])
    check('8. faculty cannot see unassigned-category (Academics) attachments', unassigned.length === 0, JSON.stringify(unassigned))
    const { rows: sens } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.sensitive])
    check('8b. faculty cannot see sensitive-complaint attachments', sens.length === 0)
  })
  await asUser(client, U.facultyB, async () => {
    const { rows } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.academics])
    check('7b. Academics faculty sees the Academics attachment', rows.length === 1, JSON.stringify(rows))
  })
  await asUser(client, U.facultyCse, async () => {
    const { rows } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.ownLabs])
    check('9. cross-department faculty cannot see ECS attachments', rows.length === 0)
  })
  await asUser(client, U.facultyNoDept, async () => {
    const { rows } = await client.query(`select id from public.complaint_attachments limit 5`)
    check('11a. faculty without a department sees no attachments at all', rows.length === 0)
  })
  await asUser(client, U.committee, async () => {
    const { rows: sens } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.sensitive])
    check('10a. committee sees sensitive-complaint attachments', sens.length === 1, JSON.stringify(sens))
    const { rows: notSens } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.ownLabs])
    check('10b. committee cannot see non-sensitive attachments', notSens.length === 0)
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select id from public.complaint_attachments`)
    check('10c. admin sees all live attachments', rows.length === 7, JSON.stringify(rows.length))
  })

  // --------------------------------------------------------------------------
  // 6. Storage objects SELECT (the signed-URL boundary).
  // --------------------------------------------------------------------------
  console.log('\n== Storage objects SELECT ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.ownLabs}/%`])
    check('12a. owning student reads own complaint\'s objects', rows.length === 3, JSON.stringify(rows.map((r) => r.name)))
    const { rows: other } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.otherLabs}/%`])
    check('12b. student cannot read another student\'s objects', other.length === 0)
  })
  await asUser(client, U.facultyA, async () => {
    const { rows: mine } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.ownLabs}/%`])
    check('12c. assigned faculty can read the complaint\'s objects', mine.length === 3)
    const { rows: unassigned } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.academics}/%`])
    check('12d. unassigned faculty cannot read the complaint\'s objects', unassigned.length === 0)
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.sensitive}/%`])
    check('12e. committee can read sensitive complaint objects', rows.length === 1)
    const { rows: notSens } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.ownLabs}/%`])
    check('12f. committee cannot read non-sensitive complaint objects', notSens.length === 0)
  })

  // --------------------------------------------------------------------------
  // 7. Create — authorization + limits.
  // --------------------------------------------------------------------------
  console.log('\n== Create (authorization & limits) ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, '14. cannot add attachment to another student\'s complaint', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.otherLabs, `complaints/${C.otherLabs}/b1111111-1111-4111-8111-111111111111.jpg`]),
    )
    await expectFailure(client, '15. cannot add after Under Review', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.underReview, `complaints/${C.underReview}/b1111111-1111-4111-8111-111111111111.jpg`]),
    )
    await expectFailure(client, '15b. cannot add to a resolved complaint', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.resolved, `complaints/${C.resolved}/b1111111-1111-4111-8111-111111111111.jpg`]),
    )
  })
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '17a. faculty cannot add attachments', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.ownLabs, `complaints/${C.ownLabs}/b1111111-1111-4111-8111-111111111111.jpg`]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, '17b. committee cannot add attachments', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.sensitive, `complaints/${C.sensitive}/b1111111-1111-4111-8111-111111111111.jpg`]),
    )
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '17c. admin cannot add attachments (student-only RPC)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.ownLabs, `complaints/${C.ownLabs}/b1111111-1111-4111-8111-111111111111.jpg`]),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '17d. anonymous cannot add attachments', () =>
    client.query(`select * from public.create_complaint_attachment('${C.ownLabs}', 'complaints/${C.ownLabs}/b1111111-1111-4111-8111-111111111111.jpg', 'x.jpg', 'image/jpeg', 100)`),
  )
  await client.query('reset role')

  // Count limits: max 5 images + max 1 video on C.count.
  const countImgs = []
  for (let i = 0; i < 5; i++) {
    countImgs.push(await addAttachment(client, U.student, C.count, 'jpg', 102400, 'image/jpeg', `count-${i}.jpg`))
  }
  check('18a. five images accepted on one complaint', countImgs.every((a) => !!a.row))
  await asUser(client, U.student, async () => {
    await expectFailure(client, '18b. sixth image rejected (max 5)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'sixth.jpg', 'image/jpeg', 1000)`, [C.count, `complaints/${C.count}/b2222222-2222-4222-8222-222222222222.jpg`]),
    )
  })
  const countVid = await addAttachment(client, U.student, C.count, 'mp4', 1048576, 'video/mp4', 'count-video.mp4')
  check('19a. one video accepted', !!countVid.row)
  await asUser(client, U.student, async () => {
    await expectFailure(client, '19b. second video rejected (max 1)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'second.mp4', 'video/mp4', 1000)`, [C.count, `complaints/${C.count}/b3333333-3333-4333-8333-333333333333.mp4`]),
    )
  })

  // Type / size validation.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '20a. invalid MIME rejected (application/pdf)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'doc.pdf', 'application/pdf', 100)`, [C.ownLabs, `complaints/${C.ownLabs}/b4444444-4444-4444-8444-444444444444.pdf`]),
    )
    await expectFailure(client, '20b. extension/media-type mismatch rejected (mp4 declared, .jpg path)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'video/mp4', 1000)`, [C.ownLabs, `complaints/${C.ownLabs}/b5555555-5555-4555-8555-555555555555.jpg`]),
    )
  })
  // Oversized image: object passes the storage policy (<=50 MB) but the RPC
  // must reject it (image cap is 5 MB).
  const bigImgPath = await uploadObjectAs(client, U.student, C.ownLabs, 'jpg', 6291456, 'image/jpeg')
  await asUser(client, U.student, async () => {
    await expectFailure(client, '21a. oversized image rejected by RPC (6 MB > 5 MB)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'big.jpg', 'image/jpeg', 6291456)`, [C.ownLabs, bigImgPath]),
    )
  })
  // Storage INSERT policy must reject a >50 MB object outright.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '21b. storage INSERT policy rejects >50 MB object', () =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
        [`complaints/${C.ownLabs}/b6666666-6666-4666-8666-666666666666.mp4`, JSON.stringify({ size: 53554432, mimetype: 'video/mp4' })],
      ),
    )
  })
  // Oversized video: object pre-inserted (bypassing the policy, as a rogue
  // upload might), but the RPC must still reject it using the real bytes.
  await client.query(
    `insert into storage.objects (bucket_id, name, owner, metadata)
     values ('complaint-attachments', $1, $2, $3::jsonb)`,
    [`complaints/${C.ownLabs}/b7777777-7777-4777-8777-777777777777.mp4`, U.student, JSON.stringify({ size: 53554432, mimetype: 'video/mp4' })],
  )
  await asUser(client, U.student, async () => {
    await expectFailure(client, '21c. oversized video rejected by RPC (51 MB > 50 MB)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'big.mp4', 'video/mp4', 53554432)`, [C.ownLabs, `complaints/${C.ownLabs}/b7777777-7777-4777-8777-777777777777.mp4`]),
    )
  })

  // Total-size limit on C.total: 5 images of exactly 5 MB + a 40 MB video
  // would exceed 60 MB total.
  for (let i = 0; i < 5; i++) {
    await addAttachment(client, U.student, C.total, 'jpg', 5242880, 'image/jpeg', `tot-${i}.jpg`)
  }
  await asUser(client, U.student, async () => {
    await expectFailure(client, '22. total-size limit enforced (25 MB images + 40 MB video > 60 MB)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'video.mp4', 'video/mp4', 41943040)`, [C.total, `complaints/${C.total}/b8888888-8888-4888-8888-888888888888.mp4`]),
    )
  })

  // Server-side verification of the real storage bytes.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '23a. storage path must belong to the complaint (wrong folder)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.ownLabs, `complaints/${C.otherLabs}/b9999999-9999-4999-8999-999999999999.jpg`]),
    )
    await expectFailure(client, '23b. path without an uploaded object rejected', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.ownLabs, `complaints/${C.ownLabs}/caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`]),
    )
    await expectFailure(client, '23c. claimed size != stored size rejected', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 200)`, [C.ownLabs, bigImgPath]),
    )
  })
  // Wrong owner: object exists but was uploaded by someone else.
  await client.query(
    `insert into storage.objects (bucket_id, name, owner, metadata)
     values ('complaint-attachments', $1, $2, $3::jsonb)`,
    [`complaints/${C.ownLabs}/cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`, U.otherStudent, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
  )
  await asUser(client, U.student, async () => {
    await expectFailure(client, '23d. object uploaded by someone else rejected (owner check)', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 1000)`, [C.ownLabs, `complaints/${C.ownLabs}/cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`]),
    )
  })
  // File-name sanitization.
  const sanitized = await addAttachment(client, U.student, C.ownLabs, 'jpg', 5120, 'image/jpeg', 'a/b\\c..d.jpg')
  check('24. file name sanitized (path separators removed)', sanitized.row?.file_name === 'abc..d.jpg', sanitized.row?.file_name)

  // Direct SQL bypass attempts.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '26a. direct INSERT into complaint_attachments rejected (no grant)', () =>
      client.query(
        `insert into public.complaint_attachments (complaint_id, storage_path, file_name, media_type, file_size)
         values ($1, 'complaints/${C.ownLabs}/c0000000-0000-4000-8000-000000000000.jpg', 'hack.jpg', 'image/jpeg', 1)`,
        [C.ownLabs],
      ),
    )
    await expectFailure(client, '26b. direct UPDATE rejected (no grant)', () =>
      client.query(`update public.complaint_attachments set file_name = 'hacked.jpg' where complaint_id = $1`, [C.ownLabs]),
    )
    await expectFailure(client, '26c. direct DELETE rejected (no grant)', () =>
      client.query(`delete from public.complaint_attachments where complaint_id = $1`, [C.ownLabs]),
    )
  })

  // --------------------------------------------------------------------------
  // 8. Storage INSERT / DELETE policies.
  // --------------------------------------------------------------------------
  console.log('\n== Storage INSERT / DELETE policies ==')
  await asUser(client, U.student, async () => {
    // Own submitted folder + allowed extension + sane size -> allowed.
    const okPath = `complaints/${C.ownLabs}/c1111111-1111-4111-8111-111111111111.webp`
    await client.query(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
      [okPath, JSON.stringify({ size: 1000, mimetype: 'image/webp' })],
    )
    check('27a. storage INSERT allows own submitted complaint folder', true, okPath)
    await expectFailure(client, '27b. storage INSERT rejects another student\'s folder', () =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
        [`complaints/${C.otherLabs}/c2222222-2222-4222-8222-222222222222.jpg`, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
      ),
    )
    await expectFailure(client, '27c. storage INSERT rejects non-submitted complaint folder', () =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
        [`complaints/${C.underReview}/c3333333-3333-4333-8333-333333333333.jpg`, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
      ),
    )
    await expectFailure(client, '27d. storage INSERT rejects disallowed extension (.gif)', () =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
        [`complaints/${C.ownLabs}/c4444444-4444-4444-8444-444444444444.gif`, JSON.stringify({ size: 1000, mimetype: 'image/gif' })],
      ),
    )
    await expectFailure(client, '27e. storage INSERT rejects non-bucket paths', () =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
        [`other/${C.ownLabs}/c5555555-5555-4555-8555-555555555555.jpg`, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
      ),
    )
  })
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '27f. storage INSERT rejects faculty (student-only)', () =>
      client.query(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
        [`complaints/${C.ownLabs}/c6565656-5656-4656-8656-565656565656.jpg`, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
      ),
    )
  })
  await asUser(client, U.student, async () => {
    // DELETE policy: own submitted folder -> allowed. RLS DELETE never
    // raises errors for unauthorized rows — it silently filters them to 0
    // rows — so the assertions below check the deleted-row counts.
    const delOkPath = `complaints/${C.ownLabs}/c6666666-6666-4666-8666-666666666666.jpg`
    await client.query(
      `insert into storage.objects (bucket_id, name, owner, metadata)
       values ('complaint-attachments', $1, auth.uid(), $2::jsonb)`,
      [delOkPath, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
    )
    const delOk = await client.query(`delete from storage.objects where bucket_id = 'complaint-attachments' and name = $1`, [delOkPath])
    check('31a. storage DELETE allows own submitted complaint folder', delOk.rowCount === 1, `rowCount=${delOk.rowCount}`)
    const delOther = await client.query(`delete from storage.objects where bucket_id = 'complaint-attachments' and name = $1`, [otherLabs.storagePath])
    check('31b. storage DELETE removes nothing from another student\'s folder', delOther.rowCount === 0, `rowCount=${delOther.rowCount}`)
    const delUnder = await client.query(`delete from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.underReview}/%`])
    check('31c. storage DELETE removes nothing from a non-submitted folder', delUnder.rowCount === 0, `rowCount=${delUnder.rowCount}`)
  })
  await asUser(client, U.facultyA, async () => {
    const delFac = await client.query(`delete from storage.objects where bucket_id = 'complaint-attachments' and name = $1`, [ownLabs.storagePath])
    check('30b. faculty storage DELETE removes nothing (student-only policy)', delFac.rowCount === 0, `rowCount=${delFac.rowCount}`)
  })

  // --------------------------------------------------------------------------
  // 9. Delete — RPC.
  // --------------------------------------------------------------------------
  console.log('\n== Delete (RPC) ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint_attachment($1)`, [ownLabs2.row.id])
    check('28. student deletes own attachment while Submitted', rows.length === 1 && rows[0].storage_path === ownLabs2.storagePath && rows[0].media_type === 'image/png', JSON.stringify(rows[0]))
  })
  const { rows: afterDelCount } = await client.query(`select count(*)::int as n from public.complaint_attachments where complaint_id = $1`, [C.ownLabs])
  check('28b. metadata row removed after delete', afterDelCount[0].n === 3, JSON.stringify(afterDelCount))

  // Delete gating on a non-submitted complaint: attach to C.underReview
  // directly (superuser), then try to delete it as the student.
  await client.query(
    `insert into storage.objects (bucket_id, name, owner, metadata)
     values ('complaint-attachments', $1, $2, $3::jsonb)`,
    [`complaints/${C.underReview}/c7777777-7777-4777-8777-777777777777.jpg`, U.student, JSON.stringify({ size: 1000, mimetype: 'image/jpeg' })],
  )
  await client.query(
    `insert into public.complaint_attachments (complaint_id, storage_path, file_name, media_type, file_size)
     values ($1, 'complaints/${C.underReview}/c7777777-7777-4777-8777-777777777777.jpg', 'under-review.jpg', 'image/jpeg', 1000)`,
    [C.underReview],
  )
  await asUser(client, U.student, async () => {
    await expectFailure(client, '29. cannot delete attachment after status leaves submitted', () =>
      client.query(`select * from public.delete_complaint_attachment((select id from public.complaint_attachments where complaint_id = $1 limit 1))`, [C.underReview]),
    )
    await expectFailure(client, '29b. cannot delete another student\'s attachment', () =>
      client.query(`select * from public.delete_complaint_attachment($1)`, [otherLabs.row.id]),
    )
  })
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '30a. faculty cannot delete attachments (RPC)', () =>
      client.query(`select * from public.delete_complaint_attachment($1)`, [ownLabs.row.id]),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '30c. anonymous cannot delete attachments (RPC)', () =>
    client.query(`select * from public.delete_complaint_attachment('${ownLabs.row.id}')`),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 10. Soft-deleted complaint -> attachments unreachable everywhere.
  // --------------------------------------------------------------------------
  console.log('\n== Soft-deleted complaint ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint($1)`, [C.deleted])
    check('37a. Day 10A delete still works (soft delete)', rows[0]?.ticket_number === 'CMP-1107' && !!rows[0]?.deleted_at, JSON.stringify(rows[0]))
  })
  const delComplaintMeta = await client.query(`select count(*)::int as n from public.complaint_attachments where complaint_id = $1`, [C.deleted])
  check('35. metadata NOT physically removed (audit preserved)', delComplaintMeta.rows[0].n === 1)
  const delComplaintObj = await client.query(`select count(*)::int as n from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.deleted}/%`])
  check('35b. storage objects NOT physically removed (audit preserved)', delComplaintObj.rows[0].n === 1)
  for (const u of [U.student, U.facultyA, U.admin, U.committee]) {
    await asUser(client, u, async () => {
      const { rows: meta } = await client.query(`select id from public.complaint_attachments where complaint_id = $1`, [C.deleted])
      const { rows: objs } = await client.query(`select name from storage.objects where bucket_id = 'complaint-attachments' and name like $1`, [`complaints/${C.deleted}/%`])
      check(`32. ${u === U.student ? 'owning student' : u === U.facultyA ? 'faculty' : u === U.admin ? 'admin' : 'committee'} sees no metadata for a deleted complaint`, meta.length === 0, JSON.stringify(meta))
      check(`33. ${u === U.student ? 'owning student' : u === U.facultyA ? 'faculty' : u === U.admin ? 'admin' : 'committee'} sees no storage objects for a deleted complaint`, objs.length === 0, JSON.stringify(objs))
    })
  }
  await asUser(client, U.student, async () => {
    await expectFailure(client, '34a. cannot add attachment to a deleted complaint', () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.deleted, `complaints/${C.deleted}/c8888888-8888-4888-8888-888888888888.jpg`]),
    )
    await expectFailure(client, '34b. cannot delete attachment of a deleted complaint', () =>
      client.query(`select * from public.delete_complaint_attachment($1)`, [deletedAtt.row.id]),
    )
  })

  // --------------------------------------------------------------------------
  // 11. Regressions.
  // --------------------------------------------------------------------------
  console.log('\n== Regressions ==')

  // Day 10A edit.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint($1, 'Edited title', 'A valid description long enough for the edit regression.', $2, 'high')`,
      [C.edit, catId['Labs']],
    )
    check('36. Day 10A: edit still works (title/priority updated)', rows[0]?.title === 'Edited title' && rows[0]?.priority === 'high' && rows[0]?.status === 'submitted', JSON.stringify(rows[0]))
  })
  // Day 10A delete.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint($1)`, [C.del])
    check('37. Day 10A: delete still works (soft delete)', rows[0]?.ticket_number === 'CMP-1114' && !!rows[0]?.deleted_at, JSON.stringify(rows[0]))
  })

  // Day 9B routing.
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view order by ticket_number`)
    check('38. Day 9B: Labs faculty still sees only assigned-category complaints', rows.length === 11 && !rows.some((r) => r.ticket_number === 'CMP-1108') && !rows.some((r) => r.ticket_number === 'CMP-1107') && !rows.some((r) => r.ticket_number === 'CMP-1114'), JSON.stringify(rows.map((r) => r.ticket_number)))
  })
  await asUser(client, U.facultyB, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('38b. Day 9B: Academics faculty sees only Academics', rows.length === 1 && rows[0].ticket_number === 'CMP-1108', JSON.stringify(rows.map((r) => r.ticket_number)))
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyB, [catId['Academics'], catId['Labs']]])
    check('38c. Day 9B: assignment RPC still works', rows.length === 2 && rows.every((r) => r.faculty_id === U.facultyB), JSON.stringify(rows.map((r) => r.category)))
  })

  // Day 7 chat.
  await asUser(client, U.facultyA, async () => {
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'We are looking into it.')`, [C.chat])
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'Thanks for checking!') returning sender_role, body`,
      [C.chat],
    )
    check('39. Day 7: chat send still works (sender derived server-side)', rows[0]?.sender_role === 'student', JSON.stringify(rows))
  })

  // Day 8A message controls.
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint_message((select id from public.messages where complaint_id = $1 and sender_role = 'staff' limit 1), 'We are looking into it — ETA tomorrow.')`,
      [C.chat],
    )
    check('40. Day 8A: message edit still works', rows[0]?.body === 'We are looking into it — ETA tomorrow.' && !!rows[0]?.edited_at, JSON.stringify(rows))
  })

  // Day 8B conversation deletion.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.chat])
    check('41. Day 8B: delete conversation for me still works', !!rows[0]?.deleted_before, JSON.stringify(rows))
  })

  // Day 9 resolution confirmation + reopen.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.confirm_complaint_resolution($1)`, [C.resolved])
    check('42. Day 9: resolution confirmation still works (resolved -> closed)', rows[0]?.status === 'closed', JSON.stringify(rows))
    const { rows: reopened } = await client.query(`select * from public.reopen_complaint($1)`, [C.resolved2])
    check('43. Day 9: reopen still works (resolved -> reopened)', reopened[0]?.status === 'reopened', JSON.stringify(reopened))
  })

  // Day 9 escalation (skips soft-deleted complaints).
  await client.query(`update public.system_settings set value = '1 hour' where key = 'escalation_threshold'`)
  await client.query(`update public.complaints set updated_at = now() - interval '3 hours' where id = $1`, [C.deleted])
  const { rows: escalated } = await client.query(`select * from public.escalate_stale_complaints()`)
  check('44. Day 9: stale live complaint still escalated', escalated.some((r) => r.ticket_number === 'CMP-1115') && (await client.query(`select status from public.complaints where id = $1`, [C.stale])).rows[0].status === 'escalated', JSON.stringify(escalated.map((r) => r.ticket_number)))
  check('44b. Day 9: escalation skips soft-deleted complaints', !escalated.some((r) => r.ticket_number === 'CMP-1107'), JSON.stringify(escalated.map((r) => r.ticket_number)))

  // --------------------------------------------------------------------------
  // 12. Anon + Realtime + identity.
  // --------------------------------------------------------------------------
  console.log('\n== Anon / Realtime / identity ==')
  await client.query('set role anon')
  await expectFailure(client, '45a. anon cannot read attachment metadata (no grant)', () =>
    client.query(`select * from public.complaint_attachments limit 1`),
  )
  {
    const { rows: anonObjs } = await client.query(`select * from storage.objects limit 5`)
    check('45b. anon sees no storage objects (RLS: no anon policy)', anonObjs.length === 0, JSON.stringify(anonObjs.length))
  }
  await client.query('reset role')

  const { rows: pubTables } = await client.query(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`,
  )
  const pubNames = pubTables.map((r) => r.tablename)
  check('46. complaints + messages still in realtime publication', pubNames.includes('complaints') && pubNames.includes('messages'), pubNames.join(','))
  check('46b. complaint_attachments NOT added to realtime (no global Realtime)', !pubNames.includes('complaint_attachments'), pubNames.join(','))

  const { rows: staffViewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaints_staff_view' order by ordinal_position`,
  )
  const staffColNames = staffViewCols.map((r) => r.column_name)
  check('48. student_id / sender_id / email / name still hidden everywhere', !staffColNames.some((c) => FORBIDDEN_IDENTITY.includes(c)), staffColNames.join(','))
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '48b. sender_id column still not selectable', () =>
      client.query(`select sender_id from public.messages limit 1`),
    )
    await expectFailure(client, '48c. student_id column still not selectable', () =>
      client.query(`select student_id from public.complaints limit 1`),
    )
  })
} finally {
  await client.end().catch(() => {})
  try {
    await pgEmbed.stop()
  } catch (err) {
    // Windows sometimes keeps the data dir locked briefly after stop;
    // the next run clears it at startup.
    console.log('  (cleanup note:', err?.code ?? err, ')')
  }
}

console.log(`\n========================================`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log(`========================================`)
process.exit(failed === 0 ? 0 : 1)
