import type { ReactNode } from 'react'
import { LANDING_URL } from '@/lib/api'

export const authInputClass =
  'rounded-md border border-border bg-code-bg px-4 py-2.5 text-sm text-foreground placeholder-subtle focus:border-primary focus:outline-none'

export const authLabelClass = 'text-xs font-semibold tracking-wide text-subtle uppercase'

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-16 font-sans">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}

export function AuthLogo() {
  return (
    <a href={LANDING_URL} className="mb-6 inline-flex items-center">
      <img src="/stubbase-logo-text.png" alt="Stubbase" className="h-8" />
    </a>
  )
}
