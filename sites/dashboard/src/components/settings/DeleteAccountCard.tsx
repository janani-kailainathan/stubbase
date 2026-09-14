import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { LANDING_URL } from '@/lib/api'
import { useProjects, type Project } from '@/hooks/projects'
import { DeleteProjectDialog } from '@/components/shell/TopBar'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { PasswordInput } from '@/pages/auth-shared'
import { useAuthStore } from '@/stores/auth'
import {
  Card,
  copyClass,
  dangerClass,
  Field,
  inputClass,
  linkClass,
  Row,
  secondaryClass,
  smallDangerClass,
  UsernameField,
} from './shared'

/** Brings the Password card into view with its first control focused. */
function goToPasswordCard() {
  const card = document.getElementById('password')
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  card
    ?.querySelector<HTMLElement>('input:not([tabindex="-1"]), button')
    ?.focus({ preventScroll: true })
}

/**
 * Deleting the account, and what has to happen first.
 *
 * The server refuses while the account owns a project or has no password, and
 * this says so up front rather than letting the dialog fail: each project is
 * listed with its own Delete — the top bar's dialog, with its stop-it-first
 * guard — and an account made by Google or GitHub is sent to the Password card.
 * The button stays visible but disabled until both are done.
 */
export function DeleteAccountCard() {
  const user = useAuthStore((s) => s.user)
  const refreshUser = useAuthStore((s) => s.refreshUser)
  const { data: projects, isLoading } = useProjects()
  const [target, setTarget] = useState<Project | null>(null)
  const [confirming, setConfirming] = useState(false)

  // hasPassword may be missing from a stored session that predates it.
  useEffect(() => {
    refreshUser().catch(() => {})
  }, [refreshUser])

  const hasPassword = user?.hasPassword !== false
  const count = projects?.length ?? 0
  const ready = !isLoading && count === 0 && hasPassword

  return (
    <Card
      title="Delete account"
      tone="danger"
      description="Deletes your Stubbase account and signs you out on every device. It cannot be undone."
      footer={
        <button type="button" className={dangerClass} disabled={!ready} onClick={() => setConfirming(true)}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete account
        </button>
      }
    >
      {!ready && (
        <div className="flex flex-col gap-4">
          {isLoading && <p className={copyClass}>Checking your projects…</p>}

          {count > 0 && (
            <div>
              <p className={copyClass}>
                First delete {count === 1 ? 'the project' : `the ${count} projects`} you own. Each takes its
                data and settings with it, and a running API has to be stopped before it can go.
              </p>
              <div className="mt-2 divide-y divide-border">
                {projects!.map((p) => (
                  <Row
                    key={p.tenantId}
                    leading={
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${p.color} text-sm font-semibold text-primary-foreground`}
                      >
                        {p.name[0]?.toUpperCase()}
                      </div>
                    }
                    title={p.name}
                    detail={<span className="font-mono">/{p.tenantId}</span>}
                    action={
                      <button type="button" className={smallDangerClass} onClick={() => setTarget(p)}>
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    }
                  />
                ))}
              </div>
            </div>
          )}

          {!hasPassword && (
            <p className={copyClass}>
              Deleting asks for your password, and this account has none yet — you signed up with Google or
              GitHub.{' '}
              <button type="button" className={linkClass} onClick={goToPasswordCard}>
                Set a password
              </button>{' '}
              first.
            </p>
          )}
        </div>
      )}

      {target && (
        <DeleteProjectDialog
          key={target.tenantId}
          tenantId={target.tenantId}
          name={target.name}
          resourceCount={target.resources.length}
          open
          onOpenChange={(open) => !open && setTarget(null)}
        />
      )}
      <DeleteAccountDialog open={confirming} onOpenChange={setConfirming} email={user?.email ?? ''} />
    </Card>
  )
}

/**
 * The last step: the password, then the account is gone. Asking for it inside
 * the dialog keeps the one irreversible action two deliberate steps away, and
 * it is what the server checks — a session alone cannot delete an account.
 */
function DeleteAccountDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  email: string
}) {
  const deleteAccount = useAuthStore((s) => s.deleteAccount)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const setOpen = (next: boolean) => {
    if (busy) return
    if (!next) setPassword('')
    onOpenChange(next)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !password) return
    setBusy(true)
    try {
      await deleteAccount(password)
      // Out to the marketing site, as signing out does. The store has already
      // cleared the hint cookie, so that page renders signed out.
      window.location.href = LANDING_URL
    } catch (error) {
      setPassword('')
      setBusy(false)
      toast.error(error instanceof Error ? error.message : 'Something went wrong')
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[26rem] rounded-xl border-border bg-card p-6" showCloseButton={false}>
        <DialogTitle className="text-base font-semibold text-heading">Delete your account?</DialogTitle>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogDescription className={copyClass}>
            This deletes the account for <span className="break-words text-heading">{email}</span> and signs
            you out on every device. It cannot be undone. You can sign up with the same address again later,
            as a new account.
          </DialogDescription>
          <UsernameField email={email} />
          <Field label="Password" htmlFor="delete-account-password">
            <PasswordInput
              id="delete-account-password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={setPassword}
              inputClassName={inputClass}
            />
          </Field>
          <div className="flex items-center justify-end gap-3">
            <button type="button" className={secondaryClass} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className={dangerClass} disabled={busy || !password}>
              <Trash2 className="h-3.5 w-3.5" />
              {busy ? 'Deleting…' : 'Delete account'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
