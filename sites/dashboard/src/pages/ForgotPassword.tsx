import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import * as api from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import {
  AuthLayout,
  AuthLogo,
  CodeInput,
  PasswordInput,
  authInputClass,
  authLabelClass,
} from './auth-shared'

/**
 * The reset email links here as `/forgot-password#email=…&code=…`.
 *
 * The fragment is read once and stripped from the URL straight away, so the
 * code does not sit in history, the back button or a bookmark. It is stashed at
 * module scope because StrictMode runs state initializers twice and the second
 * run would find the hash already gone; the page drops the stash once mounted,
 * so a later visit starts clean.
 */
let linkStash: { email: string; code: string } | null = null

function consumeLink(): { email: string; code: string } | null {
  if (window.location.hash) {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const email = params.get('email')
    const code = params.get('code')
    if (email && code && /^\d{6}$/.test(code)) linkStash = { email, code }
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
  return linkStash
}

/**
 * The address this tab is resetting, so a reload — or a phone that drops the
 * tab while you fetch the code — comes back to the code step. Not a secret.
 */
const STEP_KEY = 'stubbase-password-reset'

function readStep(): string | null {
  try {
    return sessionStorage.getItem(STEP_KEY)
  } catch {
    return null
  }
}

function writeStep(email: string | null) {
  try {
    if (email) sessionStorage.setItem(STEP_KEY, email)
    else sessionStorage.removeItem(STEP_KEY)
  } catch {
    // Storage blocked: the code step still works, it just won't survive a reload.
  }
}

export default function ForgotPassword() {
  const user = useAuthStore((s) => s.user)
  const location = useLocation()
  const [link] = useState(consumeLink)
  const [email, setEmail] = useState(
    () => link?.email ?? (location.state as { email?: string } | null)?.email ?? '',
  )
  const [sentTo, setSentTo] = useState<string | null>(() => link?.email ?? readStep())
  const [sending, setSending] = useState(false)

  useEffect(() => {
    linkStash = null
    if (link) writeStep(link.email)
  }, [link])

  if (user) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const address = email.trim()
    if (!address || sending) return
    setSending(true)
    try {
      await api.forgotPassword(address)
      writeStep(address)
      setSentTo(address)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send a reset code')
    } finally {
      setSending(false)
    }
  }

  if (sentTo) {
    return (
      <ResetStep
        email={sentTo}
        initialCode={link?.email === sentTo ? link.code : ''}
        onRestart={() => {
          setEmail(sentTo)
          writeStep(null)
          setSentTo(null)
        }}
      />
    )
  }

  return (
    <AuthLayout>
      <div className="mb-8 text-center">
        <AuthLogo />
        <h1 className="mb-2 text-2xl font-extrabold text-foreground">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          Enter the email you use for Stubbase and we'll send you a code.{' '}
          <Link to="/login" className="text-primary-accent hover:text-primary-ink">
            Back to log in
          </Link>
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-8">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className={authLabelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={authInputClass}
            />
          </div>
          <button
            type="submit"
            disabled={sending}
            className="mt-1 rounded bg-primary py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {sending ? 'Sending…' : 'Send reset code'}
          </button>
        </form>
      </div>
    </AuthLayout>
  )
}

/**
 * Step two: the code and the new password on one form. The page says the same
 * thing for every address, as the API does — it cannot know whether a code was
 * actually sent, and should not pretend to.
 */
function ResetStep({
  email,
  initialCode,
  onRestart,
}: {
  email: string
  initialCode: string
  onRestart: () => void
}) {
  const resetPassword = useAuthStore((s) => s.resetPassword)
  const navigate = useNavigate()
  const [code, setCode] = useState(initialCode)
  const [password, setPassword] = useState('')
  const [resetting, setResetting] = useState(false)
  const [resending, setResending] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length !== 6 || !password || resetting) return
    setResetting(true)
    try {
      await resetPassword(email, code, password)
      writeStep(null)
      toast.success('Your password has been reset')
      navigate('/', { replace: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reset your password'
      // A wrong code is worth retyping; a refused password is no reason to lose the code.
      if (message.includes('code')) setCode('')
      toast.error(message)
      setResetting(false)
    }
  }

  const resend = async () => {
    if (resending) return
    setResending(true)
    try {
      await api.forgotPassword(email)
      setCode('')
      toast.success(`If ${email} has an account, a new code is on its way`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send a new code')
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
          If <span className="font-medium break-words text-foreground">{email}</span> has a Stubbase
          account, we sent it a 6-digit code. Enter it with your new password.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-8">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className={authLabelClass}>
              Reset code
            </label>
            <CodeInput id="code" autoFocus={!initialCode} value={code} onChange={setCode} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-password" className={authLabelClass}>
              New password
            </label>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              autoFocus={Boolean(initialCode)}
              value={password}
              onChange={setPassword}
            />
          </div>
          <button
            type="submit"
            disabled={resetting || code.length !== 6 || !password}
            className="mt-1 rounded bg-primary py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {resetting ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs leading-relaxed text-subtle">
          The code expires in 15 minutes. Didn't get it?{' '}
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
