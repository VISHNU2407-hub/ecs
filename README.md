# College Complaint Management System

Day 2: a **React + Vite + Tailwind CSS** frontend with **React Router** and
**Supabase Auth**. Day 1 provided the app shell and placeholder role pages;
Day 2 adds email/password authentication (sign-up, login, password reset) with
role-aware route protection.

## Getting started

```bash
npm install

# Configure Supabase credentials (required before using any Supabase features)
cp .env.example .env
# Edit .env and fill in:
#   VITE_SUPABASE_URL            -> e.g. https://xxxx.supabase.co
#   VITE_SUPABASE_PUBLISHABLE_KEY -> the publishable (anon) key
# Use only the publishable key. Never put a secret key (sb_secret_*) in the frontend.

npm run dev
```

Open http://localhost:5173 — you'll be redirected to `/login`.

## Authentication (Day 2)

- Students self-register with a college email (`@gprec.ac.in`), password, and
  password confirmation. Other domains are rejected.
- Supabase's **Confirm email** setting is currently enabled, so new accounts
  must verify their email before the first sign-in (users are intentionally
  not signed in automatically after registering).
- Login errors are intentionally generic ("Invalid email or password.") so the
  UI never reveals whether an email exists.
- Forgot password uses Supabase's password-reset flow; the recovery link
  returns to `/update-password` where the user sets a new password.
- Sessions persist via supabase-js (stored by the client, restored on reload).

### Roles (interim)

The `users` table does not exist yet (planned for Day 3), so there is no
database role system. Roles are resolved through a single abstraction,
`getUserRole` in `src/lib/authService.js`:

- accounts created via `/register` store `role: 'student'` in Supabase auth
  user metadata;
- any other authenticated user defaults to `student`;
- on Day 3 this function is swapped for a `users`-table lookup so staff/admin
  roles can exist.

Because of this, all dashboards currently resolve to `/student` — visiting
`/staff` or `/admin` while signed in redirects to the user's own dashboard.

## Routes

| Route             | Page                                    | Access                |
| ----------------- | --------------------------------------- | --------------------- |
| `/login`          | Sign in                                 | Public (redirects if signed in) |
| `/register`       | Create a student account                | Public (redirects if signed in) |
| `/forgot-password`| Request a password reset email          | Public                |
| `/update-password`| Set a new password (recovery link lands here) | Recovery session |
| `/student`        | Student dashboard placeholder           | Signed-in students    |
| `/staff`          | Staff dashboard placeholder             | Staff (Day 3)         |
| `/admin`          | Admin dashboard placeholder             | Admin (Day 3)         |

Unknown routes redirect to `/login`.

## Project structure

```
├── .env.example              # Env template (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY)
├── index.html                # Vite HTML entry point
├── vite.config.js            # Vite + React + Tailwind CSS v4 plugins
└── src/
    ├── main.jsx              # React root + BrowserRouter
    ├── App.jsx               # Route definitions + AuthProvider
    ├── index.css             # Tailwind entry (@import "tailwindcss")
    ├── lib/
    │   ├── supabaseClient.js # Supabase client (env-driven, anon key only)
    │   └── authService.js    # Auth actions + interim role resolution
    ├── context/
    │   └── AuthContext.jsx   # AuthProvider / useAuth (session, role, actions)
    ├── components/
    │   ├── layout/
    │   │   └── AppLayout.jsx # Shared role-aware layout (header/nav/footer)
    │   ├── ProtectedRoute.jsx# Role-aware route guards (Protected + PublicOnly)
    │   ├── LoadingScreen.jsx # Session-check loading state
    │   └── PagePlaceholder.jsx
    └── pages/
        ├── LoginPage.jsx
        ├── RegisterPage.jsx
        ├── ForgotPasswordPage.jsx
        ├── UpdatePasswordPage.jsx
        ├── StudentPage.jsx
        ├── StaffPage.jsx
        └── AdminPage.jsx
```
