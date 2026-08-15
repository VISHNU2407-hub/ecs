import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import {
  CHAT_SELECT_COLUMNS,
  MESSAGE_MAX_LENGTH,
  fetchComplaintMessages,
  sendComplaintMessage,
} from '../lib/complaintService.js'

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
 */
export default function useComplaintChat(complaintId) {
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
  }, [complaintId, reloadKey])

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
      // The Realtime event for this same row may also arrive — addMessage
      // deduplicates by id, so it appears exactly once.
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
    retryLoad: () => setReloadKey((k) => k + 1),
    sendMessage,
  }
}
