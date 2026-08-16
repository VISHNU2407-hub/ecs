/**
 * Day 10A local verification harness — Complaint Edit & Delete.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` schema,
 * applies ALL migrations (Day 3 + 6 + 7 + 8A + 8B + 9 + 9B + 10A), and
 * exercises the complaint-level edit/delete security model the frontend
 * relies on (src/lib/complaintService.js + StudentComplaintDetailPage +
 * StudentPage/StaffPage, which need NO frontend security changes because the
 * database enforces everything):
 *
 * EDIT (1-19)
 *   1.  complaints gained title / deleted_at / deleted_by_role columns
 *   2.  title selectable by authenticated; deleted_at / deleted_by_role NOT
 *   3.  student edits OWN submitted complaint -> allowed (safe fields only)
 *   4.  only editable columns changed (title/description/category/priority)
 *   5.  student_id / ticket_number / department_id / status / sensitivity /
 *       handler_type never change through the edit path
 *   6.  updated_at is refreshed by the edit
 *   7.  empty title rejected
 *   8.  oversized title rejected
 *   9.  short description rejected
 *  10.  oversized description rejected
 *  11.  invalid priority rejected (enum)
 *  12.  invalid category rejected
 *  13.  category from another department rejected
 *  14.  sensitive category rejected for a non-sensitive complaint
 *  15.  sensitivity cannot be flipped (sensitive -> non-sensitive rejected)
 *  16.  sensitive complaint can still be edited (title/description/priority)
 *  17.  student editing another student's complaint rejected
 *  18.  resolved / closed / under_review complaints rejected
 *  19.  faculty / committee / admin / anon edit RPC rejected
 *
 * DELETE (20-33)
 *  20.  student deletes OWN submitted complaint -> allowed (soft delete)
 *  21.  deleted_at set + deleted_by_role = 'student' (audit only)
 *  22.  deleting another student's complaint rejected
 *  23.  resolved / closed / under_review complaints rejected
 *  24.  already-deleted complaint rejected ("not found")
 *  25.  faculty / committee / admin / anon delete RPC rejected
 *  26.  direct UPDATE bypass rejected (no UPDATE grant)
 *  27.  direct DELETE bypass rejected (no DELETE grant)
 *  28.  edit RPC on a deleted complaint rejected
 *  29.  status-update RPC on a deleted complaint rejected
 *  30.  resolution/reopen RPCs on a deleted complaint rejected
 *  31.  automatic escalation skips deleted complaints
 *
 * VISIBILITY AFTER DELETE (32-42)
 *  32.  student base-table read returns nothing (dashboard/detail/direct URL)
 *  33.  staff view read returns nothing
 *  34.  admin/committee/faculty read paths return nothing
 *  35.  can_access_complaint() false (chat + history blocked)
 *  36.  chat messages hidden for every role
 *  37.  messages / history rows are NOT physically deleted
 *  38.  staff view exposes no deleted_at / deleted_by_role (no leak)
 *  39.  faculty visibility still assignment-based after an edit (routing)
 *  40.  changing Labs -> Academics updates routing (facultyB sees, facultyA not)
 *  41.  department_id stays ECS after the category change (no student-chosen dept)
 *  42.  escalated/committee/admin visibility regressions for live complaints
 *
 * IDENTITY (43-46)
 *  43.  sender_id stays hidden
 *  44.  student_id stays hidden
 *  45.  email/name stay hidden; profiles select-own holds
 *  46.  edit RPC response contains no student_id / deleted_at / deleted_by_role
 *
 * REGRESSIONS (47-70)
 *  47.  Day 4 submission still works (title NULL ok, ticket generated)
 *  48.  Day 5 student isolation unchanged
 *  49.  Day 5 staff view identity-free + role visibility unchanged
 *  50.  Day 6 status flow + history (role-anonymous) unchanged
 *  51.  Day 6 invalid transitions still rejected
 *  52.  Day 7 chat send + read unchanged (identity-free)
 *  53.  Day 8A message edit/delete ownership unchanged
 *  54.  Day 8B conversation deletion unchanged
 *  55.  Day 9 resolution confirmation + reopen unchanged
 *  56.  Day 9 automatic escalation still works (live complaint)
 *  57.  Day 9B faculty assignment RPCs + faculty isolation unchanged
 *  58.  anon blocked from every read path
 *  59.  Realtime preconditions (publication membership) hold
 *
 * FIXTURES ONLY: a CSE department + 'CSE Electives' category are created in
 * this throwaway database (same pattern as verify-day9b.mjs) purely to prove
 * cross-department rejection. The migration itself adds no departments, no
 * categories and no fake users — the MVP stays ECS.
 *
 * Usage:  node scripts/verify-day10a.mjs
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
]
const DB_DIR = path.join(root, '.tmp', 'day10a-pgdata')
const PORT = 55493

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
  editLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', // CMP-1011 Labs, student, submitted (edited)
  otherLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', // CMP-1012 Labs, otherStudent, submitted
  resolved: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa13', // CMP-1013 Labs, student, resolved
  closed: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa14', // CMP-1014 Labs, student, closed
  deleteLabs: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa15', // CMP-1015 Labs, student, submitted (deleted)
  sensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa16', // CMP-1016 Harassment, student, submitted
  underReview: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa17', // CMP-1017 Labs, student, under_review
  stale: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa18', // CMP-1018 Labs, student, submitted, stale (escalation)
  academics: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa19', // CMP-1019 Academics, student, submitted
  chat: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa20', // CMP-1020 Labs, student, submitted (chat regressions)
  historyFlow: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa21', // CMP-1021 Labs, student, submitted (status flow)
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

async function getRow(client, id) {
  const { rows } = await client.query('select * from public.complaints where id = $1', [id])
  return rows[0] ?? null
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
  // Stub the Supabase auth schema + roles (+ the realtime publication so the
  // guarded publication-add blocks in Day 7 / Day 9 actually run).
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
  `)

  // --------------------------------------------------------------------------
  // 1. Migrations.
  // --------------------------------------------------------------------------
  console.log('\n== 1. Migrations ==')
  try {
    for (const m of MIGRATIONS) await client.query(fs.readFileSync(m, 'utf8'))
    check('all migrations (Day 3 .. Day 10A) applied cleanly', true)
  } catch (err) {
    check('all migrations (Day 3 .. Day 10A) applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[7], 'utf8'))
    check('Day 10A migration is re-runnable', true)
  } catch (err) {
    check('Day 10A migration is re-runnable', false, String(err?.message ?? err))
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

  // Fixture department + category (throwaway DB only).
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
    `update public.profiles set department_id = (select id from public.departments where name = 'ECS')
     where id in ($1, $2)`,
    [U.facultyA, U.facultyB],
  )
  await client.query(
    `update public.profiles set department_id = (select id from public.departments where name = 'CSE')
     where id = $1`,
    [U.facultyCse],
  )

  const ecsDept = (await client.query(`select id from public.departments where name = 'ECS'`)).rows[0].id

  await client.query(
    `insert into public.complaints
       (id, ticket_number, student_id, category_id, description, priority, status, updated_at)
     values
       ($1,  'CMP-1011', $2,  $3,  'Lab 4 projector flickers constantly.', 'medium', 'submitted', now()),
       ($4,  'CMP-1012', $5,  $6,  'Labs complaint owned by another student.', 'medium', 'submitted', now()),
       ($7,  'CMP-1013', $8,  $9,  'Resolved Labs complaint.', 'medium', 'resolved', now()),
       ($10, 'CMP-1014', $11, $12, 'Closed Labs complaint.', 'low', 'closed', now()),
       ($13, 'CMP-1015', $14, $15, 'Labs complaint to be soft-deleted.', 'high', 'submitted', now()),
       ($16, 'CMP-1016', $17, $18, 'Sensitive harassment report.', 'urgent', 'submitted', now()),
       ($19, 'CMP-1017', $20, $21, 'Labs complaint under review.', 'medium', 'under_review', now()),
       ($22, 'CMP-1018', $23, $24, 'Stale Labs complaint for escalation.', 'high', 'submitted', now() - interval '3 hours'),
       ($25, 'CMP-1019', $26, $27, 'Academics timetable clash.', 'high', 'submitted', now()),
       ($28, 'CMP-1020', $29, $30, 'Labs complaint with a conversation.', 'medium', 'submitted', now()),
       ($31, 'CMP-1021', $32, $33, 'Labs complaint for status-flow regression.', 'medium', 'submitted', now())`,
    [
      C.editLabs, U.student, catId['Labs'],
      C.otherLabs, U.otherStudent, catId['Labs'],
      C.resolved, U.student, catId['Labs'],
      C.closed, U.student, catId['Labs'],
      C.deleteLabs, U.student, catId['Labs'],
      C.sensitive, U.student, catId['Harassment / Ragging'],
      C.underReview, U.student, catId['Labs'],
      C.stale, U.student, catId['Labs'],
      C.academics, U.student, catId['Academics'],
      C.chat, U.student, catId['Labs'],
      C.historyFlow, U.student, catId['Labs'],
    ],
  )

  // Assignments via the admin RPC (regression 57 as well).
  await asUser(client, U.admin, async () => {
    await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs']]])
    await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyB, [catId['Academics'], catId['Faculty / Teaching']]])
    await client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyCse, [catId['CSE Electives']]])
  })

  // Conversations for the delete + chat regressions.
  await asUser(client, U.student, async () => {
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'Projector still broken.')`, [C.deleteLabs])
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'Hello, can you help?')`, [C.chat])
  })
  await asUser(client, U.facultyA, async () => {
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'We will check it today.')`, [C.deleteLabs])
    await client.query(`insert into public.messages (complaint_id, body) values ($1, 'We are looking into it.')`, [C.chat])
  })

  // --------------------------------------------------------------------------
  // 3. Columns + grants.
  // --------------------------------------------------------------------------
  console.log('\n== Columns & grants ==')
  const { rows: cols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaints' order by ordinal_position`,
  )
  const colNames = cols.map((r) => r.column_name)
  check('1. complaints has title / deleted_at / deleted_by_role', ['title', 'deleted_at', 'deleted_by_role'].every((c) => colNames.includes(c)), colNames.join(','))
  await asUser(client, U.student, async () => {
    const { rows: t } = await client.query(`select title from public.complaints where id = $1`, [C.editLabs])
    check('2. title selectable by authenticated (owner)', t.length === 1 && t[0].title === null, JSON.stringify(t))
    await expectFailure(client, '2b. deleted_at NOT selectable by authenticated', () =>
      client.query(`select deleted_at from public.complaints where id = $1`, [C.editLabs]),
    )
    await expectFailure(client, '2c. deleted_by_role NOT selectable by authenticated', () =>
      client.query(`select deleted_by_role from public.complaints where id = $1`, [C.editLabs]),
    )
  })
  const { rows: viewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaints_staff_view' order by ordinal_position`,
  )
  const viewColNames = viewCols.map((r) => r.column_name)
  check('38. staff view has title but NO deleted_at / deleted_by_role (no leak)', viewColNames.includes('title') && !viewColNames.includes('deleted_at') && !viewColNames.includes('deleted_by_role'), viewColNames.join(','))

  // --------------------------------------------------------------------------
  // 4. Edit behavior.
  // --------------------------------------------------------------------------
  console.log('\n== Edit ==')
  let editResult = null
  let beforeEdit = await getRow(client, C.editLabs)
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint($1, 'Projector fixed please', 'The Lab 4 projector has been flickering for a week now and it is hard to read.', $2, 'high')`,
      [C.editLabs, catId['Academics']],
    )
    editResult = rows[0]
    check('3. student edits OWN submitted complaint -> allowed (returns safe row)', !!editResult && editResult.ticket_number === 'CMP-1011' && editResult.title === 'Projector fixed please' && editResult.description.startsWith('The Lab 4 projector') && editResult.category_id === catId['Academics'] && editResult.priority === 'high' && editResult.status === 'submitted', JSON.stringify(editResult))
    check('46. edit response contains no student_id / deleted_at / deleted_by_role', !FORBIDDEN_IDENTITY.concat(['deleted_at', 'deleted_by_role']).some((f) => f in (editResult ?? {})), Object.keys(editResult ?? {}).join(','))
  })
  const afterEdit = await getRow(client, C.editLabs)
  check('4. only editable columns changed', afterEdit.title === 'Projector fixed please' && afterEdit.description.startsWith('The Lab 4 projector') && afterEdit.category_id === catId['Academics'] && afterEdit.priority === 'high', JSON.stringify({ title: afterEdit.title, cat: afterEdit.category_id, prio: afterEdit.priority }))
  check('5. protected fields never change (student_id/ticket/department/status/sensitivity/handler)', afterEdit.student_id === beforeEdit.student_id && afterEdit.ticket_number === 'CMP-1011' && afterEdit.department_id === beforeEdit.department_id && afterEdit.department_id === ecsDept && afterEdit.status === 'submitted' && afterEdit.is_sensitive === false && afterEdit.handler_type === 'department', JSON.stringify({ student_id: afterEdit.student_id, dept: afterEdit.department_id, status: afterEdit.status, sensitive: afterEdit.is_sensitive, handler: afterEdit.handler_type }))
  check('6. updated_at refreshed by edit', new Date(afterEdit.updated_at).getTime() >= new Date(beforeEdit.updated_at).getTime(), `${afterEdit.updated_at} >= ${beforeEdit.updated_at}`)
  check('41. department_id stays ECS after category change (no student-chosen department)', afterEdit.department_id === ecsDept)

  // Input validation.
  await asUser(client, U.student, async () => {
    const longDesc = 'x'.repeat(10001)
    await expectFailure(client, '7. empty title rejected', () =>
      client.query(`select * from public.edit_complaint($1, '   ', 'A valid description long enough to pass.', $2, 'medium')`, [C.editLabs, catId['Academics']]),
    )
    await expectFailure(client, '8. oversized title rejected', () =>
      client.query(`select * from public.edit_complaint($1, $2, 'A valid description long enough to pass.', $3, 'medium')`, [C.editLabs, 'x'.repeat(201), catId['Academics']]),
    )
    await expectFailure(client, '9. short description rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'Too short.', $2, 'medium')`, [C.editLabs, catId['Academics']]),
    )
    await expectFailure(client, '10. oversized description rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', $2, $3, 'medium')`, [C.editLabs, longDesc, catId['Academics']]),
    )
    await expectFailure(client, '11. invalid priority rejected (enum)', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'bogus')`, [C.editLabs, catId['Academics']]),
    )
    await expectFailure(client, '12. invalid category rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'medium')`, [C.editLabs]),
    )
    await expectFailure(client, '13. category from another department rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.editLabs, catId['CSE Electives']]),
    )
    await expectFailure(client, '14. sensitive category rejected for non-sensitive complaint', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.editLabs, catId['Harassment / Ragging']]),
    )
    // ownership + status gating
    await expectFailure(client, '17. student editing another student complaint rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Hijack', 'A valid description long enough to pass.', $2, 'medium')`, [C.otherLabs, catId['Labs']]),
    )
    await expectFailure(client, '18a. resolved complaint edit rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.resolved, catId['Labs']]),
    )
    await expectFailure(client, '18b. closed complaint edit rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.closed, catId['Labs']]),
    )
    await expectFailure(client, '18c. under_review complaint edit rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.underReview, catId['Labs']]),
    )
  })

  // Sensitive complaint: title/description/priority editable; category cannot
  // be flipped to non-sensitive.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint($1, 'Sensitive follow-up', 'Updating the sensitive complaint details while it stays committee-handled.', $2, 'urgent')`,
      [C.sensitive, catId['Harassment / Ragging']],
    )
    check('16. sensitive complaint editable (title/description/priority, same sensitive category)', rows[0]?.title === 'Sensitive follow-up' && rows[0]?.is_sensitive === true && rows[0]?.handler_type === 'committee' && rows[0]?.status === 'submitted', JSON.stringify(rows[0]))
    await expectFailure(client, '15. sensitivity cannot be flipped (sensitive -> non-sensitive)', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.sensitive, catId['Labs']]),
    )
  })

  // Non-student roles cannot use the edit RPC.
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '19a. faculty edit RPC rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.editLabs, catId['Academics']]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, '19b. committee edit RPC rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.sensitive, catId['Harassment / Ragging']]),
    )
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '19c. admin edit RPC rejected (student-only RPC)', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.editLabs, catId['Academics']]),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '19d. anonymous edit RPC rejected', () =>
    client.query(`select * from public.edit_complaint('${C.editLabs}', 'Title ok', 'A valid description long enough to pass.', '${catId['Academics']}', 'medium')`),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 5. Routing after edit (faculty visibility follows the new category).
  // --------------------------------------------------------------------------
  console.log('\n== Category routing ==')
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view where id = $1`, [C.editLabs])
    check('39. Labs faculty lost visibility after edit to Academics (assignment-based)', rows.length === 0, JSON.stringify(rows))
  })
  await asUser(client, U.facultyB, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view where id = $1`, [C.editLabs])
    check('40. Academics faculty gained visibility after edit to Academics', rows.length === 1 && rows[0].ticket_number === 'CMP-1011', JSON.stringify(rows))
    check('40b. can_access_complaint true for the re-routed complaint', (await client.query(`select public.can_access_complaint($1)`, [C.editLabs])).rows[0].can_access_complaint === true)
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('42a. Labs faculty still sees ONLY assigned-category complaints', rows.length === 8 && rows.every((r) => r.ticket_number !== 'CMP-1011' && r.ticket_number !== 'CMP-1019'), JSON.stringify(rows.map((r) => r.ticket_number)))
  })

  // --------------------------------------------------------------------------
  // 6. Delete behavior.
  // --------------------------------------------------------------------------
  console.log('\n== Delete ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint($1)`, [C.deleteLabs])
    check('20. student deletes OWN submitted complaint -> allowed (soft delete)', rows[0]?.ticket_number === 'CMP-1015' && rows[0]?.status === 'submitted' && !!rows[0]?.deleted_at, JSON.stringify(rows[0]))
  })
  const deletedRow = await getRow(client, C.deleteLabs)
  check('21. deleted_at set + deleted_by_role = student (audit only)', !!deletedRow.deleted_at && deletedRow.deleted_by_role === 'student', JSON.stringify({ deleted_at: deletedRow.deleted_at, deleted_by_role: deletedRow.deleted_by_role }))
  check('21b. soft delete never removes the row', deletedRow.id === C.deleteLabs)

  await asUser(client, U.student, async () => {
    await expectFailure(client, '22. deleting another student complaint rejected', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.otherLabs]),
    )
    await expectFailure(client, '23a. resolved complaint delete rejected', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.resolved]),
    )
    await expectFailure(client, '23b. closed complaint delete rejected', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.closed]),
    )
    await expectFailure(client, '23c. under_review complaint delete rejected', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.underReview]),
    )
    await expectFailure(client, '24. already-deleted complaint delete rejected ("not found")', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.deleteLabs]),
    )
  })
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '25a. faculty delete RPC rejected', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.chat]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, '25b. committee delete RPC rejected', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.sensitive]),
    )
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '25c. admin delete RPC rejected (student-only RPC)', () =>
      client.query(`select * from public.delete_complaint($1)`, [C.chat]),
    )
  })
  await client.query('set role anon')
  await expectFailure(client, '25d. anonymous delete RPC rejected', () =>
    client.query(`select * from public.delete_complaint('${C.chat}')`),
  )
  await client.query('reset role')

  // Direct bypass attempts.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '26. direct UPDATE bypass rejected (no UPDATE grant)', () =>
      client.query(`update public.complaints set description = 'hacked' where id = $1`, [C.chat]),
    )
    await expectFailure(client, '26b. direct UPDATE of protected column rejected', () =>
      client.query(`update public.complaints set status = 'closed' where id = $1`, [C.chat]),
    )
    await expectFailure(client, '27. direct DELETE bypass rejected (no DELETE grant)', () =>
      client.query(`delete from public.complaints where id = $1`, [C.chat]),
    )
    // Deleted complaint is invisible to the RPCs too.
    await expectFailure(client, '28. edit RPC on a deleted complaint rejected', () =>
      client.query(`select * from public.edit_complaint($1, 'Title ok', 'A valid description long enough to pass.', $2, 'medium')`, [C.deleteLabs, catId['Labs']]),
    )
  })
  await asUser(client, U.facultyA, async () => {
    await expectFailure(client, '29. status-update RPC on a deleted complaint rejected', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.deleteLabs]),
    )
  })
  await asUser(client, U.student, async () => {
    await expectFailure(client, '30a. confirm-resolution RPC on a deleted complaint rejected', () =>
      client.query(`select * from public.confirm_complaint_resolution($1)`, [C.deleteLabs]),
    )
    await expectFailure(client, '30b. reopen RPC on a deleted complaint rejected', () =>
      client.query(`select * from public.reopen_complaint($1)`, [C.deleteLabs]),
    )
  })

  // Automatic escalation skips deleted complaints (make it stale first).
  await client.query(`update public.complaints set updated_at = now() - interval '3 hours' where id = $1`, [C.deleteLabs])
  await client.query(`update public.system_settings set value = '1 hour' where key = 'escalation_threshold'`)
  const { rows: escalated } = await client.query(`select * from public.escalate_stale_complaints()`)
  check('56. Day 9: stale live complaint still escalated (regression)', escalated.some((r) => r.ticket_number === 'CMP-1018') && (await getStatus(client, C.stale)) === 'escalated', JSON.stringify(escalated.map((r) => r.ticket_number)))
  check('31. automatic escalation skips deleted complaints', !escalated.some((r) => r.ticket_number === 'CMP-1015') && (await getStatus(client, C.deleteLabs)) === 'submitted', JSON.stringify(escalated.map((r) => r.ticket_number)))

  // --------------------------------------------------------------------------
  // 7. Visibility after delete.
  // --------------------------------------------------------------------------
  console.log('\n== Visibility after delete ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select id, ticket_number from public.complaints where id = $1`, [C.deleteLabs])
    check('32. deleted complaint invisible on student read paths (dashboard/detail/direct URL)', rows.length === 0, JSON.stringify(rows))
    const { rows: msgs } = await client.query(`select id from public.messages where complaint_id = $1`, [C.deleteLabs])
    check('36. chat messages hidden for the owning student after delete', msgs.length === 0)
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.deleteLabs])
    check('33. deleted complaint invisible on staff view', rows.length === 0)
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select id from public.complaints where id = $1`, [C.deleteLabs])
    check('34a. deleted complaint invisible to admin (base table)', rows.length === 0)
    const { rows: view } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.deleteLabs])
    check('34b. deleted complaint invisible to admin (staff view)', view.length === 0)
  })
  await asUser(client, U.committee, async () => {
    check('35a. can_access_complaint false for deleted complaint (any role)', (await client.query(`select public.can_access_complaint($1)`, [C.deleteLabs])).rows[0].can_access_complaint === false)
    const { rows: hist } = await client.query(`select id from public.complaint_status_history where complaint_id = $1`, [C.deleteLabs])
    check('35b. status history hidden for deleted complaint', hist.length === 0)
  })
  // Messages + history rows still physically exist (audit preserved).
  const { rows: rawMsgs } = await client.query(`select count(*)::int as n from public.messages where complaint_id = $1`, [C.deleteLabs])
  check('37. messages NOT physically deleted (2 rows still exist)', rawMsgs[0].n === 2, JSON.stringify(rawMsgs))

  // --------------------------------------------------------------------------
  // 8. Identity.
  // --------------------------------------------------------------------------
  console.log('\n== Identity ==')
  const { rows: msgViewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'messages_staff_view' order by ordinal_position`,
  )
  check('43. sender_id hidden from staff view', !msgViewCols.map((r) => r.column_name).includes('sender_id'))
  const { rows: staffViewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaints_staff_view' order by ordinal_position`,
  )
  const staffColNames = staffViewCols.map((r) => r.column_name)
  check('44. student_id hidden from staff view', !staffColNames.includes('student_id'))
  check('45. email/name hidden from staff view', !staffColNames.some((c) => ['email', 'name'].includes(c)))
  await asUser(client, U.facultyB, async () => {
    await expectFailure(client, '43b. sender_id column not selectable by staff', () =>
      client.query(`select sender_id from public.messages limit 1`),
    )
    await expectFailure(client, '44b. student_id column not selectable by staff', () =>
      client.query(`select student_id from public.complaints limit 1`),
    )
    const { rows: prof } = await client.query(`select email from public.profiles where id = $1`, [U.student])
    check('45b. staff cannot read student profile email (RLS select-own)', prof.length === 0, JSON.stringify(prof))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select sender_role, body from public.messages_staff_view where complaint_id = $1 order by created_at`,
      [C.chat],
    )
    check('52b. chat remains identity-free for the owner (roles only)', rows.length >= 2 && FORBIDDEN_IDENTITY.every((f) => !(f in rows[0])), Object.keys(rows[0] ?? {}).join(','))
  })

  // --------------------------------------------------------------------------
  // 9. Regressions.
  // --------------------------------------------------------------------------
  console.log('\n== Regressions ==')

  // 47. Day 4 submission (title nullable on insert; new trigger must not break).
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values ($1, $2, 'Day 10A regression submission.', 'medium')
       returning ticket_number, status, title` ,
      [U.student, catId['Labs']],
    )
    check('47. Day 4: student submission still works (ticket + submitted, title NULL)', /^CMP-\d{4}$/.test(rows[0]?.ticket_number ?? '') && rows[0]?.status === 'submitted' && rows[0]?.title === null, JSON.stringify(rows))
  })

  // 47b/47c — EXACT reproduction of the reported live regression: submit a
  // complaint exactly as the app does, then run the EXACT query
  // fetchStudentComplaintDetail() issues (same columns, same embedded
  // category relationship, same RLS session). This proves the detail path
  // loads freshly submitted complaints in a correctly-migrated database —
  // the row is then soft-deleted so the count-based checks below are
  // unaffected.
  let freshId = null
  await asUser(client, U.student, async () => {
    const { rows: fresh } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values ($1, $2, 'Detail-fetch regression reproduction.', 'medium')
       returning id, ticket_number, status`,
      [U.student, catId['Labs']],
    )
    freshId = fresh[0].id
    const { rows: detail } = await client.query(
      `select c.id, c.ticket_number, c.category_id, c.title, c.description,
              c.priority, c.status, c.created_at, c.updated_at,
              cc.name as category
         from public.complaints c
         left join public.complaint_categories cc on cc.id = c.category_id
        where c.id = $1`,
      [freshId],
    )
    check('47b. detail fetch on a freshly submitted complaint loads (title/description present, status submitted)', detail.length === 1 && detail[0].ticket_number === fresh[0].ticket_number && detail[0].status === 'submitted' && detail[0].title === null && detail[0].description === 'Detail-fetch regression reproduction.', JSON.stringify(detail[0]))
  })
  const freshRow = await getRow(client, freshId)
  check('47c. new complaint has deleted_at = NULL (RLS `deleted_at is null` guard can never block it)', freshRow.deleted_at === null, JSON.stringify({ deleted_at: freshRow.deleted_at }))
  // Cleanup: soft-delete the reproduction row (owner-level) so the count
  // checks below stay stable — deleted rows are invisible to every role.
  await client.query(`update public.complaints set deleted_at = now(), deleted_by_role = 'student' where id = $1`, [freshId])

  // 48. Day 5 student isolation.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('48. Day 5: student sees own non-deleted complaints only', !rows.some((r) => r.ticket_number === 'CMP-1012') && !rows.some((r) => r.ticket_number === 'CMP-1015') && rows.length === 10, JSON.stringify(rows.map((r) => r.ticket_number)))
  })
  await asUser(client, U.otherStudent, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints`)
    check('48b. Day 5: other student isolated', rows.length === 1 && rows[0].ticket_number === 'CMP-1012', JSON.stringify(rows))
  })

  // 49. Day 5 staff view role visibility (committee sensitive / admin all).
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints`)
    check('49. Day 5: committee sees sensitive complaints only (and not deleted)', rows.length === 1 && rows[0].ticket_number === 'CMP-1016', JSON.stringify(rows))
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('49b. Day 5: admin sees all non-deleted complaints', rows.length === 11 && !rows.some((r) => r.ticket_number === 'CMP-1015'), JSON.stringify(rows.map((r) => r.ticket_number)))
  })

  // 50/51. Day 6 status flow + history + invalid transition.
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.historyFlow])
    check('50. Day 6: faculty status update still works (submitted -> under_review)', rows[0]?.status === 'under_review', JSON.stringify(rows))
    await expectFailure(client, '51. Day 6: invalid transition still rejected (under_review -> closed)', () =>
      client.query(`select * from public.update_complaint_status($1, 'closed')`, [C.historyFlow]),
    )
    await client.query(`select * from public.update_complaint_status($1, 'in_progress')`, [C.historyFlow])
    await client.query(`select * from public.update_complaint_status($1, 'resolved')`, [C.historyFlow])
  })
  const flowHist = await getHistory(client, C.historyFlow)
  check('50b. Day 6: history recorded with ROLE only (faculty)', flowHist.some((h) => h.previous_status === 'submitted' && h.new_status === 'under_review' && h.changed_by_role === 'faculty') && flowHist.some((h) => h.previous_status === 'in_progress' && h.new_status === 'resolved' && h.changed_by_role === 'faculty'), JSON.stringify(flowHist))

  // 52. Day 7 chat.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'Thanks!') returning sender_role, body`,
      [C.chat],
    )
    check('52. Day 7: chat send still works (sender derived server-side)', rows[0]?.sender_role === 'student', JSON.stringify(rows))
  })

  // 53. Day 8A message controls.
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(
      `select * from public.edit_complaint_message((select id from public.messages where complaint_id = $1 and sender_role = 'staff' limit 1), 'We are looking into it — ETA tomorrow.')`,
      [C.chat],
    )
    check('53. Day 8A: staff edits own message (unchanged)', rows[0]?.body === 'We are looking into it — ETA tomorrow.' && !!rows[0]?.edited_at, JSON.stringify(rows))
  })

  // 54. Day 8B conversation deletion.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.chat])
    check('54. Day 8B: delete conversation for me still works', !!rows[0]?.deleted_before, JSON.stringify(rows))
  })

  // 55. Day 9 resolution confirmation + reopen.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.confirm_complaint_resolution($1)`, [C.resolved])
    check('55. Day 9: student resolution confirmation still works (resolved -> closed)', rows[0]?.status === 'closed', JSON.stringify(rows))
  })
  const resolvedHist = await getHistory(client, C.resolved)
  check('55b. Day 9: history records student role, no identity', resolvedHist.some((h) => h.previous_status === 'resolved' && h.new_status === 'closed' && h.changed_by_role === 'student'), JSON.stringify(resolvedHist))

  // 57. Day 9B faculty assignment RPCs still work + isolation holds.
  await asUser(client, U.facultyNoDept, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('57a. Day 9B: faculty without a department sees nothing', rows.length === 0)
  })
  await asUser(client, U.facultyCse, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view`)
    check('57b. Day 9B: CSE faculty sees no ECS complaints', rows.length === 0)
  })
  await asUser(client, U.facultyA, async () => {
    const { rows } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.academics])
    check('57c. Day 9B: Labs faculty still cannot see Academics complaint', rows.length === 0)
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '57d. Day 9B: sensitive category cannot be assigned to faculty', () =>
      client.query(`select * from public.set_faculty_category_assignments($1, $2)`, [U.facultyA, [catId['Labs'], catId['Harassment / Ragging']]]),
    )
  })

  // 58. Anonymous blocked everywhere.
  await client.query('set role anon')
  await expectFailure(client, '58a. anonymous blocked from base complaints', () =>
    client.query(`select * from public.complaints limit 1`),
  )
  await expectFailure(client, '58b. anonymous blocked from staff view', () =>
    client.query(`select * from public.complaints_staff_view limit 1`),
  )
  await expectFailure(client, '58c. anonymous blocked from messages', () =>
    client.query(`select * from public.messages limit 1`),
  )
  await client.query('reset role')

  // 59. Realtime preconditions.
  const { rows: pubTables } = await client.query(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`,
  )
  const pubNames = pubTables.map((r) => r.tablename)
  check('59. complaints + messages in supabase_realtime publication', pubNames.includes('complaints') && pubNames.includes('messages'), pubNames.join(','))
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
