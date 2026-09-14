import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/api'
import { CodeInput, PasswordInput } from '@/pages/auth-shared'
import { useAuthStore } from '@/stores/auth'
import { Card, copyClass, Field, inputClass, linkClass, primaryClass, quietClass, UsernameField } from './shared'

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
 *
 * `id="password"` is what the Delete account card scrolls to when the account
 * has no password to delete with.
 */
export function PasswordCard() {
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

  const address = <span className="break-words text-heading">{email}</span>
  const description = hasPassword
    ? 'Change it with your current password. You stay signed in here; every other device is signed out.'
    : 'You signed up with Google or GitHub, so there is no password yet. Set one with a code sent to your email.'

  if (mode === 'send')
    return (
      <Card
        id="password"
        title="Password"
        description={description}
        footer={
          <>
            <button type="button" className={primaryClass} disabled={busy || !email} onClick={sendCode}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
            {hasPassword && (
              <button type="button" className={linkClass} onClick={() => setChosen('current')}>
                Use your current password instead
              </button>
            )}
          </>
        }
      >
        <p className={copyClass}>
          We'll email a 6-digit code to {address}. Enter it with your new password.
        </p>
      </Card>
    )

  if (mode === 'code')
    return (
      <Card
        id="password"
        title="Password"
        description={description}
        onSubmit={submitCode}
        footer={
          <>
            <button type="submit" className={primaryClass} disabled={busy || code.length !== 6 || !next}>
              {busy ? 'Saving…' : hasPassword ? 'Reset password' : 'Set password'}
            </button>
            <button type="button" className={linkClass} disabled={busy} onClick={sendCode}>
              Send a new code
            </button>
            <button type="button" className={quietClass} disabled={busy} onClick={startOver}>
              Cancel
            </button>
          </>
        }
      >
        <UsernameField email={email} />
        <p className={copyClass}>
          Enter the code we sent to {address} and your new password. It expires in 15 minutes.
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <Field label="Code" htmlFor="password-code">
            <CodeInput id="password-code" autoFocus value={code} onChange={setCode} inputClassName={inputClass} />
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
      </Card>
    )

  return (
    <Card
      id="password"
      title="Password"
      description={description}
      onSubmit={submitChange}
      footer={
        <>
          <button type="submit" className={primaryClass} disabled={busy || !current || !next}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
          <button type="button" className={linkClass} onClick={() => setChosen('send')}>
            Forgot it? Use an email code instead
          </button>
        </>
      }
    >
      <UsernameField email={email} />
      <div className="flex flex-col gap-4">
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
    </Card>
  )
}
