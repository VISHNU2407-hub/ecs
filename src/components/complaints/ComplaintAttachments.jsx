import { useCallback, useEffect, useState } from 'react'
import { getAttachmentSignedUrl } from '../../lib/complaintService.js'
import { formatDateTime, formatFileSize } from '../../lib/format.js'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']

/**
 * Day 10B — shared attachment display for the student and staff detail
 * pages. Renders ONLY safe, identity-free data (file_name / media_type /
 * file_size / created_at); storage paths and private URLs are never shown.
 *
 * Every image/video loads through a SHORT-LIVED signed URL that the storage
 * service only issues after enforcing its RLS (can_access_complaint on the
 * complaint parsed from the path) — an unauthorized viewer gets no URL and
 * no file. Images open in a lightbox (with prev/next); videos use a normal
 * HTML player. When `onRemove` is provided (owning student, submitted
 * complaint only), each item gets a remove control.
 *
 * Renders nothing when there are no attachments.
 */
export default function ComplaintAttachments({
  attachments = [],
  onRemove = null,
  removingId = null,
  removeBusy = false,
}) {
  // id -> short-lived signed URL (refreshed whenever the list changes).
  const [urls, setUrls] = useState({})
  // Lightbox: index into the image attachments + a freshly signed URL.
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState('')

  const imageAttachments = attachments.filter((a) => IMAGE_TYPES.includes(a.media_type))
  const videoAttachments = attachments.filter((a) => VIDEO_TYPES.includes(a.media_type))

  // Fetch short-lived signed URLs for the current list. RLS inside the
  // storage service decides which requests succeed; failures just render a
  // placeholder (never a raw path or URL).
  useEffect(() => {
    let cancelled = false
    setUrls({})
    Promise.all(
      attachments.map(async (attachment) => {
        try {
          const signedUrl = await getAttachmentSignedUrl(attachment)
          return { id: attachment.id, signedUrl }
        } catch (err) {
          console.warn('[attachments] signed URL request failed', err)
          return { id: attachment.id, signedUrl: null }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const next = {}
      for (const result of results) {
        if (result.signedUrl) next[result.id] = result.signedUrl
      }
      setUrls(next)
    })
    return () => {
      cancelled = true
    }
  }, [attachments])

  const openLightbox = useCallback(
    async (index) => {
      const attachment = imageAttachments[index]
      if (!attachment) return
      setLightboxIndex(index)
      try {
        const fresh = await getAttachmentSignedUrl(attachment)
        setLightboxUrl(fresh ?? urls[attachment.id] ?? '')
      } catch {
        setLightboxUrl(urls[attachment.id] ?? '')
      }
    },
    [imageAttachments, urls],
  )

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null)
    setLightboxUrl('')
  }, [])

  const moveLightbox = useCallback(
    async (delta) => {
      const next = ((lightboxIndex ?? 0) + delta + imageAttachments.length) % imageAttachments.length
      setLightboxIndex(next)
      const attachment = imageAttachments[next]
      if (!attachment) return
      try {
        const fresh = await getAttachmentSignedUrl(attachment)
        setLightboxUrl(fresh ?? urls[attachment.id] ?? '')
      } catch {
        setLightboxUrl(urls[attachment.id] ?? '')
      }
    },
    [lightboxIndex, imageAttachments, urls],
  )

  // Keyboard: Esc closes the lightbox; arrows navigate.
  useEffect(() => {
    if (lightboxIndex === null) return undefined
    function onKeyDown(event) {
      if (event.key === 'Escape') closeLightbox()
      if (event.key === 'ArrowLeft') moveLightbox(-1)
      if (event.key === 'ArrowRight') moveLightbox(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightboxIndex, closeLightbox, moveLightbox])

  if (attachments.length === 0) return null

  const lightboxAttachment = lightboxIndex !== null ? imageAttachments[lightboxIndex] : null

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">Attachments</h2>
        <p className="text-xs text-gray-500">
          {imageAttachments.length} image{imageAttachments.length === 1 ? '' : 's'}
          {videoAttachments.length > 0 && (
            <>
              {' '}· {videoAttachments.length} video{videoAttachments.length === 1 ? '' : 's'}
            </>
          )}
        </p>
      </div>

      {imageAttachments.length > 0 && (
        <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {imageAttachments.map((attachment, index) => {
            const isRemoving = removingId === attachment.id
            return (
              <li key={attachment.id} className="group relative">
                <button
                  type="button"
                  onClick={() => openLightbox(index)}
                  className="block w-full overflow-hidden rounded-md border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label={`Open ${attachment.file_name} in full size`}
                >
                  {urls[attachment.id] ? (
                    <img
                      src={urls[attachment.id]}
                      alt={attachment.file_name}
                      loading="lazy"
                      className="h-24 w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-24 w-full items-center justify-center bg-gray-100 text-xs text-gray-500">
                      Loading…
                    </div>
                  )}
                </button>
                <figcaption className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                  <span className="min-w-0 truncate" title={attachment.file_name}>
                    {attachment.file_name}
                  </span>
                  <span className="shrink-0">{formatFileSize(attachment.file_size)}</span>
                </figcaption>
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(attachment)}
                    disabled={removeBusy || isRemoving}
                    className="absolute right-1 top-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white opacity-0 transition-opacity hover:bg-red-700 focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Remove ${attachment.file_name}`}
                  >
                    {isRemoving ? '…' : '✕'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {videoAttachments.map((attachment) => {
        const isRemoving = removingId === attachment.id
        return (
          <div key={attachment.id} className="mt-5 border-t border-gray-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm text-gray-700">
                <span aria-hidden="true" className="text-gray-400">▶</span>
                <span className="min-w-0 truncate font-medium" title={attachment.file_name}>
                  {attachment.file_name}
                </span>
                <span className="shrink-0 text-xs text-gray-500">
                  {formatFileSize(attachment.file_size)}
                </span>
              </p>
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(attachment)}
                  disabled={removeBusy || isRemoving}
                  className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isRemoving ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            {urls[attachment.id] ? (
              <video
                controls
                preload="metadata"
                src={urls[attachment.id]}
                className="mt-2 max-h-80 w-full rounded-md bg-black"
              />
            ) : (
              <div className="mt-2 flex h-24 items-center justify-center rounded-md bg-gray-100 text-xs text-gray-500">
                Loading video…
              </div>
            )}
            <p className="mt-1 text-xs text-gray-400">
              Added {formatDateTime(attachment.created_at)}
            </p>
          </div>
        )
      })}

      {/* Lightbox */}
      {lightboxAttachment && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview: ${lightboxAttachment.file_name}`}
          onClick={closeLightbox}
        >
          <div
            className="relative max-w-4xl"
            onClick={(event) => event.stopPropagation()}
          >
            {lightboxUrl ? (
              <img
                src={lightboxUrl}
                alt={lightboxAttachment.file_name}
                className="max-h-[82vh] w-auto max-w-full rounded-md shadow-2xl"
              />
            ) : (
              <div className="flex h-48 w-72 items-center justify-center rounded-md bg-gray-800 text-sm text-gray-300">
                Image unavailable
              </div>
            )}
            <button
              type="button"
              onClick={closeLightbox}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-sm font-semibold text-gray-900 shadow-lg hover:bg-gray-100"
              aria-label="Close preview"
            >
              ✕
            </button>
            {imageAttachments.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => moveLightbox(-1)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 px-3 py-2 text-sm font-semibold text-gray-900 shadow-lg hover:bg-white"
                  aria-label="Previous image"
                >
                  ‹
                </button>
                <button
                  type="button"
                  onClick={() => moveLightbox(1)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 px-3 py-2 text-sm font-semibold text-gray-900 shadow-lg hover:bg-white"
                  aria-label="Next image"
                >
                  ›
                </button>
              </>
            )}
            <p className="mt-3 text-center text-xs text-gray-300">
              {lightboxAttachment.file_name} · {formatFileSize(lightboxAttachment.file_size)}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
