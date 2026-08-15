import { supabase } from './supabaseClient.js'

// College email domain required for new student accounts.
export const COLLEGE_EMAIL_DOMAIN = 'gprec.ac.in'

const COLLEGE_EMAIL_REGEX = /@gprec\.ac\.in$/i

export function isCollegeEmail(email) {
  return COLLEGE_EMAIL_REGEX.test(email ?? '')
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
 * Day 3 role resolution.
 *
 * The authoritative application role lives in public.profiles.role (set by a
 * database trigger at sign-up). Auth user metadata is NOT authoritative — a
 * user can edit their own metadata, so it must never decide access. If the
 * profile row is missing (e.g. the Day 3 migration has not been applied yet)
 * or the lookup fails, the role falls back to 'student' so sign-in never
 * blocks and least privilege is preserved.
 */
export async function getUserRole(user) {
  if (!user?.id || !supabase) return 'student'
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()
    if (error) throw error
    return data?.role ?? 'student'
  } catch {
    // Never block sign-in on a role lookup failure; default to least privilege.
    return 'student'
  }
}

/**
 * Maps the authoritative database role to the dashboard route key used by
 * the router. The DB roles are student / faculty / admin / committee; the
 * existing routes are /student, /staff and /admin.
 *
 * Day 5 mapping (unchanged role system, no new dashboards):
 *   student  -> student (own complaints dashboard)
 *   faculty  -> staff   (the staff dashboard is the faculty dashboard)
 *   admin    -> staff   (interim: no separate admin dashboard yet)
 *   committee -> staff  (interim: no separate committee dashboard yet)
 *
 * Unknown roles fall back to the student dashboard (least privilege).
 */
export function getDashboardKey(role) {
  switch (role) {
    case 'student':
      return 'student'
    case 'faculty':
    case 'admin':
    case 'committee':
      return 'staff'
    default:
      return 'student'
  }
}

export async function signIn(email, password) {
  const client = ensureSupabase()
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signUp(email, password) {
  const client = ensureSupabase()
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      // Informational only — the authoritative role is created by the
      // database sign-up trigger as 'student'. This metadata is never used
      // for access decisions.
      data: { role: 'student' },
    },
  })
  if (error) throw error
  return data
}

export async function signOut() {
  const client = ensureSupabase()
  const { error } = await client.auth.signOut()
  if (error) throw error
}

export async function resetPassword(email) {
  const client = ensureSupabase()
  const { error } = await client.auth.resetPasswordForEmail(email, {
    // The recovery link returns to this app, where the user sets a new password.
    redirectTo: `${window.location.origin}/update-password`,
  })
  if (error) throw error
}

export async function updatePassword(newPassword) {
  const client = ensureSupabase()
  const { error } = await client.auth.updateUser({ password: newPassword })
  if (error) throw error
}
