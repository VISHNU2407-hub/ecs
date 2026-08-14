import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import {
  getDashboardKey,
  getUserRole,
  resetPassword as resetPasswordAction,
  signIn as signInAction,
  signOut as signOutAction,
  signUp as signUpAction,
  updatePassword as updatePasswordAction,
} from '../lib/authService.js'

const AuthContext = createContext(null)

/**
 * Provides the current Supabase auth session, the resolved role, and the
 * auth actions used by pages. Session persistence (refresh, restore on
 * reload) is handled by supabase-js itself.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  // The authoritative role from public.profiles (Day 3). Resolved asynchronously
  // after the session is known; falls back to 'student' if the profile lookup
  // fails or the migration has not been applied yet.
  const [role, setRole] = useState(null)
  // True while the session (and role) is being checked on first load.
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return undefined
    }

    let mounted = true

    async function resolveRoleForUser(nextUser) {
      if (!nextUser) {
        setRole(null)
        return
      }
      const nextRole = await getUserRole(nextUser)
      if (mounted) setRole(nextRole)
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      setSession(data.session)
      setUser(data.session?.user ?? null)
      await resolveRoleForUser(data.session?.user ?? null)
      if (mounted) setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession)
      setUser(newSession?.user ?? null)
      await resolveRoleForUser(newSession?.user ?? null)
      if (mounted) setLoading(false)
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo(
    () => ({
      session,
      user,
      role,
      // Route-safe dashboard key derived from the DB role (see getDashboardKey).
      dashboardKey: role ? getDashboardKey(role) : null,
      loading,
      signIn: signInAction,
      signUp: signUpAction,
      signOut: signOutAction,
      resetPassword: resetPasswordAction,
      updatePassword: updatePasswordAction,
    }),
    [session, user, role, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
