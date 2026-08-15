import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
 *
 * Role-resolution lifecycle (Day 5 bug fix — the /null redirect):
 *   loading     — true until the initial session check completes. This covers
 *                 the session-restore path (refresh while logged in): the
 *                 stored session's role is resolved before loading turns
 *                 false, so the first render after boot already has a valid
 *                 dashboard key.
 *   roleLoading — true while an authenticated user's profile role is being
 *                 fetched from public.profiles.role. This is SEPARATE from
 *                 `loading` so a sign-in event can never race the redirect:
 *                 when the session appears, the UI must wait for the role
 *                 lookup before building any dashboard route.
 *   role         — the resolved app role (public.profiles.role). null while
 *                 resolving or when signed out.
 *   dashboardKey — route-safe dashboard key derived from role. null while the
 *                 role is unresolved, so route guards can never build a
 *                 navigation target from null/undefined.
 *
 * getUserRole never returns null for a signed-in user: a missing profile row
 * or a failed lookup falls back to 'student' (least privilege). The role
 * authority remains public.profiles.role — auth user metadata is never used.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  // The authoritative role from public.profiles (Day 3). Resolved asynchronously
  // after the session is known; falls back to 'student' if the profile lookup
  // fails or the migration has not been applied yet.
  const [role, setRole] = useState(null)
  // True while the initial session (and its role) is being checked on first load.
  const [loading, setLoading] = useState(true)
  // True while an authenticated user's role is still being fetched.
  const [roleLoading, setRoleLoading] = useState(false)

  // The user the resolved role belongs to. Lets token-refresh / repeat auth
  // events for the SAME user skip the role fetch entirely, so the guards do
  // not flash the loading state on every session refresh.
  const userRef = useRef(null)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return undefined
    }

    let mounted = true

    async function resolveRoleForUser(nextUser) {
      if (!mounted) return
      const nextId = nextUser?.id ?? null
      // Same user (or still signed out): nothing to (re-)resolve. This keeps
      // TOKEN_REFRESHED events from re-entering roleLoading.
      if (nextId === userRef.current?.id) return
      userRef.current = nextUser ?? null
      if (!nextUser) {
        setRole(null)
        setRoleLoading(false)
        return
      }
      // Authenticated but role/profile resolution still in progress — guards
      // must show a loading state, never redirect to an unresolved route.
      setRoleLoading(true)
      const nextRole = await getUserRole(nextUser)
      if (!mounted) return
      setRole(nextRole)
      setRoleLoading(false)
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      const nextUser = data.session?.user ?? null
      setSession(data.session)
      setUser(nextUser)
      await resolveRoleForUser(nextUser)
      if (mounted) setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (!mounted) return
      const nextUser = newSession?.user ?? null
      setSession(newSession)
      setUser(nextUser)
      await resolveRoleForUser(nextUser)
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
      // null while the role is unresolved — never a usable route.
      dashboardKey: role ? getDashboardKey(role) : null,
      loading,
      roleLoading,
      signIn: signInAction,
      signUp: signUpAction,
      signOut: signOutAction,
      resetPassword: resetPasswordAction,
      updatePassword: updatePasswordAction,
    }),
    [session, user, role, loading, roleLoading],
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
