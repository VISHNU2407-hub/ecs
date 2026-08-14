import { Link } from 'react-router-dom'

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-4xl" aria-hidden="true">
            🎓
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">
            College Complaint Management System
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Sign in to submit and manage complaints
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@college.edu"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled
              title="Authentication will be added in a later phase"
              className="w-full cursor-not-allowed rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white opacity-60"
            >
              Sign in
            </button>
          </form>
          <p className="mt-4 text-center text-xs text-gray-500">
            Authentication will be added in a later phase.
          </p>
        </div>

        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-center text-xs font-medium uppercase tracking-wide text-gray-400">
            Preview role pages (Day 1 only)
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <Link
              to="/student"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Student
            </Link>
            <Link
              to="/staff"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Staff
            </Link>
            <Link
              to="/admin"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Admin
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
