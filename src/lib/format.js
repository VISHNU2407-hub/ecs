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

/**
 * Day 10B — formats a byte count for the attachment UI:
 * "512 B", "4.5 KB", "2.3 MB", "48 MB". Returns an em dash for missing or
 * invalid values so a bad row never renders garbage.
 */
export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes)) || Number(bytes) < 0) {
    return '—'
  }
  const value = Number(bytes)
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB']
  let amount = value / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && amount >= 1024; i += 1) {
    amount /= 1024
    unit = units[i]
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`
}
