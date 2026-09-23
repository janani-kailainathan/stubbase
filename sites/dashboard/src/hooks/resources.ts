import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  deleteResourceFile,
  fetchLiveResource,
  fetchResource,
  restoreResourceFile,
  saveResourceFile,
} from '@/lib/api'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * One query per file, holding the records and the revision they came with.
 * useResource and useResourceRevision read the two halves of the same cache
 * entry, so the revision an editor saves against is always the one of the
 * records it shows.
 */
const resourceQuery = (tenantId: string | undefined, resource: string | undefined) => ({
  queryKey: ['resource', tenantId, resource],
  queryFn: () => fetchResource(tenantId!, resource!),
  enabled: Boolean(tenantId && resource),
  // Without this the default staleTime of 0 refetches on every remount, so
  // simply clicking between the Docs/Live tabs re-hit the API
  // each time. Writes invalidate this key explicitly, so nothing goes stale.
  staleTime: 30_000,
})

export function useResource(tenantId: string | undefined, resource: string | undefined) {
  return useQuery({ ...resourceQuery(tenantId, resource), select: (r) => r.records })
}

/** The revision of the records useResource shows — what a save names in If-Match. */
export function useResourceRevision(tenantId: string | undefined, resource: string | undefined) {
  return useQuery({ ...resourceQuery(tenantId, resource), select: (r) => r.revision }).data ?? null
}

/**
 * What the public API is serving for a resource right now: its deployed
 * records, or `null` when it serves nothing — a resource that has been saved
 * but never deployed. The playground needs exactly that distinction, because
 * the rail lists a new resource the moment it is saved while the API only
 * routes it after a deploy.
 *
 * Keyed under the editor's copy so every write that invalidates
 * `['resource', tenantId, resource]` refreshes this too; a deploy invalidates
 * the whole `['resource', tenantId]` prefix.
 */
export function useLiveResource(tenantId: string | undefined, resource: string | undefined) {
  return useQuery({
    queryKey: ['resource', tenantId, resource, 'live'],
    queryFn: async (): Promise<unknown[] | null> => {
      try {
        return await fetchLiveResource(tenantId!, resource!)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    enabled: Boolean(tenantId && resource),
    staleTime: 30_000,
  })
}

/**
 * Replace a resource file wholesale (the editor's Save, and its Undo). A live
 * table's records go live at once; a table not deployed yet stays a draft.
 * `revision` is the one the records were read at: a save after someone else
 * wrote is refused with a 409 instead of erasing their records.
 */
export function useSaveResource(tenantId: string | undefined, resource: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ records, revision }: { records: unknown[]; revision: string | null }) =>
      saveResourceFile(tenantId!, resource!, records, revision),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['resource', tenantId, resource] })
      if (res.draft) {
        // A new table's draft: the project has something to deploy now, and a
        // new change undoes an earlier dismissal of the strip saying so.
        queryClient.invalidateQueries({ queryKey: ['projects'] })
        useWorkspaceStore.getState().resurfaceStaged()
      }
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
    onSuccess: ({ mode }) => {
      // Emptying is live at once; removing marks the tables for the next
      // deploy, so it raises the "not live yet" strip.
      queryClient.invalidateQueries({ queryKey: ['resource', tenantId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['diagnostics', tenantId] })
      if (mode === 'remove') useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

/**
 * Remove a table. A live one is marked and keeps serving until the next
 * deploy; one never deployed is gone at once.
 */
export function useDeleteResource(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (resource: string) => deleteResourceFile(tenantId!, resource),
    onSuccess: (res, resource) => {
      if (res.deleted) queryClient.removeQueries({ queryKey: ['resource', tenantId, resource] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (res.pendingRemoval) useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

/** Take back a table's removal before it is deployed. */
export function useRestoreResource(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (resource: string) => restoreResourceFile(tenantId!, resource),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}
