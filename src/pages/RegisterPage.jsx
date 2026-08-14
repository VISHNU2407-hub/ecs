import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { COLLEGE_EMAIL_DOMAIN, isCollegeEmail } from '../lib/authService.js'

const DUPLICATE_EMAIL_MESSAGE = 'An account with this email already exists. Please login.'

export default function RegisterPage() {
  const { signUp } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSuccess('')

    const trimmedEmail = email.trim()

    if (!isCollegeEmail(trimmedEmail)) {
      setError('Please use your college email address.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    signUp(trimmedEmail, password)
      .then(({ user }) => {
        // With "Confirm email" enabled, Supabase reports an already-registered
        // email as a successful sign-up with no identities (to avoid leaking
        // that the account exists) — treat it as a duplicate.
        if (user && Array.isArray(user.identities) && user.identities.length === 0) {
          setError(DUPLICATE_EMAIL_MESSAGE)
          setSubmitting(false)
          return
        }

        const message = `Account created successfully! A confirmation email has been sent to ${trimmedEmail}. Please verify your email before signing in.`
        setSuccess(message)
        // Show the success message briefly, then send the user to /login
        // (they are intentionally NOT signed in automatically).
        window.setTimeout(() => {
          navigate('/login', { state: { notice: message } })
        }, 2500)
      })
      .catch((err) => {
        if (
          err?.code === 'user_already_exists' ||
          /already registered/i.test(err?.message ?? '')
        ) {
          setError(DUPLICATE_EMAIL_MESSAGE)
        } else {
          setError(err?.message ?? 'Something went wrong. Please try again.')
        }
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
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">
            Create a student account
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Use your college email address ({COLLEGE_EMAIL_DOMAIN})
          </p>
        </div>

        {success && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <p>{success}</p>
            <p className="mt-1 text-xs text-green-700">Redirecting to login…</p>
          </div>
        )}

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                College email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@gprec.ac.in"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
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
                Confirm password
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
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-blue-600 hover:text-blue-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
