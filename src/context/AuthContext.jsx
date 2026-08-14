import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import {
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
  // True while the existing session is being checked on first load.
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return undefined
    }

    let mounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setUser(newSession?.user ?? null)
      setLoading(false)
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
      role: user ? getUserRole(user) : null,
      loading,
      signIn: signInAction,
      signUp: signUpAction,
      signOut: signOutAction,
      resetPassword: resetPasswordAction,
      updatePassword: updatePasswordAction,
    }),
    [session, user, loading],
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
