export default function LoadingScreen({ label = 'Loading…' }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
        />
        <p className="text-sm text-gray-500">{label}</p>
      </div>
    </div>
  )
}
