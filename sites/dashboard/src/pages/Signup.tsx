import { useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { LANDING_URL } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { AuthLayout, AuthLogo, authInputClass, authLabelClass } from './auth-shared'

export default function Signup() {
  const user = useAuthStore((s) => s.user)
  const signup = useAuthStore((s) => s.signup)
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)

  if (user) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password || pending) return
    setPending(true)
    try {
      await signup(email, password, name || undefined)
      navigate('/', { replace: true })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Signup failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout>
      <div className="mb-8 text-center">
        <AuthLogo />
        <h1 className="mb-2 text-2xl font-extrabold text-zinc-50">Create your account</h1>
        <p className="text-sm text-zinc-400">
          Already have one?{' '}
          <Link to="/login" className="text-emerald-500 hover:text-emerald-400">
            Log in
          </Link>
        </p>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className={authLabelClass}>
              Name
            </label>
            <input
              id="name"
              type="text"
              placeholder="Jane Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={authInputClass}
            />
          </div>
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
            <label htmlFor="password" className={authLabelClass}>
              Password
            </label>
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
            className="mt-1 rounded-md bg-emerald-500 py-3 font-semibold text-black transition-colors hover:bg-emerald-600 disabled:opacity-60"
          >
            {pending ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs leading-relaxed text-zinc-500">
          By creating an account you agree to our{' '}
          <a href={`${LANDING_URL}/terms`} className="text-emerald-500 hover:text-emerald-400">
            Terms
          </a>{' '}
          and{' '}
          <a href={`${LANDING_URL}/privacy`} className="text-emerald-500 hover:text-emerald-400">
            Privacy Policy
          </a>.
        </p>
      </div>
    </AuthLayout>
  )
}
