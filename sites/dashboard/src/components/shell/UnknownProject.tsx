import { FolderX } from 'lucide-react'
import { useOpenProject, useProjects } from '@/hooks/projects'

/**
 * What `/p/<id>` shows when the id is not one of yours.
 *
 * Two causes, one screen: the project was deleted, or the URL came from
 * somebody else's browser. They are deliberately not distinguished — the
 * Dashboard API answers 404 to both for the same reason (a 403 would confirm
 * that a project with that id exists), and so does this.
 */
export function UnknownProject({ tenantId }: { tenantId: string }) {
  const { data: projects } = useProjects()
  const openProject = useOpenProject()
  const first = projects?.[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <FolderX className="h-7 w-7 text-faintest" />
      <div>
        <p className="text-sm font-medium text-emphasis">
          No project <span className="font-mono">{tenantId}</span>
        </p>
        <p className="mt-1.5 max-w-md font-mono text-xs leading-relaxed text-subtle">
          It has been deleted, or it belongs to another account. Pick one of yours from the menu
          above.
        </p>
      </div>
      {first && (
        <button
          onClick={() => openProject(first.tenantId)}
          className="cursor-pointer rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Open {first.name}
        </button>
      )}
    </div>
  )
}
