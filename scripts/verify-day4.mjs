/**
 * Day 4 local verification harness.
 *
 * Boots a throwaway PostgreSQL instance (embedded-postgres, project-local
 * binaries under node_modules), stubs the Supabase `auth` schema, applies the
 * Day 3 migration unchanged, and exercises the exact complaint-submission
 * flow the Day 4 frontend uses (see src/lib/complaintService.js):
 *
 *   1. a student can fetch all 8 complaint categories (id + name) from
 *      public.complaint_categories — nothing is hardcoded in the frontend
 *   2. a student can insert a complaint sending only the fields they control
 *      (student_id, category_id, description, priority) and gets the
 *      generated ticket number back via INSERT ... RETURNING
 *   3. the database derives ticket_number / status / department_id /
 *      is_sensitive / handler_type — never the client
 *   4. sensitive categories (Harassment / Ragging) derive committee handling
 *   5. priority defaults to medium when omitted
 *   6. students cannot submit a complaint for another user (RLS)
 *   7. omitting student_id is rejected (schema + RLS)
 *   8. invalid priority and missing/unknown categories are rejected
 *   9. a student cannot forge derived columns (column grants)
 *  10. anon has no access at all (unauthenticated users cannot submit)
 *  11. every accepted submission gets a distinct CMP-XXXX ticket
 *  12. students only ever see their own complaints
 *
 * Duplicate-click protection itself is enforced in the React form (disabled
 * submit button + an in-flight guard); the database side guarantees that
 * every accepted submission gets a unique ticket.
 *
 * Usage:  node scripts/verify-day4.mjs
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
const DB_DIR = path.join(root, '.tmp', 'day4-pgdata')
const PORT = 55434

const U = {
  student: '11111111-1111-1111-1111-111111111111',
  other: '22222222-2222-2222-2222-222222222222',
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
  // Apply the Day 3 migration unchanged (it is the live foundation).
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

  // Seed one student (+ a second user for the isolation checks). The sign-up
  // trigger creates their profiles with role 'student'.
  await client.query(
    `insert into auth.users (id, email) values ($1, 'student@example.com'), ($2, 'other@example.com')`,
    [U.student, U.other],
  )
  const { rows: profileRows } = await client.query(
    `select id, role from public.profiles order by email`,
  )
  check(
    'sign-up trigger created both student profiles',
    profileRows.length === 2 && profileRows.every((r) => r.role === 'student'),
    JSON.stringify(profileRows),
  )

  // --------------------------------------------------------------------------
  // 1. Categories are fetched from the database (never hardcoded).
  // --------------------------------------------------------------------------
  console.log('\n== 1. Categories ==')
  const { rows: cats } = await client.query(
    `select id, name from public.complaint_categories order by name`,
  )
  const expectedNames = [
    'Academics',
    'Labs',
    'Faculty / Teaching',
    'Department Infrastructure',
    'Equipment',
    'IT / Network',
    'Department Administration',
    'Harassment / Ragging',
  ]
  check('exactly 8 categories', cats.length === 8, JSON.stringify(cats.map((c) => c.name)))
  for (const name of expectedNames) {
    check(`category present: ${name}`, cats.some((c) => c.name === name))
  }
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  // --------------------------------------------------------------------------
  // 2. The Day 4 submission flow (exact client payload).
  // --------------------------------------------------------------------------
  console.log('\n== 2. Submission flow ==')
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values (auth.uid(), $1, 'The projector in Lab 4 flickers constantly during lectures.', 'high')
       returning id, ticket_number, status, department_id, is_sensitive, handler_type`,
      [catId['Academics']],
    )
    const r = rows[0]
    check('student can submit a complaint (payload accepted)', !!r?.ticket_number, JSON.stringify(r))
    check('ticket number CMP-0001 (first sequence value)', r?.ticket_number === 'CMP-0001', r?.ticket_number)
    check('status derived to submitted', r?.status === 'submitted', r?.status)
    check('is_sensitive derived false for Academics', r?.is_sensitive === false)
    check('handler_type derived department (non-sensitive)', r?.handler_type === 'department', r?.handler_type)
    check('department_id derived (ECS)', !!r?.department_id)
    const { rows: dept } = await client.query(`select name from public.departments where id = $1`, [
      r?.department_id,
    ])
    check('derived department is ECS', dept[0]?.name === 'ECS', dept[0]?.name)

    // Sensitive category -> committee handling, all derived server-side.
    const { rows: sens } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values (auth.uid(), $1, 'I have been facing harassment and want it reported.', 'urgent')
       returning ticket_number, is_sensitive, handler_type`,
      [catId['Harassment / Ragging']],
    )
    check('sensitive category -> is_sensitive true', sens[0]?.is_sensitive === true)
    check(
      'sensitive category -> handler_type committee',
      sens[0]?.handler_type === 'committee',
      sens[0]?.handler_type,
    )

    // Priority default when omitted.
    const { rows: def } = await client.query(
      `insert into public.complaints (student_id, category_id, description)
       values (auth.uid(), $1, 'Default priority should be medium for this issue.')
       returning priority`,
      [catId['Labs']],
    )
    check('priority defaults to medium', def[0]?.priority === 'medium', def[0]?.priority)

    // Derived columns are excluded from the INSERT grant, so a student cannot
    // forge ticket_number / is_sensitive / handler_type / department_id at all.
    await expectFailure(client, 'student cannot forge derived columns (column grant)', () =>
      client.query(
        `insert into public.complaints (student_id, category_id, description, priority,
                                        ticket_number, is_sensitive, handler_type, department_id)
         values (auth.uid(), $1, 'Trying to forge derived values should not work.', 'low',
                 'CMP-FORGED', true, 'committee', null)`,
        [catId['Equipment']],
      ),
    )
  })

  // --------------------------------------------------------------------------
  // 3. Rejections.
  // --------------------------------------------------------------------------
  console.log('\n== 3. Rejections ==')
  await asUser(client, U.student, async () => {
    // A student cannot file a complaint for another user (RLS check).
    await expectFailure(client, 'submitting for another user is rejected', () =>
      client.query(
        `insert into public.complaints (student_id, category_id, description, priority)
         values ($1, $2, 'trying to file for someone else', 'medium')`,
        [U.other, catId['Academics']],
      ),
    )
    // Omitting student_id is rejected (NOT NULL + RLS with check).
    await expectFailure(client, 'omitting student_id is rejected', () =>
      client.query(
        `insert into public.complaints (category_id, description, priority)
         values ($1, 'no student id provided', 'medium')`,
        [catId['Academics']],
      ),
    )
    // Invalid priority is rejected by the enum.
    await expectFailure(client, 'invalid priority is rejected', () =>
      client.query(
        `insert into public.complaints (student_id, category_id, description, priority)
         values (auth.uid(), $1, 'invalid priority value test', 'critical')`,
        [catId['Academics']],
      ),
    )
    // Unknown category is rejected by the FK.
    await expectFailure(client, 'unknown category is rejected', () =>
      client.query(
        `insert into public.complaints (student_id, category_id, description, priority)
         values (auth.uid(), '00000000-0000-0000-0000-000000000000', 'unknown category test', 'medium')`,
      ),
    )
    // Missing category is rejected by NOT NULL.
    await expectFailure(client, 'missing category is rejected', () =>
      client.query(
        `insert into public.complaints (student_id, category_id, description, priority)
         values (auth.uid(), null, 'missing category test', 'medium')`,
      ),
    )
  })

  // --------------------------------------------------------------------------
  // 4. anon (unauthenticated) has no access at all.
  // --------------------------------------------------------------------------
  console.log('\n== 4. anon ==')
  await client.query('set role anon')
  await expectFailure(client, 'anon cannot insert a complaint', () =>
    client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values ('${U.student}', $1, 'anon attempt', 'medium')`,
      [catId['Academics']],
    ),
  )
  await expectFailure(client, 'anon cannot read categories', () =>
    client.query('select * from public.complaint_categories limit 1'),
  )
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 5. Distinct tickets for every accepted submission.
  // --------------------------------------------------------------------------
  console.log('\n== 5. Ticket uniqueness ==')
  await asUser(client, U.student, async () => {
    const tickets = []
    for (const [desc, prio] of [
      ['A fourth complaint with a distinct description.', 'low'],
      ['A fifth complaint with a distinct description.', 'medium'],
      ['A sixth complaint with a distinct description.', 'urgent'],
    ]) {
      const { rows } = await client.query(
        `insert into public.complaints (student_id, category_id, description, priority)
         values (auth.uid(), $1, $2, $3)
         returning ticket_number`,
        [catId['IT / Network'], desc, prio],
      )
      tickets.push(rows[0].ticket_number)
    }
    const unique = new Set(tickets)
    check(
      '3 more submissions -> 3 distinct CMP-XXXX tickets',
      unique.size === 3 && tickets.every((t) => /^CMP-\d{4}$/.test(t)),
      tickets.join(','),
    )
    // Failed inserts may or may not consume sequence numbers, so only require
    // that the new tickets are distinct from the three known-good ones.
    check(
      'new tickets differ from the first three',
      tickets.every((t) => !['CMP-0001', 'CMP-0002', 'CMP-0003'].includes(t)),
      tickets.join(','),
    )
  })

  // --------------------------------------------------------------------------
  // 6. Student isolation — students only see their own complaints.
  // --------------------------------------------------------------------------
  console.log('\n== 6. Student isolation ==')
  await asUser(client, U.other, async () => {
    const { rows } = await client.query('select ticket_number from public.complaints')
    check('other student sees zero complaints', rows.length === 0, JSON.stringify(rows))
  })
  await asUser(client, U.student, async () => {
    const { rows } = await client.query(
      'select ticket_number from public.complaints order by ticket_number',
    )
    check(
      'student sees own 6 complaints only (3 + 3)',
      rows.length === 6,
      JSON.stringify(rows.map((r) => r.ticket_number)),
    )
    await expectFailure(client, 'student cannot read student_id column', () =>
      client.query('select student_id from public.complaints limit 1'),
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
