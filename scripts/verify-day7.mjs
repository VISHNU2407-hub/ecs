/**
 * Day 7 local verification harness — Anonymous complaint chat.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` schema,
 * applies the Day 3 + Day 6 + Day 7 migrations, and exercises the message
 * security model the chat UI relies on (see src/lib/complaintService.js +
 * useComplaintChat.js):
 *
 *   1. migrations apply cleanly (Day 7 idempotent)
 *   2. sender_id / sender_role are derived server-side by the trigger
 *   3. read visibility per role via messages_staff_view (student own,
 *      faculty non-sensitive, committee sensitive, admin all)
 *   4. staff/student responses never contain sender_id / student_id / email
 *   5. students and staff cannot forge sender_role or sender_id (column grants)
 *   6. unauthorized inserts are rejected (RLS)
 *   7. empty / whitespace-only / oversized messages are rejected (Day 7 CHECK)
 *   8. anon has no access
 *   9. messages stay tied to complaint_id
 *  10. existing complaint authorization + status flow are unchanged
 *  11. Realtime preconditions: RLS row-level via can_access_complaint (no
 *      broad policy), sender_id not selectable, view identity-free
 *
 * NOTE: Supabase Realtime itself cannot run inside embedded-postgres (it
 * needs the Realtime server + logical replication). This harness verifies the
 * database-side guarantees Realtime inherits: row-level RLS on messages and
 * column grants that hide sender_id. The client additionally subscribes with
 * an explicit safe column selection, which the Realtime server enforces
 * ("columns must be selectable by the subscribing role") — see the Day 7
 * migration header.
 *
 * Usage:  node scripts/verify-day7.mjs
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
]
const DB_DIR = path.join(root, '.tmp', 'day7-pgdata')
const PORT = 55440

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  otherStudent: '22222222-2222-2222-2222-222222222222',
  faculty: '33333333-3333-3333-3333-333333333333',
  admin: '44444444-4444-4444-4444-444444444444',
  committee: '55555555-5555-5555-5555-555555555555',
}

const C = {
  nonSensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', // CMP-9301 (student)
  sensitive: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12', // CMP-9302 (student, committee)
  other: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa13', // CMP-9303 (otherStudent)
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
    for (const m of MIGRATIONS) await client.query(fs.readFileSync(m, 'utf8'))
    check('Day 3 + 6 + 7 migrations applied cleanly', true)
  } catch (err) {
    check('Day 3 + 6 + 7 migrations applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[2], 'utf8'))
    check('Day 7 migration is re-runnable', true)
  } catch (err) {
    check('Day 7 migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // Seed users, roles and complaints.
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
    `select id, name from public.complaint_categories order by name`,
  )
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  await client.query(
    `insert into public.complaints (id, ticket_number, student_id, category_id, description, priority, status)
     values
       ($1, 'CMP-9301', $2, $3, 'AC in Lab 3 is not working.', 'medium', 'submitted'),
       ($4, 'CMP-9302', $2, $5, 'Sensitive harassment report.', 'urgent', 'submitted'),
       ($6, 'CMP-9303', $7, $8, 'Other student lab issue.', 'low', 'submitted')`,
    [
      C.nonSensitive, U.student, catId['Academics'],
      C.sensitive, catId['Harassment / Ragging'],
      C.other, U.otherStudent, catId['Labs'],
    ],
  )

  // --------------------------------------------------------------------------
  // 2. Seed messages through the real send path (trigger derives sender).
  // --------------------------------------------------------------------------
  console.log('\n== 2. Seed + server-derived sender ==')
  const seeded = []
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2), ($3, $4)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.nonSensitive, 'The issue happens every day.', C.sensitive, 'Please keep this anonymous.'],
    )
    seeded.push(...rows)
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.nonSensitive, 'Which lab is affected?'],
    )
    seeded.push(...rows)
  })
  await asUser(client, U.otherStudent, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.other, 'A message on my own complaint.'],
    )
    seeded.push(...rows)
  })
  check('seed: 4 messages inserted', seeded.length === 4, seeded.length)

  // The trigger must have set sender_id = auth.uid() and the correct role.
  const { rows: senderCheck } = await client.query(
    `select m.id, m.sender_id, m.sender_role, m.complaint_id from public.messages m order by m.created_at`,
  )
  const byComplaint = {}
  for (const r of senderCheck) (byComplaint[r.complaint_id] ??= []).push(r)
  const nonSensMsgs = byComplaint[C.nonSensitive] ?? []
  const sensMsgs = byComplaint[C.sensitive] ?? []
  const otherMsgs = byComplaint[C.other] ?? []
  check(
    'student message sender_id derived to auth.uid()',
    nonSensMsgs.some((m) => m.sender_id === U.student && m.sender_role === 'student'),
    JSON.stringify(nonSensMsgs),
  )
  check(
    'faculty message sender_role derived to staff (not client input)',
    nonSensMsgs.some((m) => m.sender_id === U.faculty && m.sender_role === 'staff'),
  )

  // --------------------------------------------------------------------------
  // 3. Read visibility per role (via messages_staff_view, the chat's query).
  // --------------------------------------------------------------------------
  console.log('\n== 3. Read visibility ==')
  const CHAT_SELECT = 'id, complaint_id, sender_role, body, created_at'
  await asUser(client, U.student, async () => {
    const { rows: mine } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1 order by created_at`,
      [C.nonSensitive],
    )
    check('student reads messages for own complaint', mine.length === 2 && mine.some((m) => m.sender_role === 'staff'), JSON.stringify(mine))
    const { rows: other } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1`,
      [C.other],
    )
    check('student cannot read another student\'s messages', other.length === 0)
    // Safe-column response only.
    const forbidden = ['sender_id', 'student_id', 'email', 'name']
    check(
      'student message response has no identity fields',
      mine.every((r) => forbidden.every((f) => !(f in r))),
      Object.keys(mine[0] ?? {}).join(','),
    )
  })
  await asUser(client, U.faculty, async () => {
    const { rows: mine } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1`,
      [C.nonSensitive],
    )
    check('faculty reads authorized non-sensitive complaint messages', mine.length === 2 && mine.some((m) => m.sender_role === 'student'))
    const { rows: sens } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1`,
      [C.sensitive],
    )
    check('faculty cannot read sensitive committee complaint messages', sens.length === 0)
    check(
      'staff message response has no identity fields',
      mine.every((r) => !('sender_id' in r) && !('student_id' in r) && !('email' in r) && !('name' in r)),
      Object.keys(mine[0] ?? {}).join(','),
    )
  })
  await asUser(client, U.committee, async () => {
    const { rows: sens } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1`,
      [C.sensitive],
    )
    check('committee reads authorized sensitive complaint messages', sens.length === 1 && sens[0].sender_role === 'student')
    const { rows: norm } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1`,
      [C.nonSensitive],
    )
    check('committee cannot read non-sensitive complaint messages', norm.length === 0)
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select ${CHAT_SELECT} from public.messages_staff_view`)
    check('admin reads all messages', rows.length === 4, rows.length)
  })

  // The view itself has no identity columns at all.
  const { rows: viewCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'messages_staff_view'
     order by ordinal_position`,
  )
  const viewColNames = viewCols.map((r) => r.column_name)
  check(
    'messages_staff_view has no identity columns',
    !viewColNames.some((c) => ['sender_id', 'student_id', 'email', 'name'].includes(c)),
    viewColNames.join(','),
  )

  // --------------------------------------------------------------------------
  // 4. Cannot forge sender identity (column grants).
  // --------------------------------------------------------------------------
  console.log('\n== 4. No forging ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'student cannot forge sender_role', () =>
      client.query(`insert into public.messages (complaint_id, body, sender_role) values ($1, 'x', 'staff')`, [C.nonSensitive]),
    )
    await expectFailure(client, 'student cannot forge sender_id', () =>
      client.query(`insert into public.messages (complaint_id, body, sender_id) values ($1, 'x', $2)`, [C.nonSensitive, U.faculty]),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'staff cannot forge sender_role', () =>
      client.query(`insert into public.messages (complaint_id, body, sender_role) values ($1, 'x', 'student')`, [C.nonSensitive]),
    )
    await expectFailure(client, 'staff cannot forge sender_id', () =>
      client.query(`insert into public.messages (complaint_id, body, sender_id) values ($1, 'x', $2)`, [C.nonSensitive, U.student]),
    )
  })

  // --------------------------------------------------------------------------
  // 5. Unauthorized inserts rejected (RLS).
  // --------------------------------------------------------------------------
  console.log('\n== 5. Unauthorized inserts ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'student cannot message another student\'s complaint', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, 'nope')`, [C.other]),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'faculty cannot message sensitive complaint', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, 'nope')`, [C.sensitive]),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectFailure(client, 'committee cannot message non-sensitive complaint', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, 'nope')`, [C.nonSensitive]),
    )
  })

  // --------------------------------------------------------------------------
  // 6. Message validation (Day 7 CHECK constraint).
  // --------------------------------------------------------------------------
  console.log('\n== 6. Validation ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'empty message rejected', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, '')`, [C.nonSensitive]),
    )
    await expectFailure(client, 'whitespace-only message rejected', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, '   ')`, [C.nonSensitive]),
    )
    await expectFailure(client, 'tab/newline-only message rejected', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, E'\\t\\n')`, [C.nonSensitive]),
    )
    const oversized = 'a'.repeat(2001)
    await expectFailure(client, 'oversized (2001 char) message rejected', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, $2)`, [C.nonSensitive, oversized]),
    )
    // The exact maximum length is accepted.
    const ok = 'b'.repeat(2000)
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2) returning complaint_id, char_length(body)::int as len`,
      [C.nonSensitive, ok],
    )
    check('2000-char message accepted', rows.length === 1 && rows[0].complaint_id === C.nonSensitive && rows[0].len === 2000)
  })

  // --------------------------------------------------------------------------
  // 7. anon has no access.
  // --------------------------------------------------------------------------
  console.log('\n== 7. anon ==')
  await client.query('set role anon')
  await expectFailure(client, 'anon cannot read messages (view)', () =>
    client.query(`select ${CHAT_SELECT} from public.messages_staff_view limit 1`),
  )
  await expectFailure(client, 'anon cannot insert a message', () =>
    client.query(`insert into public.messages (complaint_id, body) values ('${C.nonSensitive}', 'x')`),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 8. Messages stay tied to complaint_id.
  // --------------------------------------------------------------------------
  console.log('\n== 8. Tied to complaint ==')
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select ${CHAT_SELECT} from public.messages_staff_view where complaint_id = $1`,
      [C.nonSensitive],
    )
    check('non-sensitive complaint conversation is isolated', rows.length === 3 && rows.every((r) => r.complaint_id === C.nonSensitive), JSON.stringify(rows.map((r) => r.complaint_id)))
  })

  // --------------------------------------------------------------------------
  // 9. Existing complaint authorization + status flow unchanged.
  // --------------------------------------------------------------------------
  console.log('\n== 9. Existing behavior unchanged ==')
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query('select ticket_number, is_sensitive from public.complaints order by ticket_number')
    check('faculty complaint authorization unchanged (non-sensitive only)', rows.length === 2 && rows.every((r) => r.is_sensitive === false), JSON.stringify(rows))
    const { rows: upd } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.nonSensitive])
    check('status RPC still works after Day 7', upd[0]?.status === 'under_review', JSON.stringify(upd))
  })
  const { rows: hist } = await client.query(
    `select previous_status, new_status from public.complaint_status_history where complaint_id = $1`,
    [C.nonSensitive],
  )
  check('status history still recorded', hist.length === 1 && hist[0].previous_status === 'submitted' && hist[0].new_status === 'under_review', JSON.stringify(hist))

  // --------------------------------------------------------------------------
  // 10. Realtime preconditions (RLS + column grants + view).
  // --------------------------------------------------------------------------
  console.log('\n== 10. Realtime preconditions ==')
  const { rows: rls } = await client.query(
    `select relname from pg_class where relnamespace = 'public'::regnamespace and relname = 'messages' and relrowsecurity`,
  )
  check('messages RLS is enabled', rls.length === 1)
  const { rows: policies } = await client.query(
    `select polname, polcmd, pg_get_expr(polqual, polrelid) as qual
     from pg_policy where polrelid = 'public.messages'::regclass`,
  )
  const selectPolicies = policies.filter((p) => p.polcmd === 'r')
  check(
    'every messages SELECT policy uses can_access_complaint (no broad policy)',
    selectPolicies.length >= 1 && selectPolicies.every((p) => (p.qual ?? '').includes('can_access_complaint')),
    JSON.stringify(selectPolicies),
  )
  // sender_id must not be selectable by authenticated (Realtime enforces the
  // same column rule for its select option).
  const { rows: grants } = await client.query(
    `select privilege_type from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'messages'
       and column_name = 'sender_id' and grantee = 'authenticated'`,
  )
  check('sender_id has no SELECT grant for authenticated', grants.length === 0, JSON.stringify(grants))
} finally {
  await client.end().catch(() => {})
  try {
    await pgEmbed.stop()
  } catch (err) {
    console.log('  (cleanup note:', err?.code ?? err, ')')
  }
}

console.log(`\n========================================`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log(`========================================`)
process.exit(failed === 0 ? 0 : 1)
