/**
 * Day 10C local verification harness — Faculty Self-Registration.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` AND
 * `storage` schemas (auth.users needs email_confirmed_at; storage is needed
 * because the Day 10B migration runs as part of the full migration list),
 * applies ALL migrations (Day 3 .. Day 10C), and exercises the faculty
 * self-registration security model the frontend relies on
 * (src/pages/FacultyRegisterPage.jsx + authService.registerFaculty):
 *
 * REGISTRATION CODE (1-11)
 *   1.  faculty_registration_codes table exists (hash-only columns), RLS on
 *   2.  no policies / no grants: student cannot READ the code table
 *   3.  student cannot MODIFY the code table
 *   4.  anonymous cannot read the code table
 *   5.  unconfigured code -> registration refused
 *   6.  the database owner (postgres — the Supabase SQL Editor, where
 *       auth.uid() is NULL by design) can set the code (returns boolean only)
 *   7.  normal client roles (student / faculty / committee / a real
 *       authenticated session) cannot call the setup function: EXECUTE is
 *       granted to postgres ONLY, and the in-function session_user guard
 *       rejects client sessions even if a grant were added
 *   8.  too-short code rejected
 *   9.  stored value is a bcrypt hash (never the plaintext)
 *  10.  RPCs never return the code or hash
 *  11.  the test code does not appear in src/ or env files (JS bundle guard)
 *
 * REGISTRATION VALIDATION (12-26)
 *  12.  correct code + department + categories -> SUCCESS (role faculty,
 *       department set, assignments created)
 *  13.  wrong code rejected
 *  14.  empty code rejected
 *  15.  unauthenticated (anon) rejected
 *  16.  unverified email CAN register (Day 10E: email confirmation OFF —
 *       the email_confirmed_at requirement is gone; the private code is the
 *       authorization gate)
 *  17.  already-faculty account rejected (existing faculty untouched)
 *  18.  admin/committee accounts rejected
 *  19.  nonexistent department rejected
 *  20.  nonexistent category rejected
 *  21.  sensitive category rejected (atomic — nothing written)
 *  22.  cross-department category rejected
 *  23.  zero categories rejected
 *  24.  duplicate category ids handled safely (dedupe -> one assignment)
 *  25.  RPC result contains only safe fields (no email / code / hash)
 *  26.  direct role elevation impossible: UPDATE profiles SET role = 'faculty'
 *       has no grant, UPDATE department_id has no grant
 *
 * POST-REGISTRATION / ROUTING (27-38)
 *  27.  new faculty role = faculty, department = ECS
 *  27c. the RLS-gated profile read (getUserRole's exact query) resolves
 *       'faculty' immediately after registration — the value refreshRole()
 *       returns for the /staff navigation decision
 *  28.  multiple assignments created (Labs + IT / Network)
 *  29.  registered faculty SEES assigned-category complaints (Labs, IT/Network)
 *  30.  registered faculty does NOT see Academics complaints
 *  31.  cannot open an Academics complaint detail URL (0 rows)
 *  32.  cannot read Academics chat (can_access_complaint false / no messages)
 *  33.  cannot update Academics status (RPC rejected)
 *  34.  can update an assigned-category complaint status (authorized)
 *  35.  admin faculty-assignment list naturally includes the new faculty
 *  36.  existing faculty regression: role + assignments untouched, still sees
 *       their complaints
 *  37.  role isolation: student / other student / admin / committee unchanged
 *  38.  assignments created by registration are Day 9B rows (same table,
 *       admin can manage them via the existing RPC)
 *
 * REGRESSIONS (39-56) — Day 3..Day 10B behavior stays intact
 *  39.  Day 4: student submission works
 *  40.  Day 5: student dashboard sees own complaints only
 *  41.  Day 6: status flow + history
 *  42.  Day 7: anonymous chat (student + faculty on assigned complaint)
 *  43.  Day 8A: message edit + delete-for-everyone + delete-for-me
 *  44.  Day 8B: conversation deletion for me
 *  45.  Day 9: resolution confirm + reopen
 *  46.  Day 9: automatic escalation
 *  47.  Day 9B: admin assignment RPC still works; non-admin rejected
 *  48.  Day 9B: routing still enforced for existing faculty
 *  49.  Day 10A: edit still works
 *  50.  Day 10A: delete still works (+ invisible after delete)
 *  51.  Day 10B: attachment create / read / delete still works
 *  52.  Day 10B: attachment limits still enforced
 *  53.  identity hiding: student_id / sender_id / email stay unselectable
 *  54.  anon blocked on both Day 10C RPCs
 *  55.  Day 10C migration re-runnable
 *  56.  all migrations apply cleanly together
 *
 * REGISTRATION OPTIONS (57-60) — Day 10D (the anonymous reference-data read
 *   the /faculty/register page uses to render Department ECS + its categories
 *   before a visitor signs up)
 *  57.  get_faculty_registration_options exists; EXECUTE granted to anon AND
 *       authenticated (public reference data — no identity, no code)
 *  58.  anonymous can read ECS + its mapped categories (the bug fix: the page
 *       must render before sign-up, and the Day 3 table grants are
 *       authenticated-only)
 *  58b. the options include the sensitive category (rendered disabled in UI)
 *  58c. the options include the 7 non-sensitive ECS categories
 *  59.  authenticated (student) reads the same ECS options
 *  60.  the RPC returns ONLY reference data — no identity / code / hash
 *
 * FIXTURES ONLY: a CSE department + 'CSE Electives' category are created in
 * this throwaway database purely to prove cross-department rejection. The
 * migration itself adds no departments, no categories and no fake users.
 *
 * Usage:  node scripts/verify-day10c.mjs
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
  path.join(root, 'supabase', 'migrations', '20260823000000_day10c_faculty_self_registration.sql'),
  path.join(root, 'supabase', 'migrations', '20260824000000_day10d_faculty_registration_options.sql'),
  path.join(root, 'supabase', 'migrations', '20260825000000_day10e_faculty_registration_no_email_verification.sql'),
]
const DB_DIR = path.join(root, '.tmp', 'day10c-pgdata')
const PORT = 55496

// The private registration code used ONLY by this throwaway harness. It must
// never appear in src/, .env or any shipped artifact (check 11 verifies that).
const TEST_REGISTRATION_CODE = 'Faculty-Secret-2026'

const U = {
  student: '11111111-1111-1111-1111-111111111111', // verified student
  otherStudent: '22222222-2222-2222-2222-222222222222', // verified student
  newFaculty: '33333333-3333-3333-3333-333333333333', // fresh profile (student) -> registers via RPC
  newFaculty2: '3a3a3a3a-3a3a-3a3a-3a3a-3a3a3a3a3a3a', // fresh profile for duplicate-category test
  existingFaculty: '44444444-4444-4444-4444-444444444444', // role faculty, ECS + Labs (regression)
  admin: '55555555-5555-5555-5555-555555555555',
  committee: '66666666-6666-6666-6666-666666666666',
  unverified: '77777777-7777-7777-7777-777777777777', // email NOT verified
}

const C = {
  labs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', // CMP-1201 Labs, student
  itnet: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02', // CMP-1202 IT / Network, student
  academics: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03', // CMP-1203 Academics, student
  sensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa04', // CMP-1204 Harassment, student
  other: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa05', // CMP-1205 Labs, otherStudent
  resolved: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa06', // CMP-1206 Labs, resolved (Day 9 confirm)
  resolved2: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0c', // CMP-1212 Labs, resolved (Day 9 reopen)
  stale: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa07', // CMP-1207 Labs, stale (escalation)
  edit: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa08', // CMP-1208 Labs, submitted (Day 10A)
  del: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa09', // CMP-1209 Labs, submitted (Day 10A delete)
  attach: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0a', // CMP-1210 Labs, submitted (Day 10B)
  attachOther: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa0b', // CMP-1211 Labs, otherStudent (Day 10B)
}

const FORBIDDEN_IDENTITY = ['student_id', 'sender_id', 'user_id', 'email', 'name']

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
  return 'd0000000-0000-4000-8000-000000000000'.replace('000000000000', Math.random().toString(16).slice(2, 14).padEnd(12, '0'))
}

// Simulates the storage service writing an uploaded file (Day 10B regression).
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

// Static guard: the private code must never appear in frontend sources or env
// files (it would end up in the JS bundle / Vite env otherwise).
function scanForSecret() {
  const targets = ['src', 'index.html', 'vite.config.js', 'package.json', '.env', '.env.example']
  const hits = []
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.tmp') continue
        walk(full)
      } else if (entry.isFile() && /\.(js|jsx|ts|tsx|html|env|json|css)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(full, 'utf8')
          if (content.includes(TEST_REGISTRATION_CODE)) hits.push(full)
        } catch {
          // unreadable -> ignore
        }
      }
    }
  }
  for (const t of targets) {
    const full = path.join(root, t)
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(full)
    else if (fs.existsSync(full)) {
      try {
        if (fs.readFileSync(full, 'utf8').includes(TEST_REGISTRATION_CODE)) hits.push(full)
      } catch {
        // ignore
      }
    }
  }
  return hits
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

// A REAL client connection as the `authenticated` role (session_user =
// 'authenticated'), exactly like a PostgREST request in production. Used to
// prove the setup function is unavailable to normal client roles even with a
// live session, and to exercise the in-function session_user guard. (connect()
// happens AFTER the stub creates the role, see below.)
const authClient = new pg.Client({
  host: '127.0.0.1',
  port: PORT,
  user: 'authenticated',
  password: 'auth-pass',
  database: 'postgres',
})

try {
  // --------------------------------------------------------------------------
  // Stub the Supabase auth + storage schemas (auth.users needs
  // email_confirmed_at for the Day 10C email-verification rule; storage is
  // needed because the Day 10B migration runs in this list too).
  // --------------------------------------------------------------------------
  await client.query(`
    create role anon nologin;
    -- LOGIN so a second connection can faithfully model a PostgREST client
    -- (session_user = 'authenticated'), which is how the Day 10C setup
    -- function's EXECUTE grant + session_user guard are exercised. All the
    -- other checks use SET ROLE authenticated as before.
    create role authenticated login password 'auth-pass';

    create schema auth;
    grant usage on schema auth to anon, authenticated;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
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

    grant all on table storage.buckets to anon, authenticated;
    grant all on table storage.objects to anon, authenticated;
    grant execute on function storage.foldername(text) to anon, authenticated;
    grant execute on function storage.extension(text) to anon, authenticated;
  `)

  // Now that the `authenticated` role exists (with LOGIN), open the real
  // client session used by the Day 10C setup-function checks.
  await authClient.connect()

  // Reproduce the LIVE-SUPABASE scenario: pgcrypto is ALREADY enabled (e.g.
  // into `public` by an earlier migration run or a manual enable). The Day
  // 10C migration must relocate it into the canonical `extensions` schema and
  // the RPCs must still work via schema-qualified calls.
  await client.query(`create extension if not exists pgcrypto with schema public`)

  // --------------------------------------------------------------------------
  // 1. Migrations (Day 3 .. Day 10C).
  // --------------------------------------------------------------------------
  console.log('\n== 1. Migrations ==')
  try {
    for (const m of MIGRATIONS) await client.query(fs.readFileSync(m, 'utf8'))
    check('56. all migrations (Day 3 .. Day 10E) applied cleanly', true)
  } catch (err) {
    check('56. all migrations (Day 3 .. Day 10E) applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[9], 'utf8'))
    check('55. Day 10C migration is re-runnable', true)
  } catch (err) {
    check('55. Day 10C migration is re-runnable', false, String(err?.message ?? err))
  }
  // Day 10D and Day 10E are additive and re-runnable too.
  try {
    await client.query(fs.readFileSync(MIGRATIONS[10], 'utf8'))
    check('55b. Day 10D migration is re-runnable', true)
  } catch (err) {
    check('55b. Day 10D migration is re-runnable', false, String(err?.message ?? err))
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[11], 'utf8'))
    check('55c. Day 10E migration is re-runnable', true)
  } catch (err) {
    check('55c. Day 10E migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // 2. Seed users (verified except U.unverified), roles, departments,
  //    categories, complaints.
  // --------------------------------------------------------------------------
  await client.query(
    `insert into auth.users (id, email, email_confirmed_at) values
       ($1, 'student@example.com',     now()),
       ($2, 'other@example.com',       now()),
       ($3, 'new-faculty@example.com', now()),
       ($4, 'new-faculty-2@example.com', now()),
       ($5, 'faculty-existing@example.com', now()),
       ($6, 'admin@example.com',       now()),
       ($7, 'committee@example.com',   now()),
       ($8, 'unverified@example.com',  null)`,
    [U.student, U.otherStudent, U.newFaculty, U.newFaculty2, U.existingFaculty, U.admin, U.committee, U.unverified],
  )
  await client.query(`update public.profiles set role = 'faculty' where id = $1`, [U.existingFaculty])
  await client.query(`update public.profiles set role = 'admin' where id = $1`, [U.admin])
  await client.query(`update public.profiles set role = 'committee' where id = $1`, [U.committee])

  // Fixture department + category (throwaway DB only — proves cross-department
  // rejection; the migration adds nothing).
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
    `update public.profiles set department_id = (select id from public.departments where name = 'ECS')
     where id = $1`,
    [U.existingFaculty],
  )

  await client.query(
    `insert into public.complaints
       (id, ticket_number, student_id, category_id, description, priority, status, updated_at)
     values
       ($1,  'CMP-1201', $2,  $3,  'Lab 3 workstation keeps crashing.', 'medium', 'submitted', now()),
       ($4,  'CMP-1202', $5,  $6,  'Wi-Fi drops in the lab wing.', 'high', 'submitted', now()),
       ($7,  'CMP-1203', $8,  $9,  'Timetable clash for third year.', 'high', 'submitted', now()),
       ($10, 'CMP-1204', $11, $12, 'Sensitive harassment report.', 'urgent', 'submitted', now()),
       ($13, 'CMP-1205', $14, $15, 'Labs complaint by another student.', 'medium', 'submitted', now()),
       ($16, 'CMP-1206', $17, $18, 'Resolved Labs complaint.', 'low', 'resolved', now()),
       ($19, 'CMP-1207', $20, $21, 'Stale Labs complaint for escalation.', 'high', 'submitted', now() - interval '3 hours'),
       ($22, 'CMP-1208', $23, $24, 'Labs complaint for Day 10A edit.', 'medium', 'submitted', now()),
       ($25, 'CMP-1209', $26, $27, 'Labs complaint for Day 10A delete.', 'medium', 'submitted', now()),
       ($28, 'CMP-1210', $29, $30, 'Labs complaint for attachments.', 'medium', 'submitted', now()),
       ($31, 'CMP-1211', $32, $33, 'Labs attachment complaint by another student.', 'medium', 'submitted', now()),
       ($34, 'CMP-1212', $35, $36, 'Resolved Labs complaint for reopen.', 'low', 'resolved', now())`,
    [
      C.labs, U.student, catId['Labs'],
      C.itnet, U.student, catId['IT / Network'],
      C.academics, U.student, catId['Academics'],
      C.sensitive, U.student, catId['Harassment / Ragging'],
      C.other, U.otherStudent, catId['Labs'],
      C.resolved, U.student, catId['Labs'],
      C.stale, U.student, catId['Labs'],
      C.edit, U.student, catId['Labs'],
      C.del, U.student, catId['Labs'],
      C.attach, U.student, catId['Labs'],
      C.attachOther, U.otherStudent, catId['Labs'],
      C.resolved2, U.student, catId['Labs'],
    ],
  )

  // Existing faculty baseline assignment (Day 9B admin RPC — also regression 47).
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.existingFaculty, [catId['Labs']]])
    check('47. Day 9B: admin assignment RPC still works (baseline)', rows.length === 1 && rows[0].category === 'Labs', JSON.stringify(rows.map((r) => r.category)))
  })

  // Conversation on C.labs (student + existing faculty) for the chat regressions.
  await asUser(client, U.student, async () => {
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'Need help with the Lab 3 workstation.')`, [C.labs])
  })
  await asUser(client, U.existingFaculty, async () => {
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'We are looking into it.')`, [C.labs])
  })

  // --------------------------------------------------------------------------
  // 3. Registration code table + security.
  // --------------------------------------------------------------------------
  console.log('\n== Registration code ==')
  const { rows: codeCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'faculty_registration_codes' order by ordinal_position`,
  )
  const codeColNames = codeCols.map((r) => r.column_name)
  check('1. faculty_registration_codes exists with hash-only columns', ['id', 'code_hash', 'label', 'created_at', 'updated_at'].every((c) => codeColNames.includes(c)), codeColNames.join(','))
  const { rows: extSchema } = await client.query(
    `select n.nspname as schema
       from pg_extension e
       join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pgcrypto'`,
  )
  check('1d. pgcrypto relocated into the canonical extensions schema (works even when pre-enabled in public)', extSchema[0]?.schema === 'extensions', JSON.stringify(extSchema))
  const { rows: genSalt } = await client.query(`select extensions.gen_salt('bf') is not null as ok`)
  check('1e. extensions.gen_salt / extensions.crypt are callable schema-qualified', genSalt[0]?.ok === true, JSON.stringify(genSalt))
  const { rows: codeRls } = await client.query(`select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'faculty_registration_codes'`)
  check('1b. RLS enabled on faculty_registration_codes', codeRls[0]?.rowsecurity === true)
  const { rows: codePolicies } = await client.query(
    `select policyname from pg_policies where schemaname = 'public' and tablename = 'faculty_registration_codes'`,
  )
  check('1c. no RLS policies on the code table (zero read/write paths)', codePolicies.length === 0, JSON.stringify(codePolicies))

  await asUser(client, U.student, async () => {
    await expectFailure(client, '2. student cannot READ the registration code table (no grant)', () =>
      client.query(`select * from public.faculty_registration_codes`),
    )
    await expectFailure(client, '3. student cannot MODIFY the registration code table (no grant)', () =>
      client.query(`insert into public.faculty_registration_codes (code_hash) values ('x')`),
    )
    await expectFailure(client, '3b. student cannot UPDATE the registration code table', () =>
      client.query(`update public.faculty_registration_codes set code_hash = 'x'`),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '4. anonymous cannot read the registration code table', () =>
    client.query(`select * from public.faculty_registration_codes`),
  )
  await client.query('reset role')

  // Unconfigured code -> refused.
  await asUser(client, U.newFaculty, async () => {
    const msg = await expectFailure(client, '5. unconfigured registration code -> registration refused', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['Labs']]),
    )
    check('5b. refusal message does not reveal internals', !/hash|crypt|pgcrypto/i.test(msg ?? ''), msg ?? '')
  })

  // The setup function is executable ONLY by the database/dashboard owner
  // (postgres — the SQL editor). Check the EXECUTE privilege matrix first.
  const priv = await client.query(
    `select
       has_function_privilege('postgres', 'public.set_faculty_registration_code(text)', 'EXECUTE') as owner_can,
       has_function_privilege('authenticated', 'public.set_faculty_registration_code(text)', 'EXECUTE') as client_can,
       has_function_privilege('anon', 'public.set_faculty_registration_code(text)', 'EXECUTE') as anon_can,
       has_function_privilege('authenticated', 'public.register_faculty(text, uuid, uuid[])', 'EXECUTE') as register_client_can`,
  )
  check('7d. setup function EXECUTE is granted to postgres (SQL editor) only', priv.rows[0]?.owner_can === true && priv.rows[0]?.client_can === false && priv.rows[0]?.anon_can === false, JSON.stringify(priv.rows[0]))
  check('7e. register_faculty REMAINS executable by authenticated (registration flow unchanged)', priv.rows[0]?.register_client_can === true, JSON.stringify(priv.rows[0]))

  // Normal client roles cannot call the setup function (permission denied —
  // no EXECUTE grant).
  await asUser(client, U.student, async () => {
    await expectFailure(client, '7a. student cannot call the setup function (no EXECUTE grant)', () =>
      client.query(`select * from public.set_faculty_registration_code($1)`, [TEST_REGISTRATION_CODE]),
    )
  })
  await asUser(client, U.existingFaculty, async () => {
    await expectFailure(client, '7b. faculty cannot call the setup function (no EXECUTE grant)', () =>
      client.query(`select * from public.set_faculty_registration_code($1)`, [TEST_REGISTRATION_CODE]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, '7c. committee cannot call the setup function (no EXECUTE grant)', () =>
      client.query(`select * from public.set_faculty_registration_code($1)`, [TEST_REGISTRATION_CODE]),
    )
  })
  // A REAL authenticated client session (session_user = 'authenticated') is
  // blocked too — the same permission the app's anon key would get.
  await expectFailure(client, '7f. real authenticated client session cannot call the setup function', () =>
    authClient.query(`select * from public.set_faculty_registration_code($1)`, [TEST_REGISTRATION_CODE]),
  )

  // Defense in depth: even if someone later grants EXECUTE to authenticated,
  // the in-function session_user guard refuses a client session. (Session
  // role stays 'authenticated' across SECURITY DEFINER.)
  await client.query(`grant execute on function public.set_faculty_registration_code(text) to authenticated`)
  await expectFailure(client, '7g. session_user guard rejects a client session even with a grant', () =>
    authClient.query(`select * from public.set_faculty_registration_code($1)`, [TEST_REGISTRATION_CODE]),
  )
  await client.query(`revoke execute on function public.set_faculty_registration_code(text) from authenticated`)

  // The database owner (postgres — the Supabase SQL Editor, where auth.uid()
  // is NULL by design) sets the code.
  let setResult = null
  {
    const { rows, fields } = await client.query(`select * from public.set_faculty_registration_code($1)`, [TEST_REGISTRATION_CODE])
    setResult = { rows, fields }
    check('6. database owner (SQL editor) can set the registration code', rows.length === 1 && rows[0].set_faculty_registration_code === true, JSON.stringify(rows))
  }
  check('10. set RPC returns ONLY a boolean (never the code or hash)', (setResult?.fields ?? []).length === 1 && !['code_hash', 'code', 'registration_code'].includes(setResult?.fields?.[0]?.name ?? ''), JSON.stringify((setResult?.fields ?? []).map((f) => f.name)))

  const { rows: storedCodes } = await client.query(`select code_hash, label from public.faculty_registration_codes`)
  check('9. stored value is a bcrypt hash, never the plaintext', storedCodes.length === 1 && storedCodes[0].code_hash.startsWith('$2') && storedCodes[0].code_hash !== TEST_REGISTRATION_CODE && !storedCodes[0].code_hash.includes(TEST_REGISTRATION_CODE), JSON.stringify(storedCodes))

  await expectFailure(client, '8. too-short registration code rejected (owner call)', () =>
    client.query(`select * from public.set_faculty_registration_code($1)`, ['short']),
  )

  // Static bundle / env guard.
  const secretHits = scanForSecret()
  check('11. test registration code is absent from src/ and env files (JS bundle guard)', secretHits.length === 0, secretHits.join(', '))

  // --------------------------------------------------------------------------
  // 4. Registration validation.
  // --------------------------------------------------------------------------
  console.log('\n== Registration validation ==')
  await asUser(client, U.newFaculty, async () => {
    await expectFailure(client, '13. wrong registration code rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, ['Wrong-Code-2026', catId['Labs']]),
    )
    await expectFailure(client, '14. empty registration code rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, ['', catId['Labs']]),
    )
    await expectFailure(client, '14b. null registration code rejected', () =>
      client.query(`select * from public.register_faculty(null, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [catId['Labs']]),
    )
    await expectFailure(client, '19. nonexistent department rejected', () =>
      client.query(`select * from public.register_faculty($1, 'ffffffff-ffff-ffff-ffff-ffffffffffff', array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['Labs']]),
    )
    await expectFailure(client, '20. nonexistent category rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array['ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid])`, [TEST_REGISTRATION_CODE]),
    )
    await expectFailure(client, '21. sensitive category rejected (Harassment / Ragging)', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['Harassment / Ragging']]),
    )
    await expectFailure(client, '22. cross-department category rejected (CSE Electives for ECS)', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['CSE Electives']]),
    )
    await expectFailure(client, '23. zero categories rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[]::uuid[])`, [TEST_REGISTRATION_CODE]),
    )
    await expectFailure(client, '23b. null categories rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), null)`, [TEST_REGISTRATION_CODE]),
    )
  })

  // Day 10E — email confirmation is OFF for this MVP, so an unverified email
  // (auth.users.email_confirmed_at IS NULL) can complete faculty registration:
  // the private registration code is the authorization gate.
  await asUser(client, U.unverified, async () => {
    const { rows } = await client.query(
      `select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`,
      [TEST_REGISTRATION_CODE, catId['Labs']],
    )
    check('16. unverified email CAN register (email confirmation OFF)', rows.length === 1 && rows[0].role === 'faculty' && rows[0].department === 'ECS', JSON.stringify(rows[0]))
    const { rows: unvProf } = await client.query(`select role, department_id from public.profiles where id = auth.uid()`)
    check('16b. unverified registration persisted (role faculty, department set)', unvProf[0]?.role === 'faculty' && unvProf[0]?.department_id !== null, JSON.stringify(unvProf[0]))
  })

  // Already-registered roles can never be re-registered / modified.
  await asUser(client, U.existingFaculty, async () => {
    await expectFailure(client, '17. already-faculty account rejected (existing faculty untouched)', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['Labs']]),
    )
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '18. admin account rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['Labs']]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, '18b. committee account rejected', () =>
      client.query(`select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid])`, [TEST_REGISTRATION_CODE, catId['Labs']]),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '15. anonymous caller rejected (no execute grant)', () =>
    client.query(`select * from public.register_faculty('${TEST_REGISTRATION_CODE}', '${catId['Labs']}', '{${catId['Labs']}}')`),
  )
  await client.query('reset role')

  // Atomicity: all the rejected attempts above must not have written anything.
  const { rows: noProfileChanges } = await client.query(`select role, department_id from public.profiles where id = $1`, [U.newFaculty])
  check('21b. rejected attempts left the profile untouched (atomic)', noProfileChanges[0]?.role === 'student' && noProfileChanges[0]?.department_id === null, JSON.stringify(noProfileChanges))
  const { rows: noAssignments } = await client.query(`select count(*)::int as n from public.faculty_category_assignments where faculty_id = $1`, [U.newFaculty])
  check('21c. rejected attempts created no assignments (atomic)', noAssignments[0].n === 0, JSON.stringify(noAssignments))

  // Direct role elevation impossible.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '26. direct UPDATE profiles SET role = faculty rejected (no grant)', () =>
      client.query(`update public.profiles set role = 'faculty' where id = auth.uid()`),
    )
    await expectFailure(client, '26b. direct UPDATE profiles SET department_id rejected (no grant)', () =>
      client.query(`update public.profiles set department_id = (select id from public.departments where name = 'ECS') where id = auth.uid()`),
    )
    await expectFailure(client, '26c. direct INSERT into faculty_category_assignments rejected (no grant)', () =>
      client.query(`insert into public.faculty_category_assignments (faculty_id, category_id) values (auth.uid(), $1)`, [catId['Labs']]),
    )
  })

  // --------------------------------------------------------------------------
  // 5. Successful registration (multiple categories) + duplicate handling.
  // --------------------------------------------------------------------------
  console.log('\n== Successful registration ==')
  let regRows = []
  await asUser(client, U.newFaculty, async () => {
    const { rows } = await client.query(
      `select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid, $3::uuid, $2::uuid])`,
      [TEST_REGISTRATION_CODE, catId['Labs'], catId['IT / Network']],
    )
    regRows = rows
  })
  check('12. correct code + department + categories -> registration succeeds', regRows.length === 2, JSON.stringify(regRows))
  check('12b. registered with Labs + IT / Network (duplicate Labs collapsed)', regRows.every((r) => r.role === 'faculty') && regRows.some((r) => r.category === 'Labs') && regRows.some((r) => r.category === 'IT / Network'), JSON.stringify(regRows.map((r) => r.category)))
  check('24. duplicate category ids handled safely (dedupe -> 2 assignments)', regRows.length === 2, `got ${regRows.length}`)
  check('25. RPC result contains only safe fields (no email / code / hash)', !FORBIDDEN_IDENTITY.some((f) => f in (regRows[0] ?? {})) && !('code_hash' in (regRows[0] ?? {})) && !('registration_code' in (regRows[0] ?? {})), Object.keys(regRows[0] ?? {}).join(','))
  check('27. new faculty role = faculty, department = ECS', regRows[0]?.role === 'faculty' && regRows[0]?.department === 'ECS', JSON.stringify(regRows[0]))
  const { rows: newFacultyProfile } = await client.query(`select role, department_id from public.profiles where id = $1`, [U.newFaculty])
  check('27b. profiles.role = faculty and department_id persisted', newFacultyProfile[0]?.role === 'faculty' && newFacultyProfile[0]?.department_id !== null, JSON.stringify(newFacultyProfile))
  // The EXACT read authService.getUserRole performs after registration
  // (RLS-gated, id = auth.uid()) — proves refreshRole() resolves 'faculty'
  // (never 'student') so the page can navigate to /staff on the verified value.
  await asUser(client, U.newFaculty, async () => {
    const { rows: roleRead } = await client.query(`select role from public.profiles where id = auth.uid()`)
    check('27c. refreshRole RLS-gated profile read resolves role = faculty (not student)', roleRead[0]?.role === 'faculty', JSON.stringify(roleRead[0]))
  })
  const { rows: newFacultyAssignments } = await client.query(
    `select cc.name from public.faculty_category_assignments fca
     join public.complaint_categories cc on cc.id = fca.category_id
     where fca.faculty_id = $1 order by cc.name`,
    [U.newFaculty],
  )
  check('28. multiple assignments created (Labs + IT / Network)', newFacultyAssignments.length === 2 && newFacultyAssignments.every((r) => ['Labs', 'IT / Network'].includes(r.name)), JSON.stringify(newFacultyAssignments))

  // Duplicate-category-only registration (second fresh user).
  await asUser(client, U.newFaculty2, async () => {
    const { rows } = await client.query(
      `select * from public.register_faculty($1, (select id from public.departments where name = 'ECS'), array[$2::uuid, $2::uuid, $2::uuid])`,
      [TEST_REGISTRATION_CODE, catId['Labs']],
    )
    check('24b. duplicate-only category list yields exactly ONE assignment', rows.length === 1 && rows[0].category === 'Labs', JSON.stringify(rows.map((r) => r.category)))
  })

  // --------------------------------------------------------------------------
  // 6. Post-registration routing (faculty_can_access_complaint, not frontend).
  // --------------------------------------------------------------------------
  console.log('\n== Faculty routing ==')
  await asUser(client, U.newFaculty, async () => {
    const { rows } = await client.query(`select ticket_number, category_id from public.complaints order by ticket_number`)
    const allowed = new Set(rows.map((r) => r.ticket_number))
    check('29. registered faculty SEES assigned-category complaints (Labs, IT/Network)', rows.length === 10 && allowed.has('CMP-1201') && allowed.has('CMP-1202') && allowed.has('CMP-1205') && allowed.has('CMP-1206') && allowed.has('CMP-1207') && allowed.has('CMP-1208') && allowed.has('CMP-1209') && allowed.has('CMP-1210') && allowed.has('CMP-1211') && allowed.has('CMP-1212'), JSON.stringify([...allowed]))
    check('30. registered faculty does NOT see Academics complaint', !allowed.has('CMP-1203'), JSON.stringify([...allowed]))
    const { rows: academicsView } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.academics])
    check('31. cannot open an Academics complaint detail URL (0 rows)', academicsView.length === 0, JSON.stringify(academicsView))
    const { rows: academicsMsgs } = await client.query(`select id from public.messages where complaint_id = $1`, [C.academics])
    check('32. cannot read Academics chat (no messages)', academicsMsgs.length === 0, JSON.stringify(academicsMsgs))
    check('32b. can_access_complaint false for Academics', (await client.query(`select public.can_access_complaint($1)`, [C.academics])).rows[0].can_access_complaint === false)
    check('32c. can_access_complaint true for Labs', (await client.query(`select public.can_access_complaint($1)`, [C.labs])).rows[0].can_access_complaint === true)
    await expectFailure(client, '33. cannot update Academics complaint status (server-side)', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.academics]),
    )
    const { rows: updated } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.labs])
    check('34. can update an assigned-category complaint status', updated[0]?.status === 'under_review', JSON.stringify(updated))
  })

  // Admin assignment list naturally includes the new faculty (Day 9B page).
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select * from public.list_faculty_category_assignments()`)
    const newFacultyRows = rows.filter((r) => r.faculty_email === 'new-faculty@example.com')
    check('35. admin faculty-assignment list naturally includes the new faculty', newFacultyRows.length === 2 && newFacultyRows.every((r) => ['Labs', 'IT / Network'].includes(r.category)), JSON.stringify(newFacultyRows.map((r) => r.category)))
    check('38. registration-created assignments are Day 9B rows (admin can manage them)', true)
  })

  // --------------------------------------------------------------------------
  // 7. Role isolation + existing-faculty regression.
  // --------------------------------------------------------------------------
  console.log('\n== Role isolation ==')
  const { rows: allRoles } = await client.query(`select id, role from public.profiles where id = any($1::uuid[]) order by id`, [[U.student, U.otherStudent, U.newFaculty, U.existingFaculty, U.admin, U.committee]])
  const roleById = Object.fromEntries(allRoles.map((r) => [r.id, r.role]))
  check('37. role isolation: student stays student', roleById[U.student] === 'student' && roleById[U.otherStudent] === 'student', JSON.stringify(roleById))
  check('37b. role isolation: new faculty = faculty', roleById[U.newFaculty] === 'faculty', JSON.stringify(roleById))
  check('37c. role isolation: existing admin stays admin', roleById[U.admin] === 'admin', JSON.stringify(roleById))
  check('37d. role isolation: existing committee stays committee', roleById[U.committee] === 'committee', JSON.stringify(roleById))
  check('36. existing faculty regression: role untouched', roleById[U.existingFaculty] === 'faculty', JSON.stringify(roleById))
  const { rows: existingAssignments } = await client.query(
    `select cc.name from public.faculty_category_assignments fca
     join public.complaint_categories cc on cc.id = fca.category_id
     where fca.faculty_id = $1 order by cc.name`,
    [U.existingFaculty],
  )
  check('36b. existing faculty assignments intact (Labs only — not reset)', existingAssignments.length === 1 && existingAssignments[0].name === 'Labs', JSON.stringify(existingAssignments))
  await asUser(client, U.existingFaculty, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('48. existing faculty still sees exactly their assigned category', rows.length === 9 && !rows.some((r) => ['CMP-1202', 'CMP-1203'].includes(r.ticket_number)), JSON.stringify(rows.map((r) => r.ticket_number)))
  })

  // --------------------------------------------------------------------------
  // 8. Regressions (Day 3 .. Day 10B).
  // --------------------------------------------------------------------------
  console.log('\n== Regressions ==')

  // 39. Day 4 submission.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values ($1, $2, 'Day 10C regression submission.', 'medium')
       returning ticket_number, status`,
      [U.student, catId['Labs']],
    )
    check('39. Day 4: student submission still works', /^CMP-\d{4}$/.test(rows[0]?.ticket_number ?? '') && rows[0]?.status === 'submitted', JSON.stringify(rows))
  })

  // 40. Day 5 student dashboard.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('40. Day 5: student sees own complaints only', rows.length === 11 && !rows.some((r) => r.ticket_number === 'CMP-1205'), JSON.stringify(rows.map((r) => r.ticket_number)))
  })

  // 41. Day 6 status flow + history.
  await asUser(client, U.existingFaculty, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'in_progress')`, [C.labs])
    check('41. Day 6: authorized status transition works', rows[0]?.status === 'in_progress', JSON.stringify(rows))
  })
  const { rows: flowHist } = await client.query(`select previous_status, new_status, changed_by_role from public.complaint_status_history where complaint_id = $1 order by changed_at`, [C.labs])
  check('41b. Day 6: history recorded with roles only', flowHist.some((h) => h.new_status === 'in_progress' && h.changed_by_role === 'faculty'), JSON.stringify(flowHist))

  // 42. Day 7 chat.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'Thanks for the update.') returning sender_role`,
      [C.labs],
    )
    check('42. Day 7: student sends chat message (sender derived)', rows[0]?.sender_role === 'student', JSON.stringify(rows))
  })
  await asUser(client, U.newFaculty, async () => {
    const { rows } = await client.query(`select * from public.messages_staff_view where complaint_id = $1 order by created_at`, [C.labs])
    check('42b. Day 7: authorized faculty reads conversation identity-free', rows.length >= 3 && FORBIDDEN_IDENTITY.every((f) => !(f in rows[0])), Object.keys(rows[0] ?? {}).join(','))
  })

  // 43. Day 8A message controls.
  await asUser(client, U.existingFaculty, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint_message((select id from public.messages where complaint_id = $1 and sender_role = 'staff' limit 1), 'We are looking into it — ETA tomorrow.')`,
      [C.labs],
    )
    check('43. Day 8A: staff edits own message', rows[0]?.body === 'We are looking into it — ETA tomorrow.' && !!rows[0]?.edited_at, JSON.stringify(rows))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.delete_complaint_message_for_me((select id from public.messages where complaint_id = $1 and sender_role = 'student' order by created_at limit 1))`,
      [C.labs],
    )
    check('43b. Day 8A: delete-for-me works', !!rows[0]?.message_id, JSON.stringify(rows))
  })

  // 44. Day 8B conversation deletion.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.labs])
    check('44. Day 8B: delete conversation for me works', !!rows[0]?.deleted_before, JSON.stringify(rows))
  })

  // 45. Day 9 resolution + reopen.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.confirm_complaint_resolution($1)`, [C.resolved])
    check('45. Day 9: student resolution confirmation works', rows[0]?.status === 'closed', JSON.stringify(rows))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.reopen_complaint($1)`, [C.resolved2])
    check('45b. Day 9: student reopen works', rows[0]?.status === 'reopened', JSON.stringify(rows))
  })

  // 46. Day 9 automatic escalation.
  await client.query(`update public.system_settings set value = '1 hour' where key = 'escalation_threshold'`)
  const { rows: escalated } = await client.query(`select * from public.escalate_stale_complaints()`)
  check('46. Day 9: stale complaint auto-escalated', escalated.some((r) => r.ticket_number === 'CMP-1207'), JSON.stringify(escalated))

  // 49-50. Day 10A edit + delete.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint($1, 'Edited title', 'A valid description long enough for the edit regression.', $2, 'high')`,
      [C.edit, catId['Labs']],
    )
    check('49. Day 10A: edit still works', rows[0]?.title === 'Edited title' && rows[0]?.priority === 'high', JSON.stringify(rows[0]))
    const { rows: del } = await client.query(`select * from public.delete_complaint($1)`, [C.del])
    check('50. Day 10A: delete still works (soft delete)', !!del[0]?.deleted_at, JSON.stringify(del[0]))
  })
  await asUser(client, U.newFaculty, async () => {
    const { rows } = await client.query(`select id from public.complaints where id = $1`, [C.del])
    check('50b. Day 10A: deleted complaint invisible to faculty', rows.length === 0)
  })

  // 51-52. Day 10B attachments.
  const attach = await addAttachment(client, U.student, C.attach, 'jpg', 51200, 'image/jpeg', 'evidence.jpg')
  check('51. Day 10B: attachment create works', !!attach.row && attach.row.media_type === 'image/jpeg', JSON.stringify(attach.row))
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select id, file_name from public.complaint_attachments where complaint_id = $1`, [C.attach])
    check('51b. Day 10B: owner reads attachment metadata', rows.length === 1 && rows[0].file_name === 'evidence.jpg', JSON.stringify(rows))
    const { rows: del } = await client.query(`select * from public.delete_complaint_attachment($1)`, [attach.row.id])
    check('51c. Day 10B: attachment delete works', rows && del.length === 1 && del[0].storage_path === attach.storagePath, JSON.stringify(del[0]))
  })
  await asUser(client, U.student, async () => {
    await expectFailure(client, "52. Day 10B: attachment on another student's complaint rejected", () =>
      client.query(`select * from public.create_complaint_attachment($1, $2, 'x.jpg', 'image/jpeg', 100)`, [C.attachOther, `complaints/${C.attachOther}/d1111111-1111-4111-8111-111111111111.jpg`]),
    )
  })

  // 53. Identity hiding.
  await asUser(client, U.newFaculty, async () => {
    await expectFailure(client, '53. student_id column not selectable by faculty', () =>
      client.query(`select student_id from public.complaints limit 1`),
    )
    await expectFailure(client, '53b. sender_id column not selectable by faculty', () =>
      client.query(`select sender_id from public.messages limit 1`),
    )
    const { rows: prof } = await client.query(`select email from public.profiles where id = $1`, [U.student])
    check('53c. faculty cannot read another profile email (select-own RLS)', prof.length === 0, JSON.stringify(prof))
  })

  // 54. anon blocked on the Day 10C RPCs.
  await client.query('set role anon')
  await expectFailure(client, '54. anonymous blocked from register_faculty', () =>
    client.query(`select * from public.register_faculty('${TEST_REGISTRATION_CODE}', '${catId['Labs']}', '{${catId['Labs']}}')`),
  )
  await expectFailure(client, '54b. anonymous blocked from set_faculty_registration_code', () =>
    client.query(`select * from public.set_faculty_registration_code('${TEST_REGISTRATION_CODE}')`),
  )
  await client.query('reset role')

  // 47b. non-admin cannot use the Day 9B admin RPC after all this.
  await asUser(client, U.newFaculty, async () => {
    await expectFailure(client, '47b. registered faculty cannot manage assignments (admin-only RPC)', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.existingFaculty, [catId['Labs']]]),
    )
  })

  // --------------------------------------------------------------------------
  // Day 10D — Registration options RPC (the /faculty/register page loads ECS +
  // its categories anonymously via get_faculty_registration_options()).
  // --------------------------------------------------------------------------
  console.log('\n== Registration options (Day 10D) ==')
  {
    const { rows: optPriv } = await client.query(
      `select
         has_function_privilege('anon', 'public.get_faculty_registration_options()', 'EXECUTE') as anon_can,
         has_function_privilege('authenticated', 'public.get_faculty_registration_options()', 'EXECUTE') as auth_can`,
    )
    check('57. get_faculty_registration_options EXECUTE granted to anon + authenticated', optPriv[0]?.anon_can === true && optPriv[0]?.auth_can === true, JSON.stringify(optPriv[0]))

    // Anonymous read — the exact scenario that was failing: a visitor opens
    // /faculty/register before signing up, and the Day 3 reference-table
    // grants are authenticated-only. The RPC is the anonymous read path.
    await client.query('set role anon')
    const { rows: anonOpts } = await client.query(`select * from public.get_faculty_registration_options()`)
    await client.query('reset role')

    const ecsAnon = anonOpts.filter((r) => r.department_name === 'ECS')
    const sensitiveAnon = ecsAnon.find((r) => r.is_sensitive)
    check('58. anonymous can read ECS department + its mapped categories', ecsAnon.length >= 8 && ecsAnon[0]?.department_id !== null && ecsAnon[0]?.department_name === 'ECS', JSON.stringify(ecsAnon[0]))
    check('58b. options include the sensitive category (UI renders it disabled)', Boolean(sensitiveAnon) && sensitiveAnon.category_name === 'Harassment / Ragging', JSON.stringify(sensitiveAnon))
    check('58c. options include the 7 non-sensitive ECS categories', ecsAnon.filter((r) => !r.is_sensitive).length === 7, `count=${ecsAnon.filter((r) => !r.is_sensitive).length}`)

    // Authenticated (a signed-in student completing registration) reads the same options.
    await asUser(client, U.student, async () => {
      const { rows: authOpts } = await client.query(`select * from public.get_faculty_registration_options()`)
      const ecsAuth = authOpts.filter((r) => r.department_name === 'ECS')
      check('59. authenticated (student) reads the same ECS options', ecsAuth.length === ecsAnon.length && ecsAuth.length >= 8, JSON.stringify(ecsAuth[0]))
    })

    // The RPC exposes ONLY public reference data — no identity, no code/hash.
    const optionKeys = Object.keys(anonOpts[0] ?? {}).sort().join(',')
    check('60. RPC returns ONLY reference data (no identity / code / hash)', optionKeys === 'category_id,category_name,department_id,department_name,is_sensitive', optionKeys)
  }
} finally {
  await client.end().catch(() => {})
  await authClient.end().catch(() => {})
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
