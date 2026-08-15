import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PriorityBadge, SensitiveBadge, StatusBadge } from '../components/complaints/Badges.jsx'
import { fetchStaffComplaints } from '../lib/complaintService.js'
import { formatDateTime } from '../lib/format.js'

// Filter option lists come from the database enums; the category options are
// derived from the loaded data (safe fields only) so the list always matches
// the complaints actually visible to this staff member.
const STATUS_FILTER_OPTIONS = [
  'submitted',
  'under_review',
  'assigned',
  'in_progress',
  'resolved',
  'reopened',
  'escalated',
  'closed',
]
const PRIORITY_FILTER_OPTIONS = ['low', 'medium', 'high', 'urgent']

const FILTER_SELECT_CLASSES =
  'block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none'

function SelectFilter({ id, label, value, options, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-500">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 ${FILTER_SELECT_CLASSES}`}
      >
        <option value="all">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Day 5 — Staff Dashboard (faculty; admin/committee route here for now).
 *
 * Loads ECS complaints through the Day 3 safe view public.complaints_staff_view.
 * The view is security-invoker and projects ONLY identity-free fields, and
 * the underlying RLS decides which rows this role can see (faculty:
 * non-sensitive; committee: sensitive; admin: all). The frontend never sees
 * student_id / sender_id / email / name — they are not in the response and
 * are not selectable at all (column grants). Filters operate only on safe
 * complaint fields; there are no identity-based filters.
 */
export default function StaffPage() {
  const [complaints, setComplaints] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [ticketQuery, setTicketQuery] = useState('')

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadComplaints() {
    setLoading(true)
    setError('')
    try {
      const rows = await fetchStaffComplaints()
      if (!mountedRef.current) return
      setComplaints(rows)
    } catch (err) {
      // Never surface raw database errors to the user.
      console.error('[staff-dashboard] Failed to load complaints', err)
      if (!mountedRef.current) return
      setError('Could not load complaints. Please try again.')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    loadComplaints()
    // Load once on mount; the retry button re-runs loadComplaints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Category options are derived from the loaded (identity-free) data — never
  // hardcoded, and never based on identity.
  const categoryOptions = useMemo(() => {
    const names = [...new Set(complaints.map((c) => c.category).filter(Boolean))]
    return names.sort((a, b) => a.localeCompare(b))
  }, [complaints])

  const filtersActive =
    statusFilter !== 'all' ||
    categoryFilter !== 'all' ||
    priorityFilter !== 'all' ||
    ticketQuery.trim() !== ''

  // Client-side filtering over safe complaint fields only. For this ECS pilot
  // the list is small, so filtering in the UI keeps the queries minimal; the
  // database still owns row visibility via RLS on the view.
  const filteredComplaints = useMemo(() => {
    const query = ticketQuery.trim().toLowerCase()
    return complaints.filter((complaint) => {
      if (statusFilter !== 'all' && complaint.status !== statusFilter) return false
      if (categoryFilter !== 'all' && complaint.category !== categoryFilter) return false
      if (priorityFilter !== 'all' && complaint.priority !== priorityFilter) return false
      if (query && !complaint.ticket_number.toLowerCase().includes(query)) return false
      return true
    })
  }, [complaints, statusFilter, categoryFilter, priorityFilter, ticketQuery])

  function clearFilters() {
    setStatusFilter('all')
    setCategoryFilter('all')
    setPriorityFilter('all')
    setTicketQuery('')
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Staff Dashboard</h1>
        <p className="mt-1 text-sm text-gray-600">
          ECS complaints — reviewed anonymously. No student identity is ever shown.
        </p>
      </div>

      {/* Filters — safe complaint fields only */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="ticket-search" className="block text-xs font-medium text-gray-500">
              Search by ticket
            </label>
            <input
              id="ticket-search"
              type="search"
              placeholder="e.g. CMP-0002"
              value={ticketQuery}
              onChange={(event) => setTicketQuery(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <SelectFilter
            id="status-filter"
            label="Status"
            value={statusFilter}
            options={STATUS_FILTER_OPTIONS}
            onChange={setStatusFilter}
          />
          <SelectFilter
            id="category-filter"
            label="Category"
            value={categoryFilter}
            options={categoryOptions}
            onChange={setCategoryFilter}
          />
          <SelectFilter
            id="priority-filter"
            label="Priority"
            value={priorityFilter}
            options={PRIORITY_FILTER_OPTIONS}
            onChange={setPriorityFilter}
          />
        </div>
        {filtersActive && (
          <div className="mt-3 text-right">
            <button
              type="button"
              onClick={clearFilters}
              className="text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>

      {/* Complaint list */}
      <section aria-labelledby="complaints-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="complaints-heading" className="text-lg font-semibold text-gray-900">
            Complaints
          </h2>
          {!loading && !error && (
            <p className="text-xs text-gray-500">
              Showing {filteredComplaints.length} of {complaints.length} complaints
            </p>
          )}
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white p-10 shadow-sm">
            <div
              aria-hidden="true"
              className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
            />
            <p className="text-sm text-gray-500">Loading complaints…</p>
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
              Complaints submitted by students will appear here.
            </p>
          </div>
        )}

        {!loading && !error && complaints.length > 0 && filteredComplaints.length === 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
            <p className="text-lg font-medium text-gray-900">No complaints match your filters.</p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear filters
            </button>
          </div>
        )}

        {!loading && !error && filteredComplaints.length > 0 && (
          <ul className="space-y-3">
            {filteredComplaints.map((complaint) => (
              <li key={complaint.id}>
                <Link
                  to={`/staff/complaints/${complaint.id}`}
                  className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-colors hover:border-blue-300 hover:shadow-md sm:p-5"
                >
                  <article>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-semibold text-gray-900">
                          {complaint.ticket_number}
                        </p>
                        <p className="mt-0.5 text-sm text-gray-600">
                          {complaint.category ?? '—'}
                          {complaint.department ? ` · ${complaint.department}` : ''}
                          {complaint.handler_type
                            ? ` · ${complaint.handler_type} handling`
                            : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <PriorityBadge priority={complaint.priority} />
                        <StatusBadge status={complaint.status} />
                        <SensitiveBadge isSensitive={complaint.is_sensitive} />
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
                    <p className="mt-3 text-xs font-medium text-blue-600">View details →</p>
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
