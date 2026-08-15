import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import {
  fetchCategoriesWithSensitivity,
  fetchCategoryDepartmentMap,
  fetchFacultyCategoryAssignments,
  setFacultyCategoryAssignments,
} from '../lib/complaintService.js'

/**
 * Day 9B — Faculty Category Assignments (admin-only management UI).
 *
 * This is NOT a security mechanism — the database is. Faculty visibility is
 * narrowed by RLS + can_access_complaint() + update_complaint_status() to
 * the caller's department and assigned categories. This page is the ONLY
 * way to CHANGE those assignments, and every change goes through the
 * SECURITY DEFINER RPC set_faculty_category_assignments(), which verifies
 * inside the database that:
 *   - the caller's role (public.profiles.role) is admin,
 *   - the target is a faculty account with a department,
 *   - every selected category is non-sensitive and mapped to the target's
 *     department.
 * The checkboxes here are convenience; a crafted API call gets the same
 * server-side validation. Students are never listed (the RPC returns
 * faculty only), and no student identity is fetched or rendered anywhere.
 */
export default function FacultyAssignmentsPage() {
  const { role } = useAuth()

  const [facultyRows, setFacultyRows] = useState([]) // raw RPC rows
  const [categories, setCategories] = useState([])
  const [deptMap, setDeptMap] = useState([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Per-faculty draft selections (category_id -> checked).
  const [drafts, setDrafts] = useState({})
  // Per-faculty save state.
  const [savingId, setSavingId] = useState(null)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState('')

  const mountedRef = useRef(true)
  const savingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function loadAll() {
    setLoading(true)
    setLoadError('')
    try {
      const [rows, cats, map] = await Promise.all([
        fetchFacultyCategoryAssignments(),
        fetchCategoriesWithSensitivity(),
        fetchCategoryDepartmentMap(),
      ])
      if (!mountedRef.current) return
      setFacultyRows(rows)
      setCategories(cats)
      setDeptMap(map)
      // Initialize drafts from the loaded assignments.
      const next = {}
      for (const row of rows) {
        if (!next[row.faculty_id]) next[row.faculty_id] = new Set()
        if (row.category_id) next[row.faculty_id].add(row.category_id)
      }
      setDrafts(next)
    } catch (err) {
      console.error('[faculty-assignments] failed to load', err)
      if (mountedRef.current) {
        setLoadError('Could not load faculty assignments. Please try again.')
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
    // Load once on mount; the retry button re-runs loadAll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Group the RPC rows into faculty cards, preserving order.
  const faculty = useMemo(() => {
    const byId = new Map()
    for (const row of facultyRows) {
      if (!byId.has(row.faculty_id)) {
        byId.set(row.faculty_id, {
          id: row.faculty_id,
          email: row.faculty_email,
          department_id: row.department_id,
          department: row.department ?? '—',
        })
      }
    }
    return [...byId.values()]
  }, [facultyRows])

  // Categories that belong to a given department (via the routing table).
  const categoriesForDepartment = useMemo(() => {
    const byDept = new Map()
    for (const m of deptMap) {
      if (!byDept.has(m.department_id)) byDept.set(m.department_id, new Set())
      byDept.get(m.department_id).add(m.category_id)
    }
    return byDept
  }, [deptMap])

  function toggleCategory(facultyId, categoryId) {
    setSaveError('')
    setSaveSuccess('')
    setDrafts((prev) => {
      const nextSet = new Set(prev[facultyId] ?? [])
      if (nextSet.has(categoryId)) nextSet.delete(categoryId)
      else nextSet.add(categoryId)
      return { ...prev, [facultyId]: nextSet }
    })
  }

  async function handleSave(facultyId) {
    setSaveError('')
    setSaveSuccess('')
    if (savingRef.current) return
    savingRef.current = true
    setSavingId(facultyId)
    try {
      const selected = [...(drafts[facultyId] ?? [])]
      // The RPC re-validates everything server-side (role, target, category
      // sensitivity + department mapping). An empty selection clears the
      // faculty member's assignments.
      await setFacultyCategoryAssignments(facultyId, selected)
      if (!mountedRef.current) return
      setSaveSuccess(`Assignments saved for ${facultyId}.`)
      await loadAll()
    } catch (err) {
      console.error('[faculty-assignments] save failed', err)
      if (mountedRef.current) {
        setSaveError('Could not save the assignments. The selection may not be allowed.')
      }
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSavingId(null)
    }
  }

  if (role !== 'admin') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center shadow-sm">
        <p className="text-sm text-red-700">
          Admin access only — you do not have permission to manage faculty
          assignments.
        </p>
        <Link
          to="/staff"
          className="mt-4 inline-block rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Back to Staff Dashboard
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white p-12 shadow-sm">
        <div
          aria-hidden="true"
          className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
        />
        <p className="text-sm text-gray-500">Loading faculty assignments…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center shadow-sm">
        <p className="text-sm text-red-700">{loadError}</p>
        <button
          type="button"
          onClick={loadAll}
          className="mt-4 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/staff"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Back to Staff Dashboard
        </Link>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
        <h1 className="text-xl font-semibold text-gray-900">
          Faculty Category Assignments
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Choose which complaint categories each faculty member may handle.
          Faculty only ever see non-sensitive complaints from their own
          department in their assigned categories — enforced by the database.
          Students are never listed here.
        </p>
      </div>

      {saveError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 shadow-sm"
        >
          {saveError}
        </div>
      )}
      {saveSuccess && (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800 shadow-sm"
        >
          {saveSuccess}
        </div>
      )}

      {faculty.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="text-lg font-medium text-gray-900">No faculty accounts yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-600">
            Faculty accounts (role = faculty in public.profiles) will appear
            here so you can assign their categories.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {faculty.map((f) => {
            const available = categoriesForDepartment.get(f.department_id) ?? new Set()
            const assignable = categories.filter((c) => available.has(c.id))
            const selected = drafts[f.id] ?? new Set()
            return (
              <li
                key={f.id}
                className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{f.email}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      Department: {f.department}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSave(f.id)}
                    disabled={savingId === f.id}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingId === f.id ? 'Saving…' : 'Save Assignments'}
                  </button>
                </div>

                {assignable.length === 0 ? (
                  <p className="mt-4 text-sm text-gray-500">
                    No categories are routed to this department.
                  </p>
                ) : (
                  <fieldset className="mt-4">
                    <legend className="sr-only">Assigned categories</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {categories.map((category) => {
                        if (!available.has(category.id)) return null
                        const checked = selected.has(category.id)
                        if (category.is_sensitive) {
                          return (
                            <label
                              key={category.id}
                              className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-400"
                            >
                              <input
                                type="checkbox"
                                disabled
                                checked={false}
                                className="h-4 w-4 rounded border-gray-300"
                              />
                              <span className="truncate">{category.name}</span>
                              <span className="ml-auto shrink-0 text-[10px] font-medium text-gray-400">
                                sensitive
                              </span>
                            </label>
                          )
                        }
                        return (
                          <label
                            key={category.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleCategory(f.id, category.id)}
                              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="truncate">{category.name}</span>
                          </label>
                        )
                      })}
                    </div>
                  </fieldset>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
