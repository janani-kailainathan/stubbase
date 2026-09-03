import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import AuthCallback from '@/pages/AuthCallback'
import Editor from '@/pages/Editor'
import Login from '@/pages/Login'
import Signup from '@/pages/Signup'

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  return children
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        {/*
          Which project is open lives in the URL and nowhere else, so a reload
          or a bookmark comes back to the project you were in rather than to
          whichever one happens to sort first. `/` is the same screen with no
          project named; it redirects to the first one as soon as the list is
          in (see Editor), which is also where every post-auth flow lands.

          Deep-linking a project id is not an authorisation decision: the id is
          the *tenant* id, and every /projects route on the Dashboard API
          ownership-checks it, so another account's URL answers 404 and the SPA
          shows its unknown-project screen. See the "a stranger's project id in
          the URL" test in tests/dashboard-api.test.ts.
        */}
        <Route
          path="/"
          element={
            <RequireAuth>
              <Editor />
            </RequireAuth>
          }
        />
        <Route
          path="/p/:tenantId"
          element={
            <RequireAuth>
              <Editor />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
