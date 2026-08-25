import { useEffect } from 'react'
import { TopBar } from '@/components/shell/TopBar'
import { FilesSidebar } from '@/components/shell/FilesSidebar'
import { EditorPane } from '@/components/shell/EditorPane'
import { ApisRail } from '@/components/shell/ApisRail'
import { NoProjects } from '@/components/shell/NoProjects'
import { useProjects } from '@/hooks/projects'
import { useWorkspaceStore } from '@/stores/workspace'

export default function Editor() {
  const { data: projects, isLoading, error } = useProjects()
  const currentProjectId = useWorkspaceStore((s) => s.currentProjectId)
  const selection = useWorkspaceStore((s) => s.selection)
  const setProject = useWorkspaceStore((s) => s.setProject)
  const select = useWorkspaceStore((s) => s.select)

  // Adopt the first project when none (or a stale one) is selected.
  useEffect(() => {
    if (!projects?.length) return
    if (!currentProjectId || !projects.some((p) => p.tenantId === currentProjectId)) {
      setProject(projects[0].tenantId)
    }
  }, [projects, currentProjectId, setProject])

  // Default to the project's first resource so the pane is never empty.
  const project = projects?.find((p) => p.tenantId === currentProjectId)
  useEffect(() => {
    if (!selection && project?.resources[0]) {
      select({ kind: 'resource', resource: project.resources[0] })
    }
  }, [selection, project, select])

  const empty = !isLoading && !error && projects?.length === 0

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background font-sans text-muted-foreground">
      <TopBar />
      {empty ? (
        <NoProjects />
      ) : error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="font-mono text-xs text-danger-ink">
            Could not reach the Dashboard API: {error.message}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <FilesSidebar />
          <EditorPane />
          <ApisRail />
        </div>
      )}
    </div>
  )
}
