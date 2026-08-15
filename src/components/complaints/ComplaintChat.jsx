import { useEffect, useRef } from 'react'
import useComplaintChat from '../../hooks/useComplaintChat.js'
import { MESSAGE_MAX_LENGTH } from '../../lib/complaintService.js'
import { formatDateTime } from '../../lib/format.js'

// The only identity-free sender labels the UI ever shows. sender_id /
// student_id / email / name are never fetched, never rendered, and never
// arrive in Realtime payloads (safe column selection + RLS).
const SENDER_LABELS = {
  student: 'Student',
  staff: 'Staff',
  committee: 'Committee',
}

function labelFor(senderRole) {
  return SENDER_LABELS[senderRole] ?? String(senderRole ?? 'Unknown')
}

// Subtle, lightweight neutral dot texture for the conversation background
// (inline SVG data URI — no assets, no branding, no network request).
const CHAT_PATTERN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'%3E%3Ccircle cx='2' cy='2' r='1.2' fill='%2394a3b8' fill-opacity='0.16'/%3E%3C/svg%3E")`

/**
 * Day 7 — anonymous two-way conversation for one complaint. Reused by the
 * student detail page and the staff complaint detail page. WhatsApp-style:
 * the current user's messages are right-aligned blue bubbles labeled "You"
 * (or "You (Role)" for staff); the other participant's messages are
 * left-aligned white bubbles labeled only by sender_role.
 *
 *   viewerRole — the caller's app role. "My message" is determined WITHOUT
 *                any identity field:
 *                - student viewer: every student-role message on their own
 *                  complaint is theirs (RLS guarantees only the owner can be
 *                  the student participant) → sender_role === 'student'.
 *                - staff viewer: only messages whose id is in ownMessageIds
 *                  (recorded locally when THIS authenticated user sent them,
 *                  persisted per user+complaint in sessionStorage). Other
 *                  staff messages stay anonymous ("Staff"), so no identity
 *                  is ever exposed or inferred.
 *   ownerId    — the authenticated user's id, used ONLY to scope the local
 *                ownership storage key. Never sent anywhere.
 *
 * All messaging state (load, Realtime, dedupe, send) lives in
 * useComplaintChat — untouched — this component is presentational only.
 */
export default function ComplaintChat({ complaintId, viewerRole, ownerId }) {
  const {
    messages,
    loading,
    loadError,
    sending,
    sendError,
    realtimeStatus,
    ownMessageIds,
    retryLoad,
    sendMessage,
  } = useComplaintChat(complaintId, ownerId)

  const listRef = useRef(null)
  const inputRef = useRef(null)
  const isStudentViewer = viewerRole === 'student'

  // Auto-scroll to the newest message when the list changes.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  function isOwnMessage(message) {
    return isStudentViewer
      ? message.sender_role === 'student'
      : ownMessageIds.has(message.id)
  }

  function ownLabel(message) {
    if (isStudentViewer) return 'You'
    // e.g. "You (Staff)", "You (Committee)" — role only, never identity.
    return `You (${labelFor(message.sender_role)})`
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const input = inputRef.current
    const ok = await sendMessage(input?.value ?? '')
    if (ok && input) input.value = ''
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-gray-900">Conversation</h2>
      <p className="mt-1 text-xs text-gray-500">
        Messages stay anonymous — no student identity is ever shown.
      </p>

      {realtimeStatus === 'error' || realtimeStatus === 'disabled' ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Live updates are unavailable right now. Your messages still send;
          refresh the page to see new replies.
        </p>
      ) : (
        realtimeStatus === 'connecting' && (
          <p className="mt-2 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
            Connecting to live updates…
          </p>
        )
      )}

      {loading ? (
        <div className="mt-4 flex items-center justify-center gap-3 py-10">
          <div
            aria-hidden="true"
            className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
          />
          <p className="text-sm text-gray-500">Loading conversation…</p>
        </div>
      ) : loadError ? (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-center">
          <p className="text-sm text-red-700">{loadError}</p>
          <button
            type="button"
            onClick={retryLoad}
            className="mt-3 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* WhatsApp-style conversation area */}
          <ul
            ref={listRef}
            role="log"
            aria-label="Conversation messages"
            className="mt-4 max-h-80 space-y-2.5 overflow-y-auto rounded-xl border border-gray-200 p-3 sm:p-4"
            style={{ backgroundColor: '#f1f5f9', backgroundImage: CHAT_PATTERN }}
          >
            {messages.length === 0 ? (
              <li className="py-8 text-center text-sm text-gray-500">
                No messages yet. Start the conversation.
              </li>
            ) : (
              messages.map((message) => {
                const mine = isOwnMessage(message)
                return (
                  <li
                    key={message.id}
                    className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                  >
                    <span className="px-1 text-[11px] font-medium text-gray-500">
                      {mine ? ownLabel(message) : labelFor(message.sender_role)}
                    </span>
                    <div
                      className={`mt-0.5 max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm sm:max-w-[70%] ${
                        mine
                          ? 'rounded-br-md bg-blue-600 text-white'
                          : 'rounded-bl-md bg-white text-gray-900 ring-1 ring-gray-200'
                      }`}
                    >
                      <p className="whitespace-pre-line break-words">{message.body}</p>
                      {/* Timestamp inside the bubble, bottom-right */}
                      <span
                        className={`mt-1 block text-right text-[10px] leading-none ${
                          mine ? 'text-blue-200' : 'text-gray-400'
                        }`}
                      >
                        {formatDateTime(message.created_at)}
                      </span>
                    </div>
                  </li>
                )
              })
            )}
          </ul>

          {sendError && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {sendError}
            </p>
          )}

          {/* Modern chat composer */}
          <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="chat-message" className="sr-only">
                Type a message
              </label>
              <textarea
                id="chat-message"
                ref={inputRef}
                rows={2}
                maxLength={MESSAGE_MAX_LENGTH}
                placeholder="Type a message…"
                className="block w-full resize-none rounded-2xl border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 pr-1 text-right text-[11px] text-gray-400">
                {MESSAGE_MAX_LENGTH} characters max
              </p>
            </div>
            <button
              type="submit"
              aria-label="Send message"
              disabled={sending}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <svg
                className="h-5 w-5 translate-x-px"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
              </svg>
              <span className="sr-only">{sending ? 'Sending…' : 'Send'}</span>
            </button>
          </form>
        </>
      )}
    </section>
  )
}
