import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PriorityBadge, StatusBadge } from '../components/complaints/Badges.jsx'
import AttachmentDraftPicker from '../components/complaints/AttachmentDraftPicker.jsx'
import ComplaintAttachments from '../components/complaints/ComplaintAttachments.jsx'
import ComplaintChat from '../components/complaints/ComplaintChat.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import {
  DESCRIPTION_MAX_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  PRIORITY_LEVELS,
  TITLE_MAX_LENGTH,
  confirmComplaintResolution,
  deleteComplaint,
  deleteComplaintAttachment,
  editComplaint,
  fetchComplaintAttachments,
  fetchComplaintCategories,
  fetchStudentComplaintDetail,
  reopenComplaint,
  subscribeComplaintStatus,
  uploadComplaintAttachment,
} from '../lib/complaintService.js'
import { formatDateTime } from '../lib/format.js'
import useAttachmentSelection from '../hooks/useAttachmentSelection.js'

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]

function inputClasses(invalid) {
  return `mt-1 block w-full rounded-md border px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none ${
    invalid ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-blue-500'
  }`
}

/**
 * Day 7 + Day 9 + Day 10A — Student complaint detail + anonymous conversation.
 *
 * The complaint itself comes from the complaints base table filtered by its
 * id — RLS (complaints_select_student: student_id = auth.uid() AND
 * deleted_at is null) ensures only the owner can see it, so a direct URL to
 * another student's complaint — or to a soft-deleted complaint — shows the
 * same "not found" state as a missing one. The conversation below is the
 * shared ComplaintChat: RLS-scoped reads, safe Realtime, identity-free.
 *
 * Day 9 adds the resolution workflow (confirm / reopen a resolved complaint).
 *
 * Day 10A adds complaint-level Edit and Delete. Both are shown ONLY while the
 * complaint is Submitted (the page can only ever render the student's OWN
 * complaint, so ownership is implied — but the SECURITY DEFINER RPCs still
 * enforce it server-side). Edit opens an inline form prefilled with the
 * current values (title, description, category, priority) and saves through
 * public.edit_complaint, which re-derives category routing in the database.
 * Delete opens a confirmation dialog and soft-deletes through
 * public.delete_complaint, then navigates back to the Student Dashboard with
 * a success message. Neither control appears once the status leaves
 * 'submitted'. Staff never get these controls (see StaffComplaintDetailPage).
 */
export default function StudentComplaintDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { role, user } = useAuth()

  const [complaint, setComplaint] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Day 9 — resolution confirmation state (resolved -> closed / reopened).
  const [resolutionBusy, setResolutionBusy] = useState(false)
  const [resolutionError, setResolutionError] = useState('')

  // Day 10A — categories for the edit form (same source as submission).
  const [categories, setCategories] = useState([])
  const [categoriesError, setCategoriesError] = useState('')

  // Day 10A — edit state.
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [priority, setPriority] = useState('medium')
  const [fieldErrors, setFieldErrors] = useState({})
  const [editError, setEditError] = useState('')
  const [editSuccess, setEditSuccess] = useState('')
  const [saving, setSaving] = useState(false)

  // Day 10A — delete state.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)

  // Day 10B — attachments: the stored list (RLS-scoped), the draft picker
  // (validated client-side; the RPC is authoritative), and upload/remove
  // state. Add/remove are only offered while the complaint is Submitted.
  const [attachments, setAttachments] = useState([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachmentsError, setAttachmentsError] = useState('')
  const [removingId, setRemovingId] = useState(null)
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const [attachmentUploadError, setAttachmentUploadError] = useState('')
  const {
    images,
    video,
    imageCount,
    videoCount,
    totalSize,
    pickerError,
    addImages,
    addVideo,
    removeImage,
    removeVideo,
    clear: clearDrafts,
  } = useAttachmentSelection()

  const mountedRef = useRef(true)
  // In-flight guards so two rapid clicks cannot submit twice.
  const resolutionBusyRef = useRef(false)
  const savingRef = useRef(false)
  const deletingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Day 10A — load the categories the edit form offers. Same source as the
  // submission form; the database re-validates the choice inside the RPC.
  useEffect(() => {
    let cancelled = false
    fetchComplaintCategories()
      .then((cats) => {
        if (!cancelled) setCategories(cats)
      })
      .catch((err) => {
        console.error('[student-detail] failed to load categories', err)
        if (!cancelled) setCategoriesError('Could not load categories for editing.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function loadDetail() {
    setLoading(true)
    setLoadError('')
    try {
      const detail = await fetchStudentComplaintDetail(id)
      if (!mountedRef.current) return
      if (!detail) {
        // RLS returned no row: either it does not exist, is soft-deleted, or
        // it is not this student's complaint. Never distinguish between them.
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

  // Day 10B — load the attachment metadata. RLS decides which rows arrive
  // (owner only, and none once the complaint is soft-deleted), so this list
  // is always safe to render.
  async function loadAttachments() {
    setAttachmentsLoading(true)
    setAttachmentsError('')
    try {
      const rows = await fetchComplaintAttachments(id)
      if (!mountedRef.current) return
      setAttachments(rows)
    } catch (err) {
      console.error('[student-detail] failed to load attachments', err)
      if (mountedRef.current) {
        setAttachmentsError('Could not load attachments for this complaint.')
      }
    } finally {
      if (mountedRef.current) setAttachmentsLoading(false)
    }
  }

  useEffect(() => {
    loadAttachments()
    // Load once per complaint id; refreshed after uploads/removals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Day 9 — minimal per-complaint Realtime subscription: when staff change
  // the status (e.g. resolve it), the panel appears / updates without a
  // refresh. RLS decides whether this student receives the event at all.
  // NOTE: a soft-deleted complaint produces NO event for any authenticated
  // client (RLS drops events for rows the subscriber can no longer select),
  // so deletion is picked up by the focus refetch below instead.
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

  // Day 10A — quiet refetch when the tab regains focus, so a soft deletion
  // performed elsewhere (another tab/session) disappears from this already
  // open page without a manual refresh. No Realtime event exists for it by
  // design (RLS drops events for rows the user can no longer see).
  useEffect(() => {
    if (!id) return undefined
    async function refreshDetail() {
      if (!mountedRef.current || loading) return
      try {
        const detail = await fetchStudentComplaintDetail(id)
        if (!mountedRef.current) return
        if (!detail) {
          setLoadError('Complaint not found or you do not have access to it.')
          setComplaint(null)
          return
        }
        setComplaint(detail)
      } catch (err) {
        console.error('[student-detail] background refresh failed', err)
      }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') refreshDetail()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // -------------------------------------------------------------------------
  // Day 10A — edit
  // -------------------------------------------------------------------------
  function startEdit() {
    setTitle(complaint?.title ?? '')
    setDescription(complaint?.description ?? '')
    setCategoryId(complaint?.category_id ?? '')
    setPriority(complaint?.priority ?? 'medium')
    setFieldErrors({})
    setEditError('')
    setEditSuccess('')
    setEditing(true)
  }

  function clearFieldError(field) {
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  function validateEdit() {
    const errors = {}
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      errors.title = 'Please add a title.'
    } else if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      errors.title = `Title must be at most ${TITLE_MAX_LENGTH} characters.`
    }

    const trimmedDescription = description.trim()
    if (!trimmedDescription) {
      errors.description = 'Please describe your complaint.'
    } else if (trimmedDescription.length < MIN_DESCRIPTION_LENGTH) {
      errors.description = `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters.`
    } else if (trimmedDescription.length > DESCRIPTION_MAX_LENGTH) {
      errors.description = `Description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`
    }

    if (!categoryId) {
      errors.category = 'Please select a category.'
    } else if (!categories.some((c) => c.id === categoryId)) {
      errors.category = 'Please select a valid category.'
    }

    if (!PRIORITY_LEVELS.includes(priority)) {
      errors.priority = 'Please select a valid priority.'
    }
    return errors
  }

  async function handleSaveEdit(event) {
    event.preventDefault()
    setEditError('')
    setEditSuccess('')
    // Duplicate-click protection: never start a second save while one is in
    // flight (on top of the disabled submit button).
    if (savingRef.current) return

    const errors = validateEdit()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    savingRef.current = true
    setSaving(true)
    try {
      const result = await editComplaint(id, {
        title: title.trim(),
        description: description.trim(),
        categoryId,
        priority,
      })
      if (!mountedRef.current) return
      // The RPC returns only safe fields. The category NAME is resolved from
      // the locally fetched categories (the RPC returns the id, never joins
      // identity). Status stays 'submitted' — the control disappears as soon
      // as staff move the complaint.
      const categoryName = categories.find((c) => c.id === result.category_id)?.name ?? null
      setComplaint((prev) =>
        prev
          ? {
              ...prev,
              title: result.title,
              description: result.description,
              category_id: result.category_id,
              category: categoryName,
              priority: result.priority,
              updated_at: result.updated_at,
            }
          : prev,
      )
      setEditing(false)
      setEditSuccess('Your complaint has been updated.')
    } catch (err) {
      console.error('[student-detail] edit failed', err)
      if (mountedRef.current) {
        setEditError('Could not save your changes. Please try again.')
      }
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // Day 10B — attachment add/remove (student, own submitted complaint).
  // Uploads go through the private bucket + create_complaint_attachment RPC;
  // removals through delete_complaint_attachment RPC + best-effort file
  // cleanup. The database re-validates everything; the UI only orchestrates.
  // -------------------------------------------------------------------------
  async function handleUploadDraftFiles() {
    const drafts = [...images.map((draft) => draft.file), ...(video ? [video.file] : [])]
    if (drafts.length === 0) return
    setAttachmentUploadError('')
    setAttachmentUploading(true)
    let failed = 0
    let uploaded = 0
    for (let i = 0; i < drafts.length; i += 1) {
      try {
        await uploadComplaintAttachment(id, drafts[i])
        uploaded += 1
      } catch (err) {
        failed += 1
        // Failed files are cleaned up inside uploadComplaintAttachment.
        console.error('[student-detail] attachment upload failed', err)
      }
    }
    setAttachmentUploading(false)
    if (failed > 0) {
      setAttachmentUploadError(
        `${failed} of ${drafts.length} attachment(s) could not be uploaded. The database limits (types, sizes, 5 images / 1 video, 60 MB total) apply — check the message above and try again.`,
      )
    }
    clearDrafts()
    await loadAttachments()
  }

  async function handleRemoveAttachment(attachment) {
    setAttachmentUploadError('')
    setRemovingId(attachment.id)
    try {
      await deleteComplaintAttachment(attachment)
      if (mountedRef.current) {
        setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))
      }
    } catch (err) {
      console.error('[student-detail] attachment remove failed', err)
      if (mountedRef.current) {
        setAttachmentUploadError('Could not remove the attachment. Please try again.')
      }
    } finally {
      if (mountedRef.current) setRemovingId(null)
    }
  }

  // -------------------------------------------------------------------------
  // Day 10A — delete
  // -------------------------------------------------------------------------
  async function handleConfirmDelete() {
    setDeleteError('')
    // Duplicate-click protection: never start a second delete while one is in
    // flight (on top of the disabled dialog button).
    if (deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    try {
      const result = await deleteComplaint(id)
      if (!mountedRef.current) return
      // Navigate back to the dashboard; the dashboard shows a success banner
      // and (because RLS now excludes the row) the complaint is gone from the
      // list without any manual refresh.
      navigate('/student', { state: { deletedTicket: result?.ticket_number } })
    } catch (err) {
      console.error('[student-detail] delete failed', err)
      if (mountedRef.current) {
        setDeleteError('Could not delete the complaint. Please try again.')
      }
    } finally {
      deletingRef.current = false
      if (mountedRef.current) setDeleting(false)
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

  // Day 10A — Edit/Delete are only offered while the complaint is Submitted.
  // (The page only ever renders the student's OWN complaint — RLS — so
  // ownership is guaranteed; the RPCs still enforce everything server-side.)
  const canEditOrDelete = complaint.status === 'submitted'

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
          <div className="min-w-0">
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

        {/* Day 10A — complaint title + description (safe fields, owner only). */}
        {complaint.title && (
          <h2 className="mt-4 text-base font-semibold text-gray-900">
            {complaint.title}
          </h2>
        )}
        {complaint.description && (
          <p className="mt-1 whitespace-pre-line text-sm text-gray-700">
            {complaint.description}
          </p>
        )}

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

        {/* Day 10A — Edit / Delete controls. Only while Submitted. */}
        {canEditOrDelete && (
          <div className="mt-5 flex flex-wrap gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={startEdit}
              disabled={saving || deleting}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Edit Complaint
            </button>
            <button
              type="button"
              onClick={() => {
                setDeleteError('')
                setConfirmingDelete(true)
              }}
              disabled={saving || deleting}
              className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Delete Complaint
            </button>
          </div>
        )}
      </div>

      {/* Day 10B — attachments. Readable at any status; add/remove controls
          only while Submitted (the RPCs enforce this server-side too). Files
          are private: thumbnails/videos load through short-lived signed URLs
          the storage service only issues to authorized viewers. */}
      {attachmentsError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 shadow-sm"
        >
          {attachmentsError}
        </div>
      )}
      {attachmentsLoading && attachments.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Loading attachments…</p>
        </div>
      ) : (
        <ComplaintAttachments
          attachments={attachments}
          onRemove={canEditOrDelete ? handleRemoveAttachment : null}
          removingId={removingId}
          removeBusy={removingId !== null}
        />
      )}

      {canEditOrDelete && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-gray-900">Add attachments</h2>
          <p className="mt-1 text-sm text-gray-600">
            You can add or remove evidence while the complaint is still
            submitted. Files are private — only the ECS team handling this
            complaint can view them.
          </p>
          <div className="mt-4">
            <AttachmentDraftPicker
              images={images}
              video={video}
              imageCount={imageCount}
              videoCount={videoCount}
              totalSize={totalSize}
              pickerError={pickerError}
              addImages={addImages}
              addVideo={addVideo}
              removeImage={removeImage}
              removeVideo={removeVideo}
              disabled={attachmentUploading}
              onUpload={handleUploadDraftFiles}
              uploading={attachmentUploading}
              uploadError={attachmentUploadError}
            />
          </div>
        </div>
      )}

      {/* Day 10A — success banner after a save. Rendered OUTSIDE the edit
          form so it stays visible after the form closes. */}
      {editSuccess && (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 shadow-sm"
        >
          {editSuccess}
        </div>
      )}

      {/* Day 10A — inline edit form. Only while Submitted and the user asked
          to edit. Saves through the SECURITY DEFINER edit_complaint RPC. */}
      {editing && canEditOrDelete && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-gray-900">Edit complaint</h2>
          <p className="mt-1 text-sm text-gray-600">
            You can update the title, description, category and priority while
            the complaint is still submitted. Routing is recalculated by the
            database.
          </p>

          <form onSubmit={handleSaveEdit} noValidate className="mt-4 space-y-5">
            <div>
              <label htmlFor="edit-title" className="block text-sm font-medium text-gray-700">
                Title
              </label>
              <input
                id="edit-title"
                type="text"
                value={title}
                maxLength={TITLE_MAX_LENGTH}
                onChange={(event) => {
                  setTitle(event.target.value)
                  clearFieldError('title')
                }}
                aria-invalid={Boolean(fieldErrors.title)}
                className={inputClasses(Boolean(fieldErrors.title))}
              />
              <p className="mt-1 text-xs text-gray-500">
                {title.length}/{TITLE_MAX_LENGTH} characters
              </p>
              {fieldErrors.title && (
                <p role="alert" className="mt-1 text-sm text-red-600">
                  {fieldErrors.title}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="edit-category"
                className="block text-sm font-medium text-gray-700"
              >
                Category
              </label>
              <select
                id="edit-category"
                value={categoryId}
                disabled={categoriesError || categories.length === 0}
                onChange={(event) => {
                  setCategoryId(event.target.value)
                  clearFieldError('category')
                }}
                aria-invalid={Boolean(fieldErrors.category)}
                className={inputClasses(Boolean(fieldErrors.category))}
              >
                <option value="">
                  {categoriesError
                    ? 'Categories unavailable'
                    : categories.length === 0
                      ? 'Loading categories…'
                      : 'Select a category'}
                </option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {categoriesError && (
                <p role="alert" className="mt-1 text-sm text-red-600">
                  {categoriesError}
                </p>
              )}
              {fieldErrors.category && (
                <p role="alert" className="mt-1 text-sm text-red-600">
                  {fieldErrors.category}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="edit-description"
                className="block text-sm font-medium text-gray-700"
              >
                Description
              </label>
              <textarea
                id="edit-description"
                rows={5}
                value={description}
                maxLength={DESCRIPTION_MAX_LENGTH}
                onChange={(event) => {
                  setDescription(event.target.value)
                  clearFieldError('description')
                }}
                aria-invalid={Boolean(fieldErrors.description)}
                className={inputClasses(Boolean(fieldErrors.description))}
              />
              <p className="mt-1 text-xs text-gray-500">
                At least {MIN_DESCRIPTION_LENGTH} characters.
              </p>
              {fieldErrors.description && (
                <p role="alert" className="mt-1 text-sm text-red-600">
                  {fieldErrors.description}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="edit-priority" className="block text-sm font-medium text-gray-700">
                Priority
              </label>
              <select
                id="edit-priority"
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

            {editError && (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {editError}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={saving || deleting}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setFieldErrors({})
                  setEditError('')
                }}
                disabled={saving}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

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

      {/* Day 10A — delete confirmation dialog (mobile friendly, same pattern
          as the chat's dialogs). Clearly states the complaint will be removed
          from the portal and cannot be undone from the UI. */}
      {confirmingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="complaint-delete-confirm-title"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3
              id="complaint-delete-confirm-title"
              className="text-base font-semibold text-gray-900"
            >
              Delete complaint?
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              This complaint ({complaint.ticket_number}) will be removed from
              the complaint portal. This cannot be undone from the UI.
            </p>
            {deleteError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                {deleteError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDelete}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Delete Complaint'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
