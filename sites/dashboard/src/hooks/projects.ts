import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  type ProjectRow,
} from '@/lib/api'
import { useWorkspaceStore, type Selection } from '@/stores/workspace'

export const PROJECT_COLORS = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
]

export interface Project {
  tenantId: string
  name: string
  resources: string[]
  /**
   * A save is staged that the live API is not serving yet.
   *
   * Server-owned: a save writes a draft file the live API does not serve, and
   * that outlives this tab, so the flag has to come back with the project
   * rather than being remembered in a store (see StagedChanges).
   */
  dirty: boolean
  createdAt: string
  color: string
}

const toProject = (row: ProjectRow, index: number): Project => ({
  tenantId: row.tenant_id,
  name: row.name,
  resources: row.resources,
  // Tolerated as missing: a Dashboard API from before the column shipped
  // reports clean rather than crashing the workspace.
  dirty: row.dirty ?? false,
  createdAt: row.created_at,
  color: PROJECT_COLORS[index % PROJECT_COLORS.length],
})

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    select: (rows) => rows.map(toProject),
  })
}

/**
 * The tenant id the URL names, or undefined on `/`.
 *
 * This is the only place the open project is stored. It used to live in the
 * workspace store, which meant a reload had nothing to restore it from and the
 * Editor silently adopted the first project instead — you came back to someone
 * else's page every refresh.
 */
export function useCurrentProjectId(): string | undefined {
  return useParams<{ tenantId: string }>().tenantId
}

/**
 * The project the URL names — undefined while the list is loading, and also
 * when the id is not one of yours.
 *
 * Deliberately **no fallback to the first project**: an id that isn't in your
 * list is either deleted or someone else's, and quietly showing a different
 * project would misrepresent whose data is on screen (and hide the 404 the
 * Dashboard API is answering). Editor renders an unknown-project screen for
 * that case; every consumer here is already inside it.
 */
export function useCurrentProject(): Project | undefined {
  const { data: projects } = useProjects()
  const tenantId = useCurrentProjectId()
  return projects?.find((p) => p.tenantId === tenantId)
}

/**
 * The workspace's panes, and the path segment each lives at: the pane is part
 * of the URL, after the project — `/p/<tenantId>/<pane>` — for the same reason
 * the project is. Keys are the code's names, values the address's; the keys
 * pane is labelled MCP, so that is what its URL says.
 */
export type PaneMode = 'editor' | 'ai' | 'logs' | 'diagnostics' | 'keys'

const PANE_SLUGS: Record<PaneMode, string> = {
  editor: 'editor',
  ai: 'ai',
  logs: 'logs',
  diagnostics: 'diagnostics',
  keys: 'mcp',
}

/** The pane a path segment names, or undefined for anything else. */
export const paneFromSlug = (slug: string | undefined): PaneMode | undefined =>
  (Object.keys(PANE_SLUGS) as PaneMode[]).find((pane) => PANE_SLUGS[pane] === slug)

export const projectPath = (tenantId: string, pane: PaneMode = 'editor') =>
  `/p/${tenantId}/${PANE_SLUGS[pane]}`

/**
 * The pane the URL names. `/` names none and reads as the editor; a project URL
 * with no pane or an unknown one is redirected to the editor by Editor.
 */
export function usePaneMode(): PaneMode {
  return paneFromSlug(useParams<{ pane: string }>().pane) ?? 'editor'
}

/**
 * Switch pane. A navigation, like switching project: Back returns to the pane
 * you were on and a reload stays where it is. With no project open there is no
 * pane to move to. `replace` is for moves the person did not make — leaving a
 * pane that stopped making sense — so the dead view is not left in history.
 */
export function useSetPaneMode(): (pane: PaneMode, options?: { replace?: boolean }) => void {
  const navigate = useNavigate()
  const tenantId = useCurrentProjectId()
  const current = usePaneMode()
  return useCallback(
    (pane: PaneMode, options?: { replace?: boolean }) => {
      if (!tenantId || pane === current) return
      navigate(projectPath(tenantId, pane), { replace: options?.replace })
    },
    [navigate, tenantId, current],
  )
}

/**
 * Open a file or endpoint where it is shown: select it, and bring the editor up
 * if another pane is open. Every pick a person makes goes through here; the
 * store's bare `select` is for choosing a default, which must never move you
 * off the pane in the URL.
 */
export function useSelectInEditor(): (selection: Selection) => void {
  const select = useWorkspaceStore((s) => s.select)
  const setPaneMode = useSetPaneMode()
  return useCallback(
    (selection: Selection) => {
      select(selection)
      setPaneMode('editor')
    },
    [select, setPaneMode],
  )
}

/**
 * Open a project. Switching projects is a navigation, not a store write, so the
 * back button walks the projects you visited and a refresh stays put. The pane
 * comes along: switching project from the logs shows the other project's logs.
 */
export function useOpenProject(): (tenantId: string) => void {
  const navigate = useNavigate()
  const pane = usePaneMode()
  return useCallback((tenantId: string) => navigate(projectPath(tenantId, pane)), [navigate, pane])
}

/** Shared by both ways of creating a project, so a dialog can tell one is in flight. */
export const CREATE_PROJECT_KEY = ['projects', 'create']

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: CREATE_PROJECT_KEY,
    mutationFn: ({ name, resources }: { name: string; resources?: Record<string, unknown[]> }) =>
      createProject(name, resources),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useRenameProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, name }: { tenantId: string; name: string }) =>
      renameProject(tenantId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteProject,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}
