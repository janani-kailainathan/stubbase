import { FilePlus2, KeyRound, Link2, Newspaper, ShoppingCart, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useCreateProjectFromStarter } from '@/hooks/starters'
import { countRecords, STARTERS, type Starter } from '@/lib/starters'
import { useWorkspaceStore } from '@/stores/workspace'

const ICONS: Record<Starter['id'], LucideIcon> = {
  tracker: Newspaper, // unused here; kept so the map stays exhaustive
  blog: Newspaper,
  storefront: ShoppingCart,
}

const FEATURES: Record<Starter['features'][number], { Icon: LucideIcon; label: string }> = {
  relations: { Icon: Link2, label: 'relations' },
  auth: { Icon: KeyRound, label: 'auth' },
}

/**
 * The first thing a new account sees. Three ways in, blank first.
 *
 * The two examples are the starters that demonstrate a capability
 * (`features.length > 0`) rather than the first two in the list: "Empty
 * project" already occupies the simplest rung that plain-CRUD tracker holds on
 * the per-project empty state, and tracker is one click away there anyway once
 * a project exists. Deriving them keeps this honest if the starter list grows.
 */
const SHOWCASE = STARTERS.filter((s) => s.features.length > 0)

const cardClass =
  'flex cursor-pointer flex-col gap-2 rounded-md border border-border bg-panel p-4 text-left transition-colors hover:border-primary-soft-border-strong hover:bg-card disabled:cursor-not-allowed disabled:opacity-60'

export function NoProjects() {
  const setNewProjectOpen = useWorkspaceStore((s) => s.setNewProjectOpen)
  const setProject = useWorkspaceStore((s) => s.setProject)
  const create = useCreateProjectFromStarter()

  const pick = (starter: Starter) => {
    if (create.isPending) return
    create.mutate(starter, {
      onSuccess: (created) => {
        setProject(created.tenantId)
        toast.success(`Created ${created.tenantId} — Deploy, then try ${starter.example}`)
      },
      onError: (e) => toast.error(`Could not create the ${starter.title} example: ${e.message}`),
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto p-6">
      <div className="text-center">
        <p className="text-sm font-medium text-emphasis">No projects yet</p>
        <p className="mt-1.5 font-mono text-xs text-subtle">
          Start blank, or from an API that already works.
        </p>
      </div>

      <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
        <button onClick={() => setNewProjectOpen(true)} disabled={create.isPending} className={cardClass}>
          <span className="flex items-center gap-2">
            <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-primary-accent" />
            <span className="truncate text-xs font-medium text-heading">Empty project</span>
          </span>
          <span className="font-mono text-[10px] text-subtle">
            Name it and add resources yourself.
          </span>
          <span className="mt-auto pt-1 font-mono text-[10px] text-faintest">no resources</span>
        </button>

        {SHOWCASE.map((starter) => {
          const Icon = ICONS[starter.id]
          return (
            <button
              key={starter.id}
              onClick={() => pick(starter)}
              disabled={create.isPending}
              className={cardClass}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-primary-accent" />
                <span className="truncate text-xs font-medium text-heading">{starter.title}</span>
              </span>
              <span className="font-mono text-[10px] text-subtle">{starter.blurb}</span>
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
              <span className="mt-auto pt-1 font-mono text-[10px] text-faintest">
                {Object.keys(starter.resources).length} resources · {countRecords(starter)} records
              </span>
            </button>
          )
        })}
      </div>

      {create.isPending && (
        <p className="font-mono text-[11px] text-subtle">Provisioning&hellip;</p>
      )}
    </div>
  )
}
