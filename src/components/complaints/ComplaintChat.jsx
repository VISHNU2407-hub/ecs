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

/**
 * Day 7 — anonymous two-way conversation for one complaint. Reused by the
 * student detail page and the staff complaint detail page.
 *
 *   viewerRole  — the caller's app role ('student' | 'faculty' | 'admin' |
 *                 'committee'). Determines labels and bubble side:
 *                 - student viewer: their own messages = "You" (right, blue);
 *                   staff/committee messages labeled by role (left, gray).
 *                 - staff viewer: messages labeled purely by sender_role
 *                   (Student / Staff / Committee). Staff identity is never
 *                   shown — the database does not expose sender_id.
 *
 * All messaging state (load, Realtime, dedupe, send) lives in
 * useComplaintChat; this component is presentational.
 */
export default function ComplaintChat({ complaintId, viewerRole }) {
  const {
    messages,
    loading,
    loadError,
    sending,
    sendError,
    realtimeStatus,
    retryLoad,
    sendMessage,
  } = useComplaintChat(complaintId)

  const listRef = useRef(null)
  const inputRef = useRef(null)
  const isStudentViewer = viewerRole === 'student'

  // Auto-scroll to the newest message when the list changes.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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
          <ul
            ref={listRef}
            className="mt-4 max-h-80 space-y-3 overflow-y-auto rounded-md bg-gray-50 p-3"
          >
            {messages.length === 0 ? (
              <li className="py-8 text-center text-sm text-gray-500">
                No messages yet. Start the conversation.
              </li>
            ) : (
              messages.map((message) => {
                const fromStudent = message.sender_role === 'student'
                // Student messages sit on the right; staff/committee on the
                // left. The student viewer labels their own messages "You".
                const ownLabel =
                  isStudentViewer && fromStudent
                    ? 'You'
                    : labelFor(message.sender_role)
                return (
                  <li
                    key={message.id}
                    className={`flex flex-col ${fromStudent ? 'items-end' : 'items-start'}`}
                  >
                    <span className="text-xs font-medium text-gray-500">
                      {ownLabel}
                    </span>
                    <div
                      className={`mt-0.5 max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm sm:max-w-[75%] ${
                        fromStudent
                          ? 'rounded-br-sm bg-blue-600 text-white'
                          : 'rounded-bl-sm bg-white text-gray-900 ring-1 ring-gray-200'
                      }`}
                    >
                      <p className="whitespace-pre-line break-words">{message.body}</p>
                    </div>
                    <span className="mt-0.5 text-[11px] text-gray-400">
                      {formatDateTime(message.created_at)}
                    </span>
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
                className="block w-full resize-none rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1 text-right text-[11px] text-gray-400">
                Max {MESSAGE_MAX_LENGTH} characters
              </p>
            </div>
            <button
              type="submit"
              disabled={sending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </>
      )}
    </section>
  )
}
