import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import LoadingScreen from './LoadingScreen.jsx'

/**
 * Guards role dashboards:
 * - while the session is being checked, show a loading state;
 * - unauthenticated users are sent to /login;
 * - users who do not have the required role are sent to their own dashboard.
 *
 * The role requirement is enforced against the role resolved by
 * authService.getUserRole (currently auth metadata; users table on Day 3).
 */
export default function ProtectedRoute({ role, children }) {
  const { user, role: userRole, loading } = useAuth()

  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  if (role && userRole !== role) return <Navigate to={`/${userRole}`} replace />
  return children
}

/**
 * Guards public-only pages (/login, /register): a user who is already signed
 * in is sent to their own dashboard instead.
 */
export function PublicOnlyRoute({ children }) {
  const { user, role, loading } = useAuth()

  if (loading) return <LoadingScreen />
  if (user) return <Navigate to={`/${role}`} replace />
  return children
}
