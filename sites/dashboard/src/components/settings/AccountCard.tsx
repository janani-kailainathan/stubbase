import type { ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useAccountSummary } from '@/hooks/account'
import { useProjects } from '@/hooks/projects'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore, type Theme } from '@/stores/theme'
import { Card } from './shared'

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** A pack's `expiresOn` is a UTC calendar date; formatted in UTC so it cannot slip a day. */
const utcDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** `resetsOn` is a UTC calendar date; formatted in UTC so it cannot slip a day. */
const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

function Stat({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-subtle" title={hint}>
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-heading tabular-nums">{children}</dd>
    </div>
  )
}

/**
 * The account at a glance, kept compact: who it is and on which plan, how much
 * of the monthly allowance is used, the rate limit and request packs it runs under,
 * and the theme. Everything but the theme is
 * read-only here — shown first because it is what someone opening their profile
 * usually wants — and the theme sits in the footer as the card's one control.
 *
 * Email and plan come from the signed-in user and show at once; usage and the
 * dates come from /auth/account and show a dash until it answers.
 */
export function AccountCard() {
  const user = useAuthStore((s) => s.user)
  const { data: account } = useAccountSummary()
  const { data: projects } = useProjects()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  if (!user) return null

  const limit = account?.monthlyRequests ?? user.monthlyRequests
  const used = account?.requestsUsed
  const share = used !== undefined && limit > 0 ? Math.min(1, used / limit) : 0
  const meter = share >= 1 ? 'bg-danger-fill' : share >= 0.8 ? 'bg-warning-fill' : 'bg-primary'
  const rps = account?.requestsPerSecond ?? user.requestsPerSecond
  const burst = account?.burst ?? user.burst
  const fromPacks = account?.packRequests ?? 0

  return (
    <Card
      title="Account"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-heading">Theme</p>
            <p className="text-xs text-subtle">In this browser, and on the Stubbase website.</p>
          </div>
          {/* Real radios, so arrow keys move between the two. */}
          <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border border-border p-0.5">
            {THEMES.map(({ id, label, icon: Icon }) => {
              const selected = theme === id
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
                    selected ? 'bg-primary-soft font-medium text-primary-ink' : 'text-subtle hover:text-heading'
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={id}
                    checked={selected}
                    onChange={() => setTheme(id)}
                    className="sr-only"
                  />
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </label>
              )
            })}
          </div>
        </div>
      }
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-sm font-semibold text-heading uppercase select-none">
          {(user.name?.trim() || user.email)[0]}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-heading">{user.email}</p>
          <p className="truncate text-xs text-subtle">
            {account ? `Member since ${longDate(account.memberSince)}` : ' '}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary-ink">
          {account?.planName ?? user.planName}
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat
          wide
          label="Requests this month"
          hint={
            account && fromPacks > 0
              ? `Counted across all your projects, deleted ones included. Your plan's ${account.planMonthlyRequests.toLocaleString()} plus ${fromPacks.toLocaleString()} left in request packs.`
              : 'Counted across all your projects, deleted ones included'
          }
        >
          <span className="flex items-center gap-3">
            <span className="whitespace-nowrap">
              {used === undefined ? '—' : used.toLocaleString()}{' '}
              <span className="font-normal text-subtle">/ {limit.toLocaleString()}</span>
            </span>
            <span
              className="block h-1.5 min-w-12 flex-1 overflow-hidden rounded-full border border-border"
              role="meter"
              aria-label="Requests used this month"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={used ?? 0}
            >
              <span className={`block h-full ${meter}`} style={{ width: `${share * 100}%` }} />
            </span>
          </span>
        </Stat>
        <Stat label="Resets on">{account ? shortDate(account.resetsOn) : '—'}</Stat>
        <Stat label="Projects">{projects ? projects.length.toLocaleString() : '—'}</Stat>
        <Stat
          label="Rate limit"
          hint="Requests per second, shared by all your projects. The burst is how many may arrive at once."
        >
          {rps === undefined || burst === undefined ? (
            '—'
          ) : (
            <span className="whitespace-nowrap">
              {rps.toLocaleString()}/s <span className="font-normal text-subtle">· burst {burst.toLocaleString()}</span>
            </span>
          )}
        </Stat>
        <Stat
          wide
          label="Request packs"
          hint="Used once your plan's monthly requests run out. What is left carries over until the pack expires."
        >
          {!account ? (
            '—'
          ) : account.requestPacks.length === 0 ? (
            <span className="font-normal text-subtle">None</span>
          ) : (
            <span className="flex flex-col gap-1">
              {account.requestPacks.map((p) => (
                <span key={`${p.name}-${p.expiresOn}-${p.remaining}`} className="whitespace-nowrap">
                  {p.remaining.toLocaleString()}{' '}
                  <span className="font-normal text-subtle">
                    of {p.requests.toLocaleString()} left · expires {utcDate(p.expiresOn)}
                  </span>
                </span>
              ))}
              {/* Held but idle: a pack bought on Pro, on an account that has since left it. */}
              {account.packRequests === 0 && (
                <span className="text-xs font-normal text-subtle">Request packs are used on Pro only.</span>
              )}
            </span>
          )}
        </Stat>
        <Stat
          wide
          label="AI credits"
          hint="Spent by the AI Co-Pilot, soonest-expiring first. A reply costs one credit per 1,000 tokens it used."
        >
          {!account ? (
            '—'
          ) : account.aiCredits.grants.length === 0 ? (
            <span className="font-normal text-subtle">None left</span>
          ) : (
            <span className="flex flex-col gap-1">
              {account.aiCredits.grants.map((g) => (
                <span key={`${g.name}-${g.expiresAt}`} className="whitespace-nowrap">
                  {g.remaining.toLocaleString()}{' '}
                  <span className="font-normal text-subtle">
                    of {g.credits.toLocaleString()} · {g.name} · expires {utcDate(g.expiresAt.slice(0, 10))}
                  </span>
                </span>
              ))}
            </span>
          )}
        </Stat>
      </dl>
    </Card>
  )
}
