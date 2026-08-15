/**
 * Day 6 local verification harness — Status Flow.
 *
 * Boots a throwaway PostgreSQL instance (embedded-postgres), stubs the
 * Supabase `auth` schema, applies the Day 3 migration UNCHANGED plus the new
 * Day 6 migration, and exercises the status-flow security model the frontend
 * relies on (see src/lib/complaintService.js + StaffComplaintDetailPage):
 *
 *   1. Day 3 + Day 6 migrations apply cleanly (Day 6 is idempotent)
 *   2. students see only their own complaints (and their status reflects a
 *      staff update — the dashboard shows the new status)
 *   3. students CANNOT update status (RPC rejects them) and have no direct
 *      UPDATE grant on complaints
 *   4. staff detail reads come from complaints_staff_view with NO identity
 *      fields; sensitive complaints stay invisible to ordinary faculty and
 *      non-sensitive ones invisible to committee; admin sees all
 *   5. a valid faculty update succeeds atomically, creates a history row with
 *      the previous/new status, a timestamp, and changed_by_role only
 *   6. invalid transitions and no-op self-transitions are rejected
 *   7. invalid enum values are rejected at the call boundary
 *   8. sensitive complaints cannot be updated by ordinary faculty (but can by
 *      committee); non-sensitive cannot be updated by committee
 *   9. a faculty member with a department can only update complaints of that
 *      department (cross-department updates rejected)
 *  10. admin (department-less coordinator) can update sensitive ECS complaints
 *  11. history is read-only and follows the same visibility rule as the
 *      complaint; it contains timestamps and NO identity columns
 *  12. staff cannot forge student identity and cannot bypass the RPC with a
 *      direct UPDATE / history INSERT
 *  13. anon has no access at all (view, history, RPC)
 *
 * Usage:  node scripts/verify-day6.mjs
 * Exit code is non-zero if any check fails.
 */
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const MIGRATION_DAY3 = path.join(
  root,
  'supabase',
  'migrations',
  '20260814000000_day3_database_security_foundation.sql',
)
const MIGRATION_DAY6 = path.join(
  root,
  'supabase',
  'migrations',
  '20260815000000_day6_status_flow.sql',
)
const DB_DIR = path.join(root, '.tmp', 'day6-pgdata')
const PORT = 55438

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  otherStudent: '22222222-2222-2222-2222-222222222222',
  faculty: '33333333-3333-3333-3333-333333333333',
  admin: '44444444-4444-4444-4444-444444444444',
  committee: '55555555-5555-5555-5555-555555555555',
}

const C = {
  ecsNonSensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', // CMP-9101, Academics, submitted  (student)
  ecsSensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02', // CMP-9102, Harassment/Ragging, submitted (student)
  otherStudent: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03', // CMP-9103, Labs, submitted (otherStudent)
  cseDept: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa04', // CMP-9104, CSE category, submitted (student)
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
  // Stub the Supabase auth schema + roles.
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
  // 1. Migrations.
  // --------------------------------------------------------------------------
  console.log('\n== 1. Migrations ==')
  try {
    await client.query(fs.readFileSync(MIGRATION_DAY3, 'utf8'))
    check('Day 3 migration applied cleanly', true)
  } catch (err) {
    check('Day 3 migration applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATION_DAY6, 'utf8'))
    check('Day 6 migration applied cleanly', true)
  } catch (err) {
    check('Day 6 migration applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATION_DAY6, 'utf8'))
    check('Day 6 migration is re-runnable', true)
  } catch (err) {
    check('Day 6 migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // Seed users + roles + departments + complaints.
  // --------------------------------------------------------------------------
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
  // Faculty belongs to ECS (used by the department authorization check).
  await client.query(
    `update public.profiles set department_id = (select id from public.departments where name = 'ECS') where id = $1`,
    [U.faculty],
  )

  // A second department + category so the cross-department test is real.
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

  const { rows: cats } = await client.query(
    `select id, name, is_sensitive from public.complaint_categories order by name`,
  )
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  await client.query(
    `insert into public.complaints (id, ticket_number, student_id, category_id, description, priority, status)
     values
       ($1, 'CMP-9101', $2, $3, 'Projector flickers in Lab 4.', 'medium', 'submitted'),
       ($4, 'CMP-9102', $2, $5, 'Harassment report that must stay anonymous.', 'urgent', 'submitted'),
       ($6, 'CMP-9103', $7, $8, 'WiFi down in block B.', 'low', 'submitted'),
       ($9, 'CMP-9104', $2, $10, 'CSE elective enrollment issue.', 'medium', 'submitted')`,
    [
      C.ecsNonSensitive, U.student, catId['Academics'],
      C.ecsSensitive, catId['Harassment / Ragging'],
      C.otherStudent, U.otherStudent, catId['Labs'],
      C.cseDept, catId['CSE Electives'],
    ],
  )
  const { rows: seeded } = await client.query(
    `select ticket_number, is_sensitive, handler_type,
            (select d.name from public.departments d where d.id = complaints.department_id) as dept
     from public.complaints order by ticket_number`,
  )
  const seedMap = Object.fromEntries(seeded.map((r) => [r.ticket_number, r]))
  check('seed: CMP-9104 routed to CSE department', seedMap['CMP-9104']?.dept === 'CSE', seedMap['CMP-9104']?.dept)
  check('seed: CMP-9102 sensitive + committee handler', seedMap['CMP-9102']?.is_sensitive === true && seedMap['CMP-9102']?.handler_type === 'committee')

  // --------------------------------------------------------------------------
  // 2. Student visibility + status reflection.
  // --------------------------------------------------------------------------
  console.log('\n== 2. Student visibility ==')
  let studentStatuses = []
  await asUser(client, U.student, async () => {
    // Same query shape as the Day 5 student dashboard (no ownership filter;
    // RLS enforces student_id = auth.uid()).
    const { rows } = await client.query(
      `select c.ticket_number, c.status, cc.name as category
       from public.complaints c
       left join public.complaint_categories cc on cc.id = c.category_id
       order by c.ticket_number`,
    )
    studentStatuses = rows
  })
  check(
    'student sees own 3 complaints only',
    studentStatuses.length === 3 &&
      ['CMP-9101', 'CMP-9102', 'CMP-9104'].every((t) => studentStatuses.some((r) => r.ticket_number === t)) &&
      !studentStatuses.some((r) => r.ticket_number === 'CMP-9103'),
    JSON.stringify(studentStatuses.map((r) => r.ticket_number)),
  )
  await asUser(client, U.otherStudent, async () => {
    const { rows } = await client.query('select ticket_number from public.complaints')
    check('other student sees only their own complaint', rows.length === 1 && rows[0].ticket_number === 'CMP-9103', JSON.stringify(rows))
  })

  // --------------------------------------------------------------------------
  // 3. Students cannot update status.
  // --------------------------------------------------------------------------
  console.log('\n== 3. Student cannot update ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'student RPC status update rejected', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.ecsNonSensitive]),
    )
    await expectFailure(client, 'student direct UPDATE on complaints denied (no grant)', () =>
      client.query(`update public.complaints set status = 'in_progress' where id = $1`, [C.ecsNonSensitive]),
    )
  })

  // --------------------------------------------------------------------------
  // 4. Staff detail read — safe view, per-role visibility.
  // --------------------------------------------------------------------------
  console.log('\n== 4. Staff detail reads ==')
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select id, ticket_number, category, department, description, priority, status,
              handler_type, is_sensitive, created_at, updated_at
       from public.complaints_staff_view where id = $1`,
      [C.ecsNonSensitive],
    )
    check('faculty reads authorized ECS complaint detail', rows.length === 1 && rows[0].ticket_number === 'CMP-9101' && rows[0].department === 'ECS', JSON.stringify(rows))
    const forbidden = ['student_id', 'sender_id', 'email', 'name']
    check('detail response has no identity fields', rows.every((r) => forbidden.every((f) => !(f in r))), Object.keys(rows[0] ?? {}).join(','))
    const { rows: sens } = await client.query(
      `select id from public.complaints_staff_view where id = $1`,
      [C.ecsSensitive],
    )
    check('faculty cannot read sensitive complaint via view', sens.length === 0)
  })
  await asUser(client, U.committee, async () => {
    const { rows: sens } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.ecsSensitive])
    const { rows: norm } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.ecsNonSensitive])
    check('committee reads sensitive complaint', sens.length === 1)
    check('committee cannot read non-sensitive complaint via view', norm.length === 0)
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select id from public.complaints_staff_view where id in ($1, $2) order by id`, [C.ecsSensitive, C.ecsNonSensitive])
    check('admin reads sensitive + non-sensitive', rows.length === 2)
  })

  // --------------------------------------------------------------------------
  // 5. Valid faculty update -> atomic update + history + student reflection.
  // --------------------------------------------------------------------------
  console.log('\n== 5. Valid update ==')
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select * from public.update_complaint_status($1, 'under_review')`,
      [C.ecsNonSensitive],
    )
    const r = rows[0]
    check('valid update returns ticket + new status + updated_at', r?.ticket_number === 'CMP-9101' && r?.status === 'under_review' && !!r?.updated_at, JSON.stringify(r))
  })
  const { rows: hist1 } = await client.query(
    `select previous_status, new_status, changed_by_role, changed_at
     from public.complaint_status_history where complaint_id = $1`,
    [C.ecsNonSensitive],
  )
  check('history row created', hist1.length === 1, JSON.stringify(hist1))
  check('history previous submitted / new under_review', hist1[0]?.previous_status === 'submitted' && hist1[0]?.new_status === 'under_review')
  check('history changed_by_role is anonymous role (faculty)', hist1[0]?.changed_by_role === 'faculty', hist1[0]?.changed_by_role)
  check('history contains a timestamp', !!hist1[0]?.changed_at)
  check('history timestamp is not in the future', new Date(hist1[0]?.changed_at).getTime() <= Date.now() + 1000)

  // The student dashboard must now show the new status.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select status from public.complaints where id = $1`, [C.ecsNonSensitive])
    check('student dashboard reflects staff update (under_review)', rows[0]?.status === 'under_review', rows[0]?.status)
  })

  // --------------------------------------------------------------------------
  // 6. Transition validation (invalid + no-op).
  // --------------------------------------------------------------------------
  console.log('\n== 6. Transition validation ==')
  await asUser(client, U.faculty, async () => {
    // CMP-9103 is 'submitted': submitted -> resolved is not allowed.
    await expectFailure(client, 'invalid transition submitted -> resolved rejected', () =>
      client.query(`select * from public.update_complaint_status($1, 'resolved')`, [C.otherStudent]),
    )
    // A valid step first...
    await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.otherStudent])
    // ...then the same status again is a rejected no-op.
    await expectFailure(client, 'no-op self-transition rejected', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.otherStudent]),
    )
    // under_review -> closed is not in the lifecycle (closed only from resolved).
    await expectFailure(client, 'under_review -> closed rejected', () =>
      client.query(`select * from public.update_complaint_status($1, 'closed')`, [C.otherStudent]),
    )
  })

  // --------------------------------------------------------------------------
  // 7. Invalid enum value rejected at the call boundary.
  // --------------------------------------------------------------------------
  console.log('\n== 7. Invalid status value ==')
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'invalid enum value rejected', () =>
      client.query(`select * from public.update_complaint_status($1, $2)`, [C.otherStudent, 'archived']),
    )
  })

  // --------------------------------------------------------------------------
  // 8. Sensitive complaints stay restricted from ordinary faculty.
  // --------------------------------------------------------------------------
  console.log('\n== 8. Sensitive restriction ==')
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'faculty cannot update sensitive complaint', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.ecsSensitive]),
    )
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.ecsSensitive])
    check('committee can update sensitive complaint', rows[0]?.status === 'under_review', JSON.stringify(rows))
    await expectFailure(client, 'committee cannot update non-sensitive complaint', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.ecsNonSensitive]),
    )
  })
  const { rows: hist2 } = await client.query(
    `select changed_by_role from public.complaint_status_history where complaint_id = $1`,
    [C.ecsSensitive],
  )
  check('sensitive history changed_by_role is committee', hist2[0]?.changed_by_role === 'committee', hist2[0]?.changed_by_role)

  // --------------------------------------------------------------------------
  // 9. Department authorization.
  // --------------------------------------------------------------------------
  console.log('\n== 9. Department authorization ==')
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'faculty (ECS) cannot update CSE complaint', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.cseDept]),
    )
  })

  // --------------------------------------------------------------------------
  // 10. Admin (coordinator) can update sensitive ECS complaints.
  // --------------------------------------------------------------------------
  console.log('\n== 10. Admin ==')
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'assigned')`, [C.ecsSensitive])
    check('admin can update sensitive complaint', rows[0]?.status === 'assigned', JSON.stringify(rows))
  })
  const { rows: hist3 } = await client.query(
    `select changed_by_role from public.complaint_status_history where complaint_id = $1 and new_status = 'assigned'`,
    [C.ecsSensitive],
  )
  check('admin history changed_by_role is admin', hist3[0]?.changed_by_role === 'admin', hist3[0]?.changed_by_role)

  // --------------------------------------------------------------------------
  // 11. History visibility follows the complaint's visibility rule.
  // --------------------------------------------------------------------------
  console.log('\n== 11. History visibility ==')
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select id from public.complaint_status_history where complaint_id = $1`, [C.ecsNonSensitive])
    check('faculty sees history of non-sensitive complaint', rows.length >= 1)
    const { rows: sens } = await client.query(`select id from public.complaint_status_history where complaint_id = $1`, [C.ecsSensitive])
    check('faculty cannot see history of sensitive complaint', sens.length === 0)
  })
  await asUser(client, U.student, async () => {
    const { rows: own } = await client.query(`select id from public.complaint_status_history where complaint_id in ($1, $2)`, [C.ecsNonSensitive, C.ecsSensitive])
    check('student sees history of own complaints', own.length >= 2)
    const { rows: other } = await client.query(`select id from public.complaint_status_history where complaint_id = $1`, [C.otherStudent])
    check('student cannot see history of another student complaint', other.length === 0)
  })
  const { rows: histCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaint_status_history'
     order by ordinal_position`,
  )
  const histColNames = histCols.map((r) => r.column_name)
  check(
    'history table has no identity columns',
    !histColNames.some((c) => ['student_id', 'sender_id', 'user_id', 'email', 'name'].includes(c)),
    histColNames.join(','),
  )

  // --------------------------------------------------------------------------
  // 12. Staff cannot forge identity / bypass the RPC.
  // --------------------------------------------------------------------------
  console.log('\n== 12. No direct write path ==')
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'faculty direct UPDATE on complaints denied (no grant)', () =>
      client.query(`update public.complaints set status = 'resolved' where id = $1`, [C.ecsNonSensitive]),
    )
    await expectFailure(client, 'faculty cannot rewrite student_id (no grant)', () =>
      client.query(`update public.complaints set student_id = $1 where id = $2`, [U.faculty, C.ecsNonSensitive]),
    )
    await expectFailure(client, 'faculty cannot insert history directly (no grant + RLS)', () =>
      client.query(
        `insert into public.complaint_status_history (complaint_id, previous_status, new_status, changed_by_role)
         values ($1, 'submitted', 'resolved', 'faculty')`,
        [C.ecsNonSensitive],
      ),
    )
  })

  // --------------------------------------------------------------------------
  // 13. anon has no access.
  // --------------------------------------------------------------------------
  console.log('\n== 13. anon ==')
  await client.query('set role anon')
  await expectFailure(client, 'anon cannot read staff view', () =>
    client.query('select * from public.complaints_staff_view limit 1'),
  )
  await expectFailure(client, 'anon cannot read status history', () =>
    client.query('select * from public.complaint_status_history limit 1'),
  )
  await expectFailure(client, 'anon cannot call update RPC', () =>
    client.query(`select * from public.update_complaint_status('${C.ecsNonSensitive}', 'under_review')`),
  )
  await client.query('reset role')
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
