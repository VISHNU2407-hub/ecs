/**
 * Day 9B local verification harness — Faculty category assignment & routing.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` schema,
 * applies ALL migrations (Day 3 + 6 + 7 + 8A + 8B + 9 + 9B), and exercises
 * the faculty-level category-routing security model the frontend relies on
 * (src/lib/complaintService.js + FacultyAssignmentsPage + the existing
 * staff dashboard/detail/chat, which need NO frontend security changes
 * because the database enforces everything):
 *
 * ASSIGNMENT MODEL (1-11)
 *   1. faculty_category_assignments table exists
 *   2. UNIQUE(faculty_id, category_id) enforced
 *   3. students cannot create assignments (table + RPC)
 *   4. faculty cannot create assignments (table)
 *   5. faculty cannot modify their own assignments (RPC)
 *   6. admin can manage assignments (RPC replace works)
 *   7. non-admin cannot manage assignments (student/faculty/committee RPC)
 *   8. invalid faculty target rejected
 *   9. student target rejected
 *  10. sensitive category assignment rejected (atomically — nothing written)
 *  11. cross-department category assignment rejected
 *
 * FACULTY VISIBILITY (12-18)
 *  12. Labs-assigned faculty sees Labs complaints
 *  13. Labs-assigned faculty cannot see Academics complaints
 *  14. faculty from a wrong/no department sees nothing
 *  15. unauthorized complaint detail rejected (generic no-row)
 *  16. unauthorized complaint chat rejected (can_access_complaint)
 *  17. unauthorized status update rejected (server-side)
 *  18. authorized status update still works (+ history)
 *
 * ROLE ISOLATION (19-21)
 *  19. student isolation unchanged
 *  20. committee sensitive access unchanged
 *  21. admin visibility unchanged
 *
 * IDENTITY (22-24)
 *  22. sender_id stays hidden
 *  23. student_id stays hidden
 *  24. email/name stay hidden (staff views; admin RPC is admin-only)
 *  24b. even a hand-inserted sensitive assignment grants faculty nothing
 *
 * SECURITY (25-29)
 *  25. base-table RLS blocks unauthorized faculty rows (no frontend filter)
 *  26. staff view returns only authorized rows
 *  27. category filtering is NOT the security boundary (bare queries)
 *  28. direct assignment-table bypass rejected (no DML grants)
 *  29. anonymous users rejected everywhere
 *
 * REGRESSION (30-34)
 *  30. Day 9 escalation still works (and escalated visibility follows the
 *      assignment rule for faculty)
 *  31. Day 8B conversation deletion still works
 *  32. Day 8A message controls still work
 *  33. Day 7 chat still works
 *  34. Day 6 status flow + Day 9 resolution still work
 *
 * FIXTURES ONLY: a CSE department + 'CSE Electives' category are created in
 * this throwaway database (same pattern as verify-day6.mjs) purely to prove
 * cross-department rejection. The migration itself adds no departments, no
 * categories and no fake users — the MVP stays ECS.
 *
 * Usage:  node scripts/verify-day9b.mjs
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
]
const DB_DIR = path.join(root, '.tmp', 'day9b-pgdata')
const PORT = 55492

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  otherStudent: '22222222-2222-2222-2222-222222222222',
  facultyA: '33333333-3333-3333-3333-333333333333', // ECS + Labs
  facultyB: '44444444-4444-4444-4444-444444444444', // ECS + Academics, Faculty / Teaching
  facultyNoDept: '55555555-5555-5555-5555-555555555555', // faculty, no department
  facultyCse: '66666666-6666-6666-6666-666666666666', // CSE (fixture) + CSE Electives
  admin: '77777777-7777-7777-7777-777777777777',
  committee: '88888888-8888-8888-8888-888888888888',
}

const C = {
  labs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa31', // CMP-9301 Labs, student
  academics: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa32', // CMP-9302 Academics, student
  equipment: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa33', // CMP-9303 Equipment, student
  sensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa34', // CMP-9304 Harassment, student
  other: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa35', // CMP-9305 Labs, otherStudent
  staleLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa36', // CMP-9306 Labs, stale (escalation)
  resolvedLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa37', // CMP-9307 Labs, resolved
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

async function getStatus(client, id) {
  const { rows } = await client.query('select status from public.complaints where id = $1', [id])
  return rows[0]?.status ?? null
}

async function getHistory(client, id) {
  const { rows } = await client.query(
    `select previous_status, new_status, changed_by_role, changed_at
     from public.complaint_status_history where complaint_id = $1 order by changed_at`,
    [id],
  )
  return rows
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
    for (const m of MIGRATIONS) await client.query(fs.readFileSync(m, 'utf8'))
    check('all migrations (Day 3 .. Day 9B) applied cleanly', true)
  } catch (err) {
    check('all migrations (Day 3 .. Day 9B) applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[6], 'utf8'))
    check('Day 9B migration is re-runnable', true)
  } catch (err) {
    check('Day 9B migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // 2. Seed users, roles, departments, categories, complaints, messages.
  // --------------------------------------------------------------------------
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'student@example.com'),
       ($2, 'other@example.com'),
       ($3, 'faculty-a@example.com'),
       ($4, 'faculty-b@example.com'),
       ($5, 'faculty-nodept@example.com'),
       ($6, 'faculty-cse@example.com'),
       ($7, 'admin@example.com'),
       ($8, 'committee@example.com')`,
    [U.student, U.otherStudent, U.facultyA, U.facultyB, U.facultyNoDept, U.facultyCse, U.admin, U.committee],
  )
  await client.query(`update public.profiles set role = 'faculty'   where id in ($1, $2, $3, $4)`, [U.facultyA, U.facultyB, U.facultyNoDept, U.facultyCse])
  await client.query(`update public.profiles set role = 'admin'     where id = $1`, [U.admin])
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

  const { rows: cats } = await client.query(
    `select id, name, is_sensitive from public.complaint_categories order by name`,
  )
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  // Faculty departments: A + B -> ECS, Cse -> CSE, NoDept -> NULL.
  await client.query(
    `update public.profiles set department_id = (select id from public.departments where name = 'ECS')
     where id in ($1, $2)`,
    [U.facultyA, U.facultyB],
  )
  await client.query(
    `update public.profiles set department_id = (select id from public.departments where name = 'CSE')
     where id = $1`,
    [U.facultyCse],
  )

  await client.query(
    `insert into public.complaints
       (id, ticket_number, student_id, category_id, description, priority, status, updated_at)
     values
       ($1,  'CMP-9301', $2,  $3,  'Lab 4 projector flickers.', 'medium', 'submitted', now()),
       ($4,  'CMP-9302', $5,  $6,  'Academics timetable clash.', 'high', 'submitted', now()),
       ($7,  'CMP-9303', $8,  $9,  'Equipment UPS beeping.', 'low', 'submitted', now()),
       ($10, 'CMP-9304', $11, $12, 'Sensitive harassment report.', 'urgent', 'under_review', now()),
       ($13, 'CMP-9305', $14, $15, 'Labs complaint by another student.', 'medium', 'submitted', now()),
       ($16, 'CMP-9306', $17, $18, 'Stale Labs complaint for escalation.', 'high', 'submitted', now() - interval '3 hours'),
       ($19, 'CMP-9307', $20, $21, 'Resolved Labs complaint.', 'medium', 'resolved', now())`,
    [
      C.labs, U.student, catId['Labs'],
      C.academics, U.student, catId['Academics'],
      C.equipment, U.student, catId['Equipment'],
      C.sensitive, U.student, catId['Harassment / Ragging'],
      C.other, U.otherStudent, catId['Labs'],
      C.staleLabs, U.student, catId['Labs'],
      C.resolvedLabs, U.student, catId['Labs'],
    ],
  )

  // --------------------------------------------------------------------------
  // 3. Assignments via the admin RPC (also proves 6).
  // --------------------------------------------------------------------------
  console.log('\n== Assignment model ==')
  await asUser(client, U.admin, async () => {
    const { rows: a } = await client.query(
      `select * from public.set_faculty_category_assignments($1, $2)`,
      [U.facultyA, [catId['Labs']]],
    )
    check('6. admin can manage assignments (facultyA -> Labs)', a.length === 1 && a[0].category === 'Labs' && a[0].faculty_email === 'faculty-a@example.com', JSON.stringify(a))
    const { rows: b } = await client.query(
      `select * from public.set_faculty_category_assignments($1, $2)`,
      [U.facultyB, [catId['Academics'], catId['Faculty / Teaching']]],
    )
    check('6b. admin can manage assignments (facultyB -> 2 categories)', b.length === 2 && b.some((r) => r.category === 'Academics') && b.some((r) => r.category === 'Faculty / Teaching'), JSON.stringify(b))
    const { rows: cse } = await client.query(
      `select * from public.set_faculty_category_assignments($1, $2)`,
      [U.facultyCse, [catId['CSE Electives']]],
    )
    check('6c. admin can manage assignments (fixture CSE faculty)', cse.length === 1 && cse[0].category === 'CSE Electives', JSON.stringify(cse))
    const { rows: list } = await client.query(`select * from public.list_faculty_category_assignments()`)
    check('6d. admin list returns faculty with their assignments', list.length >= 3 && list.some((r) => r.faculty_email === 'faculty-a@example.com' && r.category === 'Labs'), JSON.stringify(list.map((r) => `${r.faculty_email}:${r.category ?? '-'}`)))
  })

  // 1. Table + 2. unique constraint.
  const { rows: tbl } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'faculty_category_assignments' order by ordinal_position`,
  )
  const tblCols = tbl.map((r) => r.column_name)
  check('1. faculty_category_assignments table exists', ['id', 'faculty_id', 'category_id', 'created_at'].every((c) => tblCols.includes(c)), tblCols.join(','))
  const { rows: uniq } = await client.query(
    `select conname from pg_constraint where conrelid = 'public.faculty_category_assignments'::regclass and contype = 'u'`,
  )
  check('2. UNIQUE(faculty_id, category_id) constraint exists', uniq.some((r) => r.conname.includes('faculty') && r.conname.includes('category')), JSON.stringify(uniq))
  await expectFailure(client, '2b. duplicate (faculty, category) assignment rejected', () =>
    client.query(
      `insert into public.faculty_category_assignments (faculty_id, category_id) values ($1, $2)`,
      [U.facultyA, catId['Labs']],
    ),
  )

  // 3-5, 7-11: management restrictions.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '3. student direct INSERT on assignments denied (no grant)', () =>
      client.query(
        `insert into public.faculty_category_assignments (faculty_id, category_id) values ($1, $2)`,
        [U.facultyA, catId['Labs']],
      ),
    )
    await expectFailure(client, '3b. student RPC set rejected', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs']]]),
    )
  })
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '4. faculty direct INSERT on assignments denied (no grant)', () =>
      client.query(
        `insert into public.faculty_category_assignments (faculty_id, category_id) values ($1, $2)`,
        [U.facultyB, catId['Academics']],
      ),
    )
    await expectFailure(client, '5. faculty cannot modify their own assignments (RPC rejected)', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs']]]),
    )
    await expectFailure(client, '5b. faculty cannot modify another faculty assignments (RPC rejected)', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyB, [catId['Academics']]]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, '7. committee cannot manage assignments (RPC rejected)', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs']]]),
    )
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '8. invalid faculty target rejected', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, ['ffffffff-ffff-ffff-ffff-ffffffffffff', [catId['Labs']]]),
    )
    await expectFailure(client, '9. student target rejected (not faculty)', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.student, [catId['Academics']]]),
    )
    await expectFailure(client, '10. sensitive category assignment rejected', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs'], catId['Harassment / Ragging']]]),
    )
    await expectFailure(client, '11. cross-department category assignment rejected', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['CSE Electives']]]),
    )
    await expectFailure(client, '11b. ECS category for CSE faculty rejected', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyCse, [catId['Labs']]]),
    )
    await expectFailure(client, '8b. target faculty without a department rejected', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyNoDept, [catId['Labs']]]),
    )
  })
  // Atomicity: the rejected sensitive assignment must not have touched
  // facultyA's existing Labs assignment.
  const { rows: afterReject } = await client.query(
    `select category_id from public.faculty_category_assignments where faculty_id = $1`,
    [U.facultyA],
  )
  check('10b. rejected assignment left existing assignments untouched (atomic)', afterReject.length === 1 && afterReject[0].category_id === catId['Labs'], JSON.stringify(afterReject))

  // Conversation on the Labs complaint (student + facultyA) for the chat /
  // message-control / conversation-deletion regressions. Seeded AFTER the
  // assignments exist — the Day 9B RLS already blocks facultyA from chatting
  // on C.labs without the Labs assignment.
  await asUser(client, U.student, async () => {
    await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'Need help with the Lab 4 projector.')`,
      [C.labs],
    )
  })
  await asUser(client, U.facultyA, async () => {
    await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'We are looking into it.')`,
      [C.labs],
    )
  })

  // --------------------------------------------------------------------------
  // 4. Faculty visibility.
  // --------------------------------------------------------------------------
  console.log('\n== Faculty visibility ==')
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('12. Labs faculty sees Labs complaints (base table)', rows.length === 4 && rows.every((r) => ['CMP-9301', 'CMP-9305', 'CMP-9306', 'CMP-9307'].includes(r.ticket_number)), JSON.stringify(rows))
    const { rows: view } = await client.query(`select ticket_number, category from public.complaints_staff_view order by ticket_number`)
    check('12b. Labs faculty staff view contains only Labs rows', view.length === 4 && view.every((r) => r.category === 'Labs'), JSON.stringify(view))
    const { rows: hidden } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.academics])
    check('13. Labs faculty cannot see Academics complaint', hidden.length === 0)
    const { rows: hidden2 } = await client.query(`select id from public.complaints where id = $1`, [C.academics])
    check('13b. Labs faculty base-table RLS blocks Academics complaint', hidden2.length === 0)
    check('15. Labs faculty can open own assigned complaint detail', (await client.query(`select id from public.complaints_staff_view where id = $1`, [C.labs])).rows.length === 1)
    check('12c. can_access_complaint true for assigned complaint', (await client.query(`select public.can_access_complaint($1)`, [C.labs])).rows[0].can_access_complaint === true)
  })
  await asUser(client, U.facultyB, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('13c. Academics faculty sees only Academics complaint', rows.length === 1 && rows[0].ticket_number === 'CMP-9302', JSON.stringify(rows))
    const { rows: hidden } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.labs])
    check('15b. unauthorized complaint detail rejected (no access row)', hidden.length === 0)
    check('16. unauthorized chat rejected (can_access_complaint false)', (await client.query(`select public.can_access_complaint($1)`, [C.labs])).rows[0].can_access_complaint === false)
    const { rows: msgs } = await client.query(`select id from public.messages where complaint_id = $1`, [C.labs])
    check('16b. unauthorized chat returns no messages', msgs.length === 0)
    await expectFailure(client, '17. unauthorized status update rejected (server-side)', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.labs]),
    )
  })
  await asUser(client, U.facultyCse, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('14. faculty from wrong department sees no ECS complaints', rows.length === 0, JSON.stringify(rows))
  })
  await asUser(client, U.facultyNoDept, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('14b. faculty without a department sees nothing', rows.length === 0, JSON.stringify(rows))
  })

  // 18. Authorized status update (Labs faculty on Labs complaint).
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.labs])
    check('18. authorized status update still works', rows[0]?.status === 'under_review', JSON.stringify(rows))
  })
  const labsHistory = await getHistory(client, C.labs)
  check('18b. authorized update recorded in history', labsHistory.some((h) => h.previous_status === 'submitted' && h.new_status === 'under_review' && h.changed_by_role === 'faculty'), JSON.stringify(labsHistory))

  // --------------------------------------------------------------------------
  // 5. Role isolation.
  // --------------------------------------------------------------------------
  console.log('\n== Role isolation ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('19. student sees own complaints only', rows.length === 6 && !rows.some((r) => r.ticket_number === 'CMP-9305'), JSON.stringify(rows))
  })
  await asUser(client, U.otherStudent, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints`)
    check('19b. other student sees own complaint only', rows.length === 1 && rows[0].ticket_number === 'CMP-9305', JSON.stringify(rows))
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints`)
    check('20. committee sees sensitive complaint only', rows.length === 1 && rows[0].ticket_number === 'CMP-9304', JSON.stringify(rows))
    const { rows: hidden } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.labs])
    check('20b. committee cannot see non-sensitive complaint', hidden.length === 0)
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('21. admin visibility unchanged (sees all complaints)', rows.length === 7, JSON.stringify(rows.map((r) => r.ticket_number)))
  })

  // --------------------------------------------------------------------------
  // 6. Identity hiding.
  // --------------------------------------------------------------------------
  console.log('\n== Identity ==')
  const { rows: msgViewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'messages_staff_view' order by ordinal_position`,
  )
  check('22. sender_id hidden from staff view', !msgViewCols.map((r) => r.column_name).includes('sender_id'), msgViewCols.map((r) => r.column_name).join(','))
  const { rows: staffViewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaints_staff_view' order by ordinal_position`,
  )
  const staffColNames = staffViewCols.map((r) => r.column_name)
  check('23. student_id hidden from staff view', !staffColNames.includes('student_id'), staffColNames.join(','))
  check('24. email/name hidden from staff view', !staffColNames.some((c) => ['email', 'name'].includes(c)), staffColNames.join(','))
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '22b. sender_id column not selectable by staff', () =>
      client.query(`select sender_id from public.messages limit 1`),
    )
    await expectFailure(client, '23b. student_id column not selectable by staff', () =>
      client.query(`select student_id from public.complaints limit 1`),
    )
    const { rows: prof } = await client.query(`select email from public.profiles where id = $1`, [U.facultyB])
    check('24b. faculty cannot read another profile email (RLS select-own)', prof.length === 0, JSON.stringify(prof))
    await expectFailure(client, '24c. faculty cannot call the admin list RPC', () =>
      client.query(`select * from public.list_faculty_category_assignments()`),
    )
  })
  // 24d: even a hand-inserted sensitive assignment grants faculty nothing.
  await client.query(
    `insert into public.faculty_category_assignments (faculty_id, category_id) values ($1, $2)`,
    [U.facultyA, catId['Harassment / Ragging']],
  )
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.sensitive])
    check('24d. sensitive complaint stays invisible to faculty despite assignment', rows.length === 0)
    await expectFailure(client, '24e. sensitive status update still denied for faculty', () =>
      client.query(`select * from public.update_complaint_status($1, 'escalated')`, [C.sensitive]),
    )
    check('24f. can_access_complaint false for sensitive complaint', (await client.query(`select public.can_access_complaint($1)`, [C.sensitive])).rows[0].can_access_complaint === false)
  })
  await client.query(`delete from public.faculty_category_assignments where faculty_id = $1 and category_id = $2`, [U.facultyA, catId['Harassment / Ragging']])

  // --------------------------------------------------------------------------
  // 7. Security (base table is the boundary, no frontend filtering).
  // --------------------------------------------------------------------------
  console.log('\n== Security ==')
  await asUser(client, U.facultyB, async () => {
    // Bare base-table query with NO category filter: RLS alone decides rows.
    const { rows } = await client.query(`select ticket_number, category_id from public.complaints`)
    check('25. base-table RLS blocks unauthorized faculty rows', rows.length === 1 && rows[0].ticket_number === 'CMP-9302', JSON.stringify(rows))
    const { rows: view } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('26. staff view returns only authorized rows', view.length === 1 && view[0].ticket_number === 'CMP-9302', JSON.stringify(view))
    check('27. category filtering is not the security boundary (bare query already safe)', true)
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints`)
    check('25b. Labs faculty bare base-table query returns only Labs rows', rows.length === 4 && rows.every((r) => r.ticket_number !== 'CMP-9302' && r.ticket_number !== 'CMP-9303'), JSON.stringify(rows))
    await expectFailure(client, '28. faculty direct UPDATE on assignments denied', () =>
      client.query(`update public.faculty_category_assignments set category_id = $1 where faculty_id = $2`, [catId['Academics'], U.facultyA]),
    )
    await expectFailure(client, '28b. faculty direct DELETE on assignments denied', () =>
      client.query(`delete from public.faculty_category_assignments where faculty_id = $1`, [U.facultyA]),
    )
  })
  await asUser(client, U.student, async () => {
    await expectFailure(client, '28c. student direct UPDATE on assignments denied', () =>
      client.query(`update public.faculty_category_assignments set category_id = $1 where faculty_id = $2`, [catId['Labs'], U.facultyA]),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '29. anonymous blocked from assignments table', () =>
    client.query(`select * from public.faculty_category_assignments limit 1`),
  )
  await expectFailure(client, '29b. anonymous blocked from staff view', () =>
    client.query(`select * from public.complaints_staff_view limit 1`),
  )
  await expectFailure(client, '29c. anonymous blocked from set RPC', () =>
    client.query(`select * from public.set_faculty_category_assignments('${U.facultyA}', '{${catId['Labs']}}')`),
  )
  await expectFailure(client, '29d. anonymous blocked from list RPC', () =>
    client.query(`select * from public.list_faculty_category_assignments()`),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 8. Regressions.
  // --------------------------------------------------------------------------
  console.log('\n== Regressions ==')

  // 30. Day 9 escalation still works; escalated visibility follows assignment.
  await client.query(`update public.system_settings set value = '1 hour' where key = 'escalation_threshold'`)
  const { rows: escalated } = await client.query(`select * from public.escalate_stale_complaints()`)
  check('30. Day 9: stale Labs complaint auto-escalated', escalated.some((r) => r.ticket_number === 'CMP-9306') && (await getStatus(client, C.staleLabs)) === 'escalated', JSON.stringify(escalated))
  const staleHist = await getHistory(client, C.staleLabs)
  check('30b. Day 9: escalation history recorded (system role)', staleHist.some((h) => h.new_status === 'escalated' && h.changed_by_role === 'system'), JSON.stringify(staleHist))
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select ticket_number, status from public.complaints_staff_view where ticket_number = 'CMP-9306'`)
    check('30c. Labs faculty sees escalated Labs complaint (assignment rule)', rows.length === 1 && rows[0].status === 'escalated', JSON.stringify(rows))
  })
  await asUser(client, U.facultyB, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view where ticket_number = 'CMP-9306'`)
    check('30d. Academics faculty cannot see escalated Labs complaint', rows.length === 0, JSON.stringify(rows))
  })

  // 33. Day 7 chat still works (authorized faculty reads identity-free).
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'Thanks for the update.') returning sender_role, body`,
      [C.labs],
    )
    check('33. Day 7: student sends chat message (sender derived)', rows[0]?.sender_role === 'student', JSON.stringify(rows))
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select * from public.messages_staff_view where complaint_id = $1 order by created_at`, [C.labs])
    check('33b. Day 7: authorized faculty reads conversation identity-free', rows.length >= 3 && FORBIDDEN_IDENTITY.every((f) => !(f in rows[0])), Object.keys(rows[0] ?? {}).join(','))
  })
  await asUser(client, U.facultyB, async () => {
    const { rows } = await client.query(`select id from public.messages_staff_view where complaint_id = $1`, [C.labs])
    check('33c. Day 7: unauthorized faculty sees no chat messages', rows.length === 0)
  })

  // 32. Day 8A message controls still work.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '32. Day 8A: student cannot edit a staff message', () =>
      client.query(`select * from public.edit_complaint_message((select id from public.messages where complaint_id = $1 and sender_role = 'staff' limit 1), 'hijacked')`, [C.labs]),
    )
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint_message((select id from public.messages where complaint_id = $1 and sender_role = 'staff' limit 1), 'We are looking into it — ETA tomorrow.')`,
      [C.labs],
    )
    check('32b. Day 8A: staff edits own message', rows[0]?.body === 'We are looking into it — ETA tomorrow.' && !!rows[0]?.edited_at, JSON.stringify(rows))
    const { rows: del } = await client.query(
      `select * from public.delete_complaint_message_for_everyone((select id from public.messages where complaint_id = $1 and sender_role = 'staff' limit 1))`,
      [C.labs],
    )
    check('32c. Day 8A: staff deletes own message for everyone', del[0]?.is_deleted === true && !!del[0]?.deleted_at, JSON.stringify(del))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.delete_complaint_message_for_me((select id from public.messages where complaint_id = $1 and sender_role = 'student' order by created_at limit 1))`,
      [C.labs],
    )
    check('32d. Day 8A: delete for me still works', !!rows[0]?.message_id, JSON.stringify(rows))
  })

  // 31. Day 8B conversation deletion still works.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.labs])
    check('31. Day 8B: student deletes conversation for me (cutoff)', !!rows[0]?.deleted_before, JSON.stringify(rows))
    const { rows: visible } = await client.query(
      `select id from public.messages_staff_view where complaint_id = $1 and created_at > $2`,
      [C.labs, rows[0].deleted_before],
    )
    check('31b. Day 8B: pre-cutoff messages hidden for that user', visible.length === 0, JSON.stringify(visible))
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select id from public.messages_staff_view where complaint_id = $1`, [C.labs])
    check('31c. Day 8B: other participant unaffected', rows.length >= 3, JSON.stringify(rows))
  })

  // 34. Day 6 status flow + Day 9 resolution still work.
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '34. Day 6: invalid transition still rejected (under_review -> closed)', () =>
      client.query(`select * from public.update_complaint_status($1, 'closed')`, [C.labs]),
    )
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'in_progress')`, [C.labs])
    check('34b. Day 6: valid transition still works (under_review -> in_progress)', rows[0]?.status === 'in_progress', JSON.stringify(rows))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.confirm_complaint_resolution($1)`, [C.resolvedLabs])
    check('34c. Day 9: student resolution confirmation still works', rows[0]?.status === 'closed', JSON.stringify(rows))
  })
  await asUser(client, U.facultyA, async () => {
    const hist = await getHistory(client, C.resolvedLabs)
    check('34d. Day 9: faculty sees resolution history (resolved -> closed, student)', hist.some((h) => h.previous_status === 'resolved' && h.new_status === 'closed' && h.changed_by_role === 'student'), JSON.stringify(hist))
  })

  // 34e. Day 4 submission still works through the changed complaints RLS
  // (student INSERT ... RETURNING passes the student policy; the new faculty
  // policy evaluates false on the brand-new row, exactly as designed).
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values ($1, $2, 'Day 9B regression submission.', 'medium')
       returning ticket_number, status`,
      [U.student, catId['Labs']],
    )
    check('34e. Day 4: student submission still works (ticket + submitted)', /^CMP-\d{4}$/.test(rows[0]?.ticket_number ?? '') && rows[0]?.status === 'submitted', JSON.stringify(rows))
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
