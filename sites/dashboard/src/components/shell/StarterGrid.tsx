import {
  Blocks,
  CalendarCheck,
  ClipboardList,
  FilePlus2,
  Flag,
  GraduationCap,
  KeyRound,
  Link2,
  MessagesSquare,
  Newspaper,
  Radio,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useHasFeature } from '@/hooks/plan'
import {
  countRecords,
  PLANNED_STARTERS,
  STARTERS,
  type PlannedStarter,
  type Starter,
} from '@/lib/starters'

/**
 * The starter cards, rendered once for both screens that offer them: the
 * account-level empty state (no projects at all) and a project's own empty
 * state (no resources yet).
 *
 * Presentation only — the starter data itself lives in lib/starters.ts, and
 * every starter in it is offered on both screens. That is the point of this
 * file: adding or removing a starter there changes both places, and the card
 * itself has one definition rather than two that drift.
 *
 * Nine cards, of which three are real and six are placeholders for examples not
 * written yet (PLANNED_STARTERS). Showing the planned ones greyed out is a
 * deliberate choice over hiding them: the grid reads as a set someone is filling
 * in rather than as three options and a shrug, and the layout stops moving every
 * time one lands. They are `disabled` buttons, not divs, so keyboard focus and
 * the disabled cursor behave without any extra handling.
 *
 * The two screens differ in exactly one way, which is what `onBlank` selects:
 * with no projects yet there is also a "start blank" card, since naming an
 * empty project is a real way in. Inside a project that rung is already taken.
 * It spans the full row rather than taking a cell, so the nine examples keep a
 * clean 3×3 and a card is the same width on both screens.
 */
const ICONS: Record<string, LucideIcon> = {
  tracker: ClipboardList,
  blog: Newspaper,
  storefront: ShoppingCart,
  chat: MessagesSquare,
  crm: Users,
  telemetry: Radio,
  bookings: CalendarCheck,
  courses: GraduationCap,
  flags: Flag,
}

const FEATURES: Record<Starter['features'][number], { Icon: LucideIcon; label: string }> = {
  relations: { Icon: Link2, label: 'relations' },
  auth: { Icon: KeyRound, label: 'auth' },
}

const cardBase = 'flex flex-col gap-2 rounded-md border p-3 text-left transition-colors'

const cardClass = `${cardBase} cursor-pointer border-border bg-panel hover:border-primary-soft-border-strong hover:bg-card disabled:cursor-not-allowed disabled:opacity-60`

// Placeholders read as unavailable rather than merely disabled: a dashed edge
// says "nothing here yet" the way a dimmed solid card cannot, since the real
// cards go dim too while a starter is being provisioned.
const plannedClass = `${cardBase} cursor-not-allowed border-dashed border-border bg-transparent opacity-70`

const titleClass = 'truncate text-xs font-medium text-heading'
const iconClass = 'h-3.5 w-3.5 shrink-0 text-primary-accent'
const blurbClass = 'font-mono text-[10px] text-subtle'
const footClass = 'mt-auto pt-1 font-mono text-[10px] text-faintest'

function FeatureBadges({ features, muted }: { features: Starter['features']; muted?: boolean }) {
  if (features.length === 0) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {features.map((feature) => {
        const { Icon, label } = FEATURES[feature]
        return (
          <span
            key={feature}
            className={
              muted
                ? 'flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-faint'
                : 'flex items-center gap-1 rounded border border-primary/20 bg-primary-soft-weak px-1.5 py-0.5 font-mono text-[10px] text-primary-accent/90'
            }
          >
            <Icon className="h-2.5 w-2.5" />
            {label}
          </span>
        )
      })}
    </span>
  )
}

export function StarterGrid({
  busy,
  onPick,
  onBlank,
}: {
  busy: boolean
  onPick: (starter: Starter) => void
  /** Renders the leading "Empty project" card when given. */
  onBlank?: () => void
}) {
  // A starter that advertises `auth` stages AUTH_ENABLED into the tenant's
  // config, which the files proxy refuses off-plan. Disabling the card is not
  // decoration: without it the resources would land, the config write would
  // 402, and the user would be left with a half-applied example.
  const mayUseAuth = useHasFeature('auth')
  const offPlan = (starter: Starter) => starter.features.includes('auth') && !mayUseAuth

  return (
    <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {onBlank && (
        <button
          onClick={onBlank}
          disabled={busy}
          className={`${cardClass} sm:col-span-2 lg:col-span-3 flex-row items-center gap-3`}
        >
          <FilePlus2 className={iconClass} />
          <span className={titleClass}>Empty project</span>
          <span className={blurbClass}>Name it and add resources yourself.</span>
          <span className="ml-auto font-mono text-[10px] text-faintest">no resources</span>
        </button>
      )}

      {STARTERS.map((starter) => {
        const Icon = ICONS[starter.id] ?? Blocks
        const locked = offPlan(starter)
        return (
          <button
            key={starter.id}
            onClick={() => onPick(starter)}
            disabled={busy || locked}
            title={locked ? 'This example turns on AuthGuard — available on Pro QA' : undefined}
            className={cardClass}
          >
            <span className="flex items-center gap-2">
              <Icon className={iconClass} />
              <span className={titleClass}>{starter.title}</span>
            </span>
            <span className={blurbClass}>{starter.blurb}</span>
            <span className="font-mono text-[10px] break-words text-muted-foreground">
              {Object.keys(starter.resources).join(' · ')}
            </span>
            <FeatureBadges features={starter.features} muted={locked} />
            <span className={footClass}>
              {locked
                ? 'needs Pro QA'
                : `${resourceCount(Object.keys(starter.resources).length)} · ${countRecords(starter)} records`}
            </span>
          </button>
        )
      })}

      {PLANNED_STARTERS.map((planned: PlannedStarter) => {
        const Icon = ICONS[planned.id] ?? Blocks
        return (
          <button key={planned.id} disabled aria-disabled className={plannedClass}>
            <span className="flex items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0 text-faint" />
              <span className="truncate text-xs font-medium text-muted-foreground">
                {planned.title}
              </span>
            </span>
            <span className="font-mono text-[10px] text-faint">{planned.blurb}</span>
            <span className="font-mono text-[10px] break-words text-faint">
              {planned.resources.join(' · ')}
            </span>
            <FeatureBadges features={planned.features} muted />
            <span className={footClass}>
              {resourceCount(planned.resources.length)} · coming soon
            </span>
          </button>
        )
      })}
    </div>
  )
}

const resourceCount = (n: number) => `${n} resource${n === 1 ? '' : 's'}`
