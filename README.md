# College Complaint Management System

Day 1 scaffold: a clean **React + Vite + Tailwind CSS** frontend with
**React Router** and a **Supabase** client setup. No auth, database tables, or
business logic yet — just the app shell and placeholder pages.

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

## Routes

| Route     | Page                          |
| --------- | ----------------------------- |
| `/login`  | Sign-in placeholder           |
| `/student`| Student dashboard placeholder |
| `/staff`  | Staff dashboard placeholder   |
| `/admin`  | Admin dashboard placeholder   |

Unknown routes redirect to `/login`.

## Project structure

```
├── .env.example              # Env template (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY)
├── index.html                # Vite HTML entry point
├── vite.config.js            # Vite + React + Tailwind CSS v4 plugins
└── src/
    ├── main.jsx              # React root + BrowserRouter
    ├── App.jsx               # Route definitions
    ├── index.css             # Tailwind entry (@import "tailwindcss")
    ├── lib/
    │   └── supabaseClient.js # Supabase client (env-driven, anon key only)
    ├── components/
    │   ├── layout/
    │   │   └── AppLayout.jsx # Shared role-aware layout (header/nav/footer)
    │   └── PagePlaceholder.jsx
    └── pages/
        ├── LoginPage.jsx
        ├── StudentPage.jsx
        ├── StaffPage.jsx
        └── AdminPage.jsx
```

The shared `AppLayout` centralizes per-role navigation items, so switching to
auth-driven, role-based navigation in a later phase only requires changing how
the active role is determined.
