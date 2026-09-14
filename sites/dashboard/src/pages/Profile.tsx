import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { TopBar } from '@/components/shell/TopBar'
import { useAuthStore } from '@/stores/auth'
import { CodeInput, PasswordInput } from './auth-shared'

/**
 * The profile page, at /account: who is signed in, and how they sign in.
 *
 * Built like the no-projects screen — the ordinary top bar, then a centred
 * heading over one column of cards — so it reads as part of the dashboard
 * rather than a detour out of it. Each thing an account can do is a card of its
 * own; the password is the first of them.
 */
export default function Profile() {
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background font-sans text-muted-foreground">
      <TopBar />
      {/* m-auto rather than justify-center: centred while it fits, and
          scrolling from the top — not clipped at it — once it does not. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        <div className="m-auto flex w-full max-w-3xl flex-col items-center gap-6">
          <div className="text-center">
            <h1 className="text-sm font-medium text-emphasis">Profile</h1>
            <p className="mt-1.5 font-mono text-xs text-subtle">Your account, and how you sign in.</p>
          </div>
          <div className="flex w-full flex-col gap-4">
            <AccountCard />
            <PasswordCard />
          </div>
        </div>
      </div>
    </div>
  )
}

const labelClass = 'font-mono text-[10px] font-semibold tracking-wide text-faint uppercase'
// The create-project form's field, so the two screens share one input.
const inputClass =
  'w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-heading placeholder-faint focus:border-primary focus:outline-none disabled:opacity-60'
const primaryClass =
  'flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors enabled:cursor-pointer enabled:hover:bg-primary-hover disabled:opacity-60'
const linkClass = 'font-mono text-[11px] text-primary-accent hover:text-primary-ink disabled:opacity-60'
const quietClass = 'font-mono text-[11px] text-muted-foreground hover:text-heading disabled:opacity-60'
const copyClass = 'font-mono text-xs leading-relaxed text-subtle'

function Card({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="w-full rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-medium text-emphasis">{title}</h2>
        <p className={`mt-1 ${copyClass}`}>{description}</p>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
    </div>
  )
}

function AccountCard() {
  const user = useAuthStore((s) => s.user)
  if (!user) return null
  const name = user.name?.trim()
  const rows: [string, string][] = [
    ['Name', name || '—'],
    ['Email', user.email],
    [
      'Plan',
      user.monthlyRequests
        ? `${user.planName} · ${user.monthlyRequests.toLocaleString()} requests a month`
        : user.planName,
    ],
  ]

  return (
    <Card title="Account" description="Who is signed in, and on which plan.">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background font-mono text-sm font-semibold text-heading uppercase select-none">
          {(name || user.email)[0]}
        </div>
        <dl className="grid min-w-0 flex-1 grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className={`${labelClass} pt-0.5`}>{label}</dt>
              <dd className="font-mono text-xs break-words text-heading">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  )
}

type Mode = 'current' | 'send' | 'code'

/**
 * Change the password, or set one.
 *
 * Changing needs the current password — a session alone must not be able to
 * lock the owner out. Forgotten it, or an account made by Google or GitHub with
 * no password at all, goes through the same emailed code as the login page's
 * "Forgot password?", which proves the mailbox instead. Either way this device
 * stays signed in and every other one is signed out, and the card returns to
 * its resting state rather than leaving the page.
 */
function PasswordCard() {
  const user = useAuthStore((s) => s.user)
  const refreshUser = useAuthStore((s) => s.refreshUser)
  const changePassword = useAuthStore((s) => s.changePassword)
  const resetPassword = useAuthStore((s) => s.resetPassword)
  const email = user?.email ?? ''
  // Absent on a session stored before the field existed; the refresh below settles it.
  const hasPassword = user?.hasPassword !== false

  const [chosen, setChosen] = useState<Mode>('current')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    refreshUser().catch(() => {})
  }, [refreshUser])

  // An account with no password has nothing to check a current password against.
  const mode: Mode = !hasPassword && chosen === 'current' ? 'send' : chosen

  const run = async (work: () => Promise<void>, onError?: (message: string) => void) => {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong'
      onError?.(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const startOver = () => {
    setCurrent('')
    setNext('')
    setCode('')
    setChosen('current')
  }

  const submitChange = (e: React.FormEvent) => {
    e.preventDefault()
    void run(
      async () => {
        await changePassword(current, next)
        toast.success('Password changed. Your other devices have been signed out.')
        startOver()
      },
      (message) => {
        if (message.includes('current password')) setCurrent('')
      },
    )
  }

  const sendCode = () =>
    run(async () => {
      await api.forgotPassword(email)
      setCode('')
      if (mode === 'code') toast.success(`A new code is on its way to ${email}`)
      setChosen('code')
    })

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault()
    void run(
      async () => {
        await resetPassword(email, code, next)
        toast.success(
          hasPassword
            ? 'Password reset. Your other devices have been signed out.'
            : 'Password set. You can now log in with your email and this password.',
        )
        startOver()
      },
      (message) => {
        if (message.includes('code')) setCode('')
      },
    )
  }

  // Lets a password manager tie the new password to this account.
  const usernameField = (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={email}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
    />
  )
  const address = <span className="break-words text-emphasis">{email}</span>

  return (
    <Card
      title="Password"
      description={
        hasPassword
          ? 'Change it with your current password. You stay signed in here; every other device is signed out.'
          : 'You signed up with Google or GitHub, so there is no password yet. Set one with a code sent to your email.'
      }
    >
      {mode === 'current' && (
        <form className="flex flex-col gap-4" onSubmit={submitChange}>
          {usernameField}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current password" htmlFor="current-password">
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={current}
                onChange={setCurrent}
                inputClassName={inputClass}
              />
            </Field>
            <Field label="New password" htmlFor="new-password">
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                value={next}
                onChange={setNext}
                inputClassName={inputClass}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" className={linkClass} onClick={() => setChosen('send')}>
              Forgot it? Use an email code instead
            </button>
            <button type="submit" className={primaryClass} disabled={busy || !current || !next}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      )}

      {mode === 'send' && (
        <div className="flex flex-col gap-4">
          <p className={copyClass}>
            We'll email a 6-digit code to {address}. Enter it with your new password.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {hasPassword ? (
              <button type="button" className={linkClass} onClick={() => setChosen('current')}>
                Use your current password instead
              </button>
            ) : (
              <span />
            )}
            <button type="button" className={primaryClass} disabled={busy || !email} onClick={sendCode}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        </div>
      )}

      {mode === 'code' && (
        <form className="flex flex-col gap-4" onSubmit={submitCode}>
          {usernameField}
          <p className={copyClass}>
            Enter the code we sent to {address} and your new password. It expires in 15 minutes.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" htmlFor="password-code">
              <CodeInput
                id="password-code"
                autoFocus
                value={code}
                onChange={setCode}
                inputClassName={inputClass}
              />
            </Field>
            <Field label="New password" htmlFor="code-new-password">
              <PasswordInput
                id="code-new-password"
                autoComplete="new-password"
                value={next}
                onChange={setNext}
                inputClassName={inputClass}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <button type="button" className={linkClass} disabled={busy} onClick={sendCode}>
                Send a new code
              </button>
              <button type="button" className={quietClass} disabled={busy} onClick={startOver}>
                Cancel
              </button>
            </div>
            <button type="submit" className={primaryClass} disabled={busy || code.length !== 6 || !next}>
              {busy ? 'Saving…' : hasPassword ? 'Reset password' : 'Set password'}
            </button>
          </div>
        </form>
      )}
    </Card>
  )
}
