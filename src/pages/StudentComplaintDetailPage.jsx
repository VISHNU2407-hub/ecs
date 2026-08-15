import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PriorityBadge, StatusBadge } from '../components/complaints/Badges.jsx'
import ComplaintChat from '../components/complaints/ComplaintChat.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { fetchStudentComplaintDetail } from '../lib/complaintService.js'
import { formatDateTime } from '../lib/format.js'

/**
 * Day 7 — Student complaint detail + anonymous conversation.
 *
 * The complaint itself comes from the complaints base table filtered by its
 * id — RLS (complaints_select_student: student_id = auth.uid()) ensures only
 * the owner can see it, so a direct URL to another student's complaint shows
 * the same "not found" state as a missing one. The conversation below is the
 * shared ComplaintChat: RLS-scoped reads, safe Realtime, identity-free.
 */
export default function StudentComplaintDetailPage() {
  const { id } = useParams()
  const { role } = useAuth()

  const [complaint, setComplaint] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const mountedRef = useRef(true)

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

      {/* Anonymous conversation */}
      <ComplaintChat complaintId={id} viewerRole={role} />
    </div>
  )
}
