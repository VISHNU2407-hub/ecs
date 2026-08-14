import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout.jsx'
import ProtectedRoute, { PublicOnlyRoute } from './components/ProtectedRoute.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx'
import UpdatePasswordPage from './pages/UpdatePasswordPage.jsx'
import StudentPage from './pages/StudentPage.jsx'
import StaffPage from './pages/StaffPage.jsx'
import AdminPage from './pages/AdminPage.jsx'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* Public auth pages. Signed-in users are redirected to their dashboard. */}
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicOnlyRoute>
              <RegisterPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/update-password" element={<UpdatePasswordPage />} />

        {/*
          Role-based areas. Each is wrapped in the shared layout and the
          role-aware ProtectedRoute guard, which sends users without the
          required role to their own dashboard. The role is resolved by
          authService.getUserRole from public.profiles (the authoritative
          source since Day 3).
        */}
        <Route
          path="/student"
          element={
            <ProtectedRoute role="student">
              <AppLayout role="student">
                <StudentPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/staff"
          element={
            <ProtectedRoute role="staff">
              <AppLayout role="staff">
                <StaffPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute role="admin">
              <AppLayout role="admin">
                <AdminPage />
              </AppLayout>
            </ProtectedRoute>
          }
        />

        {/* Unknown routes fall back to the login page. */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </AuthProvider>
  )
}
