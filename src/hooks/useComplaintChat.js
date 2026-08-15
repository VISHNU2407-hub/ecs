import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import {
  CHAT_SELECT_COLUMNS,
  MESSAGE_MAX_LENGTH,
  fetchComplaintMessages,
  sendComplaintMessage,
} from '../lib/complaintService.js'

// ---------------------------------------------------------------------------
// Session-scoped ownership persistence (UI state only).
//
// The chat never reads sender_id — ownership of staff messages is decided by
// which message ids THIS authenticated client created. Those ids are kept in
// an in-memory Set for the live session AND persisted to sessionStorage so
// ownership survives a refresh / remount / navigation away and back.
//
// SECURITY:
//   * The stored VALUE is an array of message id strings ONLY. Never
//     sender_id, student_id, email, name, user metadata, message bodies or
//     auth tokens.
//   * The storage KEY includes the authenticated user's id, so ids recorded
//     by one user can never leak into another user's (or a logged-out)
//     session. When the authenticated user changes, only their own key is
//     read.
//   * All access is wrapped in try/catch: if sessionStorage is unavailable
//     or malformed, the chat falls back to the in-memory Set and works
//     exactly as before.
// ---------------------------------------------------------------------------

function storageKey(ownerId, complaintId) {
  return `cc:owned-msgs:${ownerId}:${complaintId}`
}

// Returns a Set of message ids (strings only). Empty on any problem.
function readPersistedOwnIds(ownerId, complaintId) {
  if (!ownerId || !complaintId) return new Set()
  try {
    const raw = sessionStorage.getItem(storageKey(ownerId, complaintId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v) => typeof v === 'string' && v.length > 0))
  } catch {
    return new Set()
  }
}

function persistOwnId(ownerId, complaintId, id) {
  if (!ownerId || !complaintId || !id) return
  try {
    const ids = readPersistedOwnIds(ownerId, complaintId)
    ids.add(id)
    sessionStorage.setItem(storageKey(ownerId, complaintId), JSON.stringify([...ids]))
  } catch {
    // Storage unavailable — the in-memory Set still tracks this session.
  }
}

/**
 * Day 7 — chat state for ONE complaint, shared by the student and staff
 * conversation UIs.
 *
 * - Initial load through messages_staff_view (RLS decides visibility).
 * - Supabase Realtime subscription for INSERT events on `messages`, filtered
 *   to this complaint only (`complaint_id=eq.…`) and selecting ONLY safe
 *   columns. Row-level RLS decides which clients receive events at all, and
 *   Realtime only allows selecting columns the subscriber can read — so
 *   sender_id / student identity can never appear in a payload.
 * - Messages are deduplicated by stable id, so a row delivered by both the
 *   INSERT response and a Realtime event appears exactly once.
 * - The channel is removed on unmount and when the complaint id changes
 *   (no duplicate subscriptions, no leaks).
 * - Sending goes through the safe INSERT path (complaint_id + body only).
 * - ownMessageIds: ids of messages created by the CURRENT authenticated user
 *   (`ownerId`) for this complaint, restored from sessionStorage on mount and
 *   updated on every send. This is local UI state — never an identity field —
 *   and lets the chat render "You (Role)" for the current user's own staff
 *   messages even after a refresh.
 */
export default function useComplaintChat(complaintId, ownerId) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  // 'connecting' | 'subscribed' | 'error' | 'disabled'
  const [realtimeStatus, setRealtimeStatus] = useState(supabase ? 'connecting' : 'disabled')

  const idsRef = useRef(new Set())
  const channelRef = useRef(null)
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  const [reloadKey, setReloadKey] = useState(0)
  // Ids of messages THIS authenticated user created for this complaint —
  // restored from sessionStorage, updated on send. Self-knowledge only; it
  // never leaves the browser and never contains identity.
  const [ownMessageIds, setOwnMessageIds] = useState(() =>
    readPersistedOwnIds(ownerId, complaintId),
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Stable, deduplicating append — used by both the INSERT response and the
  // Realtime callback, so a message can never appear twice.
  const addMessage = useCallback((msg) => {
    if (!msg || !msg.id) return
    if (idsRef.current.has(msg.id)) return
    idsRef.current.add(msg.id)
    setMessages((prev) => [...prev, msg])
  }, [])

  useEffect(() => {
    let cancelled = false
    idsRef.current = new Set()
    // Restore this user's ownership ids for this complaint (empty when the
    // user changed, logged out, or storage is unavailable).
    setOwnMessageIds(readPersistedOwnIds(ownerId, complaintId))
    setMessages([])
    setLoadError('')
    setSendError('')

    async function loadInitial() {
      setLoading(true)
      try {
        const rows = await fetchComplaintMessages(complaintId)
        if (cancelled) return
        idsRef.current = new Set(rows.map((m) => m.id))
        setMessages(rows)
      } catch (err) {
        console.error('[chat] failed to load messages', err)
        if (!cancelled) setLoadError('Could not load the conversation. Please try again.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadInitial()

    if (!supabase) {
      setRealtimeStatus('disabled')
      return () => {
        cancelled = true
      }
    }

    // Realtime — this complaint's messages only, safe columns only.
    const channel = supabase
      .channel(`complaint-messages:${complaintId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `complaint_id=eq.${complaintId}`,
          select: CHAT_SELECT_COLUMNS,
        },
        (payload) => {
          if (!cancelled) addMessage(payload.new)
        },
      )
      .subscribe((status, err) => {
        if (cancelled) return
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('subscribed')
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.error('[chat] realtime subscription error', status, err)
          setRealtimeStatus('error')
        }
      })
    channelRef.current = channel

    return () => {
      cancelled = true
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complaintId, ownerId, reloadKey])

  async function sendMessage(text) {
    setSendError('')
    const body = text.trim()
    if (!body) {
      setSendError('Please enter a message.')
      return false
    }
    if (body.length > MESSAGE_MAX_LENGTH) {
      setSendError(`Message must be at most ${MESSAGE_MAX_LENGTH} characters.`)
      return false
    }
    // In-flight guard: no duplicate submissions while one is pending.
    if (sendingRef.current) return false
    sendingRef.current = true
    setSending(true)
    try {
      const row = await sendComplaintMessage(complaintId, body)
      // Mark it as "mine": in memory AND sessionStorage (keyed by this user +
      // complaint), so ownership survives a refresh/remount. The Realtime
      // event for this same row may also arrive — addMessage deduplicates by
      // id, so it appears exactly once.
      persistOwnId(ownerId, complaintId, row.id)
      setOwnMessageIds((prev) => new Set(prev).add(row.id))
      addMessage(row)
      return true
    } catch (err) {
      console.error('[chat] failed to send message', err)
      setSendError('Could not send the message. Please try again.')
      return false
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return {
    messages,
    loading,
    loadError,
    sending,
    sendError,
    realtimeStatus,
    ownMessageIds,
    retryLoad: () => setReloadKey((k) => k + 1),
    sendMessage,
  }
}
