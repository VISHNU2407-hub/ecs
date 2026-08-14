import { createClient } from '@supabase/supabase-js'

// Credentials come exclusively from environment variables (see .env.example).
// Only the publishable (anon) key belongs in frontend code — never a secret
// key (sb_secret_*). Secrets must stay server-side.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null

if (!supabase) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set. ' +
      'Copy .env.example to .env and fill in your Supabase project credentials.',
  )
}
