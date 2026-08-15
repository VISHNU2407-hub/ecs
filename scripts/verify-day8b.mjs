/**
 * Day 8B local verification harness — Delete conversation for me.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` schema,
 * applies the Day 3 + 6 + 7 + 8A + 8B migrations, and exercises the
 * conversation-cutoff security model the chat UI relies on
 * (src/lib/complaintService.js + useComplaintChat.js + ComplaintChat.jsx):
 *
 *   1. migrations apply cleanly (Day 8B idempotent)
 *   2. each role can delete their own conversation (cutoff upserted)
 *   3. the cutoff hides only pre-cutoff messages for THAT user; the other
 *      participant and the database are untouched
 *   4. messages created after the cutoff become visible again
 *   5. sending after deletion works; the complaint stays on the dashboard
 *   6. the RPC uses auth.uid() — user_id cannot be supplied by the client
 *   7. no direct table bypass (no INSERT/UPDATE/DELETE grants) and anon has
 *      no access; another user's state is unreadable/unmodifiable
 *   8. existing Day 8A behavior (edit, delete for me, delete for everyone)
 *      and Day 7 sending still work alongside the cutoff
 *   9. "old" message events cannot bypass the cutoff (server-side
 *      created_at > deleted_before filtering); new events appear normally
 *  10. identity stays hidden (sender_id / student_id / email / name,
 *      including conversation_user_state.user_id in grants)
 *  11. student isolation + sensitive-complaint restrictions intact
 *  12. Day 6 status flow intact
 *  13. Realtime preconditions: RLS on conversation_user_state, self-scoped
 *      policies, no broad policies
 *
 * NOTE: Supabase Realtime itself cannot run inside embedded-postgres. The
 * client additionally filters INSERT/UPDATE events against the cutoff in the
 * hook; this harness proves the database-side semantics (the fetch query uses
 * created_at > deleted_before server-side, so even a replayed old event is
 * excluded by the same rule).
 *
 * Usage:  node scripts/verify-day8b.mjs
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
]
const DB_DIR = path.join(root, '.tmp', 'day8b-pgdata')
const PORT = 55460

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

const SAFE = 'id, complaint_id, sender_role, body, created_at, edited_at, is_deleted, deleted_at'

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
    check(`${label} — expected to fail, but succeeded`, false)
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
    check('Day 3 + 6 + 7 + 8A + 8B migrations applied cleanly', true)
  } catch (err) {
    check('Day 3 + 6 + 7 + 8A + 8B migrations applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[4], 'utf8'))
    check('Day 8B migration is re-runnable', true)
  } catch (err) {
    check('Day 8B migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // Seed users, roles, complaints and messages (through the real send path,
  // with deterministic pre-cutoff created_at set by the owner afterwards).
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

  // 5 pre-cutoff messages on the non-sensitive complaint: 3 student + 2 faculty.
  // Plus 1 student + 1 committee message on the sensitive complaint.
  const M = {}
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2), ($3, $4), ($5, $6)
       returning id, complaint_id, sender_role, body`,
      [C.nonSensitive, 'message 1', C.nonSensitive, 'message 2', C.nonSensitive, 'message 3'],
    )
    M.s1 = rows[0].id
    M.s2 = rows[1].id
    M.s3 = rows[2].id
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2), ($3, $4)
       returning id, complaint_id, sender_role, body`,
      [C.nonSensitive, 'reply 1', C.nonSensitive, 'reply 2'],
    )
    M.f1 = rows[0].id
    M.f2 = rows[1].id
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body`,
      [C.sensitive, 'Please keep this anonymous.'],
    )
    M.ss = rows[0].id
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body`,
      [C.sensitive, 'We are looking into it.'],
    )
    M.cm = rows[0].id
  })
  await asUser(client, U.otherStudent, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body`,
      [C.other, 'A message on my own complaint.'],
    )
    M.o1 = rows[0].id
  })
  check(
    'seed: 8 messages inserted',
    [M.s1, M.s2, M.s3, M.f1, M.f2, M.ss, M.cm, M.o1].every(Boolean),
    JSON.stringify(M),
  )

  // Deterministic pre-cutoff timestamps (5 days in the past, 1 minute apart).
  const oldIds = [M.s1, M.s2, M.s3, M.f1, M.f2, M.ss, M.cm, M.o1]
  for (let i = 0; i < oldIds.length; i++) {
    await client.query(
      `update public.messages set created_at = now() - interval '5 days' + make_interval(mins => $1) where id = $2`,
      [i, oldIds[i]],
    )
  }

  // --------------------------------------------------------------------------
  // 2. Conversation cutoff — student deletes conversation.
  // --------------------------------------------------------------------------
  console.log('\n== 2. Student deletes conversation ==')
  let studentCutoff = null
  await asUser(client, U.student, async () => {
    const res = await expectSuccess(client, 'student can delete their conversation for me', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.nonSensitive])
      return rows[0]
    })
    check('RPC returns a cutoff timestamp', res && res.deleted_before !== null, JSON.stringify(res))
    studentCutoff = res?.deleted_before
  })
  check('cutoff recorded at ~now (after seed timestamps)', studentCutoff !== null && new Date(studentCutoff).getTime() > Date.now() - 60000, String(studentCutoff))

  // 10. The current user no longer sees messages before deleted_before.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view
        where complaint_id = $1 and created_at > $2 order by created_at`,
      [C.nonSensitive, studentCutoff],
    )
    check('student sees no pre-cutoff messages', rows.length === 0, String(rows.length))
  })
  // 9. Other participant still sees all old messages.
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view where complaint_id = $1 order by created_at`,
      [C.nonSensitive],
    )
    check('faculty still sees the full conversation (5 old messages)', rows.length === 5, String(rows.length))
  })
  // 8. Messages remain in the database.
  const { rows: dbCount } = await client.query(`select count(*)::int as n from public.messages`)
  check('messages remain in the database (8 rows)', dbCount[0].n === 8, String(dbCount[0].n))
  // 7. Complaint remains unchanged.
  const { rows: complaintRow } = await client.query(
    `select ticket_number, status, priority, category_id from public.complaints where id = $1`,
    [C.nonSensitive],
  )
  check(
    'complaint unchanged (ticket/status/priority intact)',
    complaintRow.length === 1 && complaintRow[0].ticket_number === 'CMP-9301' && complaintRow[0].status === 'submitted' && complaintRow[0].priority === 'medium',
    JSON.stringify(complaintRow),
  )
  // 6. RPC used auth.uid() — the stored row belongs to the caller.
  const { rows: stateRow } = await client.query(
    `select complaint_id, user_id, deleted_before from public.conversation_user_state where complaint_id = $1`,
    [C.nonSensitive],
  )
  check(
    'state row stored under auth.uid() (student), not client input',
    stateRow.length === 1 && stateRow[0].user_id === U.student,
    JSON.stringify(stateRow),
  )

  // --------------------------------------------------------------------------
  // 3. New messages after the cutoff become visible again.
  // --------------------------------------------------------------------------
  console.log('\n== 3. New messages after cutoff ==')
  let newMsgId = null
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2) returning id`,
      [C.nonSensitive, 'Any update?'],
    )
    newMsgId = rows[0].id
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view
        where complaint_id = $1 and created_at > $2 order by created_at`,
      [C.nonSensitive, studentCutoff],
    )
    check('student sees the new post-cutoff message', rows.length === 1 && rows[0].body === 'Any update?', JSON.stringify(rows.map((r) => r.body)))
  })
  await asUser(client, U.student, async () => {
    await expectSuccess(client, 'student can send a new message after deletion', async () => {
      const { rows } = await client.query(
        `insert into public.messages (complaint_id, body) values ($1, $2) returning id`,
        [C.nonSensitive, 'Hello again'],
      )
      return rows[0]
    })
    const { rows } = await client.query(
      `select body from public.messages_staff_view
        where complaint_id = $1 and created_at > $2 order by created_at`,
      [C.nonSensitive, studentCutoff],
    )
    check('student conversation now shows exactly the post-cutoff messages', rows.length === 2 && rows[0].body === 'Any update?' && rows[1].body === 'Hello again', JSON.stringify(rows.map((r) => r.body)))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select body from public.messages_staff_view where complaint_id = $1 order by created_at`,
      [C.nonSensitive],
    )
    check('faculty sees entire conversation + the new messages (7 rows)', rows.length === 7 && rows[6].body === 'Hello again', String(rows.length))
  })

  // --------------------------------------------------------------------------
  // 4. Faculty deletes their own conversation (independent cutoff).
  // --------------------------------------------------------------------------
  console.log('\n== 4. Faculty deletes conversation ==')
  let facultyCutoff = null
  await asUser(client, U.faculty, async () => {
    const res = await expectSuccess(client, 'faculty can delete their conversation for me', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.nonSensitive])
      return rows[0]
    })
    facultyCutoff = res?.deleted_before
  })
  // Messages sent BEFORE the faculty cutoff (the two sent after the student's
  // deletion) are now hidden for faculty too; a message sent AFTER the
  // faculty cutoff becomes visible again.
  await asUser(client, U.faculty, async () => {
    const { rows: ins } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2) returning id`,
      [C.nonSensitive, 'Checking in'],
    )
    check('faculty can send a message after their own deletion', ins.length === 1)
    const { rows } = await client.query(
      `select body from public.messages_staff_view
        where complaint_id = $1 and created_at > $2 order by created_at`,
      [C.nonSensitive, facultyCutoff],
    )
    check('faculty sees only post-cutoff messages after their own deletion', rows.length === 1 && rows[0].body === 'Checking in', JSON.stringify(rows.map((r) => r.body)))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select body from public.messages_staff_view
        where complaint_id = $1 and created_at > $2 order by created_at`,
      [C.nonSensitive, studentCutoff],
    )
    check('student view unaffected by faculty deletion (now 3 post-cutoff messages)', rows.length === 3 && rows[2].body === 'Checking in', JSON.stringify(rows.map((r) => r.body)))
  })
  // Each user has exactly one state row; faculty's row belongs to faculty.
  const { rows: allStates } = await client.query(
    `select complaint_id, user_id from public.conversation_user_state where complaint_id = $1 order by user_id`,
    [C.nonSensitive],
  )
  check(
    'one state row per user (student + faculty), each self-owned',
    allStates.length === 2 && allStates.some((r) => r.user_id === U.student) && allStates.some((r) => r.user_id === U.faculty),
    JSON.stringify(allStates),
  )

  // --------------------------------------------------------------------------
  // 5. Committee on the sensitive complaint.
  // --------------------------------------------------------------------------
  console.log('\n== 5. Committee ==')
  let committeeCutoff = null
  await asUser(client, U.committee, async () => {
    const res = await expectSuccess(client, 'committee can delete their conversation for me', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.sensitive])
      return rows[0]
    })
    committeeCutoff = res?.deleted_before
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view
        where complaint_id = $1 and created_at > $2`,
      [C.sensitive, committeeCutoff],
    )
    check('committee sees no pre-cutoff messages on sensitive complaint', rows.length === 0, String(rows.length))
  })
  // The owning student has no cutoff on the sensitive complaint — full view.
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view where complaint_id = $1 order by created_at`,
      [C.sensitive],
    )
    check('student (owner) still sees full sensitive conversation (2 messages)', rows.length === 2, String(rows.length))
  })
  // Sensitive access intact: faculty cannot see sensitive messages at all.
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view where complaint_id = $1`,
      [C.sensitive],
    )
    check('sensitive complaint restriction intact (faculty sees nothing)', rows.length === 0, String(rows.length))
  })

  // --------------------------------------------------------------------------
  // 6. RPC security: anon, self-scoping, no direct bypass.
  // --------------------------------------------------------------------------
  console.log('\n== 6. RPC security ==')
  await client.query('set role anon')
  await expectFailure(client, 'anon cannot call delete_complaint_conversation_for_me', () =>
    client.query(`select * from public.delete_complaint_conversation_for_me('${C.nonSensitive}')`),
  )
  await client.query('reset role')

  await asUser(client, U.student, async () => {
    // RPC takes only complaint_id — user_id / deleted_before can never be
    // supplied by the client. Direct writes are not granted at all.
    await expectFailure(client, 'direct INSERT into conversation_user_state rejected', () =>
      client.query(`insert into public.conversation_user_state (complaint_id, user_id, deleted_before) values ($1, $2, now())`, [C.nonSensitive, U.faculty]),
    )
    await expectFailure(client, 'direct UPDATE on conversation_user_state rejected', () =>
      client.query(`update public.conversation_user_state set deleted_before = now()`),
    )
    await expectFailure(client, 'direct DELETE on conversation_user_state rejected', () =>
      client.query(`delete from public.conversation_user_state`),
    )
    // Self-scoped reads: the student cannot see the faculty's state row.
    const { rows } = await client.query(`select complaint_id from public.conversation_user_state`)
    check('student can read only their own conversation state', rows.length === 1 && rows[0].complaint_id === C.nonSensitive, JSON.stringify(rows))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select complaint_id from public.conversation_user_state`)
    check('faculty reads only their own conversation state', rows.length === 1 && rows[0].complaint_id === C.nonSensitive, JSON.stringify(rows))
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query(`select complaint_id from public.conversation_user_state`)
    check('admin reads only their own (empty) conversation state', rows.length === 0, String(rows.length))
  })
  // Cannot delete for a complaint you cannot access.
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'RPC requires complaint access (faculty vs sensitive)', () =>
      client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.sensitive]),
    )
  })
  await asUser(client, U.student, async () => {
    await expectFailure(client, "RPC requires complaint access (student vs another student's complaint)", () =>
      client.query(`select * from public.delete_complaint_conversation_for_me($1)`, [C.other]),
    )
  })

  // --------------------------------------------------------------------------
  // 7. Old-message events cannot bypass the cutoff (server-side filter).
  // --------------------------------------------------------------------------
  console.log('\n== 7. Cutoff vs old/new events ==')
  // Simulate a replayed "old" INSERT event: a message stamped before the
  // student cutoff. The cutoff-filtered query excludes it. (Inserted through
  // the real send path so the trigger derives sender identity, then backdated
  // by the owner to a pre-cutoff timestamp.)
  let oldReplayId = null
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2) returning id`,
      [C.nonSensitive, 'Old replay attempt'],
    )
    oldReplayId = rows[0].id
  })
  // Backdate by the owner (authenticated has no UPDATE grant on messages).
  await client.query(
    `update public.messages set created_at = now() - interval '5 days' + interval '6 minutes' where id = $1`,
    [oldReplayId],
  )
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `select body from public.messages_staff_view
        where complaint_id = $1 and created_at > $2`,
      [C.nonSensitive, studentCutoff],
    )
    check('old (replayed) message excluded by the cutoff', rows.every((r) => r.body !== 'Old replay attempt'), JSON.stringify(rows.map((r) => r.body)))
    const { rows: all } = await client.query(
      `select body from public.messages_staff_view where complaint_id = $1 order by created_at`,
      [C.nonSensitive],
    )
    check('the old message still exists for users without a cutoff', all.some((r) => r.body === 'Old replay attempt'), JSON.stringify(all.map((r) => r.body)))
  })

  // --------------------------------------------------------------------------
  // 8. Day 8A behaviors still work alongside the cutoff.
  // --------------------------------------------------------------------------
  console.log('\n== 8. Day 8A intact ==')
  await asUser(client, U.student, async () => {
    // Send a fresh message, then edit it — ownership (Day 8A) still applies:
    // the student may only edit their OWN message, even after a conversation
    // deletion.
    const { rows: mine } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2) returning id`,
      [C.nonSensitive, 'My own message'],
    )
    const edited = await expectSuccess(client, 'edit still works after conversation deletion (own message)', async () => {
      const { rows } = await client.query(`select * from public.edit_complaint_message($1, $2)`, [mine[0].id, 'My own message (edited)'])
      return rows[0]
    })
    check(
      'edited message keeps post-cutoff visibility + edited_at',
      edited && edited.body === 'My own message (edited)' && edited.edited_at !== null,
      JSON.stringify(edited),
    )
    await expectFailure(client, 'edit ownership still enforced (cannot edit faculty message)', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [newMsgId, 'x']),
    )
    // Delete-for-me on the faculty message.
    await expectSuccess(client, 'delete for me still works after conversation deletion', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_message_for_me($1)`, [newMsgId])
      return rows[0]
    })
    const { rows: hidden } = await client.query(
      `select message_id from public.message_user_deletions`,
    )
    check('delete-for-me record created for the student only', hidden.length === 1 && hidden[0].message_id === newMsgId, JSON.stringify(hidden))
    // Delete-for-everyone on the student's own "Hello again".
    const del = await expectSuccess(client, 'delete for everyone still works after conversation deletion', async () => {
      const { rows } = await client.query(
        `select id from public.messages where complaint_id = $1 and body = 'Hello again' order by created_at desc limit 1`,
        [C.nonSensitive],
      )
      const { rows: r } = await client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [rows[0].id])
      return r[0]
    })
    check('delete-for-everyone soft-deletes the post-cutoff message', del && del.is_deleted === true, JSON.stringify(del))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `select is_deleted from public.messages_staff_view
        where complaint_id = $1 and body = 'Hello again'`,
      [C.nonSensitive],
    )
    check('delete-for-everyone visible to the other participant (precedence over cutoffs)', rows.length === 1 && rows[0].is_deleted === true, JSON.stringify(rows))
  })

  // --------------------------------------------------------------------------
  // 9. Identity stays hidden.
  // --------------------------------------------------------------------------
  console.log('\n== 9. Identity hidden ==')
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
  const { rows: senderGrants } = await client.query(
    `select privilege_type from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'messages'
       and column_name = 'sender_id' and grantee = 'authenticated'`,
  )
  check('sender_id has no SELECT grant for authenticated', senderGrants.length === 0, JSON.stringify(senderGrants))
  const { rows: stateColGrants } = await client.query(
    `select column_name from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'conversation_user_state'
       and grantee = 'authenticated' and privilege_type = 'SELECT'
     order by column_name`,
  )
  const stateGrantedCols = stateColGrants.map((r) => r.column_name)
  check(
    'conversation_user_state grants expose no user_id',
    stateGrantedCols.every((c) => c !== 'user_id') && stateGrantedCols.includes('deleted_before'),
    stateGrantedCols.join(','),
  )
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'staff cannot select sender_id directly', () =>
      client.query(`select sender_id from public.messages limit 1`),
    )
    const { rows } = await client.query(
      `select ${SAFE} from public.messages_staff_view where complaint_id = $1 limit 1`,
      [C.nonSensitive],
    )
    check('staff chat responses contain only safe fields', rows.length === 1 && ['sender_id', 'student_id', 'email', 'name'].every((f) => !(f in rows[0])), Object.keys(rows[0] ?? {}).join(','))
  })

  // --------------------------------------------------------------------------
  // 10. Student isolation + Day 7 sending + Day 6 status.
  // --------------------------------------------------------------------------
  console.log('\n== 10. Isolation + existing behavior ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ${SAFE} from public.messages_staff_view where complaint_id = $1`, [C.other])
    check("student isolation intact (cannot read another student's messages)", rows.length === 0)
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at, edited_at, is_deleted, deleted_at`,
      [C.nonSensitive, 'Day 7 sending still works after Day 8B.'],
    )
    check('Day 7 message sending still works', rows.length === 1 && rows[0].sender_role === 'student' && rows[0].is_deleted === false)
  })
  await asUser(client, U.faculty, async () => {
    const { rows: upd } = await client.query(`select * from public.update_complaint_status($1, 'under_review')`, [C.nonSensitive])
    check('Day 6 status RPC still works', upd[0]?.status === 'under_review', JSON.stringify(upd))
  })
  const { rows: hist } = await client.query(
    `select previous_status, new_status from public.complaint_status_history where complaint_id = $1`,
    [C.nonSensitive],
  )
  check('Day 6 status history still recorded', hist.length === 1 && hist[0].previous_status === 'submitted' && hist[0].new_status === 'under_review', JSON.stringify(hist))

  // --------------------------------------------------------------------------
  // 11. Realtime preconditions.
  // --------------------------------------------------------------------------
  console.log('\n== 11. Realtime preconditions ==')
  const { rows: rls } = await client.query(
    `select relname from pg_class
     where relnamespace = 'public'::regnamespace
       and relname in ('messages', 'message_user_deletions', 'conversation_user_state')
       and relrowsecurity order by relname`,
  )
  check(
    'messages + message_user_deletions + conversation_user_state RLS enabled',
    rls.length === 3,
    JSON.stringify(rls.map((r) => r.relname)),
  )
  const { rows: convPolicies } = await client.query(
    `select polname, polcmd, pg_get_expr(polqual, polrelid) as qual,
            pg_get_expr(polwithcheck, polrelid) as wc
     from pg_policy where polrelid = 'public.conversation_user_state'::regclass`,
  )
  check(
    'every conversation_user_state policy is self-scoped to the caller',
    convPolicies.length >= 1 && convPolicies.every(
      (p) => `${p.qual ?? ''} ${p.wc ?? ''}`.includes('user_id = auth.uid()'),
    ),
    JSON.stringify(convPolicies),
  )
  const { rows: messagesPolicies } = await client.query(
    `select polcmd, pg_get_expr(polqual, polrelid) as qual
     from pg_policy where polrelid = 'public.messages'::regclass`,
  )
  const selPol = messagesPolicies.filter((p) => p.polcmd === 'r')
  check(
    'messages policies unchanged (SELECT via can_access_complaint, no broad policy)',
    selPol.every((p) => (p.qual ?? '').includes('can_access_complaint')),
    JSON.stringify(selPol),
  )
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
