import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { useAuth } from '../context/AuthContext.jsx'

// True when the URL still carries recovery tokens (implicit or PKCE flow) that
// supabase-js is about to exchange into a session. During that window the user
// has no session yet, but they should NOT be bounced back to /forgot-password.
function hasRecoveryParams() {
  return (
    window.location.hash.includes('access_token') ||
    new URLSearchParams(window.location.search).has('code')
  )
}

export default function UpdatePasswordPage() {
  const { user, loading, updatePassword, signOut } = useAuth()
  const navigate = useNavigate()

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (loading || (!user && hasRecoveryParams())) {
    return <LoadingScreen label="Preparing password reset…" />
  }
  // No recovery session — the user opened this page on their own.
  if (!user) {
    return <Navigate to="/forgot-password" replace />
  }

  function handleSubmit(event) {
    event.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    updatePassword(password)
      .then(async () => {
        await signOut()
        navigate('/login', {
          replace: true,
          state: {
            notice: 'Your password has been updated. Please sign in with your new password.',
          },
        })
      })
      .catch((err) => {
        setError(err?.message ?? 'Something went wrong. Please try again.')
        setSubmitting(false)
      })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-4xl" aria-hidden="true">
            🎓
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">Choose a new password</h1>
          <p className="mt-1 text-sm text-gray-500">
            For {user.email ?? 'your account'}
          </p>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700">
                Confirm new password
              </label>
              <input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
