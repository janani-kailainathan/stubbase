import { useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { AuthLayout, AuthLogo, OAuthButtons, authInputClass, authLabelClass } from './auth-shared'

export default function Login() {
  const user = useAuthStore((s) => s.user)
  const login = useAuthStore((s) => s.login)
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)

  if (user) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password || pending) return
    setPending(true)
    try {
      await login(email, password)
      navigate('/', { replace: true })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Login failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout>
      <div className="mb-8 text-center">
        <AuthLogo />
        <h1 className="mb-2 text-2xl font-extrabold text-foreground">Log in to your account</h1>
        <p className="text-sm text-muted-foreground">
          New here?{' '}
          <Link to="/signup" className="text-primary-accent hover:text-primary-ink">
            Create an account
          </Link>
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-8">
        <OAuthButtons />
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className={authLabelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={authInputClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className={authLabelClass}>
                Password
              </label>
              <a href="#" className="text-xs text-primary-accent hover:text-primary-ink">
                Forgot password?
              </a>
            </div>
            <input
              id="password"
              type="password"
              required
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={authInputClass}
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="mt-1 rounded-md bg-primary py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {pending ? 'Logging in…' : 'Log in'}
          </button>
        </form>
      </div>
    </AuthLayout>
  )
}
