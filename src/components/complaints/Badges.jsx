/**
 * Shared visual treatment for complaint status / priority / sensitivity.
 * Used by both the student and staff dashboards so the two dashboards are
 * consistent (Day 5). Values are database enum members; unknown values fall
 * back to a neutral badge so a future enum value never breaks the UI.
 */

const STATUS_STYLES = {
  submitted: 'bg-gray-100 text-gray-700 ring-gray-200',
  under_review: 'bg-blue-50 text-blue-700 ring-blue-200',
  assigned: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  in_progress: 'bg-amber-50 text-amber-700 ring-amber-200',
  resolved: 'bg-green-50 text-green-700 ring-green-200',
  reopened: 'bg-orange-50 text-orange-700 ring-orange-200',
  escalated: 'bg-red-50 text-red-700 ring-red-200',
  closed: 'bg-gray-100 text-gray-600 ring-gray-200',
}

export const STATUS_LABELS = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  reopened: 'Reopened',
  escalated: 'Escalated',
  closed: 'Closed',
}

const PRIORITY_STYLES = {
  low: 'bg-gray-100 text-gray-600 ring-gray-200',
  medium: 'bg-blue-50 text-blue-700 ring-blue-200',
  high: 'bg-amber-50 text-amber-800 ring-amber-200',
  urgent: 'bg-red-50 text-red-700 ring-red-200',
}

function badgeClasses(colorClasses) {
  return `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${colorClasses}`
}

export function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700 ring-gray-200'
  const label = STATUS_LABELS[status] ?? String(status ?? 'unknown')
  return (
    <span className={badgeClasses(style)}>{label}</span>
  )
}

export function PriorityBadge({ priority }) {
  const style = PRIORITY_STYLES[priority] ?? 'bg-gray-100 text-gray-700 ring-gray-200'
  return (
    <span className={badgeClasses(style)}>{String(priority ?? 'unknown')}</span>
  )
}

/**
 * Sensitive / non-sensitive indicator. Explicit both ways so a reviewer can
 * confirm at a glance that the dashboard shows the flag and nothing more.
 */
export function SensitiveBadge({ isSensitive }) {
  return isSensitive ? (
    <span className={badgeClasses('bg-red-50 text-red-700 ring-red-200')}>Sensitive</span>
  ) : (
    <span className={badgeClasses('bg-gray-100 text-gray-600 ring-gray-200')}>Standard</span>
  )
}
