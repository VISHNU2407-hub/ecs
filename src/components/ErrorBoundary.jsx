import { Component } from 'react'

/**
 * Last line of defense against a blank page: if any component below this
 * boundary throws during render, React would otherwise unmount the entire
 * tree (a blank white screen). This boundary renders a visible error card
 * instead and logs the original error to the console — it never hides the
 * problem, it surfaces it.
 *
 * Note: error boundaries only catch render/lifecycle errors, not errors in
 * event handlers or async code (those are handled by the pages' own error
 * states). This does not replace role-based routing or any security check —
 * it is purely a UX safety net.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Keep the real error visible to developers (this is not a silent catch).
    console.error('[error-boundary]', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
          <div className="w-full max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
            <p className="text-lg font-semibold text-gray-900">Something went wrong</p>
            <p className="mt-1 text-sm text-red-700">
              {String(this.state.error?.message ?? this.state.error)}
            </p>
            <p className="mt-2 text-xs text-gray-500">
              Check the browser console for the full error.
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <a
                href="/login"
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go to login
              </a>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
