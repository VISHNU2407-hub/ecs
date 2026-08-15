import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PriorityBadge, StatusBadge } from '../components/complaints/Badges.jsx'
import ComplaintChat from '../components/complaints/ComplaintChat.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import {
  confirmComplaintResolution,
  fetchStudentComplaintDetail,
  reopenComplaint,
  subscribeComplaintStatus,
} from '../lib/complaintService.js'
import { formatDateTime } from '../lib/format.js'

/**
 * Day 7 + Day 9 — Student complaint detail + anonymous conversation.
 *
 * The complaint itself comes from the complaints base table filtered by its
 * id — RLS (complaints_select_student: student_id = auth.uid()) ensures only
 * the owner can see it, so a direct URL to another student's complaint shows
 * the same "not found" state as a missing one. The conversation below is the
 * shared ComplaintChat: RLS-scoped reads, safe Realtime, identity-free.
 *
 * Day 9 adds the resolution workflow. When staff mark the complaint
 * Resolved, the student sees a confirmation panel:
 *
 *     Is your issue resolved?
 *     [ Yes, close complaint ]  [ No, reopen complaint ]
 *
 * Both actions go through SECURITY DEFINER RPCs that verify inside the
 * database that the caller is the OWNING student and the complaint is
 * currently 'resolved' — the UI is never the security boundary. Closing
 * moves resolved -> closed (the panel disappears); reopening moves
 * resolved -> reopened and shows a notice that the complaint is back in the
 * handling workflow. Staff identity is never shown. A minimal per-complaint
 * Realtime subscription updates the status live when staff act.
 */
export default function StudentComplaintDetailPage() {
  const { id } = useParams()
  const { role, user } = useAuth()

  const [complaint, setComplaint] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Day 9 — resolution confirmation state (resolved -> closed / reopened).
  const [resolutionBusy, setResolutionBusy] = useState(false)
  const [resolutionError, setResolutionError] = useState('')

  const mountedRef = useRef(true)
  // In-flight guard so two rapid clicks cannot submit twice.
  const resolutionBusyRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadDetail() {
    setLoading(true)
    setLoadError('')
    try {
      const detail = await fetchStudentComplaintDetail(id)
      if (!mountedRef.current) return
      if (!detail) {
        // RLS returned no row: either it does not exist or it is not this
        // student's complaint. Never distinguish between the two.
        setLoadError('Complaint not found or you do not have access to it.')
        return
      }
      setComplaint(detail)
    } catch (err) {
      console.error('[student-detail] Failed to load complaint', err)
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

  // Day 9 — minimal per-complaint Realtime subscription: when staff change
  // the status (e.g. resolve it), the panel appears / updates without a
  // refresh. RLS decides whether this student receives the event at all.
  useEffect(() => {
    if (!id) return undefined
    const unsubscribe = subscribeComplaintStatus(id, (next) => {
      if (!mountedRef.current) return
      setComplaint((prev) =>
        prev
          ? { ...prev, status: next.status, updated_at: next.updated_at }
          : prev,
      )
    })
    return unsubscribe
  }, [id])

  // Day 9 — student confirms their resolved complaint is fixed
  // (resolved -> closed via the SECURITY DEFINER RPC).
  async function handleConfirmResolution() {
    setResolutionError('')
    if (resolutionBusyRef.current) return
    resolutionBusyRef.current = true
    setResolutionBusy(true)
    try {
      const result = await confirmComplaintResolution(id)
      if (!mountedRef.current) return
      setComplaint((prev) =>
        prev ? { ...prev, status: result.status, updated_at: result.updated_at } : prev,
      )
    } catch (err) {
      console.error('[student-detail] resolution confirmation failed', err)
      if (mountedRef.current) {
        setResolutionError('Could not close the complaint. Please try again.')
      }
    } finally {
      resolutionBusyRef.current = false
      if (mountedRef.current) setResolutionBusy(false)
    }
  }

  // Day 9 — student reopens their resolved complaint
  // (resolved -> reopened via the SECURITY DEFINER RPC).
  async function handleReopen() {
    setResolutionError('')
    if (resolutionBusyRef.current) return
    resolutionBusyRef.current = true
    setResolutionBusy(true)
    try {
      const result = await reopenComplaint(id)
      if (!mountedRef.current) return
      setComplaint((prev) =>
        prev ? { ...prev, status: result.status, updated_at: result.updated_at } : prev,
      )
    } catch (err) {
      console.error('[student-detail] reopen failed', err)
      if (mountedRef.current) {
        setResolutionError('Could not reopen the complaint. Please try again.')
      }
    } finally {
      resolutionBusyRef.current = false
      if (mountedRef.current) setResolutionBusy(false)
    }
  }

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
          to="/student"
          className="mt-4 inline-block rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Back to Student Dashboard
        </Link>
      </div>
    )
  }

  if (!complaint) return null

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/student"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Back to Student Dashboard
        </Link>
      </div>

      {/* Complaint header */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-mono text-xl font-semibold text-gray-900">
              {complaint.ticket_number}
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              {complaint.category ?? 'Category unavailable'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={complaint.priority} />
            <StatusBadge status={complaint.status} />
          </div>
        </div>
        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 text-xs text-gray-500">
          <div>
            <dt className="sr-only">Created date</dt>
            <dd>Created: {formatDateTime(complaint.created_at)}</dd>
          </div>
          <div>
            <dt className="sr-only">Updated date</dt>
            <dd>Updated: {formatDateTime(complaint.updated_at)}</dd>
          </div>
        </dl>
      </div>

      {/* Day 9 — resolution confirmation. Shown ONLY while the complaint is
          Resolved: the student decides whether the issue is truly fixed
          (resolved -> closed) or needs more work (resolved -> reopened).
          Both paths are enforced by SECURITY DEFINER RPCs (ownership +
          current-status checks inside the database). Once closed or
          reopened, the panel is no longer rendered. Staff identity is never
          exposed anywhere. */}
      {complaint.status === 'resolved' && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-gray-900">
            Is your issue resolved?
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Your complaint is marked as{' '}
            <span className="font-medium text-green-800">Resolved</span>. Let
            us know whether the issue is truly fixed, or whether it needs more
            work.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleConfirmResolution}
              disabled={resolutionBusy}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resolutionBusy ? 'Closing…' : 'Yes, close complaint'}
            </button>
            <button
              type="button"
              onClick={handleReopen}
              disabled={resolutionBusy}
              className="rounded-md border border-orange-300 bg-white px-4 py-2 text-sm font-medium text-orange-700 hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              No, reopen complaint
            </button>
          </div>
          {resolutionError && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {resolutionError}
            </p>
          )}
        </div>
      )}

      {/* Day 9 — reopened notice. Shown while the complaint is Reopened so the
          student knows it is back in the handling workflow (staff identity
          is never shown). */}
      {complaint.status === 'reopened' && (
        <div
          role="status"
          className="rounded-lg border border-orange-200 bg-orange-50 p-5 text-sm text-orange-800 shadow-sm"
        >
          Your complaint has been reopened and returned to the handling
          workflow.
        </div>
      )}

      {/* Anonymous conversation. ownerId scopes only the local "messages I
          sent" UI marker in sessionStorage (unused for students, whose own
          messages are identified by sender_role on their own complaint). */}
      <ComplaintChat complaintId={id} viewerRole={role} ownerId={user?.id} />
    </div>
  )
}
