import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import LoadingScreen from '../components/LoadingScreen.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { fetchFacultyRegistrationOptions } from '../lib/complaintService.js'

// Shown when a SIGNED-OUT user tries to register an email that already has an
// account (Supabase reports this by returning a user with zero identities, a
// null user, or an "already registered"-style error). The account already
// exists, so no signUp and no second account may happen — the user must sign
// in first, then return here to complete faculty setup via register_faculty.
const EXISTING_ACCOUNT_MESSAGE =
  'This account already exists. Please sign in first, then return to Faculty ' +
  'Registration to complete faculty setup.'// Development-only diagnostics for tracing the registration flow. Never logs
// passwords, the registration code, or tokens — only safe identifiers (user
// ids, emails, role values, uuids, counters) used to identify the failing
// operation.
function logStep(label, detail) {
  if (!import.meta.env.DEV) return
  console.log(`[faculty-register] ${label}`, detail ?? '')
}


// Maps the SECURITY DEFINER RPC's messages to user-friendly copy. Never
// surface raw PostgreSQL errors to the user; log technical details to the
// developer console instead. Every register_faculty rejection is caught and
// shown (never swallowed) — the mapping below only makes the real cause clear.
function friendlyRegistrationError(message) {
  const msg = String(message ?? '')
  if (/registration code is not configured/i.test(msg)) {
    // The admin has not set the private code yet (the Day 10C migration seeds
    // none by design) — distinct from typing a wrong code; surface the real
    // cause safely so it is not mistaken for a user typo.
    return 'Faculty registration is not set up yet. Please contact your administrator.'
  }
  if (/registration code is required|invalid registration code/i.test(msg)) {
    return 'Invalid registration code. Please check the code with your administrator.'
  }
  if (/not authenticated/i.test(msg)) {
    return 'Your session expired. Please sign in again and retry faculty registration.'
  }
  if (/already registered/i.test(msg)) {
    return 'This account is already registered as faculty.'
  }
  if (/department/i.test(msg)) {
    return 'The selected department is not available.'
  }
  if (/category/i.test(msg) || /sensitive/i.test(msg)) {
    return 'One or more selected categories are not available for this department.'
  }
  return 'Faculty registration could not be completed. Please try again.'
}

/**
 * Day 10C — Faculty Registration (/faculty/register).
 *
 * A SEPARATE registration flow from the student signup: faculty use ANY
 * email (no domain restriction, and NO email-verification step — Supabase
 * Email Confirmation is intentionally OFF for this MVP, Day 10E), a PRIVATE
 * registration code (never shown, never emailed, never in the JS bundle —
 * the database validates it against a bcrypt hash), and the non-sensitive
 * complaint categories routed to their department.
 *
 * The MVP has EXACTLY ONE department — ECS — so there is NO department
 * dropdown: the page resolves ECS automatically (id + name come from the
 * database, never hardcoded) through the Day 10D read-only RPC
 * get_faculty_registration_options() (executable by anonymous + authenticated
 * callers, so the page renders before sign-up), displays it as a read-only
 * field, and loads only the complaint categories mapped to ECS via the
 * existing category_department_map / complaint_categories tables. register_faculty
 * re-validates the department and every category server-side regardless of
 * what the frontend displays.
 *
 * The form is only the entry point: it submits the code / department /
 * categories to the SECURITY DEFINER RPC register_faculty, which verifies
 * everything inside the database (auth.uid(), profile role = 'student', code
 * hash, department, category sensitivity + department mapping) and atomically
 * sets profiles.role = 'faculty', profiles.department_id and the
 * faculty_category_assignments rows. There is NO role dropdown and no client-
 * controlled role — elevation happens only through the RPC.
 *
 * NEW-USER FLOW (no email verification — Day 10E): with Supabase Email
 * Confirmation OFF, signUp() returns an authenticated session immediately.
 * The page calls signUp() -> register_faculty() -> refreshRole() in one
 * sequence: there is NO "verify your email" step and NO redirect to /login.
 * A signUp() that returns no session (or reports an already-existing
 * account) stops safely — an existing account shows "This account already
 * exists. Please sign in first..." with a Sign in action, and no second
 * account is ever created. After register_faculty(), the page navigates to
 * /staff ONLY when refreshRole() returns exactly 'faculty'; otherwise it
 * stays here with a clear error — it never bounces to /student and never
 * implies registration succeeded when the role was not changed.
 *
 * SIGNED-IN COMPLETION PATH (existing student account): when the visitor is
 * ALREADY authenticated, the page is a completion form, not a signup form —
 * the email field is locked to the signed-in email, password / confirm-
 * password are hidden, signUp() is never called (no second auth user is ever
 * created), and the submit button says "Complete Faculty Registration". The
 * department is still auto-resolved to ECS via the Day 10D options RPC; the
 * user enters only the private code and selects >=1 non-sensitive category.
 * handleSubmit then calls the existing register_faculty SECURITY DEFINER RPC
 * with the authenticated session — the ONLY mechanism that sets
 * profiles.role = 'faculty' — awaits refreshRole() (the role fetch is
 * version-guarded in AuthContext so a stale read can never bounce the fresh
 * 'faculty' role back to 'student'), and only then navigates to /staff. If
 * the RPC rejects (wrong code, expired session, invalid category, ...), the
 * mapped error is shown and NO navigation happens. Already-registered staff
 * (faculty/admin/committee) are redirected to their dashboard before the form
 * renders, so re-registration is impossible.
 */
export default function FacultyRegisterPage() {
  const { user, role, dashboardKey, loading, roleLoading, signUp, registerFaculty, refreshRole } =
    useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [registrationCode, setRegistrationCode] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [selectedCategories, setSelectedCategories] = useState(new Set())

  const [departments, setDepartments] = useState([])
  const [categories, setCategories] = useState([])
  const [deptMap, setDeptMap] = useState([])
  const [loadError, setLoadError] = useState('')

  // Per-field validation errors (shown next to the relevant field).
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  // True when the error is "this account already exists — sign in first"; the
  // error box then renders a Sign in action alongside the message.
  const [signInRequired, setSignInRequired] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const mountedRef = useRef(true)
  const submittingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    // Day 10D — the ONLY anonymous-readable reference-data path. The page must
    // render Department ECS + its categories before a visitor has signed up /
    // signed in, and the Day 3 reference-table grants are authenticated-only,
    // so this RPC (executable by anon + authenticated) is the load source. It
    // returns one row per (department, category routed to it) from the existing
    // public.departments / public.complaint_categories /
    // public.category_department_map tables.
    fetchFacultyRegistrationOptions()
      .then((rows) => {
        if (cancelled || !mountedRef.current) return
        // Rebuild the three shapes the form uses. Every id and name comes from
        // the database — nothing (especially no uuid) is hardcoded.
        const depts = []
        const cats = []
        const map = []
        const seenDept = new Set()
        const seenCat = new Set()
        for (const row of rows) {
          if (!seenDept.has(row.department_id)) {
            seenDept.add(row.department_id)
            depts.push({ id: row.department_id, name: row.department_name })
          }
          if (!seenCat.has(row.category_id)) {
            seenCat.add(row.category_id)
            cats.push({ id: row.category_id, name: row.category_name, is_sensitive: row.is_sensitive })
          }
          map.push({ category_id: row.category_id, department_id: row.department_id })
        }
        if (depts.length === 0) {
          setLoadError('Registration options are not configured yet. Please try again later.')
          return
        }
        setDepartments(depts)
        setCategories(cats)
        setDeptMap(map)
        // ECS is the MVP's only department. Resolve it BY NAME from the
        // database rows (the id is the database uuid — never a fake one); fall
        // back to the first department so a future/renamed department still
        // resolves instead of erroring.
        const ecs = depts.find((d) => d.name === 'ECS') ?? depts[0]
        setDepartmentId(ecs.id)
        logStep('options loaded', { departments: depts.map((d) => d.name), categoryCount: cats.length, autoDepartment: ecs.name })
      })
      .catch((err) => {
        console.error('[faculty-register] failed to load registration options', err)
        if (!cancelled && mountedRef.current) {
          setLoadError('Could not load the registration options. Please try again.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Categories routed to the selected department (via category_department_map —
  // the same source the admin Day 9B page uses; nothing is hardcoded).
  const categoriesForDepartment = useMemo(() => {
    const byDept = new Map()
    for (const m of deptMap) {
      if (!byDept.has(m.department_id)) byDept.set(m.department_id, new Set())
      byDept.get(m.department_id).add(m.category_id)
    }
    return byDept
  }, [deptMap])

  const availableCategories = useMemo(() => {
    if (!departmentId) return []
    const available = categoriesForDepartment.get(departmentId) ?? new Set()
    return categories.filter((c) => available.has(c.id))
  }, [categories, categoriesForDepartment, departmentId])

  function toggleCategory(categoryId) {
    setFieldErrors((prev) => ({ ...prev, categories: '' }))
    setSelectedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  function validate() {
    const errors = {}
    const trimmedEmail = email.trim()
    if (user) {
      // Signed in: the account already exists, email/password are irrelevant.
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        errors.email = 'Please enter a valid email address.'
      }
      if (password.length < 6) {
        errors.password = 'Password must be at least 6 characters.'
      }
      if (password !== confirmPassword) {
        errors.confirmPassword = 'Passwords do not match.'
      }
    }
    if (!registrationCode.trim()) {
      errors.registrationCode = 'The faculty registration code is required.'
    }
    // Department is resolved automatically from the database (ECS — the only
    // department in this pilot). If it is somehow empty the options failed to
    // load, which is handled by the loadError state that disables submission.
    if (selectedCategories.size === 0) {
      errors.categories = 'Please select at least one complaint category.'
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setFormError('')
    setSignInRequired(false)

    if (!validate()) return
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)

    // Which async operation is in flight — used to map errors to the exact
    // failing step (and to label the dev-only diagnostics below).
    let step = 'none'
    try {
      logStep('submit', {
        mode: user ? 'signed-in completion' : 'signed-out signup',
        hasSession: Boolean(user),
        authContextRole: role ?? null,
      })
      if (user) {
        logStep('session', { userId: user.id, email: user.email })
      }

      // 1. Signed-in path: the account ALREADY exists — signUp() must never
      //    run and no second auth user may be created. The email field is
      //    locked to the signed-in email; if it ever differs (defensive), stop
      //    with a clear message. register_faculty() elevates ONLY this
      //    signed-in profile.
      let currentUser = user
      if (currentUser) {
        const signedInEmail = (user.email ?? '').trim().toLowerCase()
        if (email.trim() && email.trim().toLowerCase() !== signedInEmail) {
          logStep('blocked', 'signed-in email mismatch')
          setFormError(
            `You are signed in as ${user.email}. Complete the faculty registration ` +
              'for that account — do not create a new one.',
          )
          return
        }
      } else {
        // 1b. Signed-out path: this is a NEW-user signup. Supabase Email
        //     Confirmation is intentionally OFF for this MVP, so signUp()
        //     returns an authenticated session immediately — there is NO
        //     email-verification step anywhere in this flow. Signing up with
        //     an email that ALREADY has an account must NOT create or pretend
        //     to elevate anything: Supabase reports it by returning a user
        //     with zero identities (or by throwing an "already registered"-
        //     style error), and the user must sign in first and return here.
        logStep('signUp', { email, hasSession: Boolean(user) })
        step = 'signUp'
        const result = await signUp(email.trim(), password, 'faculty')
        const created = result?.user ?? null
        const signUpSession = result?.session ?? null
        logStep('signUp result', {
          hasUser: Boolean(created),
          identities: Array.isArray(created?.identities) ? created.identities.length : null,
          hasSession: Boolean(signUpSession),
        })
        const isExistingAccount =
          !created || (Array.isArray(created.identities) && created.identities.length === 0)
        if (isExistingAccount) {
          logStep('blocked', 'existing account — sign in required')
          setSignInRequired(true)
          setFormError(EXISTING_ACCOUNT_MESSAGE)
          return
        }
        currentUser = created
        // A fresh signup with email confirmation OFF always returns a session;
        // without one there is no auth.uid() to elevate. Fail safely — never
        // a "verify your email" step and never a navigation to /login.
        if (!signUpSession) {
          logStep('blocked', 'no session after signUp')
          setFormError(
            'Your account was created but the session could not be started. ' +
              'Please sign in and return to Faculty Registration to complete faculty setup.',
          )
          return
        }
      }

      // 2c. Session present (new signup with email confirmation OFF, or
      //     already signed in): run the secure registration. The RPC
      //     re-verifies everything server-side (auth.uid, profile role,
      //     code, department, categories) and atomically elevates the profile.
      logStep('registerFaculty', {
        departmentId,
        categoryIds: [...selectedCategories],
        codeProvided: Boolean(registrationCode.trim()),
      })
      step = 'registerFaculty'
      await registerFaculty({
        registrationCode: registrationCode.trim(),
        departmentId,
        categoryIds: [...selectedCategories],
      })
      logStep('registerFaculty success', null)

      // 3. Re-resolve the authoritative role from public.profiles (the RPC
      //    just flipped it to 'faculty') and navigate ONLY on the verified
      //    value — never on a stale AuthContext role, and never falling back
      //    to /student after a successful registration.
      step = 'refreshRole'
      const refreshedRole = await refreshRole()
      logStep('refreshRole result', { refreshedRole })
      if (!mountedRef.current) return
      if (refreshedRole === 'faculty') {
        logStep('navigate', '/staff (role verified as faculty)')
        navigate('/staff', { replace: true })
        return
      }
      // The database did not confirm the faculty role: do NOT pretend the
      // registration succeeded and do NOT bounce to /student. Stay on this
      // page and show a safe error so the user never thinks the registration
      // completed when it did not.
      logStep('navigate', 'blocked — role not faculty, staying on page')
      setFormError('Faculty registration could not be confirmed. Your account was not upgraded to faculty.')
    } catch (err) {
      // Never surface raw backend errors to production users; log technical
      // details to the console. In development, append the real safe error so
      // the failing operation is identifiable (never passwords/codes/tokens).
      console.error('[faculty-register] registration failed', err)
      if (mountedRef.current) {
        const message = String(err?.message ?? '')
        logStep('error', { step, code: err?.code ?? null, message })
        if (step === 'signUp' && /already registered|already exists|already in use/i.test(message)) {
          // Some GoTrue configurations report an existing account as a thrown
          // error instead of an empty-identities response — same handling:
          // do not create anything, ask the user to sign in first.
          setSignInRequired(true)
          setFormError(EXISTING_ACCOUNT_MESSAGE)
        } else {
          const safe = friendlyRegistrationError(message)
          if (import.meta.env.DEV) {
            setFormError(`${safe} (dev: ${err?.code ?? ''} ${message})`)
          } else {
            setFormError(safe)
          }
        }
      }
    } finally {
      submittingRef.current = false
      if (mountedRef.current) setSubmitting(false)
    }
  }

  if (loading || roleLoading) return <LoadingScreen />
  // Already registered as staff (faculty / admin / committee): go to the
  // staff dashboard. A signed-in STUDENT stays here — they may be completing
  // a registration started before email verification.
  if (user && role && role !== 'student') {
    return <Navigate to={`/${dashboardKey}`} replace />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-4xl" aria-hidden="true">
            🎓
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">Faculty Registration</h1>
          <p className="mt-1 text-sm text-gray-500">Authorized faculty members only</p>
          <p className="mx-auto mt-3 max-w-sm text-xs text-gray-500">
            Registration requires the private faculty registration code issued by
            the department — it is never sent by email and never shown here.
          </p>
        </div>

        {user && (
          <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            Signed in as <span className="font-medium">{user.email}</span>. Complete your
            faculty registration below.
          </div>
        )}

        {formError && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <p>{formError}</p>
            {signInRequired && (
              <Link
                to="/login"
                className="mt-2 inline-block rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
              >
                Sign in
              </Link>
            )}
          </div>
        )}

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={Boolean(user)}
                placeholder="you@example.com"
                value={user ? (user.email ?? '') : email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
              />
              {fieldErrors.email && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            {!user && (
              <>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
                  />
                  {fieldErrors.password && (
                    <p role="alert" className="mt-1 text-xs text-red-600">
                      {fieldErrors.password}
                    </p>
                  )}
                </div>
                <div>
                  <label
                    htmlFor="confirm-password"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Confirm Password
                  </label>
                  <input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
                  />
                  {fieldErrors.confirmPassword && (
                    <p role="alert" className="mt-1 text-xs text-red-600">
                      {fieldErrors.confirmPassword}
                    </p>
                  )}
                </div>
              </>
            )}

            <div>
              <label
                htmlFor="registration-code"
                className="block text-sm font-medium text-gray-700"
              >
                Faculty Registration Code
              </label>
              <input
                id="registration-code"
                name="registration-code"
                type="password"
                autoComplete="off"
                required
                placeholder="Enter the private registration code"
                value={registrationCode}
                onChange={(event) => setRegistrationCode(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
              />
              {fieldErrors.registrationCode && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.registrationCode}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="department" className="block text-sm font-medium text-gray-700">
                Department
              </label>
              {/* Day 10D — no department dropdown: ECS is the only department in
                  this pilot, and it is resolved automatically from the database
                  (id + name come from get_faculty_registration_options, never
                  hardcoded). This read-only field is presentational only —
                  register_faculty re-validates the department server-side. */}
              <div
                id="department"
                className="mt-1 flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
              >
                <span className="text-sm font-semibold text-gray-900">
                  {departments.find((d) => d.id === departmentId)?.name ?? '…'}
                </span>
                <span className="inline-flex shrink-0 items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                  Assigned automatically
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Your department is selected automatically for this pilot.
              </p>
            </div>

            <fieldset>
              <legend className="block text-sm font-medium text-gray-700">
                Complaint Categories
              </legend>
              <p className="mt-0.5 text-xs text-gray-500">
                Choose the complaint categories you will handle. You must select at
                least one.
              </p>
              <div className="mt-2 space-y-2">
                {availableCategories.length === 0 ? (
                  <p className="rounded-md border border-dashed border-gray-200 px-3 py-3 text-sm text-gray-500">
                    {departments.length === 0
                      ? 'Loading complaint categories…'
                      : 'No complaint categories are available for your department.'}
                  </p>
                ) : (
                  availableCategories.map((category) => {
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
                            Sensitive — Committee only
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
                          checked={selectedCategories.has(category.id)}
                          onChange={() => toggleCategory(category.id)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="truncate">{category.name}</span>
                      </label>
                    )
                  })
                )}
              </div>
              {fieldErrors.categories && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {fieldErrors.categories}
                </p>
              )}
            </fieldset>

            {loadError && (
              <p role="alert" className="text-sm text-red-600">
                {loadError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || Boolean(loadError)}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting
                ? 'Completing registration…'
                : user
                  ? 'Complete Faculty Registration'
                  : 'Create Faculty Account'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-blue-600 hover:text-blue-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
