import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  type ProjectRow,
} from '@/lib/api'
import { useWorkspaceStore } from '@/stores/workspace'

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

/** The project the workspace is pointed at (or undefined while loading/none). */
export function useCurrentProject(): Project | undefined {
  const { data: projects } = useProjects()
  const currentProjectId = useWorkspaceStore((s) => s.currentProjectId)
  return projects?.find((p) => p.tenantId === currentProjectId) ?? projects?.[0]
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
