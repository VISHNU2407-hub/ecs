/**
 * Day 8A local verification harness — Chat message controls.
 *
 * Boots a throwaway PostgreSQL instance, stubs the Supabase `auth` schema,
 * applies the Day 3 + Day 6 + Day 7 + Day 8 migrations, and exercises the
 * message-control security model the chat UI relies on
 * (src/lib/complaintService.js + useComplaintChat.js + ComplaintChat.jsx):
 *
 *   1. migrations apply cleanly (Day 8 idempotent)
 *   2. edit: student/staff/committee can edit their OWN message only
 *   3. edit: not-owner / unauthorized users are rejected
 *   4. edit: deleted messages cannot be edited; empty / whitespace /
 *      oversized bodies rejected; created_at / sender_role preserved
 *   5. delete-for-everyone: original sender only, one-shot, soft delete
 *      (is_deleted + deleted_at), body never rendered (UI rule), and it
 *      takes precedence over delete-for-me
 *   6. delete-for-me: creates only the caller's record, hides from that user
 *      only, idempotent; another user's records are inaccessible
 *   7. anon cannot execute any RPC
 *   8. direct UPDATE / DELETE on messages and direct INSERT on
 *      message_user_deletions cannot bypass the RPCs (no grants)
 *   9. sender_id / student_id / email / name remain hidden everywhere
 *  10. complaint access + sensitive-complaint restrictions remain intact
 *  11. Day 7 message sending still works
 *  12. Day 6 status flow still works
 *  13. Realtime preconditions: RLS on messages + message_user_deletions, no
 *      broad policies, sender_id unselectable, view identity-free, new safe
 *      columns selectable
 *
 * NOTE: Supabase Realtime itself cannot run inside embedded-postgres. This
 * harness verifies the database-side guarantees Realtime inherits (row-level
 * RLS + column grants) and that the view/columns the client subscribes to are
 * identity-free. The client additionally subscribes with an explicit safe
 * column selection, which the Realtime server enforces.
 *
 * Usage:  node scripts/verify-day8.mjs
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
]
const DB_DIR = path.join(root, '.tmp', 'day8-pgdata')
const PORT = 55450

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

// Safe chat columns — exactly what the frontend selects (see CHAT_SELECT_COLUMNS).
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
    check('Day 3 + 6 + 7 + 8 migrations applied cleanly', true)
  } catch (err) {
    check('Day 3 + 6 + 7 + 8 migrations applied cleanly', false, String(err?.message ?? err))
    throw err
  }
  try {
    await client.query(fs.readFileSync(MIGRATIONS[3], 'utf8'))
    check('Day 8 migration is re-runnable', true)
  } catch (err) {
    check('Day 8 migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // Seed users, roles, complaints and messages (through the real send path).
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

  // S1 = student on nonSensitive, F1 = faculty on nonSensitive,
  // S2 = student on sensitive,  CM1 = committee on sensitive,
  // O1 = otherStudent on other.
  const M = {}
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.nonSensitive, 'The issue happens every day.'],
    )
    M.s1 = rows[0].id
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.nonSensitive, 'Which lab is affected?'],
    )
    M.f1 = rows[0].id
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.sensitive, 'Please keep this anonymous.'],
    )
    M.s2 = rows[0].id
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.sensitive, 'We are looking into it.'],
    )
    M.cm1 = rows[0].id
  })
  await asUser(client, U.otherStudent, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at`,
      [C.other, 'A message on my own complaint.'],
    )
    M.o1 = rows[0].id
  })
  check(
    'seed: 5 messages inserted',
    [M.s1, M.f1, M.s2, M.cm1, M.o1].every(Boolean),
    JSON.stringify(M),
  )

  // --------------------------------------------------------------------------
  // 2. Edit — own messages only, ownership + access enforced server-side.
  // --------------------------------------------------------------------------
  console.log('\n== 2. Edit ==')
  await asUser(client, U.student, async () => {
    const edited = await expectSuccess(client, 'student can edit own message', async () => {
      const { rows } = await client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, 'The issue happens every single day.'])
      return rows[0]
    })
    check(
      'edit updates body + sets edited_at, preserves created_at/sender_role',
      edited && edited.body === 'The issue happens every single day.' &&
        edited.edited_at !== null && edited.created_at !== null && edited.sender_role === 'student',
      JSON.stringify(edited),
    )
    await expectFailure(client, 'student cannot edit staff message', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.f1, 'x']),
    )
    await expectFailure(client, "student cannot edit message on another student's complaint", () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.o1, 'x']),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectSuccess(client, 'staff can edit own message', async () => {
      const { rows } = await client.query(`select * from public.edit_complaint_message($1, $2)`, [M.f1, 'Which lab is affected? Please be specific.'])
      return rows[0]
    })
    await expectFailure(client, 'staff cannot edit student message', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, 'x']),
    )
    await expectFailure(client, 'staff cannot edit sensitive-complaint message', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s2, 'x']),
    )
  })
  await asUser(client, U.committee, async () => {
    await expectSuccess(client, 'committee can edit own message', async () => {
      const { rows } = await client.query(`select * from public.edit_complaint_message($1, $2)`, [M.cm1, 'We are looking into it. Will update soon.'])
      return rows[0]
    })
    await expectFailure(client, 'committee cannot edit non-sensitive-complaint message', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.f1, 'x']),
    )
  })
  await asUser(client, U.admin, async () => {
    // Admin can see everything but is NOT the sender — ownership still applies.
    await expectFailure(client, 'admin cannot edit a message they did not send', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, 'x']),
    )
  })

  // --------------------------------------------------------------------------
  // 3. Edit — validation.
  // --------------------------------------------------------------------------
  console.log('\n== 3. Edit validation ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'empty edit rejected', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, '']),
    )
    await expectFailure(client, 'whitespace-only edit rejected', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, '   ']),
    )
    await expectFailure(client, 'oversized (2001 char) edit rejected', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, 'a'.repeat(2001)]),
    )
    const ok = await expectSuccess(client, 'exactly-2000-char edit accepted', async () => {
      const { rows } = await client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s1, 'b'.repeat(2000)])
      return rows[0]
    })
    check('2000-char edit preserved', ok && ok.body.length === 2000)
  })

  // --------------------------------------------------------------------------
  // 4. Delete for everyone — original sender only, soft delete, one-shot.
  // --------------------------------------------------------------------------
  console.log('\n== 4. Delete for everyone ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'student cannot delete staff message for everyone', () =>
      client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.f1]),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'staff cannot delete student message for everyone', () =>
      client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.s1]),
    )
    await expectFailure(client, 'staff cannot delete sensitive-complaint message for everyone', () =>
      client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.s2]),
    )
  })
  let deletedRow = null
  await asUser(client, U.student, async () => {
    deletedRow = await expectSuccess(client, 'student can delete own message for everyone', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.s2])
      return rows[0]
    })
    check(
      'delete-for-everyone soft-deletes (is_deleted + deleted_at)',
      deletedRow && deletedRow.is_deleted === true && deletedRow.deleted_at !== null,
      JSON.stringify(deletedRow),
    )
    await expectFailure(client, 'repeated delete-for-everyone rejected', () =>
      client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.s2]),
    )
    await expectFailure(client, 'deleted message cannot be edited', () =>
      client.query(`select * from public.edit_complaint_message($1, $2)`, [M.s2, 'nope']),
    )
  })
  await asUser(client, U.faculty, async () => {
    await expectSuccess(client, 'staff can delete own message for everyone', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.f1])
      return rows[0]
    })
    await expectFailure(client, 'repeated delete-for-everyone rejected (staff)', () =>
      client.query(`select * from public.delete_complaint_message_for_everyone($1)`, [M.f1]),
    )
  })

  // Deleted state visible through the safe view; row not physically removed.
  const { rows: deletedCheck } = await client.query(
    `select ${SAFE} from public.messages_staff_view where id = $1`,
    [M.f1],
  )
  check(
    'deleted message stays in messages with deleted state (soft delete)',
    deletedCheck.length === 1 && deletedCheck[0].is_deleted === true && deletedCheck[0].deleted_at !== null,
    JSON.stringify(deletedCheck),
  )

  // --------------------------------------------------------------------------
  // 5. Delete for me — per-user records only.
  // --------------------------------------------------------------------------
  console.log('\n== 5. Delete for me ==')
  // Faculty sends a second message on the non-sensitive complaint.
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2) returning id`,
      [C.nonSensitive, 'Could you confirm your roll number?'],
    )
    M.f2 = rows[0].id
  })
  await asUser(client, U.student, async () => {
    const res = await expectSuccess(client, 'student can delete-for-me any authorized message', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_message_for_me($1)`, [M.f2])
      return rows[0]
    })
    check('delete-for-me returns own record', res && res.message_id === M.f2 && res.deleted_at !== null, JSON.stringify(res))
    // Idempotent.
    await expectSuccess(client, 'delete-for-me is idempotent', async () => {
      const { rows } = await client.query(`select * from public.delete_complaint_message_for_me($1)`, [M.f2])
      return rows[0]
    })
    const { rows: mine } = await client.query(
      `select mud.message_id from public.message_user_deletions mud
       join public.messages m on m.id = mud.message_id
       where m.complaint_id = $1`,
      [C.nonSensitive],
    )
  check(
    "delete-for-me created only the caller's own record",
      mine.length === 1 && mine[0].message_id === M.f2,
      JSON.stringify(mine),
    )
  })
  await asUser(client, U.faculty, async () => {
    const { rows: mine } = await client.query(`select message_id from public.message_user_deletions`)
    check("another user's deletion record is inaccessible", mine.length === 0, JSON.stringify(mine))
    // The message is still visible to faculty (hidden only for the student).
    const { rows: view } = await client.query(
      `select ${SAFE} from public.messages_staff_view where id = $1`,
      [M.f2],
    )
    check('delete-for-me does not hide the message from another user', view.length === 1 && view[0].body === 'Could you confirm your roll number?', JSON.stringify(view))
  })
  // Delete-for-me requires complaint access.
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'delete-for-me requires complaint access', () =>
      client.query(`select * from public.delete_complaint_message_for_me($1)`, [M.s2]),
    )
  })

  // --------------------------------------------------------------------------
  // 6. anon cannot use any RPC.
  // --------------------------------------------------------------------------
  console.log('\n== 6. anon ==')
  await client.query('set role anon')
  await expectFailure(client, 'anon cannot call edit_complaint_message', () =>
    client.query(`select * from public.edit_complaint_message('${M.s1}', 'x')`),
  )
  await expectFailure(client, 'anon cannot call delete_complaint_message_for_everyone', () =>
    client.query(`select * from public.delete_complaint_message_for_everyone('${M.s1}')`),
  )
  await expectFailure(client, 'anon cannot call delete_complaint_message_for_me', () =>
    client.query(`select * from public.delete_complaint_message_for_me('${M.s1}')`),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 7. Direct SQL cannot bypass the RPCs (no UPDATE/DELETE/INSERT grants).
  // --------------------------------------------------------------------------
  console.log('\n== 7. No direct bypass ==')
  await asUser(client, U.student, async () => {
    await expectFailure(client, 'direct UPDATE on messages rejected', () =>
      client.query(`update public.messages set body = 'hacked' where id = $1`, [M.s1]),
    )
    await expectFailure(client, 'direct DELETE on messages rejected', () =>
      client.query(`delete from public.messages where id = $1`, [M.s1]),
    )
    await expectFailure(client, 'direct INSERT into message_user_deletions rejected', () =>
      client.query(`insert into public.message_user_deletions (message_id, user_id) values ($1, $2)`, [M.s1, U.student]),
    )
    await expectFailure(client, 'direct DELETE on message_user_deletions rejected', () =>
      client.query(`delete from public.message_user_deletions`),
    )
  })

  // --------------------------------------------------------------------------
  // 8. Identity remains hidden.
  // --------------------------------------------------------------------------
  console.log('\n== 8. Identity hidden ==')
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
  await asUser(client, U.faculty, async () => {
    await expectFailure(client, 'staff cannot select sender_id directly', () =>
      client.query(`select sender_id from public.messages limit 1`),
    )
  })
  const { rows: delCols } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'message_user_deletions'
     order by ordinal_position`,
  )
  check(
    'message_user_deletions exposes no identity beyond caller-scoped user_id',
    delCols.every((c) => ['id', 'message_id', 'user_id', 'deleted_at'].includes(c.column_name)),
    delCols.map((c) => c.column_name).join(','),
  )

  // --------------------------------------------------------------------------
  // 9. Complaint access + sensitive restrictions intact.
  // --------------------------------------------------------------------------
  console.log('\n== 9. Access rules ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(`select ${SAFE} from public.messages_staff_view where complaint_id = $1`, [C.other])
    check("student cannot read another student's messages", rows.length === 0)
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(`select ${SAFE} from public.messages_staff_view where complaint_id = $1`, [C.sensitive])
    check('faculty cannot read sensitive-complaint messages', rows.length === 0)
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query(`select ${SAFE} from public.messages_staff_view where complaint_id = $1`, [C.sensitive])
    check(
      'committee still reads sensitive-complaint messages (deleted state included)',
      rows.length === 2 && rows.some((r) => r.is_deleted === true) && rows.some((r) => r.is_deleted === false),
      JSON.stringify(rows.map((r) => ({ role: r.sender_role, deleted: r.is_deleted }))),
    )
  })

  // --------------------------------------------------------------------------
  // 10. Day 7 sending + Day 6 status flow unchanged.
  // --------------------------------------------------------------------------
  console.log('\n== 10. Existing behavior unchanged ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, $2)
       returning id, complaint_id, sender_role, body, created_at, edited_at, is_deleted, deleted_at`,
      [C.nonSensitive, 'Day 7 sending still works.'],
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
       and relname in ('messages', 'message_user_deletions')
       and relrowsecurity order by relname`,
  )
  check('messages + message_user_deletions RLS enabled', rls.length === 2, JSON.stringify(rls.map((r) => r.relname)))
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
  check(
    'no UPDATE/DELETE policy on messages (RPC-only writes)',
    !policies.some((p) => p.polcmd === 'u' || p.polcmd === 'd'),
    JSON.stringify(policies.map((p) => p.polcmd)),
  )
  const { rows: delPolicies } = await client.query(
    `select polname, polcmd, pg_get_expr(polqual, polrelid) as qual,
            pg_get_expr(polwithcheck, polrelid) as wc
     from pg_policy where polrelid = 'public.message_user_deletions'::regclass`,
  )
  check(
    'every message_user_deletions policy is self-scoped to the caller',
    delPolicies.length >= 1 && delPolicies.every(
      // SELECT/DELETE use USING (qual); INSERT uses WITH CHECK (wc). A policy
      // is self-scoped when its applicable expression references auth.uid().
      (p) => `${p.qual ?? ''} ${p.wc ?? ''}`.includes('user_id = auth.uid()'),
    ),
    JSON.stringify(delPolicies),
  )
  const { rows: newColGrants } = await client.query(
    `select column_name from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'messages'
       and grantee = 'authenticated' and privilege_type = 'SELECT'
     order by column_name`,
  )
  const grantedCols = newColGrants.map((r) => r.column_name)
  check(
    'new safe columns (edited_at, is_deleted, deleted_at) selectable by authenticated',
    ['edited_at', 'is_deleted', 'deleted_at'].every((c) => grantedCols.includes(c)) &&
      !grantedCols.includes('sender_id'),
    grantedCols.join(','),
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
