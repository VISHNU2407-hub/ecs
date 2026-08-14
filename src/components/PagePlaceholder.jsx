export default function PagePlaceholder({ title, description }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
      <p className="mt-2 max-w-prose text-gray-600">{description}</p>
      <span className="mt-4 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
        Placeholder — this area will be built in a later phase
      </span>
    </div>
  )
}
