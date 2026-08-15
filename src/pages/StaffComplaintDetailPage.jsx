import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  PriorityBadge,
  SensitiveBadge,
  STATUS_LABELS,
  StatusBadge,
} from '../components/complaints/Badges.jsx'
import ComplaintChat from '../components/complaints/ComplaintChat.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import {
  fetchComplaintStatusHistory,
  fetchStaffComplaintDetail,
  getNextStatuses,
  updateComplaintStatus,
} from '../lib/complaintService.js'
import { formatDateTime } from '../lib/format.js'

// Role labels for the timeline's "changed by" line. A ROLE is shown, never an
// identity — staff/student names and ids are never fetched or rendered.
const ROLE_LABELS = {
  faculty: 'Faculty',
  admin: 'Admin',
  committee: 'Committee',
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-gray-900">{value ?? '—'}</dd>
    </div>
  )
}

/**
 * Day 6 — Staff complaint detail + status control.
 *
 * The detail comes from the safe complaints_staff_view (identity-free, RLS
 * decides visibility), the history from complaint_status_history (roles and
 * timestamps only), and status changes go through the SECURITY DEFINER RPC
 * update_complaint_status — the database enforces role / sensitivity /
 * department authorization and the transition map. The UI only hides buttons
 * for convenience; it is never the security boundary.
 */
export default function StaffComplaintDetailPage() {
  const { id } = useParams()
  const { role } = useAuth()

  const [complaint, setComplaint] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [selectedStatus, setSelectedStatus] = useState('')
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [updateSuccess, setUpdateSuccess] = useState('')

  const mountedRef = useRef(true)
  // In-flight guard so two rapid clicks cannot submit twice (on top of the
  // disabled button).
  const updatingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadHistory() {
    try {
      const rows = await fetchComplaintStatusHistory(id)
      if (mountedRef.current) setHistory(rows)
    } catch (err) {
      // Non-fatal: the timeline may be unavailable, but the complaint detail
      // is still usable.
      console.error('[staff-detail] Failed to load status history', err)
    }
  }

  async function loadDetail() {
    setLoading(true)
    setLoadError('')
    setUpdateError('')
    setUpdateSuccess('')
    try {
      const detail = await fetchStaffComplaintDetail(id)
      if (!mountedRef.current) return
      if (!detail) {
        // RLS returned no row: either it does not exist or the caller is not
        // authorized for it. Never distinguish between the two.
        setLoadError('Complaint not found or you do not have access to it.')
        return
      }
      setComplaint(detail)
      await loadHistory()
    } catch (err) {
      console.error('[staff-detail] Failed to load complaint', err)
      if (mountedRef.current) {
        setLoadError('Could not load this complaint. Please try again.')
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    loadDetail()
    // Load once per complaint id; the retry button re-runs loadDetail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const allowedNext = complaint ? getNextStatuses(complaint.status) : []

  async function handleUpdateStatus(event) {
    event.preventDefault()
    setUpdateError('')
    setUpdateSuccess('')
    // Duplicate-click protection: never start a second update while one is
    // in flight.
    if (updatingRef.current) return
    if (!selectedStatus) {
      setUpdateError('Please choose a status to update to.')
      return
    }

    updatingRef.current = true
    setUpdating(true)
    try {
      const result = await updateComplaintStatus(id, selectedStatus)
      if (!mountedRef.current) return
      setComplaint((prev) =>
        prev ? { ...prev, status: result.status, updated_at: result.updated_at } : prev,
      )
      setUpdateSuccess(
        `Status updated to ${STATUS_LABELS[result.status] ?? result.status}.`,
      )
      setSelectedStatus('')
      await loadHistory()
    } catch (err) {
      console.error('[staff-detail] Status update failed', err)
      if (mountedRef.current) {
        setUpdateError(
          'Could not update the status. The change may not be allowed for this complaint.',
        )
      }
    } finally {
      updatingRef.current = false
      if (mountedRef.current) setUpdating(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white p-12 shadow-sm">
        <div
          aria-hidden="true"
          className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
        />
        <p className="text-sm text-gray-500">Loading complaint…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center shadow-sm">
        <p className="text-sm text-red-700">{loadError}</p>
        <Link
          to="/staff"
          className="mt-4 inline-block rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Back to Staff Dashboard
        </Link>
      </div>
    )
  }

  if (!complaint) return null

  // ---------------------------------------------------------------------------
  // Detail state
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/staff"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Back to Staff Dashboard
        </Link>
      </div>

      {/* Header — ticket + badges */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-mono text-xl font-semibold text-gray-900">
              {complaint.ticket_number}
            </h1>
            <p className="mt-1 text-sm text-gray-600">{complaint.category ?? '—'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={complaint.priority} />
            <StatusBadge status={complaint.status} />
            <SensitiveBadge isSensitive={complaint.is_sensitive} />
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Category" value={complaint.category} />
          <Field label="Department" value={complaint.department} />
          <Field
            label="Handler type"
            value={complaint.handler_type ? `${complaint.handler_type} handling` : null}
          />
          <Field label="Created" value={formatDateTime(complaint.created_at)} />
          <Field label="Updated" value={formatDateTime(complaint.updated_at)} />
        </dl>

        <div className="mt-5 border-t border-gray-100 pt-4">
          <h2 className="text-xs font-medium text-gray-500">Description</h2>
          <p className="mt-1 whitespace-pre-line text-sm text-gray-800">
            {complaint.description || '—'}
          </p>
        </div>
      </div>

      {/* Status control */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-gray-900">Update status</h2>
        <p className="mt-1 text-sm text-gray-600">
          Current status:{' '}
          <span className="font-medium capitalize">
            {STATUS_LABELS[complaint.status] ?? complaint.status}
          </span>
        </p>

        {allowedNext.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            No further status changes are allowed from this state.
          </p>
        ) : (
          <form onSubmit={handleUpdateStatus} className="mt-4 space-y-4">
            <div>
              <label htmlFor="new-status" className="block text-sm font-medium text-gray-700">
                Move to
              </label>
              <select
                id="new-status"
                name="new-status"
                value={selectedStatus}
                onChange={(event) => {
                  setSelectedStatus(event.target.value)
                  setUpdateError('')
                  setUpdateSuccess('')
                }}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none sm:max-w-xs"
              >
                <option value="">Select a status…</option>
                {allowedNext.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status] ?? status}
                  </option>
                ))}
              </select>
            </div>

            {updateSuccess && (
              <div
                role="status"
                className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
              >
                {updateSuccess}
              </div>
            )}
            {updateError && (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {updateError}
              </div>
            )}

            <button
              type="submit"
              disabled={updating || !selectedStatus}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {updating ? 'Updating…' : 'Update status'}
            </button>
          </form>
        )}
      </div>

      {/* Status history timeline */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-gray-900">Status history</h2>
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No status history yet.</p>
        ) : (
          <ol className="mt-4 space-y-5 border-l-2 border-gray-200 pl-5">
            {history.map((entry, index) => (
              <li key={entry.id ?? index} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute -left-[27px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-blue-600"
                />
                <p className="text-sm font-medium text-gray-900">
                  {STATUS_LABELS[entry.new_status] ?? entry.new_status}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {formatDateTime(entry.changed_at)}
                  {entry.changed_by_role && (
                    <> · by {ROLE_LABELS[entry.changed_by_role] ?? entry.changed_by_role}</>
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Day 7 — anonymous conversation with the student. Only safe fields
          are ever fetched or rendered; Realtime uses safe column selection
          plus RLS, so staff never see student identity. */}
      <ComplaintChat complaintId={id} viewerRole={role} />
    </div>
  )
}
