/**
 * Formats a database timestamp (ISO string or Date) for the dashboards:
 * e.g. "Aug 15, 2026, 2:30 PM". Returns an em dash when the value is
 * missing or unparseable so a bad row never renders "Invalid Date".
 */
export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
