import { useEffect } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { TopBar } from '@/components/shell/TopBar'
import { FilesSidebar } from '@/components/shell/FilesSidebar'
import { EditorPane } from '@/components/shell/EditorPane'
import { ApisRail } from '@/components/shell/ApisRail'
import { NoProjects } from '@/components/shell/NoProjects'
import { UnknownProject } from '@/components/shell/UnknownProject'
import { paneFromSlug, projectPath, useCurrentProjectId, useProjects } from '@/hooks/projects'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The workspace, rendered at `/`, `/p/<tenantId>` and `/p/<tenantId>/<pane>`.
 *
 * One component for the two so the loading, empty, error and unknown-project
 * screens exist once. `/` is simply "no project named yet" and redirects to the
 * first one the moment the list arrives — which is what every post-auth flow
 * and every internal `navigate('/')` relies on.
 */
export default function Editor() {
  const tenantId = useCurrentProjectId()
  const { pane } = useParams<{ pane: string }>()
  const { data: projects, isLoading, error } = useProjects()
  const selection = useWorkspaceStore((s) => s.selection)
  const select = useWorkspaceStore((s) => s.select)
  const leaveProject = useWorkspaceStore((s) => s.leaveProject)

  // The previous project's open file means nothing in this one.
  useEffect(() => {
    leaveProject()
  }, [tenantId, leaveProject])

  // Default to the project's first resource so the pane is never empty.
  const project = projects?.find((p) => p.tenantId === tenantId)
  useEffect(() => {
    if (!selection && project?.resources[0]) {
      select({ kind: 'resource', resource: project.resources[0] })
    }
  }, [selection, project, select])

  const loaded = !isLoading && !error && projects

  // A project URL always names its pane: the bare one, and a segment that is
  // no pane at all, land on the editor.
  if (tenantId && !paneFromSlug(pane)) return <Navigate to={projectPath(tenantId)} replace />

  // The URL and the account have to agree, in both directions.
  //
  // `/` names no project: put the first one in the address bar and let it own
  // the address from here, so the very next refresh comes back to it.
  if (!tenantId && loaded && projects.length > 0)
    return <Navigate to={projectPath(projects[0].tenantId)} replace />

  // …and an id on an account that owns nothing is an id worth dropping. The
  // empty state is what this person needs, and leaving a stranger's project in
  // the address bar would keep re-serving it on every refresh and re-share.
  // With projects to offer we do NOT do this: sending them to a project they
  // did not ask for is the misdirection UnknownProject exists to avoid.
  if (tenantId && loaded && projects.length === 0) return <Navigate to="/" replace />

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background font-sans text-muted-foreground">
      <TopBar />
      {error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="font-mono text-xs text-danger-ink">
            Could not reach the Dashboard API: {error.message}
          </p>
        </div>
      ) : loaded && projects.length === 0 ? (
        <NoProjects />
      ) : loaded && tenantId && !project ? (
        // A real id that is not in *your* list: deleted, or another account's.
        // Never fall through to the first project — see useCurrentProject.
        <UnknownProject tenantId={tenantId} />
      ) : project ? (
        <div className="flex min-h-0 flex-1">
          <FilesSidebar />
          <EditorPane />
          <ApisRail />
        </div>
      ) : (
        <div className="min-h-0 flex-1" />
      )}
    </div>
  )
}
