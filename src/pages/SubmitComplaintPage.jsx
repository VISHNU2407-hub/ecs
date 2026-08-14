import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import {
  MIN_DESCRIPTION_LENGTH,
  PRIORITY_LEVELS,
  fetchComplaintCategories,
  submitComplaint,
} from '../lib/complaintService.js'

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

function RequiredMark() {
  return (
    <span className="text-red-500" aria-hidden="true">
      *
    </span>
  )
}

function inputClasses(invalid) {
  return `mt-1 block w-full rounded-md border px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none ${
    invalid ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-blue-500'
  }`
}

/**
 * Day 4 — student complaint submission.
 *
 * The form only collects what a student may control (category, description,
 * priority). ticket_number, is_sensitive, handler_type, department_id and
 * status are derived by the database (Day 3 trigger) — never by this page.
 */
export default function SubmitComplaintPage() {
  const { user } = useAuth()

  const [categories, setCategories] = useState([])
  const [categoriesLoading, setCategoriesLoading] = useState(true)
  const [categoriesError, setCategoriesError] = useState('')

  const [categoryId, setCategoryId] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('medium')

  const [fieldErrors, setFieldErrors] = useState({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // The created complaint row: { id, ticket_number, status }.
  const [result, setResult] = useState(null)

  // In-flight guard so two rapid clicks cannot submit twice, on top of the
  // disabled submit button (which covers the common double-click case).
  const submittingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadCategories() {
    setCategoriesLoading(true)
    setCategoriesError('')
    try {
      const cats = await fetchComplaintCategories()
      if (!mountedRef.current) return
      setCategories(cats)
      if (cats.length === 0) {
        setCategoriesError('No complaint categories are available right now. Please try again later.')
      }
    } catch (err) {
      console.error('[complaints] Failed to load categories', err)
      if (!mountedRef.current) return
      setCategoriesError('Could not load the complaint categories. Please try again.')
    } finally {
      if (mountedRef.current) setCategoriesLoading(false)
    }
  }

  useEffect(() => {
    loadCategories()
    // Load once on mount; the retry button re-runs loadCategories directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function validate() {
    const errors = {}
    if (!categoryId) {
      errors.category = 'Please select a category.'
    } else if (!categories.some((c) => c.id === categoryId)) {
      errors.category = 'Please select a valid category.'
    }

    const trimmed = description.trim()
    if (!trimmed) {
      errors.description = 'Please describe your complaint.'
    } else if (trimmed.length < MIN_DESCRIPTION_LENGTH) {
      errors.description = `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters.`
    }

    if (!PRIORITY_LEVELS.includes(priority)) {
      errors.priority = 'Please select a valid priority.'
    }
    return errors
  }

  function clearFieldError(field) {
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitError('')

    // Duplicate-click protection: never start a second submission while one
    // is in flight.
    if (submittingRef.current) return

    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    // The route guard normally prevents this, but never submit without a
    // known session.
    if (!user) {
      setSubmitError('You must be signed in to submit a complaint. Please sign in and try again.')
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    try {
      const created = await submitComplaint({
        studentId: user.id,
        categoryId,
        description: description.trim(),
        priority,
      })
      setResult(created)
    } catch (err) {
      // Never surface raw database errors to the user.
      console.error('[complaints] Submission failed', err)
      setSubmitError('Something went wrong while submitting your complaint. Please try again.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function resetForm() {
    setCategoryId('')
    setDescription('')
    setPriority('medium')
    setFieldErrors({})
    setSubmitError('')
    setResult(null)
  }

  // ---------------------------------------------------------------------------
  // Success state — show the generated ticket number, never identity fields.
  // ---------------------------------------------------------------------------
  if (result) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 shadow-sm sm:p-8">
          <div className="flex flex-col items-center text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg
                className="h-6 w-6 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2.5"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </span>
            <h1 className="mt-4 text-xl font-semibold text-gray-900">
              Complaint submitted successfully
            </h1>
            <p className="mt-1 text-sm text-gray-600">Your ticket number:</p>
            <p className="mt-2 rounded-md bg-white px-4 py-2 font-mono text-xl font-semibold text-blue-700 ring-1 ring-green-200">
              {result.ticket_number}
            </p>
            <p className="mt-3 text-sm text-gray-600">
              Status:{' '}
              <span className="font-medium capitalize text-gray-900">{result.status}</span>
            </p>
            <p className="mt-1 text-sm text-gray-600">
              The ECS department will review your complaint. Keep your ticket number for
              reference.
            </p>
            <div className="mt-6 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Link
                to="/student"
                className="rounded-md bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
              >
                Back to Student Dashboard
              </Link>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Submit another complaint
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------
  const categoriesUnavailable = categoriesLoading || Boolean(categoriesError)

  return (
    <div className="mx-auto w-full max-w-xl">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Submit a complaint</h1>
        <p className="mt-1 text-sm text-gray-600">
          Report an issue to the ECS department. Your identity stays anonymous.
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <div>
            <label htmlFor="category" className="block text-sm font-medium text-gray-700">
              Category <RequiredMark />
            </label>
            <select
              id="category"
              name="category"
              required
              disabled={categoriesUnavailable}
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value)
                clearFieldError('category')
              }}
              aria-invalid={Boolean(fieldErrors.category)}
              className={inputClasses(Boolean(fieldErrors.category))}
            >
              <option value="">
                {categoriesLoading
                  ? 'Loading categories…'
                  : categoriesError
                    ? 'Categories unavailable'
                    : 'Select a category'}
              </option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            {categoriesError && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-red-600">
                <span>{categoriesError}</span>
                <button
                  type="button"
                  onClick={loadCategories}
                  disabled={categoriesLoading}
                  className="font-medium text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Try again
                </button>
              </div>
            )}
            {fieldErrors.category && (
              <p role="alert" className="mt-1 text-sm text-red-600">
                {fieldErrors.category}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">
              Description <RequiredMark />
            </label>
            <textarea
              id="description"
              name="description"
              required
              rows={5}
              placeholder="Describe the issue you are facing…"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
                clearFieldError('description')
              }}
              aria-invalid={Boolean(fieldErrors.description)}
              className={inputClasses(Boolean(fieldErrors.description))}
            />
            <p className="mt-1 text-xs text-gray-500">
              Provide enough detail — at least {MIN_DESCRIPTION_LENGTH} characters.
            </p>
            {fieldErrors.description && (
              <p role="alert" className="mt-1 text-sm text-red-600">
                {fieldErrors.description}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="priority" className="block text-sm font-medium text-gray-700">
              Priority <RequiredMark />
            </label>
            <select
              id="priority"
              name="priority"
              required
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value)
                clearFieldError('priority')
              }}
              aria-invalid={Boolean(fieldErrors.priority)}
              className={inputClasses(Boolean(fieldErrors.priority))}
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {fieldErrors.priority && (
              <p role="alert" className="mt-1 text-sm text-red-600">
                {fieldErrors.priority}
              </p>
            )}
          </div>

          {submitError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || categoriesUnavailable}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Submitting…' : 'Submit complaint'}
          </button>
        </form>
      </div>
    </div>
  )
}
