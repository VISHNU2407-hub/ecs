# College Complaint Management System

A **React + Vite + Tailwind CSS** frontend with **React Router** and **Supabase**.
Day 1 provided the app shell and placeholder role pages; Day 2 added
email/password authentication (sign-up, login, password reset) with role-aware
route protection; Day 3 adds the PostgreSQL database, role & security
foundation for the **ECS** department pilot (anonymous complaints, RLS,
identity-safe staff views); Day 4 adds the student complaint submission
flow — a category-aware form (categories fetched from the database), a
validated description and priority, and database-generated CMP-XXXX ticket
numbers; Day 5 adds the first real dashboards — the student dashboard
(summary stats + the student's own complaints) and the staff dashboard
(anonymous complaint list with status/category/priority/ticket filters over
the identity-free staff view); Day 6 adds the complaint status flow — a staff
complaint detail page with a database-enforced status control and a
role-anonymous status-history timeline; Day 7 adds the anonymous two-way
conversation — a chat on every complaint (student and staff sides) powered by
Supabase Realtime, with sender identity derived server-side and never exposed;
Day 8A adds WhatsApp-style message controls to that chat — edit, delete for
me, and delete for everyone (soft delete) — enforced by SECURITY DEFINER
RPCs so the database remains the only authority on message ownership.

## Getting started

```bash
npm install

# Configure Supabase credentials (required before using any Supabase features)
cp .env.example .env
# Edit .env and fill in:
#   VITE_SUPABASE_URL            -> e.g. https://xxxx.supabase.co
#   VITE_SUPABASE_PUBLISHABLE_KEY -> the publishable (anon) key
# Use only the publishable key. Never put a secret key (sb_secret_*) in the frontend.

npm run dev
```

Open http://localhost:5173 — you'll be redirected to `/login`.

## Database (Day 3 + Day 6 + Day 7 + Day 8A)

### Applying the migrations

Run the migration files **in order** in the Supabase SQL editor (or via
`supabase db push`):

```
supabase/migrations/20260814000000_day3_database_security_foundation.sql  # Day 3 — schema, roles, security
supabase/migrations/20260815000000_day6_status_flow.sql                  # Day 6 — status flow + history
supabase/migrations/20260816000000_day7_anonymous_chat.sql               # Day 7 — chat validation + Realtime
supabase/migrations/20260817000000_day8_message_controls.sql             # Day 8A — edit / delete for me / delete for everyone
```

All are written to be re-runnable, but re-running is not required. The Day 3
migration is never modified — Days 6, 7 and 8A only add to it.

There are local verification harnesses that boot a throwaway PostgreSQL
instance and run the migrations plus the security checks:

```bash
npm install -D embedded-postgres pg   # already a devDependency
node scripts/verify-day3.mjs
node scripts/verify-day6.mjs
```

### Tables

| Table                       | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `profiles`                  | One row per `auth.users` id; **`role` is the authoritative app role**    |
| `departments`               | Only `ECS` is seeded for this MVP                                        |
| `complaint_categories`      | The 8 ECS categories; `Harassment / Ragging` is `is_sensitive = true`    |
| `category_department_map`   | Category → department routing (all 8 categories map to ECS)              |
| `complaints`                | Anonymous complaints; `ticket_number` unique (`CMP-XXXX`)                |
| `messages`                  | Complaint messages; `sender_id` stored for audit, never exposed          |
| `identity_reveal_requests`  | Student-controlled consent to reveal identity (no UI yet)                |

### Roles & enums

- `app_role`: `student`, `faculty`, `admin`, `committee` (in `profiles.role`).
- `priority_level`: `low`, `medium`, `high`, `urgent`.
- `complaint_status`: `submitted`, `under_review`, `assigned`, `in_progress`,
  `resolved`, `reopened`, `escalated`, `closed`.
- `handler_type`: `department`, `committee`.
- `sender_role`: `student`, `staff`, `committee`.
- `reveal_status`: `pending`, `consented`, `denied`.

A sign-up trigger creates a `profiles` row for every new auth user with
`role = 'student'`. The role is **never** read from auth user metadata — the
frontend resolves it from `public.profiles.role` (see `getUserRole` in
`src/lib/authService.js`), falling back to `student` only when the profile is
missing.

### Security model

- RLS is enabled on every table; every policy targets the `authenticated` role
  (the `anon` role has no grants at all).
- `profiles` has a **select-own** policy and **no update policy**, so nobody
  can change their own `role` or `department_id` through the API.
- Students can only see/insert their own complaints
  (`student_id = auth.uid()`).
- Staff access is role-gated: `faculty` sees non-sensitive complaints,
  `committee` sees sensitive ones, `admin` (ECS coordinator) sees all — and
  **none of them ever see `student_id` or `sender_id`**:
  - the identity columns are excluded via column-level grants, so even a
    direct DevTools query of the base tables cannot read them;
  - the safe views `complaints_staff_view` and `messages_staff_view` project
    only identity-free fields and are **security-invoker views**, so the
    underlying RLS is respected.
- Ticket numbers are generated by a PostgreSQL sequence in an insert trigger
  (`CMP-0001`, …) — atomic and collision-safe under concurrent submissions.
  `is_sensitive`, `handler_type` and `department_id` are derived from the
  category by the same trigger, so a student cannot forge them.
- Message `sender_id`/`sender_role` are set by a trigger from the caller's
  session — a client cannot claim to be staff/committee.
- No secret keys are used anywhere in the frontend (`sb_secret_*` appears only
  in documentation comments); `service_role` is never used in client code.

### Complaint submission (Day 4)

The complete student submission flow is implemented:

```
Student logs in → Student dashboard → "Submit Complaint" →
Category (from public.complaint_categories) → Description → Priority →
Submit → Supabase INSERT → CMP-XXXX generated → Success + ticket number
```

- Route: `/student/complaints/new` (student-only; staff/admin/committee have
  no submission workflow). The student dashboard has a "Submit Complaint"
  card, and the student header nav links to the form.
- Categories are **fetched from `public.complaint_categories`** — nothing is
  hardcoded in the frontend, so the list always reflects the database.
- The form sends only the fields a student may control: `student_id` (their
  own id — required by the schema, no default, and validated by RLS via
  `student_id = auth.uid()`), `category_id`, `description`, `priority`.
  `ticket_number`, `is_sensitive`, `handler_type`, `department_id`, `status`
  and timestamps are all derived by the Day 3 trigger — the client never
  sends them and cannot forge them (they are excluded from the INSERT grant).
- `attachment_url` exists in the schema but file storage is not implemented
  yet, so the field is intentionally unused in Day 4 (no upload UI).
- Validation (client-side): category required and must be one of the fetched
  ids; description required with a 20-character minimum; priority required
  and one of `low` / `medium` / `high` / `urgent` (default `medium`).
- UX: clear labels with required indicators, inline field errors, a category
  loading state with retry, a disabled submit button while submitting, an
  in-flight guard against duplicate submissions, a success screen showing the
  generated ticket number, and a "Back to Student Dashboard" link plus
  "Submit another complaint". Raw database errors are never shown to the
  user.
- Sensitive handling is **not** duplicated in the frontend: submitting
  "Harassment / Ragging" makes the database derive `is_sensitive = true` and
  `handler_type = committee` automatically.

Local verification (no Supabase account needed):

```bash
node scripts/verify-day4.mjs
```

This boots a throwaway PostgreSQL instance, applies the Day 3 migration
unchanged, and runs the exact client payload through the schema — category
fetch, successful insert with `RETURNING`, DB-derived ticket/status/
department/sensitivity, committee handling for sensitive categories, priority
default, RLS isolation, and rejection of forged or missing values (34
checks).

### Dashboards (Day 5)

The placeholder student and staff pages became real dashboards over the
Day 3 database:

**Student dashboard** (`/student`)

- Summary cards: total, active, and resolved/closed complaints.
- "My Complaints": the signed-in student's own complaints only — fetched
  with `student_id = <their id>` and enforced again by RLS
  (`complaints_select_student`), so the frontend can never see another
  student's rows.
- Each row shows ticket number, category **name** (resolved through the
  existing `complaints -> complaint_categories` relationship — never
  hardcoded), priority, status, created and updated dates.
- Empty state with a "Submit your first complaint" button, plus loading and
  error/retry states.

**Staff dashboard** (`/staff`)

- Loads ECS complaints exclusively through the safe view
  `public.complaints_staff_view` (security-invoker, identity-free). RLS
  decides row visibility per role: faculty see non-sensitive, committee see
  sensitive, admin see all.
- Rows show ticket number, category, department, priority, status, handler
  type, a sensitive/standard indicator, and created/updated dates.
- No identity fields anywhere: the response has no `student_id`, `sender_id`,
  email or name columns, and the frontend never joins complaints to
  profiles/users.
- Filters on safe fields only: status, category, priority, and an optional
  ticket-number search (case-insensitive).

Local verification (no Supabase account needed):

```bash
node scripts/verify-day5.mjs
```

This boots a throwaway PostgreSQL instance, applies the Day 3 migration
unchanged, and runs the exact dashboard queries — student isolation and
category-name resolution, the staff view response (no identity columns),
role-based row visibility on the view (faculty/committee/admin), anon
rejection, and the staff filter logic.

### Status flow (Day 6)

Staff can open any complaint from the staff dashboard and manage its status;
the change is recorded in a role-anonymous history timeline and the student
dashboard reflects the new status automatically.

- **Staff detail page** (`/staff/complaints/:id`): shows only safe fields
  (ticket, category, department, description, priority, status, handler type,
  sensitive/standard, created/updated) fetched from `complaints_staff_view` —
  no student identity, and RLS hides complaints a role cannot see (a direct
  URL to a hidden complaint shows "not found or no access").
- **Status updates** go exclusively through the SECURITY DEFINER RPC
  `public.update_complaint_status(complaint_id, new_status)`. There is no
  direct UPDATE grant on `public.complaints`, so the RPC is the only write
  path. Inside, the database enforces:
  - role: only `faculty` / `committee` / `admin` (students are rejected);
  - sensitivity: faculty → non-sensitive only, committee → sensitive only,
    admin → all (mirrors the staff view);
  - department: a caller whose profile has a `department_id` may only update
    complaints of that department (no-op in the ECS pilot, where
    `profiles.department_id` is NULL for everyone);
  - transitions: a strict map (no random jumping, no self-transitions, no
    invalid enum values).
- **Status transitions** (the only allowed moves):
  `submitted → under_review, escalated`;
  `under_review → assigned, in_progress, escalated, resolved`;
  `assigned → in_progress, escalated, resolved`;
  `in_progress → resolved, escalated`;
  `resolved → closed, reopened`;
  `reopened → under_review, in_progress, resolved, escalated`;
  `escalated → under_review, in_progress, resolved`;
  `closed → reopened`.
- **`complaint_status_history`** records `complaint_id`, `previous_status`,
  `new_status`, `changed_at`, and `changed_by_role` — a ROLE
  (faculty/admin/committee), never an identity. It is read-only over RLS
  using the existing `can_access_complaint()` rule and has no identity
  columns.
- **Security boundary is the database.** The React UI only hides/enables
  options for convenience; the RPC enforces authorization and the transition
  map server-side, so a crafted API call cannot bypass them.

Local verification:

```bash
node scripts/verify-day6.mjs
```

This boots a throwaway PostgreSQL instance, applies the Day 3 migration
unchanged + the Day 6 migration, and runs 44 checks: student isolation and
status reflection, student update rejection, staff detail reads without
identity fields, per-role visibility, valid updates with history, invalid
and no-op transitions, invalid enum rejection, sensitive/department
restrictions, admin access, history visibility, no direct write path, and
anon rejection.

### Anonymous chat + Realtime (Day 7)

Every complaint now has an anonymous two-way conversation between the student
and the authorized staff:

- **Student side** (`/student/complaints/:id`): the student opens any of
their complaints from the dashboard and chats. Their own messages are
labeled **You**; staff messages are labeled by role (Staff / Committee). No
identity field is ever fetched or rendered.
- **Staff side** (`/staff/complaints/:id`): a conversation section below the
status control. Messages are labeled purely by `sender_role` (Student / Staff
/ Committee) — staff identity is never shown either.
- **Realtime**: new messages appear instantly in both browsers. The client
subscribes to `postgres_changes` on `messages` filtered to the current
complaint (`complaint_id=eq.…`) with an explicit safe column selection
(`id, complaint_id, sender_role, body, created_at`). Supabase Realtime applies
row-level RLS (unauthorized clients get no events) and only allows selecting
columns the subscriber can read — `sender_id` is not selectable, so it can
never appear in a payload. Channels are removed on unmount / complaint
switch (no duplicate subscriptions, no leaks), and messages are deduplicated
by stable id so the INSERT response and the Realtime event never show a
message twice.
- **Sending** goes through the existing Day 3 path: the client submits only
`complaint_id` + `body`; the `messages_set_sender` trigger derives
`sender_id` (auth.uid()) and `sender_role` server-side, and RLS blocks
anyone not authorized for the complaint. The client cannot forge sender
identity (no grants on those columns).
- **Validation**: empty / whitespace-only and > 2000-character messages are
rejected both in the UI and by a new Day 7 CHECK constraint on
`messages.body`.
- **No new tables, no RLS changes.** The Day 3 `messages` table, its
`can_access_complaint()` policies and grants, and the identity-free
`messages_staff_view` already satisfy the whole model. The Day 7 migration
only adds the body CHECK constraint and adds `messages` to the
`supabase_realtime` publication.

Local verification:

```bash
node scripts/verify-day7.mjs
```

This boots a throwaway PostgreSQL instance, applies the Day 3 + 6 + 7
migrations, and runs 36 checks: server-derived sender identity, per-role read
visibility with no identity fields, sender-role/sender-id forgery rejection,
unauthorized inserts, empty/whitespace/oversized rejection, anon rejection,
complaint-scoped conversations, unchanged Day 6 status behavior, and the
Realtime preconditions (RLS row-level via `can_access_complaint`, `sender_id`
not selectable, identity-free view). Realtime itself requires a live Supabase
project (it cannot run inside embedded-postgres) — see the manual test below.

### Chat message controls (Day 8A)

The anonymous chat now supports WhatsApp-style message controls, with the
database as the only authority on ownership:

- **Edit**: only the original sender can edit (`auth.uid() = messages.sender_id`
  verified inside the `edit_complaint_message` RPC). Body is trimmed and
  validated (1–2000 chars, empty/whitespace rejected), `edited_at` is set,
  and `created_at` / `sender_role` / `sender_id` never change. The bubble
  shows a small *(edited)* marker.
- **Delete for everyone**: soft delete by the original sender only
  (`is_deleted = true` + `deleted_at`; the row is never physically removed
  so the state propagates through Realtime). Both sides then render
  *"This message was deleted"* — the original body is no longer shown.
  One-shot: repeated deletes are rejected.
- **Delete for me**: any authorized participant can hide a message from
  themselves via a per-user record in the new `message_user_deletions` table
  (UNIQUE `(message_id, user_id)`, RLS scoped to `user_id = auth.uid()`,
  SELECT-only grant). Other users are unaffected; delete-for-everyone always
  takes precedence.
- **RPC-only writes**: there is no UPDATE/DELETE grant on `messages` and no
  INSERT/DELETE grant on `message_user_deletions` for any client role. The
  three SECURITY DEFINER RPCs (`edit_complaint_message`,
  `delete_complaint_message_for_everyone`, `delete_complaint_message_for_me`)
  are the only write paths, and each re-checks complaint access via the
  existing `can_access_complaint()` model. The client never sends
  `sender_id` / `sender_role` / `user_id`.
- **Realtime**: the subscription now also receives UPDATE events (edited
  body, `edited_at`, `is_deleted`, `deleted_at`) with the same
  `complaint_id` filter and safe column selection — edits and deletes appear
  in both browsers without a refresh. Delete-for-me is user-specific and is
  not broadcast.
- **UI**: a ⋮ action menu on every message (own: Copy / Edit / Delete for me
  / Delete for everyone; other: Copy / Delete for me), an inline edit editor,
  a mobile-friendly confirmation dialog for deletes, and clipboard copy with
  a graceful fallback. The WhatsApp-style bubbles, "You" ownership styling
  and anonymity guarantees are unchanged.

Local verification:

```bash
node scripts/verify-day8.mjs
```

This boots a throwaway PostgreSQL instance, applies the Day 3 + 6 + 7 + 8A
migrations, and runs 57 checks: per-role edit/delete ownership, edit
validation, soft-delete semantics, per-user deletion records, anon RPC
rejection, direct UPDATE/DELETE/INSERT bypass rejection, identity-column
hiding, complaint-access and sensitive restrictions, unchanged Day 7 sending
and Day 6 status behavior, and Realtime preconditions.

### Not implemented yet (Day 8B+)

Delete conversation for me (Day 8B), notifications, push notifications,
escalation automation, identity-reveal UI, analytics, duplicate detection,
public complaint board, admin/faculty account management, file upload UI,
and category assignment UI. The schema is ready for these.

## Authentication (Day 2)

- Students self-register with a college email (`@gprec.ac.in`), password, and
  password confirmation. Other domains are rejected.
- Supabase's **Confirm email** setting is enabled, so new accounts must verify
  their email before the first sign-in (users are intentionally not signed in
  automatically after registering).
- Login errors are intentionally generic ("Invalid email or password.") so the
  UI never reveals whether an email exists.
- Forgot password uses Supabase's password-reset flow; the recovery link
  returns to `/update-password` where the user sets a new password.
- Sessions persist via supabase-js (stored by the client, restored on reload).

### Roles (Day 3)

The authoritative role lives in `public.profiles.role`, created by the sign-up
trigger as `student`. `getUserRole` in `src/lib/authService.js` reads it from
the `profiles` table. Until the Day 3 migration is applied to a Supabase
project, the lookup fails and everyone resolves to `student` (least
privilege) — staff/admin dashboards become reachable only after the migration
runs and roles are set in the database.

The database roles are `student`, `faculty`, `admin` and `committee`, while
the existing dashboard routes are `/student`, `/staff` and `/admin`.
`getDashboardKey` maps `faculty → staff` (the staff dashboard is the faculty
dashboard) and, since Day 5, `admin → staff` and `committee → staff` for now
(no separate admin/committee dashboards yet — those arrive in later phases).
Unknown roles fall back to `student`.

## Routes

| Route             | Page                                    | Access                |
| ----------------- | --------------------------------------- | --------------------- |
| `/login`          | Sign in                                 | Public (redirects if signed in) |
| `/register`       | Create a student account                | Public (redirects if signed in) |
| `/forgot-password`| Request a password reset email          | Public                |
| `/update-password`| Set a new password (recovery link lands here) | Recovery session |
| `/student`        | Student dashboard (own complaints + stats) | Signed-in students |
| `/student/complaints/new` | Submit a complaint form        | Signed-in students    |
| `/student/complaints/:id` | Student complaint detail + anonymous chat | Signed-in students |
| `/staff`          | Staff dashboard (anonymous complaints + filters) | Faculty (admin/committee for now) |
| `/staff/complaints/:id` | Staff complaint detail (status control + history) | Faculty (admin/committee for now) |
| `/admin`          | Admin dashboard placeholder (admins currently route to `/staff`) | Admin |

Unknown routes redirect to `/login`.

## Project structure

```
├── .env.example              # Env template (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY)
├── index.html                # Vite HTML entry point
├── vite.config.js            # Vite + React + Tailwind CSS v4 plugins
├── supabase/
│   └── migrations/
│       └── 20260814000000_day3_database_security_foundation.sql
├── scripts/
│   ├── verify-day3.mjs       # Local Postgres verification harness (Day 3)
│   ├── verify-day4.mjs       # Local Postgres verification harness (Day 4)
│   ├── verify-day5.mjs       # Local Postgres verification harness (Day 5)
│   ├── verify-day6.mjs       # Local Postgres verification harness (Day 6)
│   └── verify-day7.mjs       # Local Postgres verification harness (Day 7)
└── src/
    ├── main.jsx              # React root + BrowserRouter
    ├── App.jsx               # Route definitions + AuthProvider
    ├── index.css             # Tailwind entry (@import "tailwindcss")
    ├── lib/
    │   ├── supabaseClient.js  # Supabase client (env-driven, anon key only)
    │   ├── authService.js     # Auth actions + role resolution from profiles
    │   ├── complaintService.js# Day 4-7: categories, submission, dashboards, status, chat
    │   └── format.js          # Day 5: shared date formatting
    ├── context/
    │   └── AuthContext.jsx    # AuthProvider / useAuth (session, role, actions)
    ├── hooks/
    │   └── useComplaintChat.js# Day 7: chat state (load, Realtime, dedupe, send)
    ├── components/
    │   ├── layout/
    │   │   └── AppLayout.jsx  # Shared role-aware layout (header/nav/footer)
    │   ├── complaints/
    │   │   ├── Badges.jsx     # Day 5: status/priority/sensitive badges
    │   │   └── ComplaintChat.jsx  # Day 7: anonymous chat UI (student + staff)
    │   ├── ProtectedRoute.jsx # Role-aware route guards (Protected + PublicOnly)
    │   ├── LoadingScreen.jsx  # Session-check loading state
    │   └── PagePlaceholder.jsx
    └── pages/
        ├── LoginPage.jsx
        ├── RegisterPage.jsx
        ├── ForgotPasswordPage.jsx
        ├── UpdatePasswordPage.jsx
        ├── StudentPage.jsx    # Day 5: student dashboard
        ├── StudentComplaintDetailPage.jsx  # Day 7: student detail + chat
        ├── SubmitComplaintPage.jsx  # Day 4: complaint form + success screen
        ├── StaffPage.jsx      # Day 5: staff dashboard (anonymous + filters)
        ├── StaffComplaintDetailPage.jsx  # Day 6/7: detail + status + history + chat
        └── AdminPage.jsx
```
