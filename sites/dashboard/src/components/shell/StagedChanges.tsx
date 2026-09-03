import { useEffect } from 'react'
import { Rocket, X } from 'lucide-react'
import { useProjectStatus } from '@/hooks/config'
import { useCurrentProject } from '@/hooks/projects'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The strip at the top of the centre pane when a *running* project has saved
 * changes its live API is not serving.
 *
 * Only when running, deliberately. A stopped project already says so in three
 * places — Logs and Diagnostics are disabled, the deploy button reads "Deploy"
 * rather than "Redeploy", and the Diagnostics panel explains the 503s — so a
 * second warning there is noise about a project serving nobody. The running
 * case is the one with a cost: real callers are getting the old records right
 * now, and nothing else on screen says so.
 *
 * Generic on purpose: it reports the *state*, not an inventory. The sidebar
 * and the editor are where you look at which file changed, and a strip that
 * grew with the edit count would compete with the pane it sits above.
 *
 * Carries no deploy button either. Redeploy is already the loudest control on
 * screen up in the TopBar, and a second one directly beneath it reads as two
 * competing calls to action — so this names that button instead.
 *
 * `dirty` comes back with the project rather than being tracked in the store,
 * so it survives a reload. Kept in the SPA it would clear on refresh and leave
 * a live API quietly serving stale data behind a clean-looking dashboard. The
 * *dismissal* is the opposite: local and transient, because "I have seen this"
 * is about the person, not the deployment.
 */
export function StagedChanges() {
  const project = useCurrentProject()
  const status = useProjectStatus(project?.tenantId)
  const dismissed = useWorkspaceStore((s) => s.stagedDismissed)
  const dismissStaged = useWorkspaceStore((s) => s.dismissStaged)
  const resurfaceStaged = useWorkspaceStore((s) => s.resurfaceStaged)

  const dirty = project?.dirty ?? false

  // A deploy ends the cycle, so the dismissal goes with it — otherwise the
  // next edit would arrive already hidden. Keyed off the flag rather than off
  // the Deploy button so it also covers the Co-Pilot's deploy tool, and a
  // refetch that finds another tab or an MCP client has deployed.
  useEffect(() => {
    if (!dirty) resurfaceStaged()
  }, [dirty, resurfaceStaged])

  if (!project || status !== 'active' || !dirty || dismissed) return null

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-warning-soft-border bg-warning-soft-weak px-4 py-2">
      <Rocket className="h-3.5 w-3.5 shrink-0 text-warning-ink" />
      <p className="min-w-0 flex-1 font-mono text-xs text-warning-ink">
        You have changes that aren&rsquo;t live yet
        <span className="text-subtle">
          {' '}
          — your API keeps serving the last deployed version until you Redeploy.
        </span>
      </p>
      <button
        onClick={dismissStaged}
        title="Hide until the next change"
        aria-label="Hide this notice"
        className="shrink-0 cursor-pointer rounded p-0.5 text-warning-ink/60 transition-colors hover:text-warning-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
