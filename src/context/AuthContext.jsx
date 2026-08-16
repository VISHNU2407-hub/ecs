import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import {
  getDashboardKey,
  getUserRole,
  registerFaculty as registerFacultyAction,
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
 *
 * Staleness guards (Day 10C stale-role fix):
 *   - The role is re-read from public.profiles on EVERY fresh SIGNED_IN (and
 *     on initial session restore / page refresh via getSession), so a
 *     sign-out + sign-in never reuses a cached role — even if the previous
 *     SIGNED_OUT was missed, the tracked-user shortcut only applies to
 *     redundant events (TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION).
 *   - A monotonic roleFetchVersionRef makes the LATEST-started fetch
 *     authoritative: a stale async read (e.g. the SIGNED_IN listener fetching
 *     the profile BEFORE register_faculty committed) can never overwrite the
 *     fresh result of refreshRole() with an old 'student' value.
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

  // Monotonic counter for role fetches. Only the LATEST fetch may update the
  // role state: an older fetch that resolves late (e.g. the SIGNED_IN listener
  // read the profile BEFORE register_faculty committed, then resolved AFTER
  // refreshRole's fresh read) must never overwrite the newer result with a
  // stale value — that is what left a freshly-registered faculty user resolved
  // as 'student' (Day 10C stale-role bug).
  const roleFetchVersionRef = useRef(0)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return undefined
    }

    let mounted = true

    async function resolveRoleForUser(nextUser, event = 'INITIAL_SESSION') {
      if (!mounted) return
      const nextId = nextUser?.id ?? null
      if (!nextUser) {
        // Sign-out: clear the tracked user so the next sign-in ALWAYS re-reads
        // the authoritative role from public.profiles (never a cached role).
        userRef.current = null
        setRole(null)
        setRoleLoading(false)
        return
      }
      // Re-read the authoritative role on every fresh sign-in (SIGNED_IN) even
      // when the same user is already tracked — the profile may have been
      // elevated since (e.g. Day 10C register_faculty), and a missed
      // SIGNED_OUT must not leave a cached role behind. Only redundant
      // same-user events (TOKEN_REFRESHED, USER_UPDATED, the listener's
      // INITIAL_SESSION after getSession already resolved) skip the fetch so
      // the guards do not flash on every token refresh.
      if (nextId === userRef.current?.id && event !== 'SIGNED_IN') return
      userRef.current = nextUser
      // Authenticated but role/profile resolution still in progress — guards
      // must show a loading state, never redirect to an unresolved route.
      setRoleLoading(true)
      const version = ++roleFetchVersionRef.current
      const nextRole = await getUserRole(nextUser)
      // Only the latest-started fetch may write the role — a stale result that
      // resolves late is dropped, so a fresh value (e.g. 'faculty' after
      // register_faculty) can never be overwritten by an older read.
      if (!mounted || version !== roleFetchVersionRef.current) return
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

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return
      const nextUser = newSession?.user ?? null
      setSession(newSession)
      setUser(nextUser)
      await resolveRoleForUser(nextUser, event)
      if (mounted) setLoading(false)
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  // Day 10C — re-resolves the authoritative role for the CURRENT user from
  // public.profiles.role and RETURNS it, so callers can navigate on the
  // verified value instead of a stale AuthContext role. Used after
  // register_faculty flips a profile to faculty, so the dashboard target
  // reflects the new role without a reload. Reads the user from the session
  // directly (not the state closure) so it works even right after signUp,
  // before onAuthStateChange has propagated; falls back to the same
  // least-privilege default as getUserRole. Returns the freshly-read role
  // (never null for a signed-in user) or null when there is no session.
  async function refreshRole() {
    const { data } = await supabase.auth.getUser()
    const nextUser = data.user ?? null
    if (!nextUser) return null
    userRef.current = nextUser
    setUser(nextUser)
    setRoleLoading(true)
    // This is the newest fetch, so it always wins over any earlier SIGNED_IN
    // read that may still be in flight (see roleFetchVersionRef): a stale
    // 'student' result can never overwrite this fresh read.
    const version = ++roleFetchVersionRef.current
    const nextRole = await getUserRole(nextUser)
    // Only the latest-started fetch may write the role state — but the value
    // read here is returned regardless: it was read from the CURRENT database
    // AFTER register_faculty committed, so it is authoritative for routing.
    if (version === roleFetchVersionRef.current) {
      setRole(nextRole)
      setRoleLoading(false)
    }
    return nextRole
  }

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
      registerFaculty: registerFacultyAction,
      refreshRole,
      resetPassword: resetPasswordAction,
      updatePassword: updatePasswordAction,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
