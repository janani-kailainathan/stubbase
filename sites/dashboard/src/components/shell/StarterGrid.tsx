import {
  ClipboardList,
  FilePlus2,
  KeyRound,
  Link2,
  Newspaper,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react'
import { countRecords, STARTERS, type Starter } from '@/lib/starters'

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
 * The two screens differ in exactly one way, which is what `onBlank` selects:
 * with no projects yet there is also a "start blank" card, since naming an
 * empty project is a real way in. Inside a project that rung is already taken.
 */
const ICONS: Record<Starter['id'], LucideIcon> = {
  tracker: ClipboardList,
  blog: Newspaper,
  storefront: ShoppingCart,
}

const FEATURES: Record<Starter['features'][number], { Icon: LucideIcon; label: string }> = {
  relations: { Icon: Link2, label: 'relations' },
  auth: { Icon: KeyRound, label: 'auth' },
}

const cardClass =
  'flex cursor-pointer flex-col gap-2 rounded-md border border-border bg-panel p-3 text-left transition-colors hover:border-primary-soft-border-strong hover:bg-card disabled:cursor-not-allowed disabled:opacity-60'

const titleClass = 'truncate text-xs font-medium text-heading'
const iconClass = 'h-3.5 w-3.5 shrink-0 text-primary-accent'
const blurbClass = 'font-mono text-[10px] text-subtle'
const footClass = 'mt-auto pt-1 font-mono text-[10px] text-faintest'

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
  // One extra card when blank is offered: a fourth column, and the room for it,
  // so a card keeps the same width on both screens.
  const layout = onBlank ? 'max-w-4xl sm:grid-cols-2 lg:grid-cols-4' : 'max-w-3xl sm:grid-cols-3'

  return (
    <div className={`grid w-full gap-3 ${layout}`}>
      {onBlank && (
        <button onClick={onBlank} disabled={busy} className={cardClass}>
          <span className="flex items-center gap-2">
            <FilePlus2 className={iconClass} />
            <span className={titleClass}>Empty project</span>
          </span>
          <span className={blurbClass}>Name it and add resources yourself.</span>
          <span className={footClass}>no resources</span>
        </button>
      )}

      {STARTERS.map((starter) => {
        const Icon = ICONS[starter.id]
        return (
          <button
            key={starter.id}
            onClick={() => onPick(starter)}
            disabled={busy}
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
            {starter.features.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                {starter.features.map((feature) => {
                  const { Icon: FeatureIcon, label } = FEATURES[feature]
                  return (
                    <span
                      key={feature}
                      className="flex items-center gap-1 rounded border border-primary/20 bg-primary-soft-weak px-1.5 py-0.5 font-mono text-[10px] text-primary-accent/90"
                    >
                      <FeatureIcon className="h-2.5 w-2.5" />
                      {label}
                    </span>
                  )
                })}
              </span>
            )}
            <span className={footClass}>
              {resourceCount(starter)} · {countRecords(starter)} records
            </span>
          </button>
        )
      })}
    </div>
  )
}

const resourceCount = (s: Starter) => {
  const n = Object.keys(s.resources).length
  return `${n} resource${n === 1 ? '' : 's'}`
}
