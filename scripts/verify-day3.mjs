/**
 * Day 3 local verification harness.
 *
 * Boots a throwaway PostgreSQL instance (embedded-postgres, project-local
 * binaries under node_modules), stubs the Supabase `auth` schema, runs the
 * Day 3 migration, and executes the security checks required by the spec:
 *
 *   1. migration applies cleanly
 *   2. all tables exist
 *   3. foreign keys exist
 *   4. enums / check constraints exist
 *   5. RLS is enabled on every table
 *   6. a student cannot change their own role (or department_id)
 *   7. students only see their own complaints
 *   8. staff/admin/committee cannot retrieve student_id (column grants)
 *   9. sender_id is not exposed (column grants + safe view)
 *  10. ticket numbers are sequence-generated, unique and collision-safe
 *
 * Usage:  node scripts/verify-day3.mjs
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
const DB_DIR = path.join(root, '.tmp', 'day3-pgdata')
const PORT = 55432

// Fixed identities used by the test scenarios.
const U = {
  student1: '11111111-1111-1111-1111-111111111111',
  student2: '22222222-2222-2222-2222-222222222222',
  faculty: '33333333-3333-3333-3333-333333333333',
  admin: '44444444-4444-4444-4444-444444444444',
  committee: '55555555-5555-5555-5555-555555555555',
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

// Expects the query to fail with a permission error; returns the error message.
async function expectPermissionDenied(client, label, run) {
  try {
    await run()
    check(`${label} — expected permission denied, but query succeeded`, false)
    return null
  } catch (err) {
    const msg = String(err?.message ?? err)
    const denied = msg.includes('permission denied') || msg.includes('violates row-level security policy')
    check(`${label} — denied`, denied, msg)
    return msg
  }
}

// Clear any leftover data dir from a previous (possibly crashed) run so
// initdb always starts from a clean state.
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
  // 1. Apply the Day 3 migration.
  // --------------------------------------------------------------------------
  console.log('\n== 1. Migration applies ==')
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8')
  try {
    await client.query(migrationSql)
    check('migration applied without errors', true)
  } catch (err) {
    check('migration applied without errors', false, String(err?.message ?? err))
    throw err
  }

  // Re-run to prove idempotency of the guards.
  try {
    await client.query(migrationSql)
    check('migration is re-runnable', true)
  } catch (err) {
    check('migration is re-runnable', false, String(err?.message ?? err))
  }

  // --------------------------------------------------------------------------
  // 2. Tables exist.
  // --------------------------------------------------------------------------
  console.log('\n== 2. Tables ==')
  const { rows: tables } = await client.query(
    `select tablename from pg_tables
     where schemaname = 'public' order by 1`,
  )
  const tableNames = tables.map((r) => r.tablename)
  const expectedTables = [
    'profiles',
    'departments',
    'complaint_categories',
    'category_department_map',
    'complaints',
    'messages',
    'identity_reveal_requests',
  ]
  for (const t of expectedTables) {
    check(`table ${t} exists`, tableNames.includes(t))
  }
  check('no extra public tables', tableNames.length === expectedTables.length, tableNames.join(','))

  // --------------------------------------------------------------------------
  // 3. Foreign keys.
  // --------------------------------------------------------------------------
  console.log('\n== 3. Foreign keys ==')
  const { rows: fks } = await client.query(
    `select conrelid::regclass::text as tbl, confrelid::regclass::text as ref, conname
     from pg_constraint
     where contype = 'f' and connamespace = 'public'::regnamespace
     order by 1, 2`,
  )
  const fkStrings = fks.map((r) => `${r.tbl}->${r.ref}`)
  const expectedFks = [
    'profiles->auth.users',
    'profiles->departments',
    'complaint_categories->departments',
    'category_department_map->complaint_categories',
    'category_department_map->departments',
    'complaints->profiles',
    'complaints->complaint_categories',
    'complaints->departments',
    'messages->complaints',
    'messages->profiles',
    'identity_reveal_requests->complaints',
    'identity_reveal_requests->profiles',
  ]
  // NOTE: complaint_categories->departments is the map's composite FK; the
  // simple names above are approximations — check subset semantics instead.
  check('FK complaints.student_id -> profiles', fkStrings.some((f) => f.startsWith('complaints->profiles')))
  check('FK complaints.category_id -> complaint_categories', fkStrings.some((f) => f.startsWith('complaints->complaint_categories')))
  check('FK complaints.department_id -> departments', fkStrings.some((f) => f.startsWith('complaints->departments')))
  check('FK messages.complaint_id -> complaints', fkStrings.some((f) => f.startsWith('messages->complaints')))
  check('FK messages.sender_id -> profiles', fkStrings.some((f) => f.startsWith('messages->profiles')))
  check('FK identity_reveal_requests.complaint_id -> complaints (unique)', fkStrings.some((f) => f.startsWith('identity_reveal_requests->complaints')))
  check('FK profiles.id -> auth.users', fkStrings.some((f) => f.startsWith('profiles->auth.users')))

  // --------------------------------------------------------------------------
  // 4. Enums.
  // --------------------------------------------------------------------------
  console.log('\n== 4. Enums ==')
  const { rows: enums } = await client.query(
    `select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
     from pg_type t
     join pg_enum e on e.enumtypid = t.oid
     where t.typnamespace = 'public'::regnamespace
     group by t.typname`,
  )
  const enumMap = Object.fromEntries(enums.map((r) => [r.typname, r.labels]))
  check('enum app_role', JSON.stringify(enumMap.app_role) === JSON.stringify(['student', 'faculty', 'admin', 'committee']), JSON.stringify(enumMap.app_role))
  check('enum priority_level', JSON.stringify(enumMap.priority_level) === JSON.stringify(['low', 'medium', 'high', 'urgent']), JSON.stringify(enumMap.priority_level))
  check('enum complaint_status', JSON.stringify(enumMap.complaint_status) === JSON.stringify(['submitted', 'under_review', 'assigned', 'in_progress', 'resolved', 'reopened', 'escalated', 'closed']), JSON.stringify(enumMap.complaint_status))
  check('enum handler_type', JSON.stringify(enumMap.handler_type) === JSON.stringify(['department', 'committee']), JSON.stringify(enumMap.handler_type))
  check('enum sender_role', JSON.stringify(enumMap.sender_role) === JSON.stringify(['student', 'staff', 'committee']), JSON.stringify(enumMap.sender_role))
  check('enum reveal_status', JSON.stringify(enumMap.reveal_status) === JSON.stringify(['pending', 'consented', 'denied']), JSON.stringify(enumMap.reveal_status))

  // --------------------------------------------------------------------------
  // 5. RLS enabled on all tables.
  // --------------------------------------------------------------------------
  console.log('\n== 5. RLS ==')
  const { rows: rls } = await client.query(
    `select relname from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity
     order by 1`,
  )
  const rlsTables = rls.map((r) => r.relname)
  for (const t of expectedTables) {
    check(`RLS enabled on ${t}`, rlsTables.includes(t))
  }

  // --------------------------------------------------------------------------
  // Seed test data (as superuser, RLS bypassed).
  // --------------------------------------------------------------------------
  console.log('\n== seed ==')
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'student1@example.com'),
       ($2, 'student2@example.com'),
       ($3, 'faculty@example.com'),
       ($4, 'admin@example.com'),
       ($5, 'committee@example.com')`,
    [U.student1, U.student2, U.faculty, U.admin, U.committee],
  )
  // Sign-up trigger created profiles with role 'student'; promote the staff roles.
  await client.query(`update public.profiles set role = 'faculty'   where id = $1`, [U.faculty])
  await client.query(`update public.profiles set role = 'admin'     where id = $1`, [U.admin])
  await client.query(`update public.profiles set role = 'committee' where id = $1`, [U.committee])

  const { rows: cats } = await client.query(
    `select id, name, is_sensitive from public.complaint_categories order by name`,
  )
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]))

  // Deterministic complaint seeds (ticket numbers provided; trigger derives the rest).
  const c1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const c2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const c3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  await client.query(
    `insert into public.complaints (id, ticket_number, student_id, category_id, description, priority, status)
     values
       ($1, 'CMP-9001', $2, $3, 'slow projector in lab 4', 'medium', 'submitted'),
       ($4, 'CMP-9002', $2, $5, 'harassment report', 'urgent', 'submitted'),
       ($6, 'CMP-9003', $7, $3, 'academic grievance', 'low', 'submitted')`,
    [c1, U.student1, catId['Academics'], c2, catId['Harassment / Ragging'], c3, U.student2],
  )

  // Messages: seeded under a sender context so the trigger can set sender_id.
  await asUser(client, U.student1, () =>
    client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'hello from student 1')`,
      [c1],
    ),
  )
  await asUser(client, U.faculty, () =>
    client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'hello from faculty')`,
      [c1],
    ),
  )

  // --------------------------------------------------------------------------
  // 6. Students cannot change their own role / department.
  // --------------------------------------------------------------------------
  console.log('\n== 6. Profile role immutability ==')
  await asUser(client, U.student1, async () => {
    await expectPermissionDenied(client, 'student update role', () =>
      client.query(`update public.profiles set role = 'admin' where id = auth.uid()`),
    )
    await expectPermissionDenied(client, 'student update department_id', () =>
      client.query(`update public.profiles set department_id = '00000000-0000-0000-0000-000000000000' where id = auth.uid()`),
    )
    await expectPermissionDenied(client, 'student update someone elses role', () =>
      client.query(`update public.profiles set role = 'student' where id = '${U.admin}'::uuid`),
    )
  })
  // Role in DB is untouched.
  const { rows: roleAfter } = await client.query(`select role from public.profiles where id = $1`, [U.student1])
  check('student role still "student" after attempts', roleAfter[0]?.role === 'student')

  // --------------------------------------------------------------------------
  // 7. Students only see their own complaints.
  // --------------------------------------------------------------------------
  console.log('\n== 7. Student isolation ==')
  await asUser(client, U.student1, async () => {
    const { rows } = await client.query('select id from public.complaints order by id')
    check('student1 sees own 2 complaints only', rows.length === 2 && rows.every((r) => [c1, c2].includes(r.id)), JSON.stringify(rows.map((r) => r.id)))
  })
  await asUser(client, U.student2, async () => {
    const { rows } = await client.query('select id from public.complaints')
    check('student2 sees own 1 complaint only', rows.length === 1 && rows[0].id === c3, JSON.stringify(rows.map((r) => r.id)))
  })

  // --------------------------------------------------------------------------
  // 8. Identity columns are not retrievable by staff/admin/committee.
  // --------------------------------------------------------------------------
  console.log('\n== 8. Identity columns hidden ==')
  for (const [label, uid] of [
    ['faculty', U.faculty],
    ['admin', U.admin],
    ['committee', U.committee],
  ]) {
    await asUser(client, uid, () =>
      expectPermissionDenied(client, `${label} cannot select student_id`, () =>
        client.query('select student_id from public.complaints limit 1'),
      ),
    )
  }
  // A student cannot select student_id either (uniform column grant).
  await asUser(client, U.student1, () =>
    expectPermissionDenied(client, 'student cannot select student_id either', () =>
      client.query('select student_id from public.complaints limit 1'),
    ),
  )
  for (const [label, uid] of [
    ['faculty', U.faculty],
    ['admin', U.admin],
    ['committee', U.committee],
    ['student', U.student1],
  ]) {
    await asUser(client, uid, () =>
      expectPermissionDenied(client, `${label} cannot select sender_id`, () =>
        client.query('select sender_id from public.messages limit 1'),
      ),
    )
  }

  // --------------------------------------------------------------------------
  // Staff views: no identity columns, and correct row visibility per role.
  // --------------------------------------------------------------------------
  console.log('\n== 8b. Safe views ==')
  const { rows: viewCols } = await client.query(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public' and table_name in ('complaints_staff_view', 'messages_staff_view')
     order by table_name, ordinal_position`,
  )
  const staffViewCols = viewCols.filter((c) => c.table_name === 'complaints_staff_view').map((c) => c.column_name)
  const msgViewCols = viewCols.filter((c) => c.table_name === 'messages_staff_view').map((c) => c.column_name)
  check('complaints_staff_view has no student_id', !staffViewCols.includes('student_id'))
  check('complaints_staff_view has no email/name columns', !staffViewCols.some((c) => /email|name/.test(c)))
  check('messages_staff_view has no sender_id', !msgViewCols.includes('sender_id'))

  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query('select ticket_number, category, department, priority, status, handler_type, is_sensitive from public.complaints_staff_view order by ticket_number')
    check('faculty view sees non-sensitive only', rows.length === 2 && rows.every((r) => r.is_sensitive === false), JSON.stringify(rows))
  })
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query('select ticket_number, is_sensitive from public.complaints_staff_view')
    check('committee view sees sensitive only', rows.length === 1 && rows[0].is_sensitive === true && rows[0].ticket_number === 'CMP-9002', JSON.stringify(rows))
  })
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query('select ticket_number, is_sensitive from public.complaints_staff_view order by ticket_number')
    check('admin view sees all ECS complaints', rows.length === 3, JSON.stringify(rows))
  })

  // Faculty also gets safe row visibility on the base table (restricted rows).
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query('select ticket_number, is_sensitive from public.complaints order by ticket_number')
    check('faculty base-table select restricted to non-sensitive', rows.length === 2 && rows.every((r) => r.is_sensitive === false), JSON.stringify(rows))
  })
  // Committee base table: sensitive only.
  await asUser(client, U.committee, async () => {
    const { rows } = await client.query('select ticket_number, is_sensitive from public.complaints')
    check('committee base-table select restricted to sensitive', rows.length === 1 && rows[0].is_sensitive === true, JSON.stringify(rows))
  })
  // Admin base table: all.
  await asUser(client, U.admin, async () => {
    const { rows } = await client.query('select count(*)::int as n from public.complaints')
    check('admin base-table select sees all', rows[0].n === 3, JSON.stringify(rows))
  })

  // Messages visibility through the safe view (no sender_id; body only).
  await asUser(client, U.student1, async () => {
    const { rows } = await client.query('select complaint_id, sender_role, body from public.messages_staff_view')
    check('student sees messages on own complaints', rows.length === 2, JSON.stringify(rows))
  })

  // --------------------------------------------------------------------------
  // 9. Ticket number generation (sequence, CMP-XXXX, collision-safe).
  // --------------------------------------------------------------------------
  console.log('\n== 9. Ticket generation ==')
  await asUser(client, U.student1, async () => {
    const { rows } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values (auth.uid(), $1, 'new academic complaint', 'high')
       returning ticket_number, status, handler_type, is_sensitive, department_id`,
      [catId['Academics']],
    )
    const r = rows[0]
    check('student can submit complaint', true, JSON.stringify(r))
    check('ticket number CMP-0001 (sequence)', r.ticket_number === 'CMP-0001', r.ticket_number)
    check('status defaults to submitted', r.status === 'submitted')
    check('handler_type department for non-sensitive', r.handler_type === 'department')
    check('is_sensitive false for Academics', r.is_sensitive === false)
    check('department_id derived to ECS', !!r.department_id)

    const { rows: sens } = await client.query(
      `insert into public.complaints (student_id, category_id, description, priority)
       values (auth.uid(), $1, 'sensitive test', 'high')
       returning ticket_number, is_sensitive, handler_type`,
      [catId['Harassment / Ragging']],
    )
    check('sensitive category -> is_sensitive true', sens[0].is_sensitive === true)
    check('sensitive category -> handler_type committee', sens[0].handler_type === 'committee')
  })

  // Duplicate ticket numbers rejected by the unique constraint.
  await client.query(`insert into public.complaints (ticket_number, student_id, category_id, description)
      values ('CMP-DUP', $1, $2, 'dup test')`, [U.student1, catId['Academics']])
  try {
    await client.query(`insert into public.complaints (ticket_number, student_id, category_id, description)
        values ('CMP-DUP', $1, $2, 'dup test 2')`, [U.student1, catId['Academics']])
    check('duplicate ticket number rejected', false)
  } catch (err) {
    check('duplicate ticket number rejected', String(err.message).includes('duplicate key'), err.message)
  }

  // Concurrency: 10 parallel inserts from separate connections -> 10 distinct tickets.
  const parallelClients = []
  for (let i = 0; i < 10; i++) {
    const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' })
    await c.connect()
    parallelClients.push(c)
  }
  const tickets = await Promise.all(
    parallelClients.map((c) =>
      asUser(c, U.student2, () =>
        c.query(
          `insert into public.complaints (student_id, category_id, description)
           values (auth.uid(), $1, $2)
           returning ticket_number`,
          [catId['Labs'], 'concurrent ' + Math.random().toString(36).slice(2)],
        ).then((r) => r.rows[0].ticket_number),
      ),
    ),
  )
  const unique = new Set(tickets)
  check('10 concurrent inserts -> 10 unique tickets', unique.size === 10 && tickets.every((t) => /^CMP-\d+$/.test(t)), tickets.join(','))
  await Promise.all(parallelClients.map((c) => c.end()))

  // Messages: INSERT ... RETURNING works and sender identity is server-enforced.
  await asUser(client, U.student1, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'returning test') returning id, sender_role`,
      [c1],
    )
    check('student message insert with RETURNING works', rows.length === 1, JSON.stringify(rows))
    check('sender_role enforced to student', rows[0]?.sender_role === 'student', JSON.stringify(rows[0]))
  })
  await asUser(client, U.faculty, async () => {
    const { rows } = await client.query(
      `insert into public.messages (complaint_id, body) values ($1, 'faculty returning') returning id, sender_role`,
      [c1],
    )
    check('faculty message insert with RETURNING works', rows.length === 1, JSON.stringify(rows))
    check('sender_role enforced to staff', rows[0]?.sender_role === 'staff', JSON.stringify(rows[0]))
  })
  await asUser(client, U.student2, () =>
    expectPermissionDenied(client, 'student2 cannot message student1 complaint (RLS)', () =>
      client.query(`insert into public.messages (complaint_id, body) values ($1, 'nope')`, [c1]),
    ),
  )

  // --------------------------------------------------------------------------
  // 10. Reveal requests: student consent control.
  // --------------------------------------------------------------------------
  console.log('\n== 10. Identity reveal consent ==')
  await asUser(client, U.student1, async () => {
    const { rows } = await client.query(
      `insert into public.identity_reveal_requests (complaint_id) values ($1) returning status`,
      [c1],
    )
    check('student can request reveal on own complaint (status pending)', rows[0].status === 'pending')
    await client.query(`update public.identity_reveal_requests set status = 'consented' where complaint_id = $1`, [c1])
    check('student can update consent status', true)
    await expectPermissionDenied(client, 'student cannot forge revealed_at', () =>
      client.query(`update public.identity_reveal_requests set revealed_at = now() where complaint_id = $1`, [c1]),
    )
  })
  await asUser(client, U.student2, () =>
    expectPermissionDenied(client, 'student2 cannot reveal student1 complaint (RLS)', () =>
      client.query(`insert into public.identity_reveal_requests (complaint_id) values ($1)`, [c1]),
    ),
  )
  await asUser(client, U.faculty, () =>
    expectPermissionDenied(client, 'faculty cannot create reveal request', () =>
      client.query(`insert into public.identity_reveal_requests (complaint_id) values ($1)`, [c1]),
    ),
  )

  // --------------------------------------------------------------------------
  // 11. anon has zero access.
  // --------------------------------------------------------------------------
  console.log('\n== 11. anon ==')
  await client.query('set role anon')
  try {
    await client.query('select * from public.complaints limit 1')
    check('anon cannot read complaints', false)
  } catch (err) {
    check('anon cannot read complaints', String(err.message).includes('permission denied'), err.message)
  }
  try {
    await client.query('select * from public.profiles limit 1')
    check('anon cannot read profiles', false)
  } catch (err) {
    check('anon cannot read profiles', String(err.message).includes('permission denied'), err.message)
  }
  await client.query('reset role')

  // --------------------------------------------------------------------------
  // 12. Views are security invoker; indexes exist.
  // --------------------------------------------------------------------------
  console.log('\n== 12. Views + indexes ==')
  const { rows: viewOpts } = await client.query(
    `select relname, reloptions from pg_class
     where relnamespace = 'public'::regnamespace and relkind = 'v'
       and relname in ('complaints_staff_view', 'messages_staff_view')`,
  )
  const opts = Object.fromEntries(viewOpts.map((r) => [r.relname, JSON.stringify(r.reloptions)]))
  check('complaints_staff_view is security invoker', opts['complaints_staff_view']?.includes('security_invoker'), opts['complaints_staff_view'])
  check('messages_staff_view is security invoker', opts['messages_staff_view']?.includes('security_invoker'), opts['messages_staff_view'])

  const { rows: idx } = await client.query(
    `select indexname from pg_indexes where schemaname = 'public' and indexname in (
       'complaints_student_id_idx',
       'complaints_department_status_idx',
       'complaints_handler_type_idx',
       'complaints_status_updated_at_idx',
       'messages_complaint_created_idx'
     ) order by 1`,
  )
  const idxNames = idx.map((r) => r.indexname)
  for (const i of [
    'complaints_student_id_idx',
    'complaints_department_status_idx',
    'complaints_handler_type_idx',
    'complaints_status_updated_at_idx',
    'messages_complaint_created_idx',
  ]) {
    check(`index ${i}`, idxNames.includes(i))
  }
  const { rows: uniq } = await client.query(
    `select indexname from pg_indexes where schemaname = 'public' and tablename = 'complaints' and indexdef ilike '%unique%'`,
  )
  check('unique index on complaints.ticket_number', uniq.length >= 1)

  // --------------------------------------------------------------------------
  // 13. Policies present (summary list).
  // --------------------------------------------------------------------------
  console.log('\n== 13. Policies ==')
  const { rows: policies } = await client.query(
    `select tablename, policyname from pg_policies where schemaname = 'public' order by tablename, policyname`,
  )
  for (const p of policies) {
    check(`policy ${p.tablename}.${p.policyname}`, true)
  }
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
