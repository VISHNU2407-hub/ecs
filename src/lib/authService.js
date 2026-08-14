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
 * Day 2 role resolution (interim).
 *
 * The users table does not exist yet, so roles cannot be looked up in the
 * database. Everyone who self-registers through /register is a student, so the
 * role is read from Supabase auth user metadata set at sign-up. On Day 3 this
 * function gets replaced by a users-table lookup (staff/admin roles live there).
 */
export function getUserRole(user) {
  return user?.user_metadata?.role ?? 'student'
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
      // Interim role source until the users table exists (Day 3). Every
      // account created here is a student by registration policy.
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
