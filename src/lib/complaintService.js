import { supabase } from './supabaseClient.js'

// Priority levels allowed by the database enum public.priority_level.
export const PRIORITY_LEVELS = ['low', 'medium', 'high', 'urgent']

// Reasonable minimum length for a complaint description. Frontend validation
// only — the database does not enforce a length.
export const MIN_DESCRIPTION_LENGTH = 20

// Day 10A — complaint title/description limits. Mirrored from the edit RPC
// (public.edit_complaint), which is the authoritative validator; the UI uses
// these only to guide the user before the RPC enforces them.
export const TITLE_MAX_LENGTH = 200
export const DESCRIPTION_MAX_LENGTH = 10000

// ---------------------------------------------------------------------------
// Day 10B — complaint attachments (images + optional video).
//
// Files live in the PRIVATE Supabase Storage bucket `complaint-attachments`
// under randomized paths (complaints/<complaint_uuid>/<random_uuid>.<ext> —
// never any identity), and the DATABASE stores metadata only, in
// public.complaint_attachments. There is no public bucket and no
// getPublicUrl() anywhere; every read goes through a SHORT-LIVED signed URL
// created AFTER the storage service has enforced its RLS
// (can_access_complaint on the complaint parsed from the path). Writes go
// EXCLUSIVELY through the Day 10B SECURITY DEFINER RPCs
// (create_complaint_attachment / delete_complaint_attachment), which
// re-verify ownership, submitted status, type/size/count limits and the
// real uploaded bytes server-side.
//
// The limits below are mirrored from the RPC (the authoritative validator)
// and the bucket config; the UI uses them only to give instant feedback
// before the database rejects a bad file.
// ---------------------------------------------------------------------------

// Private storage bucket for complaint evidence files (never public).
export const ATTACHMENT_BUCKET = 'complaint-attachments'

// Allowed MIME types (must match the migration's whitelist exactly).
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']

// Per-complaint limits (enforced server-side by the RPC).
export const MAX_IMAGES_PER_COMPLAINT = 5
export const MAX_VIDEOS_PER_COMPLAINT = 1
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
export const MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
export const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 60 * 1024 * 1024 // 60 MB

// Signed URLs expire quickly and are never persisted anywhere.
export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 60

// Maps a MIME type to the storage extensions the RPC accepts for it.
const EXTENSIONS_BY_TYPE = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
}

export function isImageType(type) {
  return ALLOWED_IMAGE_TYPES.includes(type)
}

export function isVideoType(type) {
  return ALLOWED_VIDEO_TYPES.includes(type)
}

// Returns the storage extension to use for a File, or null when the MIME
// type is not allowed. Prefers the file's own extension when it is valid
// for the type (e.g. .jpeg for image/jpeg), else the type's default.
export function attachmentExtensionFor(file) {
  const allowed = EXTENSIONS_BY_TYPE[file?.type]
  if (!allowed) return null
  const own = String(file.name ?? '').split('.').pop()?.toLowerCase() ?? ''
  return allowed.includes(own) ? own : allowed[0]
}

// Random lowercase UUID for the storage file name (identity-free).
function randomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Day 10B — strips EXIF / location metadata from an image by re-encoding it
 * through a canvas, so the stored file never carries GPS/device/identity
 * metadata. Best effort: if the browser cannot decode or re-encode the
 * image, the original bytes are returned (and the randomized storage path
 * still guarantees the path itself carries no identity).
 */
export async function stripImageMetadata(file) {
  if (!file || !isImageType(file.type)) return file
  try {
    let bitmap = null
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file)
    } else {
      // Fallback for environments without createImageBitmap.
      const url = URL.createObjectURL(file)
      try {
        const img = await new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error('image decode failed'))
          image.src = url
        })
        bitmap = img
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width || 1
    canvas.height = bitmap.height || 1
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    if (typeof bitmap.close === 'function') bitmap.close()

    // Re-encode to the original type when the browser supports it; PNG keeps
    // transparency, otherwise fall back to PNG, then to the original file.
    const encoders = file.type === 'image/png' ? ['image/png'] : [file.type, 'image/png']
    for (const encoder of encoders) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, encoder, 0.92))
      if (blob) return blob
    }
    return file
  } catch (err) {
    // Never block an upload because metadata stripping failed; the random
    // path + RLS are the real anonymity controls.
    console.warn('[attachments] EXIF strip failed, uploading original bytes', err)
    return file
  }
}

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
 * Day 10C — loads the departments a faculty member may pick during
 * registration. The database (public.departments) is the source of truth —
 * nothing is hardcoded in the frontend, no fake departments are added, and
 * the register_faculty RPC re-validates the chosen department server-side.
 * Readable by any signed-in user via the Day 3 RLS policy.
 */
export async function fetchDepartments() {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('departments')
    .select('id, name')
    .order('name', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Day 10D — loads the faculty registration options for /faculty/register
 * through the SECURITY DEFINER RPC public.get_faculty_registration_options().
 *
 * This is the ONLY anonymous-readable reference-data path: the registration
 * page must render "Department: ECS" + the ECS complaint categories before a
 * visitor has signed up / signed in, and the Day 3 grants on the reference
 * tables are `authenticated`-only. The RPC (executable by anon + authenticated)
 * returns one row per (department, category routed to it) from the existing
 * public.departments / public.complaint_categories / public.category_department_map
 * tables — id + name + is_sensitive only, no identity, no registration
 * code/hash. It is NOT authorization for anything: register_faculty still
 * re-validates the department and every category server-side.
 *
 * Returns rows of the shape:
 *   { department_id, department_name, category_id, category_name, is_sensitive }
 */
export async function fetchFacultyRegistrationOptions() {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('get_faculty_registration_options')
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
      'id, ticket_number, category_id, title, description, priority, status, created_at, updated_at, complaint_categories(name)',
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
    title: data.title ?? '',
    description: data.description ?? '',
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
      'id, ticket_number, category, department, title, description, priority, status, handler_type, is_sensitive, created_at, updated_at',
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
 * Day 7 + Day 8B — loads a complaint's conversation through the identity-free
 * messages_staff_view. Row visibility is enforced by RLS
 * (can_access_complaint): students see only their own complaints' messages,
 * faculty only non-sensitive, committee only sensitive, admin all. Only safe
 * fields are selected — never sender_id.
 *
 * Day 8B — optional `deletedBefore` cutoff: when the current user has
 * deleted their conversation for me, only messages created AFTER the cutoff
 * are fetched (created_at > deleted_before). The cutoff is an additional
 * user-specific filter; it never removes rows from the database.
 */
export async function fetchComplaintMessages(complaintId, deletedBefore = null) {
  const client = ensureSupabase()
  let query = client
    .from('messages_staff_view')
    .select(CHAT_SELECT_COLUMNS.join(', '))
    .eq('complaint_id', complaintId)
  if (deletedBefore) query = query.gt('created_at', deletedBefore)
  const { data, error } = await query.order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Day 8B — loads the CURRENT user's conversation cutoff for one complaint
 * (their own row only — RLS: user_id = auth.uid()). Returns the
 * deleted_before timestamp (ISO string) or null when the user has never
 * deleted this conversation. user_id is internal and never returned.
 */
export async function fetchConversationState(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('conversation_user_state')
    .select('deleted_before')
    .eq('complaint_id', complaintId)
    .maybeSingle()
  if (error) throw error
  return data?.deleted_before ?? null
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
 * Day 8B — deletes the conversation for the current user only. The RPC
 * (SECURITY DEFINER) verifies authentication + complaint access, derives
 * user_id from auth.uid() and upserts deleted_before = now() for this
 * complaint. Returns the cutoff timestamp (ISO string) so the chat can hide
 * pre-cutoff messages immediately. Messages created after the cutoff will
 * become visible again; the complaint and messages are never touched.
 */
export async function deleteConversationForMe(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('delete_complaint_conversation_for_me', {
    p_complaint_id: complaintId,
  })
  if (error) throw error
  return data?.[0]?.deleted_before ?? null
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

// ---------------------------------------------------------------------------
// Day 9 — Resolution confirmation, Reopen & Automatic escalation
//
// Closing a resolved complaint and reopening it are STUDENT actions. They go
// exclusively through the Day 9 SECURITY DEFINER RPCs (confirm_complaint_
// resolution / reopen_complaint), which verify INSIDE the database that the
// caller is authenticated, has role 'student', OWNS the complaint
// (student_id = auth.uid() — the user id is never accepted from the client),
// and that the complaint is currently 'resolved'. History is recorded with
// changed_by_role = 'student'. There is still no direct UPDATE grant on
// public.complaints.
// ---------------------------------------------------------------------------

/**
 * Day 9 — student confirms their OWN resolved complaint is truly fixed
 * (resolved -> closed). Returns the updated safe row:
 *   { ticket_number, status: 'closed', updated_at }
 */
export async function confirmComplaintResolution(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .rpc('confirm_complaint_resolution', { p_complaint_id: complaintId })
    .single()
  if (error) throw error
  return data
}

/**
 * Day 9 — student reopens their OWN resolved complaint (resolved -> reopened)
 * so staff pick it up again in the active workflow. Returns the updated safe
 * row: { ticket_number, status: 'reopened', updated_at }.
 */
export async function reopenComplaint(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .rpc('reopen_complaint', { p_complaint_id: complaintId })
    .single()
  if (error) throw error
  return data
}

/**
 * Day 9 — minimal per-complaint Realtime subscription for STATUS changes on
 * the `complaints` table (UPDATE events only, filtered to this complaint).
 * Row-level RLS decides which clients receive events at all (student -> own
 * complaints, staff -> authorized rows) and Realtime only delivers columns
 * the subscriber can SELECT — student_id is not selectable by
 * `authenticated`, so it can never appear in a payload. This is a focused
 * per-complaint channel (no global subscriptions); it is removed on unmount.
 *
 * onStatusChange receives { id, status, updated_at } for each UPDATE event.
 * Returns an unsubscribe function.
 */
export function subscribeComplaintStatus(complaintId, onStatusChange) {
  if (!supabase) return () => {}
  const channel = supabase
    .channel(`complaint-status:${complaintId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'complaints',
        filter: `id=eq.${complaintId}`,
        select: ['id', 'status', 'updated_at'],
      },
      (payload) => {
        const { id, status, updated_at } = payload.new ?? {}
        if (!id) return
        onStatusChange({ id, status, updated_at })
      },
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// ---------------------------------------------------------------------------
// Day 9B — Faculty category assignment (admin management UI)
//
// The security boundary is the DATABASE: faculty visibility is narrowed by
// RLS + can_access_complaint() + update_complaint_status() to the caller's
// department and assigned categories (see the Day 9B migration). The admin
// UI below is the only mechanism that CHANGES assignments, and it goes
// exclusively through two SECURITY DEFINER RPCs that verify the caller is
// admin (public.profiles.role) and validate the target faculty + categories
// server-side. Students cannot create assignments, faculty cannot change
// their own, and the client is never trusted with role or department.
// ---------------------------------------------------------------------------

/**
 * Day 9B — admin-only list of faculty + their category assignments, from the
 * SECURITY DEFINER RPC list_faculty_category_assignments(). Returns one row
 * per (faculty, assignment); faculty with no assignments appear once with
 * category null. Only faculty accounts are returned — never students.
 */
export async function fetchFacultyCategoryAssignments() {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('list_faculty_category_assignments')
  if (error) throw error
  return data ?? []
}

/**
 * Day 9B — admin sets a faculty member's assigned categories (atomic replace
 * inside the SECURITY DEFINER RPC set_faculty_category_assignments). The RPC
 * verifies the caller is admin, the target is a faculty member with a
 * department, and every category is non-sensitive and mapped to the target's
 * department — nothing is written if any input is invalid. Returns the
 * target's current assignment rows.
 */
export async function setFacultyCategoryAssignments(targetFacultyId, categoryIds) {
  const client = ensureSupabase()
  const { data, error } = await client.rpc('set_faculty_category_assignments', {
    p_target_faculty_id: targetFacultyId,
    p_category_ids: categoryIds,
  })
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------------------
// Day 10A — Complaint Edit & Delete (student, own submitted complaints)
//
// Editing and deleting a complaint are STUDENT actions that go EXCLUSIVELY
// through the Day 10A SECURITY DEFINER RPCs (edit_complaint /
// delete_complaint). The client submits only the editable values (or the
// complaint id for delete); the database verifies INSIDE each function that
// the caller is authenticated, has role 'student', OWNS the complaint
// (student_id = auth.uid() — the user id is never accepted from the client),
// that the complaint exists, is not soft-deleted, and is currently
// 'submitted'. There is still no direct UPDATE/DELETE grant on
// public.complaints, so the RPCs are the only write paths. Deletion is a
// SOFT delete (deleted_at + deleted_by_role set atomically; the row and its
// messages/history are never physically removed) and every read path —
// dashboards, detail pages, chat, history, direct URLs — returns the same
// empty "not found / no access" result for deleted complaints.
// ---------------------------------------------------------------------------

/**
 * Day 10A — student edits their OWN submitted complaint. Only title,
 * description, category and priority may change; the SECURITY DEFINER RPC
 * validates every input, re-derives category routing (is_sensitive /
 * handler_type / department_id) from the new category using the same
 * database derivation as submission, and returns ONLY safe fields:
 *   { id, ticket_number, category_id, department_id, title, description,
 *     priority, status, handler_type, is_sensitive, created_at, updated_at }
 */
export async function editComplaint(complaintId, { title, description, categoryId, priority }) {
  const client = ensureSupabase()
  const { data, error } = await client
    .rpc('edit_complaint', {
      p_complaint_id: complaintId,
      p_new_title: title,
      p_new_description: description,
      p_new_category_id: categoryId,
      p_new_priority: priority,
    })
    .single()
  if (error) throw error
  return data
}

/**
 * Day 10A — student soft-deletes their OWN submitted complaint. The RPC
 * verifies ownership + current status inside the database and sets
 * deleted_at / deleted_by_role atomically (the row is never physically
 * removed). Returns { ticket_number, status, deleted_at } so the page can
 * confirm and navigate away — the complaint disappears from every read path
 * immediately (RLS).
 */
export async function deleteComplaint(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .rpc('delete_complaint', { p_complaint_id: complaintId })
    .single()
  if (error) throw error
  return data
}

/**
 * Day 9B — loads the category -> department routing table so the admin UI can
 * render only the checkboxes for categories that actually belong to each
 * faculty member's department. Reference data, readable by any signed-in
 * user (Day 3 grant); the RPC re-validates the mapping server-side.
 */
export async function fetchCategoryDepartmentMap() {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('category_department_map')
    .select('category_id, department_id')
  if (error) throw error
  return data ?? []
}

/**
 * Day 9B — loads all categories WITH their sensitivity flag so the admin UI
 * can render every checkbox and mark sensitive categories as not assignable
 * to faculty (the RPC rejects them unconditionally).
 */
export async function fetchCategoriesWithSensitivity() {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaint_categories')
    .select('id, name, is_sensitive')
    .order('name', { ascending: true })
  if (error) throw error
  return data ?? []
}

// ---------------------------------------------------------------------------
// Day 10B — Complaint attachments (images + optional video)
//
// Files are stored in the PRIVATE bucket `complaint-attachments` under
// randomized paths (complaints/<complaint_uuid>/<random_uuid>.<ext> — never
// any identity); the database stores METADATA ONLY in
// public.complaint_attachments. Reads go through RLS-scoped queries plus
// short-lived signed URLs (the storage service re-checks authorization on
// every signed-URL request). Writes go EXCLUSIVELY through the Day 10B
// SECURITY DEFINER RPCs (create_complaint_attachment /
// delete_complaint_attachment) — the client has no INSERT/UPDATE/DELETE
// grant on complaint_attachments and never sends student_id or any identity.
//
// Metadata rows expose `storage_path` (random, identity-free) because the
// client needs it to request a signed URL; it is never rendered in the UI.
// ---------------------------------------------------------------------------

/**
 * Day 10B — fetches the attachment metadata for one complaint. Row
 * visibility is enforced ENTIRELY by RLS (can_access_complaint): the owner
 * sees their own, faculty only assigned-category complaints, committee only
 * sensitive ones, admin all; soft-deleted complaints return nothing. Returns
 * safe, identity-free rows:
 *   { id, complaint_id, storage_path, file_name, media_type, file_size,
 *     created_at }
 */
export async function fetchComplaintAttachments(complaintId) {
  const client = ensureSupabase()
  const { data, error } = await client
    .from('complaint_attachments')
    .select('id, complaint_id, storage_path, file_name, media_type, file_size, created_at')
    .eq('complaint_id', complaintId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

/**
 * Day 10B — creates a SHORT-LIVED signed URL for ONE attachment. The
 * storage service re-checks its RLS before signing: a caller who cannot
 * access the complaint (via can_access_complaint on the path's complaint
 * id) gets nothing, so paths can never be signed by unauthorized users. The
 * URL expires after ATTACHMENT_SIGNED_URL_TTL_SECONDS and is never persisted.
 */
export async function getAttachmentSignedUrl(attachment) {
  const client = ensureSupabase()
  const { data, error } = await client.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(attachment.storage_path, ATTACHMENT_SIGNED_URL_TTL_SECONDS)
  if (error) throw error
  return data?.signedUrl ?? null
}

/**
 * Day 10B — uploads ONE attachment for a complaint and registers its
 * metadata.
 *
 * Flow: (1) client-side type/size checks (mirrors of the server rules),
 * (2) EXIF-strip images by re-encoding, (3) upload the bytes to the PRIVATE
 * bucket under a randomized path (the storage INSERT policy only permits the
 * OWNING student of a submitted complaint), (4) create the metadata row via
 * the SECURITY DEFINER RPC, which re-verifies ownership/status/limits AND
 * checks the real uploaded bytes (owner + size) before accepting.
 *
 * If the RPC rejects the file (e.g. a limit the client missed), the just-
 * uploaded object is removed again (orphan cleanup) before re-throwing, so
 * no orphan file is left behind.
 *
 * Returns the metadata row (safe fields only).
 */
export async function uploadComplaintAttachment(complaintId, file) {
  const client = ensureSupabase()
  const ext = attachmentExtensionFor(file)
  if (!ext) {
    throw new Error('This file type is not supported. Use JPG, PNG or WebP images, or MP4, WebM or MOV video.')
  }

  // Randomized, identity-free storage path.
  const storagePath = `complaints/${complaintId}/${randomUuid()}.${ext}`

  // Strip EXIF/location metadata from images before permanent storage.
  const blob = await stripImageMetadata(file)

  // 1. Upload the bytes. The storage INSERT policy authorizes the owning
  //    student of a submitted complaint only.
  const { error: uploadError } = await client.storage
    .from(ATTACHMENT_BUCKET)
    .upload(storagePath, blob, { contentType: file.type, upsert: false })
  if (uploadError) throw uploadError

  // 2. Register the metadata through the RPC (authoritative validator). The
  //    size sent is the re-encoded blob's size — the same bytes the storage
  //    service recorded, so the RPC's server-side size check always passes
  //    for honest uploads.
  try {
    const { data, error } = await client
      .rpc('create_complaint_attachment', {
        p_complaint_id: complaintId,
        p_storage_path: storagePath,
        p_file_name: file.name,
        p_media_type: file.type,
        p_file_size: blob.size,
      })
      .single()
    if (error) throw error
    return data
  } catch (err) {
    // 3. Orphan cleanup: the bytes exist but no metadata row was created, so
    //    the file is unreachable through the app — remove it best-effort.
    try {
      await client.storage.from(ATTACHMENT_BUCKET).remove([storagePath])
    } catch (cleanupErr) {
      console.warn('[attachments] failed to clean up orphaned upload', cleanupErr)
    }
    throw err
  }
}

/**
 * Day 10B — removes ONE attachment: the RPC (SECURITY DEFINER) verifies
 * ownership/status and deletes the metadata row, then the file object is
 * removed from the bucket best-effort (the storage DELETE policy allows the
 * owning student while the complaint is submitted). If the file removal
 * fails the orphan is unreachable (no metadata), so the app is never left in
 * a wrong state. Returns the RPC's safe row (includes storage_path).
 */
export async function deleteComplaintAttachment(attachment) {
  const client = ensureSupabase()
  const { data, error } = await client
    .rpc('delete_complaint_attachment', { p_attachment_id: attachment.id })
    .single()
  if (error) throw error
  const storagePath = data?.storage_path
  if (storagePath) {
    try {
      await client.storage.from(ATTACHMENT_BUCKET).remove([storagePath])
    } catch (err) {
      console.warn('[attachments] metadata removed but file cleanup failed', err)
    }
  }
  return data
}
