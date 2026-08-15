import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import LoadingScreen from './LoadingScreen.jsx'

/**
 * Guards role dashboards:
 * - while the session is being checked, show a loading state;
 * - unauthenticated users are sent to /login;
 * - authenticated users whose profile role is still being resolved wait on a
 *   loading state — a redirect now would have to be built from a null
 *   dashboard key;
 * - once the role is resolved, users without the required role are sent to
 *   their own dashboard.
 *
 * The role requirement is enforced against the role resolved by
 * authService.getUserRole, which reads the authoritative role from
 * public.profiles (Day 3). A route is only ever constructed from a resolved,
 * non-null dashboardKey — "/null" / "/undefined" are impossible.
 */
export default function ProtectedRoute({ role, children }) {
  const { user, dashboardKey, loading, roleLoading } = useAuth()

  // 1. Authentication/session loading.
  if (loading) return <LoadingScreen />
  // 2. No authenticated user.
  if (!user) return <Navigate to="/login" replace />
  // 3. Authenticated but role/profile resolution still in progress (or the
  //    dashboard key is somehow unresolved) — wait, never redirect.
  if (roleLoading || !dashboardKey) return <LoadingScreen />
  // 4. Role resolved: enforce the required role.
  if (role && dashboardKey !== role) return <Navigate to={`/${dashboardKey}`} replace />
  return children
}

/**
 * Guards public-only pages (/login, /register): a user who is already signed
 * in is sent to their own dashboard — but only AFTER the profile role has
 * resolved, so the redirect never targets a route built from null.
 */
export function PublicOnlyRoute({ children }) {
  const { user, dashboardKey, loading, roleLoading } = useAuth()

  if (loading) return <LoadingScreen />
  if (user) {
    if (roleLoading || !dashboardKey) return <LoadingScreen />
    return <Navigate to={`/${dashboardKey}`} replace />
  }
  return children
}
