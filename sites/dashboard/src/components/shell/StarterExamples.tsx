import { ClipboardList, KeyRound, Link2, Newspaper, ShoppingCart, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useSaveTenantConfig, useTenantConfig } from '@/hooks/config'
import { useCreateResources } from '@/hooks/resources'
import { countRecords, STARTERS, type Starter } from '@/lib/starters'
import { useWorkspaceStore } from '@/stores/workspace'

/** Presentation only — the starter data itself lives in lib/starters.ts. */
const ICONS: Record<Starter['id'], LucideIcon> = {
  tracker: ClipboardList,
  blog: Newspaper,
  storefront: ShoppingCart,
}

const FEATURES: Record<Starter['features'][number], { Icon: LucideIcon; label: string }> = {
  relations: { Icon: Link2, label: 'relations' },
  auth: { Icon: KeyRound, label: 'auth' },
}

export function StarterExamples({ tenantId }: { tenantId: string }) {
  const create = useCreateResources(tenantId)
  const { data: config } = useTenantConfig(tenantId)
  const saveConfig = useSaveTenantConfig(tenantId)
  const select = useWorkspaceStore((s) => s.select)

  const busy = create.isPending || saveConfig.isPending

  const pick = async (starter: Starter) => {
    if (busy) return
    const names = Object.keys(starter.resources)
    try {
      await create.mutateAsync(starter.resources)
      // Merged over what is already there, so the project's own settings —
      // PROJECT_STATUS above all — survive the starter turning auth on.
      if (starter.config) await saveConfig.mutateAsync({ ...(config ?? {}), ...starter.config })
      select({ kind: 'resource', resource: names[0] })
      toast.success(`Added ${names.join(', ')} — Deploy, then try ${starter.example}`)
    } catch (e) {
      toast.error(`Could not add the ${starter.title} example: ${(e as Error).message}`)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto p-6">
      <div className="text-center">
        <p className="text-sm font-medium text-zinc-200">This project is empty</p>
        <p className="mt-1.5 font-mono text-xs text-zinc-500">
          Start from a working API, describe one in the AI pane, or add your own from Files.
        </p>
      </div>

      <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
        {STARTERS.map((starter) => {
          const Icon = ICONS[starter.id]
          return (
            <button
              key={starter.id}
              onClick={() => void pick(starter)}
              disabled={busy}
              className="flex cursor-pointer flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-left transition-colors hover:border-emerald-500/40 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="truncate text-xs font-medium text-zinc-100">{starter.title}</span>
              </span>
              <span className="font-mono text-[10px] text-zinc-500">{starter.blurb}</span>
              <span className="font-mono text-[10px] break-words text-zinc-400">
                {Object.keys(starter.resources).join(' · ')}
              </span>
              {starter.features.length > 0 && (
                <span className="flex flex-wrap items-center gap-1">
                  {starter.features.map((feature) => {
                    const { Icon: FeatureIcon, label } = FEATURES[feature]
                    return (
                      <span
                        key={feature}
                        className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/5 px-1.5 py-0.5 font-mono text-[10px] text-emerald-500/90"
                      >
                        <FeatureIcon className="h-2.5 w-2.5" />
                        {label}
                      </span>
                    )
                  })}
                </span>
              )}
              <span className="mt-auto pt-1 font-mono text-[10px] text-zinc-700">
                {names(starter)} · {countRecords(starter)} records
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const names = (s: Starter) => {
  const n = Object.keys(s.resources).length
  return `${n} resource${n === 1 ? '' : 's'}`
}
