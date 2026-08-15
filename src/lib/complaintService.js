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
