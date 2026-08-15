/**
 * Day 9 local verification harness — Resolution confirmation, Reopen
 * workflow & Automatic escalation.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` schema,
 * applies the Day 3 + 6 + 7 + 8A + 8B + 9 migrations, and exercises the Day 9
 * security model the frontend relies on
 * (src/lib/complaintService.js + StudentComplaintDetailPage +
 * StaffComplaintDetailPage):
 *
 * RESOLUTION (1-6)
 *   1. the owning student can confirm their own resolved complaint
 *      (resolved -> closed)
 *   2. a student cannot close ANOTHER student's complaint (ownership)
 *   3. a student cannot close a non-resolved complaint
 *   4. faculty cannot use the student confirmation path
 *   5. 'closed' is recorded correctly
 *   6. history records resolved -> closed (changed_by_role = 'student')
 *
 * REOPEN (7-12)
 *   7. the owning student can reopen their own resolved complaint
 *   8. a student cannot reopen another student's complaint
 *   9. reopen is only allowed from 'resolved'
 *  10. the status becomes 'reopened'
 *  11. history records resolved -> reopened
 *  12. staff can continue the workflow after a reopen (reopened ->
 *      in_progress via the Day 6 RPC)
 *
 * ESCALATION (13-24)
 *  13. an eligible stale complaint (submitted, past the threshold) escalates
 *  14. a non-stale complaint is not escalated
 *  15. an already-closed complaint is not escalated
 *  16. an already-resolved complaint is not escalated
 *  17. escalation changes the status to 'escalated'
 *  18. escalation creates a status-history row
 *  19. automatic escalation creates no fake student identity (no new profile
 *      rows, student_id untouched, history stores roles only)
 *  20. faculty cannot escalate an unauthorized (sensitive) complaint, while
 *      committee (authorized) can
 *  21. no client role can invoke the automatic escalation function
 *  22. admin/staff visibility follows the existing authorization: admin sees
 *      escalated complaints with ticket/category/department/priority/status/
 *      escalation-state/timestamps; faculty only non-sensitive escalated;
 *      committee only sensitive escalated
 *  23. the student still sees only their own complaints
 *  24. sensitive-complaint restrictions remain intact
 *
 * SECURITY (25-30)
 *  25. no student identity exposure anywhere in the Day 9 paths
 *  26. no direct UPDATE bypass of the complaints table
 *  27. no unauthorized RPC execution (wrong role on every write path)
 *  28. anonymous users are blocked from every Day 9 RPC and read path
 *  29. the existing Day 6 transition validation remains intact
 *  30. invalid transitions are rejected
 *
 * REGRESSION (31-37)
 *  31. Day 3 security foundation still holds
 *  32. Day 4 complaint submission still works
 *  33. Day 5 dashboards still work
 *  34. Day 6 status flow still works
 *  35. Day 7 anonymous chat still works
 *  36. Day 8A message controls still work
 *  37. Day 8B conversation deletion still works
 *
 * SCHEDULING NOTE: Supabase Realtime and pg_cron cannot run inside
 * embedded-postgres. The migration's pg_cron block is a guarded no-op here;
 * this harness proves the server-side semantics of escalate_stale_
 * complaints() (eligibility, status change, history, no identity, no client
 * grants) by invoking it directly as the migration owner. In a real Supabase
 * project, enable pg_cron (Dashboard -> Database -> Extensions), re-run the
 * migration (or run the scheduling block), and the job runs every 15
 * minutes. Realtime preconditions (RLS on complaints, student_id not
 * selectable, identity-free view) are verified below.
 *
 * Usage:  node scripts/verify-day9.mjs
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
]
const DB_DIR = path.join(root, '.tmp', 'day9-pgdata')
const PORT = 55490

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  otherStudent: '22222222-2222-2222-2222-222222222222',
  faculty: '33333333-3333-3333-3333-333333333333',
  admin: '44444444-4444-4444-4444-444444444444',
  committee: '55555555-5555-5555-5555-555555555555',
}

const C = {
  // Resolution + reopen complaints.
  resolvedConfirm: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa21', // resolved, student    -> confirm -> closed
  resolvedReopen: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa22', // resolved, student    -> reopen -> reopened
  resolvedOther: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa23', // resolved, otherStudent (ownership rejections)
  notResolved: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa24', // submitted, student     (cannot close / reopen)
  sensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa25', // under_review, sensitive, student
  // Escalation complaints (updated_at backdated at seed time).
  escStaleSubmitted: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa31', // submitted,   -3h -> escalates
  escStaleReview: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa32', // under_review, -3h -> escalates
  escFresh: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa33', // submitted, now         -> NOT escalated
  escClosed: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa34', // closed, -3h           -> NOT escalated
  escResolved: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa35', // resolved, -3h        -> NOT escalated
  escAssigned: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa36', // assigned, -3h        -> NOT escalated
  // Other student's complaint (isolation + regression).
  other: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa40', // Labs, otherStudent, submitted
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

async function expectSuccess(client, label, run) {
  try {
    const result = await run()
    check(label, true)
    return result
  } catch (err) {
    check(label, false, String(err?.message ?? err).split('\n')[0])
    return null
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
    -- The real Supabase project has this publication; creating it here lets
    -- the Day 7 / Day 9 guarded blocks actually add messages + complaints,
    -- so the Realtime preconditions can be asserted.
    create publication supabase_realtime;
  `)

  // --------------------------------------------------------------------------
  // 1. Migrations.
  // --------------------------------------------------------------------------
  console.log('\n== 1. Migrations ==')
  try {
    for (const m of MIGRATIONS) await client.query(fs.readFileSync(m, 'utf8'))
    check('Day 3 + 6 + 7 + 8A + 8B + 9 migrations applied cleanly', true)
  } catch (err) {
    check('Day 3 + 6 + 7 + 8A + 8B + 9 migrations applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[5], 'utf8'))
    check('Day 9 migration is re-runnable', true)
  } catch (err) {
    check('Day 9 migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // 2. Seed users, roles, departments, complaints and messages.
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

  const { rows: cats } = await client.query(
    `select id, name, is_sensitive from public.complaint_categories order by name`,
  )
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  // All complaints seeded directly (as the migration owner) with explicit
  // status and, for the escalation set, backdated updated_at (the Day 3
  // before-update trigger would clobber a backdate via UPDATE, so the
  // timestamps are set at INSERT time).
  await client.query(
    `insert into public.complaints
       (id, ticket_number, student_id, category_id, description, priority, status, updated_at)
     values
       ($1,  'CMP-9201', $2,  $3,  'Resolved Academics complaint for confirmation.', 'medium', 'resolved', now()),
       ($4,  'CMP-9202', $5,  $6,  'Resolved complaint to be reopened.', 'high', 'resolved', now()),
       ($7,  'CMP-9203', $8,  $9,  'Resolved complaint owned by another student.', 'medium', 'resolved', now()),
       ($10, 'CMP-9204', $11, $12, 'Submitted complaint that is not resolved.', 'medium', 'submitted', now()),
       ($13, 'CMP-9205', $14, $15, 'Sensitive harassment complaint under review.', 'urgent', 'under_review', now()),
       ($16, 'CMP-9206', $17, $18, 'Stale submitted complaint.', 'medium', 'submitted', now() - interval '3 hours'),
       ($19, 'CMP-9207', $20, $21, 'Stale under-review complaint.', 'high', 'under_review', now() - interval '3 hours'),
       ($22, 'CMP-9208', $23, $24, 'Fresh submitted complaint.', 'low', 'submitted', now()),
       ($25, 'CMP-9209', $26, $27, 'Closed complaint, stale.', 'medium', 'closed', now() - interval '3 hours'),
       ($28, 'CMP-9210', $29, $30, 'Resolved complaint, stale.', 'medium', 'resolved', now() - interval '3 hours'),
       ($31, 'CMP-9211', $32, $33, 'Assigned complaint, stale.', 'medium', 'assigned', now() - interval '3 hours'),
       ($34, 'CMP-9212', $35, $36, 'Other student complaint.', 'low', 'submitted', now())`,
    [
      C.resolvedConfirm, U.student, catId['Academics'],
      C.resolvedReopen, U.student, catId['Academics'],
      C.resolvedOther, U.otherStudent, catId['Labs'],
      C.notResolved, U.student, catId['Academics'],
      C.sensitive, U.student, catId['Harassment / Ragging'],
      C.escStaleSubmitted, U.student, catId['Academics'],
      C.escStaleReview, U.student, catId['Labs'],
      C.escFresh, U.student, catId['Equipment'],
      C.escClosed, U.student, catId['Labs'],
      C.escResolved, U.student, catId['Equipment'],
      C.escAssigned, U.student, catId['Equipment'],
      C.other, U.otherStudent, catId['Labs'],
    ],
  )

  // --------------------------------------------------------------------------
  // RESOLUTION — the student confirms their own resolved complaint.
  // --------------------------------------------------------------------------
  console.log('\n== Resolution ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select * from public.confirm_complaint_resolution($1)`,
      [C.resolvedConfirm],
    )
    const r = rows[0]
    check('1. student confirms own resolved complaint (resolved -> closed)', r?.ticket_number === 'CMP-9201' && r?.status === 'closed' && !!r?.updated_at, JSON.stringify(r))
  })
  const closedStatus = await getStatus(client, C.resolvedConfirm)
  check('5. closed status recorded', closedStatus === 'closed', closedStatus)
  const closedHistory = await getHistory(client, C.resolvedConfirm)
  check('6. history records resolved -> closed', closedHistory.length === 1 && closedHistory[0].previous_status === 'resolved' && closedHistory[0].new_status === 'closed', JSON.stringify(closedHistory))
  check('6b. history changed_by_role is student (role, not identity)', closedHistory[0]?.changed_by_role === 'student', closedHistory[0]?.changed_by_role)
  check('6c. history contains a DB timestamp', !!closedHistory[0]?.changed_at)

  await asUser(client, U.student, async () => {
    await expectFailure(client, '2. student cannot close another student\'s resolved complaint', () =>
      client.query(`select * from public.confirm_complaint_resolution($1)`, [C.resolvedOther]),
    )
    await expectFailure(client, '3. student cannot close a non-resolved complaint', () =>
      client.query(`select * from public.confirm_complaint_resolution($1)`, [C.notResolved]),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, '4. faculty cannot use the student confirmation path', () =>
      client.query(`select * from public.confirm_complaint_resolution($1)`, [C.resolvedReopen]),
    )
  })

  // --------------------------------------------------------------------------
  // REOPEN — the student reopens their own resolved complaint.
  // --------------------------------------------------------------------------
  console.log('\n== Reopen ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select * from public.reopen_complaint($1)`, [C.resolvedReopen])
    const r = rows[0]
    check('7. student reopens own resolved complaint (resolved -> reopened)', r?.ticket_number === 'CMP-9202' && r?.status === 'reopened' && !!r?.updated_at, JSON.stringify(r))
  })
  const reopenedStatus = await getStatus(client, C.resolvedReopen)
  check('10. status becomes reopened', reopenedStatus === 'reopened', reopenedStatus)
  const reopenHistory = await getHistory(client, C.resolvedReopen)
  check('11. history records resolved -> reopened', reopenHistory.length === 1 && reopenHistory[0].previous_status === 'resolved' && reopenHistory[0].new_status === 'reopened', JSON.stringify(reopenHistory))
  check('11b. reopen history changed_by_role is student', reopenHistory[0]?.changed_by_role === 'student', reopenHistory[0]?.changed_by_role)

  await asUser(client, U.student, async () => {
    await expectFailure(client, '8. student cannot reopen another student\'s complaint', () =>
      client.query(`select * from public.reopen_complaint($1)`, [C.resolvedOther]),
    )
    await expectFailure(client, '9. reopen only allowed from resolved (submitted rejected)', () =>
      client.query(`select * from public.reopen_complaint($1)`, [C.notResolved]),
    )
  })

  // Staff continue the workflow after a reopen (reopened -> in_progress).
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'in_progress')`, [C.resolvedReopen])
    check('12. staff continues workflow after reopen (reopened -> in_progress)', rows[0]?.status === 'in_progress', JSON.stringify(rows))
  })
  const afterReopenHistory = await getHistory(client, C.resolvedReopen)
  check('12b. history records reopened -> in_progress (staff)', afterReopenHistory.some((h) => h.previous_status === 'reopened' && h.new_status === 'in_progress' && h.changed_by_role === 'faculty'), JSON.stringify(afterReopenHistory))

  // --------------------------------------------------------------------------
  // ESCALATION — server-driven automatic escalation.
  // --------------------------------------------------------------------------
  console.log('\n== Escalation ==')
  const { rows: thresholdDefault } = await client.query(
    `select value from public.system_settings where key = 'escalation_threshold'`,
  )
  check('config: escalation threshold lives in system_settings (not React/localStorage)', thresholdDefault[0]?.value === '48 hours', thresholdDefault[0]?.value)
  // Use a short threshold so the harness can exercise staleness quickly.
  await client.query(`update public.system_settings set value = '1 hour' where key = 'escalation_threshold'`)

  const profilesBefore = (await client.query('select count(*)::int as n from public.profiles')).rows[0].n
  const { rows: escalatedRows } = await client.query(`select * from public.escalate_stale_complaints()`)
  const escalatedIds = escalatedRows.map((r) => r.complaint_id)

  check('13. eligible stale submitted complaint escalated', escalatedIds.includes(C.escStaleSubmitted) && (await getStatus(client, C.escStaleSubmitted)) === 'escalated', JSON.stringify(escalatedIds))
  check('13b. eligible stale under_review complaint escalated', escalatedIds.includes(C.escStaleReview) && (await getStatus(client, C.escStaleReview)) === 'escalated')
  check('17. escalation changes status to escalated', (await getStatus(client, C.escStaleSubmitted)) === 'escalated', await getStatus(client, C.escStaleSubmitted))
  check('14. non-stale complaint NOT escalated', !escalatedIds.includes(C.escFresh) && (await getStatus(client, C.escFresh)) === 'submitted', await getStatus(client, C.escFresh))
  check('15. already-closed complaint NOT escalated', !escalatedIds.includes(C.escClosed) && (await getStatus(client, C.escClosed)) === 'closed', await getStatus(client, C.escClosed))
  check('16. already-resolved complaint NOT escalated', !escalatedIds.includes(C.escResolved) && (await getStatus(client, C.escResolved)) === 'resolved', await getStatus(client, C.escResolved))
  check('16b. assigned complaint NOT auto-escalated (only submitted/under_review eligible)', !escalatedIds.includes(C.escAssigned) && (await getStatus(client, C.escAssigned)) === 'assigned', await getStatus(client, C.escAssigned))

  const escHistory = await getHistory(client, C.escStaleSubmitted)
  check('18. escalation creates status history', escHistory.length === 1 && escHistory[0].previous_status === 'submitted' && escHistory[0].new_status === 'escalated', JSON.stringify(escHistory))
  check('18b. escalation history changed_by_role is system', escHistory[0]?.changed_by_role === 'system', escHistory[0]?.changed_by_role)

  const profilesAfter = (await client.query('select count(*)::int as n from public.profiles')).rows[0].n
  check('19. automatic escalation creates no fake profile/identity', profilesAfter === profilesBefore, `${profilesBefore} -> ${profilesAfter}`)
  const { rows: sidRow } = await client.query(`select student_id from public.complaints where id = $1`, [C.escStaleSubmitted])
  check('19b. escalated complaint student_id untouched (still the owner)', sidRow[0]?.student_id === U.student, sidRow[0]?.student_id)
  const { rows: histCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'complaint_status_history' order by ordinal_position`,
  )
  const histColNames = histCols.map((r) => r.column_name)
  check('19c. history table has no identity columns', !histColNames.some((c) => FORBIDDEN_IDENTITY.includes(c)), histColNames.join(','))

  // Manual escalation authorization: faculty cannot escalate a sensitive
  // complaint; committee (authorized) can.
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, '20. faculty cannot escalate unauthorized (sensitive) complaint', () =>
      client.query(`select * from public.update_complaint_status($1, 'escalated')`, [C.sensitive]),
    )
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'escalated')`, [C.sensitive])
    check('20b. committee (authorized) can escalate sensitive complaint', rows[0]?.status === 'escalated', JSON.stringify(rows))
  })

  // No client role can invoke the automatic escalation function.
  await asUser(client, U.student, async () => {
    await expectFailure(client, '21. student cannot invoke automatic escalation', () =>
      client.query(`select * from public.escalate_stale_complaints()`),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, '21b. faculty cannot invoke automatic escalation', () =>
      client.query(`select * from public.escalate_stale_complaints()`),
    )
  })

  // Escalation visibility — admin sees everything, faculty/committee only
  // what their existing authorization allows, identity never exposed.
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(
      `select ticket_number, category, department, priority, status, is_escalated, created_at, updated_at
       from public.complaints_staff_view where status = 'escalated' order by ticket_number`,
    )
    check('22. admin sees all escalated complaints', rows.length === 3, JSON.stringify(rows.map((r) => r.ticket_number)))
    check(
      '22b. admin can identify ticket/category/department/priority/status/escalation-state/timestamps',
      rows.every(
        (r) =>
          r.ticket_number && r.category && r.department && r.priority && r.status === 'escalated' && r.is_escalated === true && r.created_at && r.updated_at,
      ),
      JSON.stringify(rows[0] ?? {}),
    )
    check('22c. escalated rows expose no identity', rows.every((r) => FORBIDDEN_IDENTITY.every((f) => !(f in r))), Object.keys(rows[0] ?? {}).join(','))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view where status = 'escalated' order by ticket_number`)
    check('22d. faculty sees only non-sensitive escalated complaints', rows.length === 2 && rows.every((r) => r.ticket_number !== 'CMP-9205'), JSON.stringify(rows))
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints_staff_view where status = 'escalated' order by ticket_number`)
    check('22e. committee sees only sensitive escalated complaints', rows.length === 1 && rows[0].ticket_number === 'CMP-9205', JSON.stringify(rows))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ticket_number, status from public.complaints order by ticket_number`)
    check('23. student still sees only own complaints (incl. escalated)', rows.length === 10 && !rows.some((r) => r.ticket_number === 'CMP-9203' || r.ticket_number === 'CMP-9212') && rows.some((r) => r.ticket_number === 'CMP-9206' && r.status === 'escalated'), JSON.stringify(rows.map((r) => r.ticket_number)))
  })
  await asUser(client, U.faculty, async () => {
    const { rows: sens } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.sensitive])
    check('24. sensitive restrictions intact (faculty cannot read escalated sensitive)', sens.length === 0)
  })
  await asUser(client, U.committee, async () => {
    const { rows: norm } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.escStaleSubmitted])
    check('24b. sensitive restrictions intact (committee cannot read non-sensitive escalated)', norm.length === 0)
  })

  // --------------------------------------------------------------------------
  // SECURITY.
  // --------------------------------------------------------------------------
  console.log('\n== Security ==')
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, '25. student_id column not selectable by staff (no identity exposure)', () =>
      client.query(`select student_id from public.complaints limit 1`),
    )
    await expectFailure(client, '26. direct UPDATE bypass denied (no grant)', () =>
      client.query(`update public.complaints set status = 'closed' where id = $1`, [C.escFresh]),
    )
    await expectFailure(client, '27. student write path rejected for staff (confirm)', () =>
      client.query(`select * from public.confirm_complaint_resolution($1)`, [C.escResolved]),
    )
    await expectFailure(client, '27b. student write path rejected for staff (reopen)', () =>
      client.query(`select * from public.reopen_complaint($1)`, [C.escResolved]),
    )
  })
  await asUser(client, U.student, async () => {
    await expectFailure(client, '26b. student direct UPDATE denied (no grant)', () =>
      client.query(`update public.complaints set status = 'closed' where id = $1`, [C.escFresh]),
    )
    await expectFailure(client, '27c. student cannot call staff status RPC', () =>
      client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.escFresh]),
    )
  })
  await asUser(client, U.admin, async () => {
    await expectFailure(client, '27d. admin cannot use the student confirmation path', () =>
      client.query(`select * from public.confirm_complaint_resolution($1)`, [C.escResolved]),
    )
  })

  await client.query('set role anon')
  await expectFailure(client, '28. anonymous user blocked from confirm RPC', () =>
    client.query(`select * from public.confirm_complaint_resolution('${C.resolvedConfirm}')`),
  )
  await expectFailure(client, '28b. anonymous user blocked from reopen RPC', () =>
    client.query(`select * from public.reopen_complaint('${C.resolvedReopen}')`),
  )
  await expectFailure(client, '28c. anonymous user blocked from escalation function', () =>
    client.query(`select * from public.escalate_stale_complaints()`),
  )
  await expectFailure(client, '28d. anonymous user blocked from staff view', () =>
    client.query(`select * from public.complaints_staff_view limit 1`),
  )
  await expectFailure(client, '28e. anonymous user blocked from status history', () =>
    client.query(`select * from public.complaint_status_history limit 1`),
  )
  await client.query('reset role')

  // Existing Day 6 transition validation remains authoritative.
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, '29. invalid staff transition still rejected (closed -> in_progress)', () =>
      client.query(`select * from public.update_complaint_status($1, 'in_progress')`, [C.escClosed]),
    )
    await expectFailure(client, '30. invalid staff transition still rejected (closed -> escalated)', () =>
      client.query(`select * from public.update_complaint_status($1, 'escalated')`, [C.escClosed]),
    )
    // A VALID Day 6 transition still works: closed -> reopened (staff).
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'reopened')`, [C.escClosed])
    check('29b. valid Day 6 transition still works (closed -> reopened by staff)', rows[0]?.status === 'reopened', JSON.stringify(rows))
  })

  // --------------------------------------------------------------------------
  // REGRESSION — all previous days still work.
  // --------------------------------------------------------------------------
  console.log('\n== Regressions ==')

  // 31. Day 3 — RLS foundation.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ticket_number from public.complaints order by ticket_number`)
    check('31. Day 3: student isolation intact (own rows only)', rows.length === 10 && !rows.some((r) => r.ticket_number === 'CMP-9212'), JSON.stringify(rows.map((r) => r.ticket_number)))
    const { rows: prof } = await client.query(`select role from public.profiles where id = $1`, [U.student])
    check('31b. Day 3: get_app_role resolves own role only', prof[0]?.role === 'student', JSON.stringify(prof))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select id from public.complaints_staff_view where id = $1`, [C.sensitive])
    check('31c. Day 3: faculty cannot read sensitive complaint', rows.length === 0)
  })

  // 32. Day 4 — complaint submission still works (through the granted path).
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values ($1, $2, 'Regression submission test for Day 4.', 'medium')
       returning ticket_number, status, is_sensitive, handler_type`,
      [U.student, catId['Academics']],
    )
    check('32. Day 4: student submission works (ticket + submitted)', /^CMP-\d{4}$/.test(rows[0]?.ticket_number ?? '') && rows[0]?.status === 'submitted', JSON.stringify(rows))
    check('32b. Day 4: non-sensitive category derives department handler', rows[0]?.is_sensitive === false && rows[0]?.handler_type === 'department', JSON.stringify(rows))
  })

  // 33. Day 5 — dashboards still work.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select c.ticket_number, cc.name as category, c.status
       from public.complaints c
       left join public.complaint_categories cc on cc.id = c.category_id
       where c.ticket_number = 'CMP-9204'`,
    )
    check('33. Day 5: student dashboard query resolves category name', rows[0]?.category === 'Academics' && rows[0]?.status === 'submitted', JSON.stringify(rows))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select ticket_number, category, department, priority, status from public.complaints_staff_view where ticket_number = 'CMP-9201'`,
    )
    check('33b. Day 5: staff dashboard query returns safe fields', rows[0]?.ticket_number === 'CMP-9201' && rows[0]?.category === 'Academics' && rows[0]?.department === 'ECS', JSON.stringify(rows))
  })

  // 34. Day 6 — status flow still works.
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.notResolved])
    check('34. Day 6: staff status update works', rows[0]?.status === 'under_review', JSON.stringify(rows))
  })
  const notResolvedHistory = await getHistory(client, C.notResolved)
  check('34b. Day 6: status update recorded in history', notResolvedHistory.some((h) => h.previous_status === 'submitted' && h.new_status === 'under_review' && h.changed_by_role === 'faculty'), JSON.stringify(notResolvedHistory))

  // 35. Day 7 — anonymous chat still works.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'Hello, is anyone there?') returning id, complaint_id, sender_role, body, created_at`,
      [C.notResolved],
    )
    check('35. Day 7: student can send a message (sender derived server-side)', rows[0]?.sender_role === 'student' && !!rows[0]?.id, JSON.stringify(rows))
  })
  const { rows: senderRows } = await client.query(
    `select sender_id, sender_role from public.messages where complaint_id = $1 order by created_at limit 1`,
    [C.notResolved],
  )
  check('35b. Day 7: sender_id set from auth.uid() (server-derived)', senderRows[0]?.sender_id === U.student && senderRows[0]?.sender_role === 'student', JSON.stringify(senderRows))
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select * from public.messages_staff_view where complaint_id = $1`, [C.notResolved])
    check('35c. Day 7: staff reads conversation identity-free', rows.length >= 1 && FORBIDDEN_IDENTITY.every((f) => !(f in rows[0])), Object.keys(rows[0] ?? {}).join(','))
  })
  await client.query('set role anon')
  await expectFailure(client, '35d. Day 7: anonymous user blocked from chat', () =>
    client.query(`select * from public.messages_staff_view limit 1`),
  )
  await client.query('reset role')

  // 36. Day 8A — message controls still work.
  let facultyMsgId = null
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'We are looking into it.') returning id, sender_role`,
      [C.notResolved],
    )
    facultyMsgId = rows[0]?.id
    check('36a. Day 8A: faculty message seeded (sender_role derived as staff)', rows[0]?.sender_role === 'staff', JSON.stringify(rows))
  })
  await asUser(client, U.student, async () => {
    await expectFailure(client, '36. Day 8A: student cannot edit a faculty message', () =>
      client.query(`select * from public.edit_complaint_message($1, 'Hello, we are waiting for an update.')`, [facultyMsgId]),
    )
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select * from public.edit_complaint_message($1, 'We are looking into it — ETA tomorrow.')`, [facultyMsgId])
    check('36b. Day 8A: faculty edits own message', rows[0]?.body === 'We are looking into it — ETA tomorrow.' && !!rows[0]?.edited_at, JSON.stringify(rows))
    const { rows: del } = await client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [facultyMsgId])
    check('36c. Day 8A: faculty deletes own message for everyone (soft delete)', del[0]?.is_deleted === true && !!del[0]?.deleted_at, JSON.stringify(del))
  })

  // 37. Day 8B — conversation deletion still works (per-user cutoff).
  const { rows: msgRows } = await client.query(
    `select id from public.messages where complaint_id = $1 order by created_at`,
    [C.notResolved],
  )
  const studentMsgId = msgRows[0]?.id
  await asUser(client, U.student, async () => {
    // A message the student can "delete for me" (the faculty message was
    // deleted for everyone, so delete-for-me applies to the student's own).
    const { rows } = await client.query(`select * from public.delete_complaint_message_for_me($1)`, [studentMsgId])
    check('37b. Day 8A: delete for me still works', !!rows[0]?.message_id, JSON.stringify(rows))
    const { rows: cutoff } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.notResolved])
    check('37. Day 8B: student deletes conversation for me (cutoff recorded)', !!cutoff[0]?.deleted_before, JSON.stringify(cutoff))
    const { rows: visible } = await client.query(
      `select id from public.messages_staff_view where complaint_id = $1 and created_at > $2`,
      [C.notResolved, cutoff[0].deleted_before],
    )
    check('37c. Day 8B: only post-cutoff messages visible to that user', visible.length === 0, JSON.stringify(visible))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select id from public.messages_staff_view where complaint_id = $1`, [C.notResolved])
    check('37d. Day 8B: other participant unaffected (sees full conversation)', rows.length >= 2, JSON.stringify(rows))
  })

  // Realtime preconditions for the Day 9 status subscription.
  const { rows: pubTabs } = await client.query(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`,
  )
  const pubNames = pubTabs.map((r) => r.tablename)
  check('Realtime precondition: complaints in supabase_realtime publication', pubNames.includes('complaints') && pubNames.includes('messages'), pubNames.join(','))
  const { rows: complaintsGrants } = await client.query(
    `select privilege_type from information_schema.role_column_grants
     where table_schema = 'public' and table_name = 'complaints' and column_name = 'student_id'
       and grantee = 'authenticated' and privilege_type = 'SELECT'`,
  )
  // The INSERT grant on student_id is intentional (a student must set their
  // own id when submitting); Realtime payloads only ever carry SELECTable
  // columns, so the absence of a SELECT grant means student_id can never
  // appear in a status event.
  check('Realtime precondition: student_id not selectable by authenticated (no identity in payloads)', complaintsGrants.length === 0, JSON.stringify(complaintsGrants))
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
