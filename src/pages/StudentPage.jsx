import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { PriorityBadge, StatusBadge } from '../components/complaints/Badges.jsx'
import { fetchStudentComplaints } from '../lib/complaintService.js'
import { formatDateTime } from '../lib/format.js'

// Statuses that count as "resolved / closed" for the summary cards.
// Everything else (submitted … escalated/reopened) counts as active.
const CLOSED_STATUSES = new Set(['resolved', 'closed'])

function SummaryCard({ label, value, description, accentClasses }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <p className={`text-2xl font-semibold ${accentClasses}`}>{value}</p>
      <p className="mt-1 text-sm font-medium text-gray-700">{label}</p>
      {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
    </div>
  )
}

/**
 * Day 5 — Student Dashboard.
 *
 * Shows the signed-in student only their OWN complaints. Ownership is
 * enforced by the Day 3 RLS policy (complaints_select_student:
 * student_id = auth.uid()) — the dashboard query carries no ownership
 * filter because student_id is not selectable at all (column grant), so the
 * frontend literally cannot display another student's rows. Category names
 * come from the existing complaints -> complaint_categories relationship —
 * never hardcoded.
 */
export default function StudentPage() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [complaints, setComplaints] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Day 10A — ticket number of a complaint just deleted on the detail page
  // (passed through router state), shown once as a success banner.
  const [deletedTicket, setDeletedTicket] = useState(
    location.state?.deletedTicket ?? null,
  )

  const mountedRef = useRef(true)
  const loadingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadComplaints() {
    if (!user) return
    loadingRef.current = true
    setLoading(true)
    setError('')
    try {
      // RLS (student_id = auth.uid() AND deleted_at is null) returns only
      // this student's non-deleted rows; the query itself has no ownership
      // filter because student_id is not a selectable column (Day 3 column
      // grants). Soft-deleted complaints simply never arrive.
      const rows = await fetchStudentComplaints()
      if (!mountedRef.current) return
      setComplaints(rows)
    } catch (err) {
      // Never surface raw database errors to the user.
      console.error('[student-dashboard] Failed to load complaints', err)
      if (!mountedRef.current) return
      setError('Could not load your complaints. Please try again.')
    } finally {
      loadingRef.current = false
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    loadComplaints()
    // Load once per signed-in user; the retry button re-runs loadComplaints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Day 10A — after a successful delete the detail page navigates here with
  // the deleted ticket in router state; show the banner once and clear the
  // state so a refresh does not repeat it.
  useEffect(() => {
    if (location.state?.deletedTicket) {
      setDeletedTicket(location.state.deletedTicket)
      navigate(location.pathname, { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.deletedTicket])

  // Day 10A — refetch quietly when the tab regains focus, so a complaint
  // deleted (or status-changed) in another tab/session disappears from this
  // already-open dashboard without a manual refresh. Realtime cannot deliver
  // the soft-delete event (RLS drops events for rows the subscriber can no
  // longer see), so this refocus refetch is the honest mechanism.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible' && !loadingRef.current) {
        fetchStudentComplaints()
          .then((rows) => {
            if (mountedRef.current) setComplaints(rows)
          })
          .catch((err) => {
            // Quiet failure — the list keeps its current (possibly stale)
            // data; the retry path still exists on the explicit error state.
            console.error('[student-dashboard] background refresh failed', err)
          })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [])

  const total = complaints.length
  const closedCount = complaints.filter((c) => CLOSED_STATUSES.has(c.status)).length
  const activeCount = total - closedCount

  return (
    <div className="space-y-6">
      {/* Header / welcome */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Student Dashboard</h1>
          <p className="mt-1 text-sm text-gray-600">
            Welcome back — here is what is happening with your complaints.
          </p>
          {user?.email && (
            <p className="mt-0.5 text-xs text-gray-500">Signed in as {user.email}</p>
          )}
        </div>
        <Link
          to="/student/complaints/new"
          className="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New Complaint
        </Link>
      </div>

      {/* Day 10A — success banner after deleting a complaint on the detail
          page. The complaint is already gone from the list (RLS). */}
      {deletedTicket && (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800 shadow-sm"
        >
          Complaint{' '}
          <span className="font-mono font-semibold">{deletedTicket}</span> was
          deleted. It can no longer be accessed from the complaint portal.
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Total complaints"
          value={loading ? '—' : total}
          description="All complaints you have submitted"
          accentClasses="text-gray-900"
        />
        <SummaryCard
          label="Active complaints"
          value={loading ? '—' : activeCount}
          description="Still being reviewed or worked on"
          accentClasses="text-blue-700"
        />
        <SummaryCard
          label="Resolved / closed"
          value={loading ? '—' : closedCount}
          description="Complaints that are resolved or closed"
          accentClasses="text-green-700"
        />
      </div>

      {/* My complaints */}
      <section aria-labelledby="my-complaints-heading" className="space-y-4">
        <h2 id="my-complaints-heading" className="text-lg font-semibold text-gray-900">
          My Complaints
        </h2>

        {loading && (
          <div className="flex items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white p-10 shadow-sm">
            <div
              aria-hidden="true"
              className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
            />
            <p className="text-sm text-gray-500">Loading your complaints…</p>
          </div>
        )}

        {!loading && error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-6 text-center shadow-sm"
          >
            <p className="text-sm text-red-700">{error}</p>
            <button
              type="button"
              onClick={loadComplaints}
              className="mt-4 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && complaints.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
            <p className="text-lg font-medium text-gray-900">No complaints yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-gray-600">
              When you submit a complaint, it will appear here with its ticket
              number and status.
            </p>
            <Link
              to="/student/complaints/new"
              className="mt-5 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Submit your first complaint
            </Link>
          </div>
        )}

        {!loading && !error && complaints.length > 0 && (
          <ul className="space-y-3">
            {complaints.map((complaint) => (
              <li key={complaint.id}>
                <Link
                  to={`/student/complaints/${complaint.id}`}
                  className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-blue-300 hover:shadow-md sm:p-5"
                >
                  <article>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-semibold text-gray-900">
                          {complaint.ticket_number}
                        </p>
                        <p className="mt-0.5 text-sm text-gray-600">
                          {complaint.category ?? 'Category unavailable'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <PriorityBadge priority={complaint.priority} />
                        <StatusBadge status={complaint.status} />
                      </div>
                    </div>
                    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                      <div>
                        <dt className="sr-only">Created date</dt>
                        <dd>Created: {formatDateTime(complaint.created_at)}</dd>
                      </div>
                      <div>
                        <dt className="sr-only">Updated date</dt>
                        <dd>Updated: {formatDateTime(complaint.updated_at)}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-xs font-medium text-blue-600">Open conversation →</p>
                  </article>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
