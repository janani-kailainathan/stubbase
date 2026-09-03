import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteResourceFile, fetchResource, saveResourceFile } from '@/lib/api'
import { useWorkspaceStore } from '@/stores/workspace'

export function useResource(tenantId: string | undefined, resource: string | undefined) {
  return useQuery({
    queryKey: ['resource', tenantId, resource],
    queryFn: () => fetchResource(tenantId!, resource!),
    enabled: Boolean(tenantId && resource),
    // Without this the default staleTime of 0 refetches on every remount, so
    // simply clicking between the Request/Response/Live tabs re-hit the API
    // each time. Writes invalidate this key explicitly, so nothing goes stale.
    staleTime: 30_000,
  })
}

/** Replace a resource file wholesale (the editor's Save). */
export function useSaveResource(tenantId: string | undefined, resource: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: unknown[]) => saveResourceFile(tenantId!, resource!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource', tenantId, resource] })
      // The save staged a draft, so the project is dirty now — this refetch is
      // what raises the "not live yet" strip.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      // …and a new change undoes an earlier dismissal of it.
      useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

/**
 * Add one or more resources to a project, as `{ name: records }`. The sidebar
 * creates a single empty one; a starter example scaffolds a whole related API.
 *
 * Writes are sequential on purpose: each one makes the files proxy rewrite the
 * project's `resources` column, so firing them in parallel would race and lose
 * entries.
 */
export function useCreateResources(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (resources: Record<string, unknown[]>) => {
      for (const [resource, records] of Object.entries(resources)) {
        await saveResourceFile(tenantId!, resource, records)
      }
      return Object.keys(resources)
    },
    onSuccess: (names) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      for (const name of names)
        queryClient.invalidateQueries({ queryKey: ['resource', tenantId, name] })
      useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

/**
 * Carry out a deletion the Co-Pilot proposed, once the user has confirmed it.
 *
 * The AI never runs this: its tool only returns a proposal, and this is the
 * user's click acting on the ordinary files routes. Sequential for the same
 * reason as useCreateResources — each write rewrites the project's `resources`
 * column, so parallel calls would race and lose entries.
 */
export function useApplyDeletion(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ names, mode }: { names: string[]; mode: 'empty' | 'remove' }) => {
      for (const name of names) {
        if (mode === 'remove') await deleteResourceFile(tenantId!, name)
        else await saveResourceFile(tenantId!, name, [])
      }
      return { names, mode }
    },
    onSuccess: ({ names, mode }) => {
      for (const name of names) {
        if (mode === 'remove') queryClient.removeQueries({ queryKey: ['resource', tenantId, name] })
        else queryClient.invalidateQueries({ queryKey: ['resource', tenantId, name] })
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['diagnostics', tenantId] })
      // Emptying a resource stages a draft like any other save.
      if (mode === 'empty') useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

export function useDeleteResource(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (resource: string) => deleteResourceFile(tenantId!, resource),
    onSuccess: (_data, resource) => {
      queryClient.removeQueries({ queryKey: ['resource', tenantId, resource] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}
