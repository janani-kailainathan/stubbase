import type { ComponentType } from 'react'
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, UserRound } from 'lucide-react'
import { TopBar } from '@/components/shell/TopBar'
import { ProfileSection } from '@/components/settings/ProfileSection'

/**
 * The settings sections, one nav item each. Profile holds everything about the
 * account itself; a new section is a new entry here with a component of cards.
 */
const SECTIONS: {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  Section: ComponentType
}[] = [{ id: 'profile', label: 'Profile', icon: UserRound, Section: ProfileSection }]

/**
 * Account settings, at /settings/<section>.
 *
 * One section per URL, so a reload or a copied link lands on the same one.
 * Moving between sections replaces the history entry, so Back leaves settings
 * instead of replaying every section. An unknown section — including the old
 * /settings/password and friends — opens Profile.
 *
 * The back link returns to the project the account menu was opened from. That
 * rides in router state, which survives a reload; without it, `/` opens the
 * first project as it does after sign-in.
 */
export default function Settings() {
  const { section } = useParams<{ section: string }>()
  const location = useLocation()
  const current = SECTIONS.find((s) => s.id === section)
  if (!current) return <Navigate to="/settings/profile" replace state={location.state} />

  const from = (location.state as { from?: string } | null)?.from
  const fromProject = Boolean(from?.startsWith('/p/'))

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background font-sans text-muted-foreground">
      <TopBar />
      {/* The content column is the no-projects screen's width (max-w-3xl) and
          sits centred on the page exactly as that one does. The nav takes the
          free space to its left once there is room for it (xl); below that it
          stacks above the content, inside the same column, so the content is
          never narrowed to make room. The scrollbar gutter is reserved on both
          sides, so a page long enough to scroll keeps that same centre instead
          of shifting left by the scrollbar's width. */}
      <div className="min-h-0 flex-1 overflow-auto p-6 [scrollbar-gutter:stable_both-edges] md:py-10">
        <div className="mx-auto grid w-full max-w-3xl gap-8 xl:max-w-none xl:grid-cols-[minmax(0,1fr)_minmax(0,48rem)_minmax(0,1fr)] xl:gap-0">
          <nav
            aria-label="Settings"
            className="flex flex-col gap-4 xl:sticky xl:top-0 xl:w-44 xl:justify-self-end xl:self-start xl:pr-10 xl:box-content"
          >
            <Link
              to={fromProject ? from! : '/'}
              className="flex w-fit items-center gap-1.5 text-sm text-subtle transition-colors hover:text-heading"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {fromProject ? 'Back to project' : 'Back to dashboard'}
            </Link>
            <p className="text-xs font-medium tracking-wide text-faint uppercase">Settings</p>
            {/* Wrapping rows while it sits above the content, and a column once
                it has the side to itself. */}
            <ul className="-mt-2 flex flex-wrap gap-1 xl:flex-col">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <NavLink
                    to={`/settings/${id}`}
                    replace
                    state={location.state}
                    className={({ isActive }) =>
                      // The dashboard's selected style (the top bar's mode toggle): a tint, no border.
                      `flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                        isActive ? 'bg-primary-soft font-medium text-primary-ink' : 'text-subtle hover:text-heading'
                      }`
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <main className="flex min-w-0 flex-col gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-heading">{current.label}</h1>
            <current.Section />
          </main>
        </div>
      </div>
    </div>
  )
}
