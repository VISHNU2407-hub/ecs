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
