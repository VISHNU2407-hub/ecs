import { useEffect, useRef, useState } from 'react'
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

// Small vertical-ellipsis icon (⋮) used by the per-message action menu.
function DotsIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  )
}

/**
 * Day 7 + Day 8A — anonymous two-way conversation for one complaint, reused
 * by the student detail page and the staff complaint detail page.
 *
 * Day 7 (unchanged): WhatsApp-style bubbles — the current user's messages are
 * right-aligned blue bubbles labeled "You" / "You (Role)"; other participants
 * are left-aligned white bubbles labeled only by sender_role.
 *
 *   viewerRole — the caller's app role. "My message" is determined WITHOUT
 *                any identity field:
 *                - student viewer: every student-role message on their own
 *                  complaint is theirs (RLS guarantees only the owner can be
 *                  the student participant) → sender_role === 'student'.
 *                - staff viewer: only messages whose id is in ownMessageIds
 *                  (recorded locally when THIS authenticated user sent them,
 *                  persisted per user+complaint in sessionStorage). Other
 *                  staff messages stay anonymous ("Staff").
 *   ownerId    — the authenticated user's id, used ONLY to scope the local
 *                ownership storage key. Never sent anywhere.
 *
 * Day 8A (additions): each message has a ⋮ action menu — own messages get
 * Copy / Edit / Delete for me / Delete for everyone; other participants'
 * messages get Copy / Delete for me. Edit opens an inline editor (2000-char
 * limit, empty/whitespace rejection); deletes go through the Day 8
 * SECURITY DEFINER RPCs with a confirmation dialog. "edited" and "This
 * message was deleted" states render without identity. All write
 * authorization is enforced in the database — this component is UI only.
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
    hiddenMessageIds,
    actioningId,
    actionError,
    retryLoad,
    sendMessage,
    editMessage,
    deleteForEveryone,
    deleteForMe,
  } = useComplaintChat(complaintId, ownerId)

  const [menuOpenId, setMenuOpenId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  // { kind: 'me' | 'everyone', messageId } | null
  const [confirm, setConfirm] = useState(null)
  const [copiedId, setCopiedId] = useState(null)

  const listRef = useRef(null)
  const inputRef = useRef(null)
  const isStudentViewer = viewerRole === 'student'

  // Auto-scroll to the newest message when the list changes.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Close the open menu on any outside pointer interaction (no hover needed —
  // mobile friendly; the menu itself stops propagation so its own taps stay
  // open until an action runs).
  useEffect(() => {
    if (!menuOpenId) return
    function close() {
      setMenuOpenId(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpenId])

  // Day 8A: delete-for-everyone takes precedence over delete-for-me, so a
  // message hidden by the caller is filtered out UNLESS it was also deleted
  // for everyone (both sides must then see the deleted state).
  const visibleMessages = messages.filter(
    (m) => !hiddenMessageIds.has(m.id) || m.is_deleted,
  )

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

  function toggleMenu(message) {
    setEditingId(null)
    setMenuOpenId((cur) => (cur === message.id ? null : message.id))
  }

  function startEdit(message) {
    setMenuOpenId(null)
    setEditingId(message.id)
    setEditValue(message.body)
  }

  async function handleSaveEdit(message) {
    const ok = await editMessage(message.id, editValue)
    if (ok) setEditingId(null)
  }

  async function handleCopy(message) {
    const text = message.body ?? ''
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Graceful fallback for older browsers / non-secure contexts.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // Clipboard unavailable — nothing more we can do.
      }
      document.body.removeChild(ta)
    }
    setMenuOpenId(null)
    setCopiedId(message.id)
    window.setTimeout(() => setCopiedId(null), 1500)
  }

  async function handleConfirmDelete() {
    if (!confirm) return
    const { kind, messageId } = confirm
    const ok =
      kind === 'everyone'
        ? await deleteForEveryone(messageId)
        : await deleteForMe(messageId)
    setConfirm(null)
    setMenuOpenId(null)
    if (!ok) setEditingId(null)
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
            className="mt-4 max-h-80 space-y-3 overflow-y-auto rounded-xl border border-gray-200 p-3 sm:p-4"
            style={{ backgroundColor: '#f1f5f9', backgroundImage: CHAT_PATTERN }}
          >
            {visibleMessages.length === 0 ? (
              <li className="py-8 text-center text-sm text-gray-500">
                No messages yet. Start the conversation.
              </li>
            ) : (
              visibleMessages.map((message) => {
                const mine = isOwnMessage(message)
                const deleted = Boolean(message.is_deleted)
                const editing = editingId === message.id
                const menuOpen = menuOpenId === message.id
                const busy = actioningId === message.id
                return (
                  <li
                    key={message.id}
                    className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}
                  >
                    <span className="px-1 text-[11px] font-medium text-gray-500">
                      {mine ? ownLabel(message) : labelFor(message.sender_role)}
                    </span>

                    <div className="relative mt-0.5 max-w-[80%] sm:max-w-[70%]">
                      {editing ? (
                        /* ---- Inline edit UI ---- */
                        <form
                          onSubmit={(e) => {
                            e.preventDefault()
                            handleSaveEdit(message)
                          }}
                          className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-gray-200"
                        >
                          <label htmlFor={`edit-${message.id}`} className="sr-only">
                            Edit message
                          </label>
                          <textarea
                            id={`edit-${message.id}`}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            rows={2}
                            maxLength={MESSAGE_MAX_LENGTH}
                            autoFocus
                            className="block w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <div className="mt-2 flex items-center justify-end gap-2">
                            <span className="mr-auto text-[11px] text-gray-400">
                              {editValue.length}/{MESSAGE_MAX_LENGTH}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null)
                                setEditValue('')
                              }}
                              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={busy || !editValue.trim()}
                              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {busy ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        </form>
                      ) : deleted ? (
                        /* ---- Soft-deleted message ---- */
                        <div
                          className={`rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                            mine
                              ? 'rounded-br-md bg-blue-600 text-white'
                              : 'rounded-bl-md bg-white text-gray-900 ring-1 ring-gray-200'
                          }`}
                        >
                          <p className="italic opacity-80">This message was deleted</p>
                          <span
                            className={`mt-1 block text-right text-[10px] leading-none ${
                              mine ? 'text-blue-200' : 'text-gray-400'
                            }`}
                          >
                            {formatDateTime(message.created_at)}
                          </span>
                        </div>
                      ) : (
                        /* ---- Normal message + action menu ---- */
                        <>
                          <div
                            className={`rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                              mine
                                ? 'rounded-br-md bg-blue-600 text-white'
                                : 'rounded-bl-md bg-white text-gray-900 ring-1 ring-gray-200'
                            }`}
                          >
                            <p className="whitespace-pre-line break-words pr-4">
                              {message.body}
                            </p>
                            <span
                              className={`mt-1 flex items-center justify-end gap-1.5 text-[10px] leading-none ${
                                mine ? 'text-blue-200' : 'text-gray-400'
                              }`}
                            >
                              {message.edited_at && (
                                <span className="italic">edited</span>
                              )}
                              <span>{formatDateTime(message.created_at)}</span>
                            </span>
                          </div>

                          {/* ⋮ action button (always visible — no hover needed) */}
                          <button
                            type="button"
                            aria-label={`Message options${mine ? ' (your message)' : ''}`}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleMenu(message)
                            }}
                            className={`absolute right-1.5 top-1.5 rounded-full p-0.5 transition-colors ${
                              mine
                                ? 'text-white/70 hover:text-white'
                                : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
                            }`}
                          >
                            <DotsIcon />
                          </button>

                          {menuOpen && (
                            <ul
                              role="menu"
                              aria-label="Message actions"
                              onPointerDown={(e) => e.stopPropagation()}
                              className="absolute bottom-full right-0 z-20 mb-1.5 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                            >
                              <li role="menuitem">
                                <button
                                  type="button"
                                  onClick={() => handleCopy(message)}
                                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                                >
                                  {copiedId === message.id ? 'Copied ✓' : 'Copy'}
                                </button>
                              </li>
                              {mine && (
                                <li role="menuitem">
                                  <button
                                    type="button"
                                    onClick={() => startEdit(message)}
                                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                                  >
                                    Edit
                                  </button>
                                </li>
                              )}
                              <li role="menuitem">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setMenuOpenId(null)
                                    setConfirm({ kind: 'me', messageId: message.id })
                                  }}
                                  className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                                >
                                  Delete for me
                                </button>
                              </li>
                              {mine && (
                                <li role="menuitem">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMenuOpenId(null)
                                      setConfirm({ kind: 'everyone', messageId: message.id })
                                    }}
                                    className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                                  >
                                    Delete for everyone
                                  </button>
                                </li>
                              )}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  </li>
                )
              })
            )}
          </ul>

          {(sendError || actionError) && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {actionError || sendError}
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

      {/* Confirmation dialog (mobile friendly) */}
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="message-delete-confirm-title"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3
              id="message-delete-confirm-title"
              className="text-base font-semibold text-gray-900"
            >
              {confirm.kind === 'everyone'
                ? 'Delete this message for everyone?'
                : 'Delete this message for you?'}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {confirm.kind === 'everyone'
                ? 'This message will be removed for all participants.'
                : 'Only you will stop seeing this message. The other participant can still see it.'}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actioningId !== null}
                onClick={handleConfirmDelete}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {actioningId !== null ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
