/**
 * Day 5 local verification harness.
 *
 * Boots a throwaway PostgreSQL instance (embedded-postgres, project-local
 * binaries under node_modules), stubs the Supabase `auth` schema, applies the
 * Day 3 migration unchanged, and exercises the exact queries the Day 5
 * dashboards use (see src/lib/complaintService.js):
 *
 *   STUDENT DASHBOARD
 *   1. the student dashboard query (own complaints + embedded category name)
 *      returns only the signed-in student's rows, with the category NAME
 *      (e.g. "Labs"), never just the category UUID
 *   2. the real seeded test complaint (CMP-0002, Labs, medium, submitted)
 *      shows up with the correct safe fields — nothing hardcoded
 *   3. summary math works off the fetched rows (total / active / closed)
 *   4. another student sees only their own rows (isolation, enforced by RLS)
 *   5. a student cannot read student_id at all (column grant)
 *   6. a student querying the staff VIEW also sees only their own rows
 *      (security-invoker view, defense in depth)
 *
 *   STAFF DASHBOARD
 *   7. the staff dashboard query against public.complaints_staff_view returns
 *      rows with category + department NAMES and NO identity fields:
 *      no student_id / email / name / sender_id anywhere in the response
 *   8. role-based row visibility on the view: faculty -> non-sensitive only,
 *      committee -> sensitive only, admin -> all ECS complaints
 *   9. the view schema itself contains no identity columns
 *  10. anon (unauthenticated) cannot read the view
 *  11. staff filters operate only on safe fields (status / category /
 *      priority / ticket search), both client-side (the exact React
 *      predicate) and SQL-side on the view
 *
 * Usage:  node scripts/verify-day5.mjs
 * Exit code is non-zero if any check fails.
 */
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const MIGRATION = path.join(
  root,
  'supabase',
  'migrations',
  '20260814000000_day3_database_security_foundation.sql',
)
const DB_DIR = path.join(root, '.tmp', 'day5-pgdata')
const PORT = 55436

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  otherStudent: '22222222-2222-2222-2222-222222222222',
  faculty: '33333333-3333-3333-3333-333333333333',
  admin: '44444444-4444-4444-4444-444444444444',
  committee: '55555555-5555-5555-5555-555555555555',
}

// The exact React filter predicate (src/pages/StaffPage.jsx), replicated so
// the harness asserts the same logic the UI runs over the view's data.
function applyStaffFilters(rows, { status = 'all', category = 'all', priority = 'all', ticket = '' } = {}) {
  const q = ticket.trim().toLowerCase()
  return rows.filter((r) => {
    if (status !== 'all' && r.status !== status) return false
    if (category !== 'all' && r.category !== category) return false
    if (priority !== 'all' && r.priority !== priority) return false
    if (q && !r.ticket_number.toLowerCase().includes(q)) return false
    return true
  })
}

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

// Runs a query as `authenticated` pretending to be the given user id.
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

// Expects the query to fail; returns the error message.
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
  // Stub the Supabase auth schema + roles that a real Supabase project has.
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
  `)

  // --------------------------------------------------------------------------
  // 0. Apply the Day 3 migration unchanged (it is the live foundation).
  // --------------------------------------------------------------------------
  console.log('\n== 0. Migration ==')
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8')
  try {
    await client.query(migrationSql)
    check('Day 3 migration applied cleanly', true)
  } catch (err) {
    check('Day 3 migration applied cleanly', false, String(err?.message ?? err))
    throw err
  }

  // Seed users; the sign-up trigger creates profiles with role 'student'.
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'student@example.com'),
       ($2, 'other@example.com'),
       ($3, 'faculty@example.com'),
       ($4, 'admin@example.com'),
       ($5, 'committee@example.com')`,
    [U.student, U.otherStudent, U.faculty, U.admin, U.committee],
  )
  await client.query(`update public.profiles set role = 'faculty'   where id = $1`, [U.faculty])
  await client.query(`update public.profiles set role = 'admin'     where id = $1`, [U.admin])
  await client.query(`update public.profiles set role = 'committee' where id = $1`, [U.committee])

  const { rows: cats } = await client.query(
    `select id, name, is_sensitive from public.complaint_categories order by name`,
  )
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  // Seed complaints (ticket numbers provided; the trigger derives the rest).
  // CMP-0002 mirrors the real live test complaint: Labs / medium / submitted.
  await client.query(
    `insert into public.complaints (id, ticket_number, student_id, category_id, description, priority, status)
     values
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'CMP-0002', $1, $2, 'Projector in Lab 4 flickers constantly during lectures.', 'medium', 'submitted'),
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'CMP-0003', $1, $3, 'Grade not updated for the DSP course.', 'high', 'resolved'),
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', 'CMP-0004', $1, $4, 'Harassment report that stays anonymous.', 'urgent', 'submitted'),
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', 'CMP-0005', $5, $6, 'WiFi down in block B.', 'low', 'under_review')`,
    [U.student, catId['Labs'], catId['Academics'], catId['Harassment / Ragging'], U.otherStudent, catId['IT / Network']],
  )
  const { rows: derived } = await client.query(
    `select ticket_number, is_sensitive, handler_type, department_id from public.complaints order by ticket_number`,
  )
  const derivedMap = Object.fromEntries(derived.map((r) => [r.ticket_number, r]))
  check('seed: CMP-0002 derives department handler (Labs)', derivedMap['CMP-0002']?.handler_type === 'department')
  check('seed: CMP-0004 derives committee handler (sensitive)', derivedMap['CMP-0004']?.handler_type === 'committee' && derivedMap['CMP-0004']?.is_sensitive === true)

  // --------------------------------------------------------------------------
  // 1. Student dashboard query — exact frontend query (fetchStudentComplaints).
  // NOTE: the query has NO ownership filter. Ownership is enforced by RLS
  // (complaints_select_student: student_id = auth.uid()); student_id is not
  // a selectable column (column grants), so a WHERE on it is rejected — see
  // check below. This is exactly why the frontend cannot filter on it.
  // --------------------------------------------------------------------------
  console.log('\n== 1. Student dashboard query ==')
  let studentRows = []
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select
         c.id, c.ticket_number, c.category_id, c.priority, c.status,
         c.created_at, c.updated_at,
         cc.name as category
       from public.complaints c
       left join public.complaint_categories cc on cc.id = c.category_id
       order by c.created_at desc`,
    )
    studentRows = rows
  })
  check('student dashboard returns only own 3 complaints (RLS-enforced)', studentRows.length === 3, JSON.stringify(studentRows.map((r) => r.ticket_number)))
  const cmp2 = studentRows.find((r) => r.ticket_number === 'CMP-0002')
  check('real test complaint CMP-0002 present', !!cmp2)
  check('CMP-0002 category is the NAME "Labs" (not the uuid)', cmp2?.category === 'Labs', cmp2?.category)
  check('CMP-0002 priority medium', cmp2?.priority === 'medium', cmp2?.priority)
  check('CMP-0002 status submitted', cmp2?.status === 'submitted', cmp2?.status)
  check('CMP-0002 has created/updated dates', !!cmp2?.created_at && !!cmp2?.updated_at)
  check(
    'every row carries a category name (no bare uuids)',
    studentRows.every((r) => r.category && !/^[0-9a-f-]{36}$/i.test(r.category)),
  )
  // The student response must not contain identity fields (they are not
  // selectable at all, but assert the response shape too).
  const forbidden = ['student_id', 'sender_id', 'email']
  check(
    'student response has no identity fields',
    studentRows.every((r) => forbidden.every((f) => !(f in r))),
    Object.keys(studentRows[0] ?? {}).join(','),
  )
  // Summary math (as computed by the dashboard): 3 total, 2 active, 1 closed.
  const closed = studentRows.filter((r) => ['resolved', 'closed'].includes(r.status)).length
  check('summary: total 3, active 2, closed 1', studentRows.length === 3 && studentRows.length - closed === 2 && closed === 1)

  // --------------------------------------------------------------------------
  // 2. Student isolation.
  // --------------------------------------------------------------------------
  console.log('\n== 2. Student isolation ==')
  await asUser(client, U.otherStudent, async () => {
    // Same query shape as the dashboard (no ownership filter) — RLS decides.
    const { rows } = await client.query(
      `select c.ticket_number, cc.name as category
       from public.complaints c
       left join public.complaint_categories cc on cc.id = c.category_id
       order by c.created_at desc`,
    )
    check('other student sees only their own 1 complaint', rows.length === 1 && rows[0].ticket_number === 'CMP-0005', JSON.stringify(rows))
    await expectFailure(client, 'student cannot read student_id column', () =>
      client.query('select student_id from public.complaints limit 1'),
    )
    // The column grant is why the dashboard query cannot (and need not)
    // reference student_id — even filtering on it is rejected.
    await expectFailure(client, 'student cannot filter on student_id (column grant)', () =>
      client.query(
        `select ticket_number from public.complaints where student_id = auth.uid()`,
      ),
    )
  })
  // Defense in depth: a student querying the STAFF VIEW (security invoker)
  // still only sees their own rows.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query('select ticket_number from public.complaints_staff_view order by ticket_number')
    check('student querying the staff view sees only own rows', rows.length === 3 && rows.every((r) => ['CMP-0002', 'CMP-0003', 'CMP-0004'].includes(r.ticket_number)), JSON.stringify(rows))
  })

  // --------------------------------------------------------------------------
  // 3. Staff dashboard query — exact frontend query (fetchStaffComplaints).
  // --------------------------------------------------------------------------
  console.log('\n== 3. Staff dashboard query ==')
  let staffRows = []
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select
         id, ticket_number, category, department, priority, status, handler_type,
         is_sensitive, created_at, updated_at
       from public.complaints_staff_view
       order by created_at desc`,
    )
    staffRows = rows
  })
  check('faculty sees non-sensitive complaints only', staffRows.length === 3 && staffRows.every((r) => r.is_sensitive === false), JSON.stringify(staffRows.map((r) => r.ticket_number)))
  check('staff rows carry category + department NAMES', staffRows.every((r) => r.category && r.department), JSON.stringify(staffRows.map((r) => [r.category, r.department])))
  const forbiddenStaff = ['student_id', 'sender_id', 'email', 'name']
  check(
    'staff response contains NO identity fields',
    staffRows.every((r) => forbiddenStaff.every((f) => !(f in r))),
    Object.keys(staffRows[0] ?? {}).join(','),
  )
  const staffCols = Object.keys(staffRows[0] ?? {})
  check(
    'staff response fields are exactly the safe dashboard fields',
    JSON.stringify(staffCols.sort()) ===
      JSON.stringify(['id', 'ticket_number', 'category', 'department', 'priority', 'status', 'handler_type', 'is_sensitive', 'created_at', 'updated_at'].sort()),
    staffCols.join(','),
  )
  // The SensitiveBadge field must be present for every row.
  check('staff rows carry the sensitive/standard indicator', staffRows.every((r) => typeof r.is_sensitive === 'boolean'))

  // --------------------------------------------------------------------------
  // 4. Role-based visibility on the staff view.
  // --------------------------------------------------------------------------
  console.log('\n== 4. View visibility per role ==')
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query('select ticket_number, is_sensitive from public.complaints_staff_view order by ticket_number')
    check('committee sees sensitive complaints only', rows.length === 1 && rows[0].ticket_number === 'CMP-0004' && rows[0].is_sensitive === true, JSON.stringify(rows))
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query('select ticket_number from public.complaints_staff_view order by ticket_number')
    check('admin sees all ECS complaints', rows.length === 4, JSON.stringify(rows))
  })
  const { rows: viewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaints_staff_view'
     order by ordinal_position`,
  )
  const viewColumnNames = viewCols.map((r) => r.column_name)
  check(
    'view schema contains no identity columns',
    !viewColumnNames.some((c) => ['student_id', 'sender_id', 'email'].includes(c) || c === 'name'),
    viewColumnNames.join(','),
  )
  check(
    'view schema has no sender_id',
    !viewColumnNames.includes('sender_id'),
    viewColumnNames.join(','),
  )

  // --------------------------------------------------------------------------
  // 5. anon (unauthenticated) cannot read the view.
  // --------------------------------------------------------------------------
  console.log('\n== 5. anon ==')
  await client.query('set role anon')
  await expectFailure(client, 'anon cannot read the staff view', () =>
    client.query('select * from public.complaints_staff_view limit 1'),
  )
  await expectFailure(client, 'anon cannot read the complaints table', () =>
    client.query('select * from public.complaints limit 1'),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 6. Staff filters — the exact React predicate over the view's data.
  // --------------------------------------------------------------------------
  console.log('\n== 6. Staff filters ==')
  const ticketOf = (rows) => rows.map((r) => r.ticket_number).sort().join(',')
  check('filter status=submitted', ticketOf(applyStaffFilters(staffRows, { status: 'submitted' })) === 'CMP-0002', ticketOf(applyStaffFilters(staffRows, { status: 'submitted' })))
  check('filter status=under_review', ticketOf(applyStaffFilters(staffRows, { status: 'under_review' })) === 'CMP-0005', ticketOf(applyStaffFilters(staffRows, { status: 'under_review' })))
  check('filter category=Academics', ticketOf(applyStaffFilters(staffRows, { category: 'Academics' })) === 'CMP-0003', ticketOf(applyStaffFilters(staffRows, { category: 'Academics' })))
  check('filter priority=high', ticketOf(applyStaffFilters(staffRows, { priority: 'high' })) === 'CMP-0003', ticketOf(applyStaffFilters(staffRows, { priority: 'high' })))
  check('search ticket "cmp-000" (case-insensitive)', ticketOf(applyStaffFilters(staffRows, { ticket: 'cmp-000' })) === 'CMP-0002,CMP-0003,CMP-0005', ticketOf(applyStaffFilters(staffRows, { ticket: 'cmp-000' })))
  check('combined status=submitted + category=Labs', ticketOf(applyStaffFilters(staffRows, { status: 'submitted', category: 'Labs' })) === 'CMP-0002', ticketOf(applyStaffFilters(staffRows, { status: 'submitted', category: 'Labs' })))
  check('no filters -> all visible rows', applyStaffFilters(staffRows).length === 3)
  // The same filters are safe to push down to SQL (they touch only safe view
  // columns, never identity).
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select ticket_number from public.complaints_staff_view where status = $1 and category = $2 order by ticket_number`,
      ['submitted', 'Labs'],
    )
    check('SQL-side filter on view (safe fields)', rows.length === 1 && rows[0].ticket_number === 'CMP-0002', JSON.stringify(rows))
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
