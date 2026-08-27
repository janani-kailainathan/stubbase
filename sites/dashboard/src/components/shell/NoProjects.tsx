import { toast } from 'sonner'
import { StarterGrid } from '@/components/shell/StarterGrid'
import { useCreateProjectFromStarter } from '@/hooks/starters'
import type { Starter } from '@/lib/starters'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The first thing a new account sees: start blank, or from an API that already
 * works. The cards themselves are StarterGrid's, shared with a project's own
 * empty state, so the same starters are offered in both places.
 */
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

      <StarterGrid
        busy={create.isPending}
        onPick={pick}
        onBlank={() => setNewProjectOpen(true)}
      />

      {create.isPending && (
        <p className="font-mono text-[11px] text-subtle">Provisioning&hellip;</p>
      )}
    </div>
  )
}
