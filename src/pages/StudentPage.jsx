import { Link } from 'react-router-dom'
import PagePlaceholder from '../components/PagePlaceholder.jsx'

export default function StudentPage() {
  return (
    <div className="space-y-6">
      <PagePlaceholder
        title="Student Dashboard"
        description="Submit new complaints and track the status of existing ones. Complaint tracking and history arrive in a later phase."
      />

      {/* Day 4 — the complaint submission entry point. The full complaint
          dashboard (tracking/status) is Day 5. */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Submit a complaint</h2>
        <p className="mt-1 max-w-prose text-sm text-gray-600">
          Report an issue to the ECS department — academics, labs, equipment,
          infrastructure and more. Your identity stays anonymous.
        </p>
        <Link
          to="/student/complaints/new"
          className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Submit Complaint
        </Link>
      </div>
    </div>
  )
}
