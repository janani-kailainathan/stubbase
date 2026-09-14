import {
  Blocks,
  Check,
  ChefHat,
  ClipboardList,
  FilePlus2,
  Fingerprint,
  Flag,
  KeyRound,
  LifeBuoy,
  Link2,
  LogIn,
  MessagesSquare,
  Newspaper,
  ShieldCheck,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  countRecords,
  PLANNED_STARTERS,
  STARTERS,
  type PlannedStarter,
  type Starter,
} from '@/lib/starters'

/**
 * The starter cards, rendered once for every place that offers them: the New
 * project form (the project menu's dialog, and the screen shown with no
 * projects at all) and a project's own empty state (no resources yet).
 *
 * Presentation only — the starter data itself lives in lib/starters.ts, and
 * every starter in it is offered on both screens. That is the point of this
 * file: adding or removing a starter there changes both places, and the card
 * itself has one definition rather than two that drift.
 *
 * Nine cards: the real starters, then as many placeholders for examples not
 * written yet (PLANNED_STARTERS) as still fit. Showing the planned ones greyed out is a
 * deliberate choice over hiding them: the grid reads as a set someone is filling
 * in rather than as three options and a shrug, and the layout stops moving every
 * time one lands. They are `disabled` buttons, not divs, so keyboard focus and
 * the disabled cursor behave without any extra handling.
 *
 * The two uses differ in exactly one way, which is what `onBlank` selects:
 * creating a project also offers an "Empty project" card, since naming an
 * empty project is a real way in. Inside a project that rung is already taken.
 * It is one more card, first in the grid and shaped like the starters, so
 * starting empty reads as one of the choices rather than a separate path —
 * and it takes the last placeholder's cell, so both screens stay at nine.
 */
const ICONS: Record<string, LucideIcon> = {
  tracker: ClipboardList,
  signin: LogIn,
  blog: Newspaper,
  storefront: ShoppingCart,
  recipes: ChefHat,
  helpdesk: LifeBuoy,
  accounts: Fingerprint,
  chat: MessagesSquare,
  crm: Users,
  flags: Flag,
}

const FEATURES: Record<Starter['features'][number], { Icon: LucideIcon; label: string }> = {
  relations: { Icon: Link2, label: 'relations' },
  auth: { Icon: KeyRound, label: 'auth' },
  rbac: { Icon: ShieldCheck, label: 'roles' },
}

/** A full 3×3: the grid is filled out to this many cards and no further. */
const GRID_CARDS = 9

const cardBase = 'flex flex-col gap-2 rounded-md border p-3 text-left transition-colors'

const cardClass = `${cardBase} cursor-pointer border-border bg-panel hover:border-primary-soft-border-strong hover:bg-card disabled:cursor-not-allowed disabled:opacity-60`

// Selected is the tint and a check, never a green border — the same rule as a
// selected file, route or tab. The border stays so the card keeps its box.
const selectedCardClass = `${cardBase} cursor-pointer border-border bg-primary-soft disabled:cursor-not-allowed disabled:opacity-60`

const checkClass = 'ml-auto h-3.5 w-3.5 shrink-0 text-primary-accent'

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
  selectedId,
}: {
  busy: boolean
  onPick: (starter: Starter) => void
  /** Renders the leading "Empty project" card when given. */
  onBlank?: () => void
  /**
   * Makes the cards a choice rather than an action: the named card is shown
   * selected, and every card reports aria-pressed. Leave it out where a click
   * acts straight away.
   */
  selectedId?: Starter['id'] | 'blank'
}) {
  const choosing = selectedId !== undefined
  // Placeholders only fill the grid out to nine, so where Empty project takes
  // a cell the last one gives it up.
  const planned = PLANNED_STARTERS.slice(
    0,
    Math.max(0, GRID_CARDS - STARTERS.length - (onBlank ? 1 : 0)),
  )
  return (
    <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {onBlank && (
        <button
          // type="button" throughout: these can sit inside a <form>, where a
          // bare button would submit it.
          type="button"
          onClick={onBlank}
          disabled={busy}
          aria-pressed={choosing ? selectedId === 'blank' : undefined}
          className={selectedId === 'blank' ? selectedCardClass : cardClass}
        >
          <span className="flex items-center gap-2">
            <FilePlus2 className={iconClass} />
            <span className={titleClass}>Empty project</span>
            {selectedId === 'blank' && <Check className={checkClass} />}
          </span>
          <span className={blurbClass}>Name it and add resources yourself.</span>
          <span className={footClass}>no resources</span>
        </button>
      )}

      {STARTERS.map((starter) => {
        const Icon = ICONS[starter.id] ?? Blocks
        const selected = selectedId === starter.id
        return (
          <button
            type="button"
            key={starter.id}
            onClick={() => onPick(starter)}
            disabled={busy}
            aria-pressed={choosing ? selected : undefined}
            className={selected ? selectedCardClass : cardClass}
          >
            <span className="flex items-center gap-2">
              <Icon className={iconClass} />
              <span className={titleClass}>{starter.title}</span>
              {selected && <Check className={checkClass} />}
            </span>
            <span className={blurbClass}>{starter.blurb}</span>
            <span className="font-mono text-[10px] break-words text-muted-foreground">
              {Object.keys(starter.resources).join(' · ')}
            </span>
            <FeatureBadges features={starter.features} />
            <span className={footClass}>
              {`${resourceCount(Object.keys(starter.resources).length)} · ${countRecords(starter)} records`}
            </span>
          </button>
        )
      })}

      {planned.map((planned: PlannedStarter) => {
        const Icon = ICONS[planned.id] ?? Blocks
        return (
          <button type="button" key={planned.id} disabled aria-disabled className={plannedClass}>
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
