import { toast } from 'sonner'
import { StarterGrid } from '@/components/shell/StarterGrid'
import { useSaveTenantConfig, useTenantConfig } from '@/hooks/config'
import { useCreateResources } from '@/hooks/resources'
import type { Starter } from '@/lib/starters'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * A project's own empty state — the same starter cards the account-level empty
 * state offers (StarterGrid), minus the "start blank" rung, which is what
 * being here already is. Picking one stages drafts into this project rather
 * than provisioning a new one.
 */
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
        <p className="text-sm font-medium text-emphasis">This project is empty</p>
        <p className="mt-1.5 font-mono text-xs text-subtle">
          Start from a working API, describe one in the AI pane, or add your own from Files.
        </p>
      </div>

      <StarterGrid busy={busy} onPick={(s) => void pick(s)} />
    </div>
  )
}
