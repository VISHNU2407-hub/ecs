import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'

/**
 * Central definition of navigation items per role.
 *
 * Later phases will render this based on the authenticated user's role
 * instead of the role passed in from the route wrapper, and each role's
 * item list will grow as its features are built.
 */
const NAV_ITEMS = {
  student: [{ to: '/student', label: 'Dashboard' }],
  staff: [{ to: '/staff', label: 'Dashboard' }],
  admin: [{ to: '/admin', label: 'Dashboard' }],
}

const ROLE_LABELS = {
  student: 'Student',
  staff: 'Staff',
  admin: 'Admin',
}

export default function AppLayout({ role, children }) {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  const navItems = NAV_ITEMS[role] ?? []
  const roleLabel = ROLE_LABELS[role] ?? role

  async function handleSignOut() {
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-4">
          <Link
            to={`/${role}`}
            className="flex shrink-0 items-center gap-2 text-lg font-semibold text-gray-900"
          >
            <span aria-hidden="true">🎓</span>
            <span>Complaint Portal</span>
          </Link>

          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            {user?.email && (
              <span className="hidden max-w-[180px] truncate text-xs text-gray-500 sm:block">
                {user.email}
              </span>
            )}
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
              {roleLabel}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-sm font-medium text-gray-500 hover:text-gray-900"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>

      <footer className="border-t border-gray-200 bg-white py-4">
        <p className="text-center text-xs text-gray-500">
          College Complaint Management System — Day 3 (Database, Roles & Security)
        </p>
      </footer>
    </div>
  )
}
