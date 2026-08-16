import { useRef } from 'react'
import {
  MAX_IMAGES_PER_COMPLAINT,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
  MAX_VIDEOS_PER_COMPLAINT,
  MAX_VIDEO_SIZE_BYTES,
} from '../../lib/complaintService.js'
import { formatFileSize } from '../../lib/format.js'

/**
 * Day 10B — shared attachment picker for the submission form and the student
 * detail page. Renders the [+ Add Images] / [+ Add Video] buttons (hidden
 * file inputs), the live counters (Images: x/5 · Video: x/1 · Total), the
 * client-side rejection message, and the draft previews (image thumbnails,
 * video player, filename + size, remove controls). Validation happens in
 * useAttachmentSelection (mirroring the database rules — the RPC is
 * authoritative).
 *
 * When `onUpload` is provided an "Upload attachments" button appears (used by
 * the detail page, which uploads immediately). The submission page omits it —
 * its attachments are uploaded automatically right after the complaint is
 * created.
 */
export default function AttachmentDraftPicker({
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
  disabled = false,
  onUpload = null,
  uploading = false,
  uploadError = '',
}) {
  const imageInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const draftCount = images.length + (video ? 1 : 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-600">
          Images: {imageCount}/{MAX_IMAGES_PER_COMPLAINT} · Video:{' '}
          {videoCount}/{MAX_VIDEOS_PER_COMPLAINT} · Total:{' '}
          {formatFileSize(totalSize)} / {formatFileSize(MAX_TOTAL_ATTACHMENT_SIZE_BYTES)}
        </p>
        {draftCount > 0 && (
          <p className="text-xs text-gray-500">
            Each image up to {formatFileSize(MAX_IMAGE_SIZE_BYTES)}, one video up to{' '}
            {formatFileSize(MAX_VIDEO_SIZE_BYTES)}.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => imageInputRef.current?.click()}
          disabled={disabled || uploading}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          + Add Images
        </button>
        <button
          type="button"
          onClick={() => videoInputRef.current?.click()}
          disabled={disabled || uploading || Boolean(video)}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          + Add Video
        </button>
        {onUpload && draftCount > 0 && (
          <button
            type="button"
            onClick={onUpload}
            disabled={disabled || uploading}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading
              ? `Uploading ${draftCount} attachment${draftCount === 1 ? '' : 's'}…`
              : `Upload ${draftCount} attachment${draftCount === 1 ? '' : 's'}`}
          </button>
        )}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            addImages(event.target.files)
            event.target.value = ''
          }}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) addVideo(file)
            event.target.value = ''
          }}
        />
      </div>

      {pickerError && (
        <p role="alert" className="text-sm text-red-600">
          {pickerError}
        </p>
      )}
      {uploadError && (
        <p role="alert" className="text-sm text-red-600">
          {uploadError}
        </p>
      )}

      {images.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {images.map((draft) => (
            <li key={draft.id} className="relative">
              {draft.url ? (
                <img
                  src={draft.url}
                  alt={draft.file.name}
                  className="h-20 w-full rounded-md border border-gray-200 object-cover"
                />
              ) : (
                <div className="flex h-20 w-full items-center justify-center rounded-md border border-gray-200 bg-gray-100 text-xs text-gray-500">
                  Preview unavailable
                </div>
              )}
              <p className="mt-1 flex items-center justify-between gap-1 text-xs text-gray-600">
                <span className="min-w-0 truncate" title={draft.file.name}>
                  {draft.file.name}
                </span>
                <span className="shrink-0 text-gray-400">{formatFileSize(draft.file.size)}</span>
              </p>
              <button
                type="button"
                onClick={() => removeImage(draft.id)}
                disabled={disabled || uploading}
                className="absolute right-1 top-1 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                aria-label={`Remove ${draft.file.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {video && (
        <div className="flex items-start gap-3 rounded-md border border-gray-200 p-3">
          {video.url ? (
            <video
              src={video.url}
              controls
              preload="metadata"
              className="h-24 w-40 shrink-0 rounded-md bg-black object-cover"
            />
          ) : (
            <div className="flex h-24 w-40 shrink-0 items-center justify-center rounded-md bg-gray-100 text-xs text-gray-500">
              Preview unavailable
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-800" title={video.file.name}>
              {video.file.name}
            </p>
            <p className="text-xs text-gray-500">{formatFileSize(video.file.size)}</p>
            <button
              type="button"
              onClick={removeVideo}
              disabled={disabled || uploading}
              className="mt-2 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Remove video
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
