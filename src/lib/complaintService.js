import { supabase } from './supabaseClient.js'

// Priority levels allowed by the database enum public.priority_level.
export const PRIORITY_LEVELS = ['low', 'medium', 'high', 'urgent']

// Reasonable minimum length for a complaint description. Frontend validation
// only — the database does not enforce a length.
export const MIN_DESCRIPTION_LENGTH = 20

function ensureSupabase() {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env',
    )
  }
  return supabase
}

/**
 * Loads the complaint categories the student can choose from.
 *
 * The list comes from public.complaint_categories (the database is the source
 * of truth — nothing is hardcoded in the frontend). Categories are readable
 * by any signed-in user via the Day 3 RLS policy.
 *
 * Only id + name are needed by the form. is_sensitive / handler_type are NOT
 * read here: the database derives those from the chosen category, and the
 * frontend must not duplicate that logic.
 */
export async function fetchComplaintCategories() {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaint_categories')
    .select('id, name')
    .order('name', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Inserts a new complaint on behalf of the signed-in student.
 *
 * The client sends ONLY the fields a student may control:
 *   - student_id  : the current user's id. The Day 3 schema requires it
 *                   (NOT NULL, no default, granted for insert) and RLS
 *                   validates it — the insert policy requires
 *                   student_id = auth.uid(), so a student can only ever file
 *                   a complaint for themselves.
 *   - category_id : chosen from the fetched categories
 *   - description : free text
 *   - priority    : one of public.priority_level
 *
 * The database derives ticket_number, is_sensitive, handler_type,
 * department_id, status and timestamps via the Day 3 trigger — the client
 * never sends those.
 *
 * Returns the created row (id, ticket_number, status) via INSERT ...
 * RETURNING, which requires the new row to pass the student's SELECT policy
 * (student_id = auth.uid()) — safe by construction. No identity-sensitive
 * fields are exposed to the student beyond their own ticket.
 */
export async function submitComplaint({ studentId, categoryId, description, priority }) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaints')
    .insert({
      student_id: studentId,
      category_id: categoryId,
      description,
      priority,
    })
    .select('id, ticket_number, status')
    .single()
  if (error) throw error
  return data
}

/**
 * Day 5 — fetches the signed-in student's own complaints for the dashboard.
 *
 * Ownership is enforced ENTIRELY by the Day 3 RLS policy
 * (complaints_select_student: student_id = auth.uid()) — the query itself
 * carries no ownership filter, and it cannot: student_id is excluded from
 * the SELECT column grant, so neither this query nor any other can reference
 * it (that is exactly what keeps staff from ever reading it). There is
 * therefore no client-supplied id at all — the database resolves the
 * authenticated user itself via auth.uid().
 *
 * The category name is resolved through the existing complaints ->
 * complaint_categories relationship (PostgREST embedded resource), so the
 * dashboard shows the category NAME, never only the category UUID. Only the
 * fields the dashboard displays are selected — description and identity
 * fields stay out of the response.
 *
 * Returns rows normalized to a stable shape:
 *   { id, ticket_number, category_id, category, priority, status,
 *     created_at, updated_at }
 */
export async function fetchStudentComplaints() {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaints')
    .select(
      'id, ticket_number, category_id, priority, status, created_at, updated_at, complaint_categories(name)',
    )
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    ticket_number: row.ticket_number,
    category_id: row.category_id,
    category: row.complaint_categories?.name ?? null,
    priority: row.priority,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
}

/**
 * Day 5 — fetches the anonymous complaint list for the staff dashboard.
 *
 * Uses the Day 3 safe view public.complaints_staff_view, which is a
 * security-invoker view that projects ONLY identity-free fields and respects
 * the underlying RLS: faculty see non-sensitive complaints, committee see
 * sensitive ones, admin sees all ECS complaints. The frontend does NOT
 * reconstruct identity — it cannot, because student_id / sender_id are not
 * selectable at all (column grants) and are not part of this response.
 *
 * Only the fields the dashboard displays are selected. Returns the view rows
 * unchanged (already identity-free):
 *   { ticket_number, category, department, priority, status, handler_type,
 *     is_sensitive, created_at, updated_at }
 */
export async function fetchStaffComplaints() {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaints_staff_view')
    .select(
      'id, ticket_number, category, department, priority, status, handler_type, is_sensitive, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

/**
 * Day 7 — fetches ONE complaint for the student detail page. The query
 * filters by the complaint id on the base table; RLS
 * (complaints_select_student: student_id = auth.uid()) restricts it to the
 * signed-in student's own complaints. Returns the same safe fields as the
 * student dashboard plus the category name, or null when the complaint does
 * not exist or is not the caller's.
 */
export async function fetchStudentComplaintDetail(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaints')
    .select(
      'id, ticket_number, category_id, priority, status, created_at, updated_at, complaint_categories(name)',
    )
    .eq('id', complaintId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    id: data.id,
    ticket_number: data.ticket_number,
    category_id: data.category_id,
    category: data.complaint_categories?.name ?? null,
    priority: data.priority,
    status: data.status,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Day 6 — Status flow
// ---------------------------------------------------------------------------

// The only allowed status transitions, mirrored from the Day 6 migration's
// public.can_transition_status(). Used ONLY to drive which options the UI
// offers; the database RPC remains the authoritative validator and will
// reject anything this map gets wrong.
export const STATUS_TRANSITIONS = {
  submitted: ['under_review', 'escalated'],
  under_review: ['assigned', 'in_progress', 'escalated', 'resolved'],
  assigned: ['in_progress', 'escalated', 'resolved'],
  in_progress: ['resolved', 'escalated'],
  resolved: ['closed', 'reopened'],
  reopened: ['under_review', 'in_progress', 'resolved', 'escalated'],
  escalated: ['under_review', 'in_progress', 'resolved'],
  closed: ['reopened'],
}

export function getNextStatuses(status) {
  return STATUS_TRANSITIONS[status] ?? []
}

/**
 * Day 6 — fetches ONE complaint for the staff detail page, through the same
 * safe view the staff dashboard uses (public.complaints_staff_view). RLS
 * decides whether this staff member may see it (faculty -> non-sensitive,
 * committee -> sensitive, admin -> all); a complaint that does not exist or
 * is not visible returns null — the page treats both the same way, so it
 * never leaks whether a hidden complaint exists.
 */
export async function fetchStaffComplaintDetail(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaints_staff_view')
    .select(
      'id, ticket_number, category, department, description, priority, status, handler_type, is_sensitive, created_at, updated_at',
    )
    .eq('id', complaintId)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Day 6 — fetches the status-history timeline for a complaint. Read access
 * follows the same RLS visibility rule as the complaint itself, so a caller
 * can only ever see history for complaints they are allowed to see. History
 * contains only roles and timestamps — never any identity.
 */
export async function fetchComplaintStatusHistory(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaint_status_history')
    .select('id, previous_status, new_status, changed_by_role, changed_at')
    .eq('complaint_id', complaintId)
    .order('changed_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Day 6 — the ONLY status-write path. Calls the SECURITY DEFINER RPC
 * public.update_complaint_status, which enforces role / sensitivity /
 * department authorization and the transition map inside the database — the
 * UI cannot bypass it, and the client has no direct UPDATE grant on
 * public.complaints. Returns the updated safe row:
 *   { ticket_number, status, updated_at }
 */
export async function updateComplaintStatus(complaintId, newStatus) {
  const client = ensureSupabase()
  const { data, error } = await client
    .rpc('update_complaint_status', {
      p_complaint_id: complaintId,
      p_new_status: newStatus,
    })
    .single()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Day 7 — Anonymous complaint chat + Realtime
// ---------------------------------------------------------------------------

// Server-enforced maximum message length (mirrors the Day 7 CHECK constraint
// on messages.body). Also used by the client for the character counter.
export const MESSAGE_MAX_LENGTH = 2000

// The ONLY columns the chat ever touches. sender_id / student_id are not in
// this list AND are not selectable by `authenticated` (Day 3 column grants),
// so neither REST responses nor Realtime payloads can ever contain them.
// Day 8A adds the edit / soft-delete state columns (still identity-free).
export const CHAT_SELECT_COLUMNS = [
  'id',
  'complaint_id',
  'sender_role',
  'body',
  'created_at',
  'edited_at',
  'is_deleted',
  'deleted_at',
]

/**
 * Day 7 — loads a complaint's conversation through the identity-free
 * messages_staff_view. Row visibility is enforced by RLS
 * (can_access_complaint): students see only their own complaints' messages,
 * faculty only non-sensitive, committee only sensitive, admin all. Only safe
 * fields are selected — never sender_id.
 */
export async function fetchComplaintMessages(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('messages_staff_view')
    .select(CHAT_SELECT_COLUMNS.join(', '))
    .eq('complaint_id', complaintId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Day 7 — sends a message. The client submits ONLY complaint_id + body; the
 * Day 3 messages_set_sender trigger derives sender_id (auth.uid()) and
 * sender_role (the caller's app role) server-side, and RLS
 * (messages_insert_accessible via can_access_complaint) blocks anyone who is
 * not authorized for the complaint. The INSERT grant excludes sender_id and
 * sender_role, so they cannot be forged. Returns the created row's safe
 * fields (id, complaint_id, sender_role, body, created_at).
 */
export async function sendComplaintMessage(complaintId, body) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('messages')
    .insert({ complaint_id: complaintId, body })
    .select(CHAT_SELECT_COLUMNS.join(', '))
    .single()
  if (error) throw error
  return data
}

// ---------------------------------------------------------------------------
// Day 8A — Chat message controls (edit / delete for me / delete for everyone)
//
// All three operations go through SECURITY DEFINER RPCs — the ONLY write
// paths. The client submits only the message id (and, for edit, the new
// body). Ownership (auth.uid() = messages.sender_id), complaint access and
// state validation are enforced inside the database; the client never sends
// sender_id / sender_role / user_id.
// ---------------------------------------------------------------------------

/**
 * Day 8A — edits the caller's own message. Returns the updated safe row
 * (id, complaint_id, sender_role, body, created_at, edited_at, is_deleted,
 * deleted_at).
 */
export async function editComplaintMessage(messageId, newBody) {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('edit_complaint_message', {
    p_message_id: messageId,
    p_new_body: newBody,
  })
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Day 8A — soft-deletes the caller's own message for everyone (is_deleted +
 * deleted_at; the row is never physically removed). Returns the updated safe
 * row.
 */
export async function deleteComplaintMessageForEveryone(messageId) {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('delete_complaint_message_for_everyone', {
    p_message_id: messageId,
  })
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Day 8A — hides a message from the current user only (creates the caller's
 * own record in message_user_deletions). Returns { message_id, deleted_at }.
 */
export async function deleteComplaintMessageForMe(messageId) {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('delete_complaint_message_for_me', {
    p_message_id: messageId,
  })
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Day 8A — loads the CURRENT user's "delete for me" message ids for one
 * complaint, so hidden messages stay hidden across refresh/remount. Only the
 * caller's own records are returned (RLS: user_id = auth.uid()), joined to
 * messages only to scope by complaint_id. Returns an array of message ids.
 */
export async function fetchMyMessageDeletions(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('message_user_deletions')
    .select('message_id, messages!inner(complaint_id)')
    .eq('messages.complaint_id', complaintId)
  if (error) throw error
  return (data ?? []).map((row) => row.message_id)
}
