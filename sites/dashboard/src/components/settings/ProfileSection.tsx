import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth'
import { AccountCard } from './AccountCard'
import { DeleteAccountCard } from './DeleteAccountCard'
import { PasswordCard } from './PasswordCard'
import { Card, Field, inputClass, primaryClass } from './shared'

/**
 * The Profile section: everything about the account itself, one card each.
 * The account at a glance comes first (with the theme), then what can be
 * changed, and deleting sits last, well away from the everyday cards.
 */
export function ProfileSection() {
  return (
    <>
      <AccountCard />
      <NameCard />
      <PasswordCard />
      <DeleteAccountCard />
    </>
  )
}

function NameCard() {
  const user = useAuthStore((s) => s.user)
  const updateName = useAuthStore((s) => s.updateName)
  const [name, setName] = useState(user?.name ?? '')
  const [busy, setBusy] = useState(false)
  if (!user) return null

  const trimmed = name.trim()
  const changed = trimmed !== (user.name ?? '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!changed || busy) return
    setBusy(true)
    try {
      await updateName(trimmed)
      setName(trimmed)
      toast.success(trimmed ? 'Name saved' : 'Name removed')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Your name"
      description="How you appear in the dashboard. Leave it empty to go by your email address."
      onSubmit={submit}
      footer={
        <button type="submit" className={primaryClass} disabled={busy || !changed}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
      }
    >
      <Field label="Display name" htmlFor="account-name">
        <input
          id="account-name"
          type="text"
          autoComplete="name"
          maxLength={100}
          placeholder={user.email.split('@')[0]}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
      </Field>
    </Card>
  )
}
