import { useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import * as api from '@/lib/api'
import { ApiError, LANDING_URL, type PendingSignup } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import {
  AuthLayout,
  AuthLogo,
  CodeInput,
  OAuthButtons,
  PasswordInput,
  authInputClass,
  authLabelClass,
} from './auth-shared'

/**
 * The sign-up this tab is verifying, kept in sessionStorage so a reload — or a
 * phone that drops the tab while you fetch the code from your mail app — comes
 * back to the code step instead of starting over. It is not a credential: the
 * id completes nothing without the code from the email, and it is per tab.
 */
const PENDING_KEY = 'stubbase-pending-signup'

function readPending(): PendingSignup | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null')
    return typeof value?.verificationId === 'string' && typeof value?.email === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

function writePending(pending: PendingSignup | null) {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // Storage blocked: the code step still works, it just won't survive a reload.
  }
}

export default function Signup() {
  const user = useAuthStore((s) => s.user)
  const signup = useAuthStore((s) => s.signup)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState<PendingSignup | null>(readPending)
  // The server's own words when free sign-ups are full — kept on the page
  // rather than in a toast, since it is the answer to "can I sign up?".
  const [full, setFull] = useState<string | null>(null)

  if (user) return <Navigate to="/" replace />

  const track = (next: PendingSignup | null) => {
    writePending(next)
    setPending(next)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password || submitting) return
    setSubmitting(true)
    try {
      track(await signup(email, password, name || undefined))
      setPassword('')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'free_signups_full') setFull(error.message)
      else toast.error(error instanceof Error ? error.message : 'Signup failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (pending) {
    return (
      <VerifyEmail
        pending={pending}
        onResent={track}
        onRestart={() => {
          setEmail(pending.email)
          track(null)
        }}
      />
    )
  }

  return (
    <AuthLayout>
      <div className="mb-8 text-center">
        <AuthLogo />
        <h1 className="mb-2 text-2xl font-extrabold text-foreground">Create your account</h1>
        <p className="text-sm text-muted-foreground">
          Already have one?{' '}
          <Link to="/login" className="text-primary-accent hover:text-primary-ink">
            Log in
          </Link>
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-8">
        {full && (
          <div role="status" className="mb-6 rounded-md border border-warning-soft-border bg-warning-soft-weak px-4 py-3">
            <p className="text-sm text-warning-ink">{full}</p>
            <a href={`${LANDING_URL}/pricing`} className="mt-2 inline-block text-sm text-primary-accent hover:text-primary-ink">
              See plans
            </a>
          </div>
        )}
        <OAuthButtons />
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
            <PasswordInput
              id="password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="mt-1 rounded bg-primary py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs leading-relaxed text-subtle">
          By creating an account you agree to our{' '}
          <a href={`${LANDING_URL}/terms`} className="text-primary-accent hover:text-primary-ink">
            Terms
          </a>{' '}
          and{' '}
          <a href={`${LANDING_URL}/privacy`} className="text-primary-accent hover:text-primary-ink">
            Privacy Policy
          </a>.
        </p>
      </div>
    </AuthLayout>
  )
}

/**
 * Step two: the 6-digit code from the email. Deliberately typed here rather
 * than clicked from the email — the code completes only the sign-up this tab
 * started, so a sign-up someone else began with your address can never be
 * finished by you following their email.
 */
function VerifyEmail({
  pending,
  onResent,
  onRestart,
}: {
  pending: PendingSignup
  onResent: (next: PendingSignup) => void
  onRestart: () => void
}) {
  const verifySignup = useAuthStore((s) => s.verifySignup)
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== 6 || verifying) return
    setVerifying(true)
    try {
      await verifySignup(pending.verificationId, code)
      writePending(null)
      navigate('/', { replace: true })
    } catch (error) {
      setCode('')
      toast.error(error instanceof Error ? error.message : 'Verification failed')
      setVerifying(false)
    }
  }

  const resend = async () => {
    if (resending) return
    setResending(true)
    try {
      onResent(await api.resendSignupCode(pending.verificationId))
      setCode('')
      toast.success(`We sent a new code to ${pending.email}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send a new code')
      // The pending sign-up is gone (expired); there is nothing left to resend for.
      if (error instanceof ApiError && error.status === 404) onRestart()
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthLayout>
      <div className="mb-8 text-center">
        <AuthLogo />
        <h1 className="mb-2 text-2xl font-extrabold text-foreground">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to{' '}
          <span className="font-medium break-words text-foreground">{pending.email}</span>. Enter it
          below to finish creating your account.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-8">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className={authLabelClass}>
              Verification code
            </label>
            <CodeInput id="code" autoFocus value={code} onChange={setCode} />
          </div>
          <button
            type="submit"
            disabled={verifying || code.length !== 6}
            className="mt-1 rounded bg-primary py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {verifying ? 'Verifying…' : 'Verify email'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs leading-relaxed text-subtle">
          The code expires in {Math.round(pending.expiresIn / 60) || 15} minutes. Didn't get it?{' '}
          <button
            type="button"
            onClick={resend}
            disabled={resending}
            className="text-primary-accent hover:text-primary-ink disabled:opacity-60"
          >
            {resending ? 'Sending…' : 'Send a new code'}
          </button>{' '}
          or{' '}
          <button
            type="button"
            onClick={onRestart}
            className="text-primary-accent hover:text-primary-ink"
          >
            use a different email
          </button>
          .
        </p>
      </div>
    </AuthLayout>
  )
}
