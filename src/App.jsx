import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout.jsx'
import LoginPage from './pages/LoginPage.jsx'
import StudentPage from './pages/StudentPage.jsx'
import StaffPage from './pages/StaffPage.jsx'
import AdminPage from './pages/AdminPage.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginPage />} />

      {/*
        Role-based areas. Each is wrapped in the shared layout, which
        renders navigation based on the role. In a later phase the role
        will come from the authenticated user instead of the route.
      */}
      <Route
        path="/student"
        element={
          <AppLayout role="student">
            <StudentPage />
          </AppLayout>
        }
      />
      <Route
        path="/staff"
        element={
          <AppLayout role="staff">
            <StaffPage />
          </AppLayout>
        }
      />
      <Route
        path="/admin"
        element={
          <AppLayout role="admin">
            <AdminPage />
          </AppLayout>
        }
      />

      {/* Unknown routes fall back to the login page. */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}
