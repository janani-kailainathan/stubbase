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
  createdAt: string
  color: string
}

const toProject = (row: ProjectRow, index: number): Project => ({
  tenantId: row.tenant_id,
  name: row.name,
  resources: row.resources,
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
 * Open a project. Switching projects is a navigation now, not a store write,
 * so the back button walks the projects you visited and a refresh stays put.
 */
export function useOpenProject(): (tenantId: string) => void {
  const navigate = useNavigate()
  return useCallback((tenantId: string) => navigate(`/p/${tenantId}`), [navigate])
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
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
