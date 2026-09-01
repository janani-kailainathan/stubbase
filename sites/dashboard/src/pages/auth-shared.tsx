import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/lib/api'
import { LANDING_URL, type OauthProvider } from '@/lib/api'
import { ThemeToggle } from '@/components/shell/ThemeToggle'

export const authInputClass =
  'rounded-md border border-border bg-code-bg px-4 py-2.5 text-sm text-foreground placeholder-subtle focus:border-primary focus:outline-none'

export const authLabelClass = 'text-xs font-semibold tracking-wide text-subtle uppercase'

/**
 * The auth screens carry their own theme toggle. They render before there is a
 * session, so the app shell's TopBar — the only other place the control lives —
 * is not on screen yet, and a visitor arriving here from a light-themed landing
 * page would otherwise have no way to change their mind until after logging in.
 *
 * The theme itself is already correct on arrival: it rides the cross-origin
 * cookie (lib/cross-site.ts) and is stamped before the bundle loads, so these
 * pages never flash the other theme on the way over from stubbase.dev.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-6 py-16 font-sans">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}

export function AuthLogo() {
  return (
    <a href={LANDING_URL} className="mb-6 inline-flex items-center">
      <img src="/stubbase-logo-text-light.svg" alt="Stubbase" className="h-8 dark:hidden" />
      <img src="/stubbase-logo-text-dark.svg" alt="Stubbase" className="hidden h-8 dark:block" />
    </a>
  )
}

// ── OAuth sign-in ─────────────────────────────────────────────────

/**
 * Brand marks, inlined. Lucide dropped its brand icons, and a sign-in button
 * without the provider's own mark is one people hesitate over.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  )
}

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-4 shrink-0" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

const MARKS: Record<OauthProvider, { label: string; mark: ReactNode }> = {
  google: { label: 'Continue with Google', mark: <GoogleMark /> },
  github: { label: 'Continue with GitHub', mark: <GithubMark /> },
}

/**
 * The provider buttons, above the email form on both auth pages.
 *
 * Rendered from what the backend says it has credentials for, so a deployment
 * without OAuth keys shows no dead buttons — and an anchor rather than a
 * button, because starting the flow is a top-level navigation.
 */
export function OAuthButtons() {
  const { data } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: api.authProviders,
    staleTime: Infinity,
    retry: false,
  })
  const enabled = (['google', 'github'] as OauthProvider[]).filter((p) => data?.[p])
  if (enabled.length === 0) return null

  return (
    <>
      <div className="flex flex-col gap-3">
        {enabled.map((provider) => (
          <a
            key={provider}
            href={api.oauthStartUrl(provider)}
            className="flex items-center justify-center gap-2.5 rounded-md border border-border bg-panel py-2.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong hover:bg-card"
          >
            {MARKS[provider].mark}
            {MARKS[provider].label}
          </a>
        ))}
      </div>
      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] font-medium tracking-wide text-faint uppercase">
          or with email
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  )
}
