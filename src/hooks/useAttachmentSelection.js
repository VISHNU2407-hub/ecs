import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_IMAGES_PER_COMPLAINT,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
  MAX_VIDEOS_PER_COMPLAINT,
  MAX_VIDEO_SIZE_BYTES,
  attachmentExtensionFor,
  isImageType,
  isVideoType,
} from '../lib/complaintService.js'
import { formatFileSize } from '../lib/format.js'

function draftId() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createObjectUrl(file) {
  try {
    return URL.createObjectURL(file)
  } catch {
    return null
  }
}

/**
 * Day 10B — attachment draft selection + client-side validation, shared by
 * the complaint submission page and the student detail page.
 *
 * The database (create_complaint_attachment RPC) remains the AUTHORITATIVE
 * validator — this hook only mirrors the rules so invalid/oversized files are
 * rejected immediately in the UI, with a clear message. It holds NO uploaded
 * state: it just collects validated File objects (with preview URLs for
 * images/video) that the caller uploads afterwards through
 * uploadComplaintAttachment().
 *
 * Returns:
 *   images / video        — the selected drafts
 *   imageCount / videoCount / totalSize — derived counters
 *   pickerError           — last rejection message (type/size/count/extension)
 *   addImages(fileList)   — validates + appends; rejects invalid files with a
 *                           message and keeps the valid ones
 *   addVideo(file)        — validates + sets the single video draft
 *   removeImage(id) / removeVideo() — remove a draft (revokes its preview URL)
 *   clear()               — remove everything (used after successful upload)
 */
export default function useAttachmentSelection() {
  const [images, setImages] = useState([])
  const [video, setVideo] = useState(null)
  const [pickerError, setPickerError] = useState('')

  const revoke = useCallback((draft) => {
    if (draft?.url) {
      try {
        URL.revokeObjectURL(draft.url)
      } catch {
        // Object URLs are best-effort.
      }
    }
  }, [])

  // Keep the latest drafts in a ref so the unmount cleanup can revoke every
  // preview URL (object URLs are per-tab and leak until revoked).
  const draftsRef = useRef({ images, video })
  useEffect(() => {
    draftsRef.current = { images, video }
  }, [images, video])
  useEffect(() => {
    return () => {
      draftsRef.current.images.forEach(revoke)
      if (draftsRef.current.video) revoke(draftsRef.current.video)
    }
  }, [revoke])

  const totalSize = useMemo(
    () => images.reduce((sum, d) => sum + (d.file?.size ?? 0), 0) + (video?.file?.size ?? 0),
    [images, video],
  )

  const validateImage = useCallback(
    (file) => {
      if (!isImageType(file.type) || !attachmentExtensionFor(file)) {
        return 'Only JPG, PNG or WebP images are allowed.'
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        return `Images must be ${formatFileSize(MAX_IMAGE_SIZE_BYTES)} or smaller (this one is ${formatFileSize(file.size)}).`
      }
      if (images.length >= MAX_IMAGES_PER_COMPLAINT) {
        return `You can add at most ${MAX_IMAGES_PER_COMPLAINT} images per complaint.`
      }
      return null
    },
    [images.length],
  )

  const validateVideo = useCallback(
    (file) => {
      if (!isVideoType(file.type) || !attachmentExtensionFor(file)) {
        return 'Only MP4, WebM or MOV videos are allowed.'
      }
      if (file.size > MAX_VIDEO_SIZE_BYTES) {
        return `Videos must be ${formatFileSize(MAX_VIDEO_SIZE_BYTES)} or smaller (this one is ${formatFileSize(file.size)}).`
      }
      if (video) {
        return `You can add at most ${MAX_VIDEOS_PER_COMPLAINT} video per complaint.`
      }
      return null
    },
    [video],
  )

  const validateTotal = useCallback(
    (file) => {
      if (totalSize + file.size > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
        return `Total attachments for one complaint are limited to ${formatFileSize(MAX_TOTAL_ATTACHMENT_SIZE_BYTES)}.`
      }
      return null
    },
    [totalSize],
  )

  const addImages = useCallback(
    (fileList) => {
      const files = Array.from(fileList ?? [])
      if (files.length === 0) return
      const messages = []
      const accepted = []
      for (const file of files) {
        const typeError = validateImage(file)
        if (typeError) {
          messages.push(`${file.name}: ${typeError}`)
          continue
        }
        const totalError = validateTotal(file)
        if (totalError) {
          messages.push(`${file.name}: ${totalError}`)
          continue
        }
        accepted.push({ id: draftId(), file, url: createObjectUrl(file) })
      }
      if (accepted.length > 0) setImages((prev) => [...prev, ...accepted])
      setPickerError(messages.length > 0 ? messages.join(' ') : '')
    },
    [validateImage, validateTotal],
  )

  const addVideo = useCallback(
    (file) => {
      if (!file) return
      const typeError = validateVideo(file)
      if (typeError) {
        setPickerError(typeError)
        return
      }
      const totalError = validateTotal(file)
      if (totalError) {
        setPickerError(totalError)
        return
      }
      if (video) revoke(video)
      setVideo({ id: draftId(), file, url: createObjectUrl(file) })
      setPickerError('')
    },
    [validateVideo, validateTotal, video, revoke],
  )

  const removeImage = useCallback(
    (id) => {
      setImages((prev) => {
        const target = prev.find((d) => d.id === id)
        if (target) revoke(target)
        return prev.filter((d) => d.id !== id)
      })
      setPickerError('')
    },
    [revoke],
  )

  const removeVideo = useCallback(() => {
    setVideo((prev) => {
      if (prev) revoke(prev)
      return null
    })
    setPickerError('')
  }, [revoke])

  const clear = useCallback(() => {
    setImages((prev) => {
      prev.forEach(revoke)
      return []
    })
    setVideo((prev) => {
      if (prev) revoke(prev)
      return null
    })
    setPickerError('')
  }, [revoke])

  return {
    images,
    video,
    imageCount: images.length,
    videoCount: video ? 1 : 0,
    totalSize,
    pickerError,
    setPickerError,
    addImages,
    addVideo,
    removeImage,
    removeVideo,
    clear,
  }
}
