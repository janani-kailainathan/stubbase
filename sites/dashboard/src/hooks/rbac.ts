import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, fetchLiveRbac, fetchRbac, saveRbac, setUserRole } from '@/lib/api'
import type { RbacRules } from '@/lib/rbac'
import { useWorkspaceStore } from '@/stores/workspace'

/** A read that answers null for "this project has no rules", rather than an error. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

/** The rules being edited — the staged draft if there is one — or null when there are none. */
export function useRbac(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['rbac', tenantId],
    queryFn: () => orNull<RbacRules>(() => fetchRbac(tenantId!)),
    enabled: Boolean(tenantId),
  })
}

/**
 * The deployed rules: which roles an account can actually be given right now.
 * Keyed under the editor's copy, so a save or a deploy refreshes both.
 */
export function useLiveRbac(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['rbac', tenantId, 'live'],
    queryFn: () => orNull<RbacRules>(() => fetchLiveRbac(tenantId!)),
    enabled: Boolean(tenantId),
  })
}

/** Stage rules for the next deploy. A refusal carries the core's reasons. */
export function useSaveRbac(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rules: unknown) => saveRbac(tenantId!, rules),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rbac', tenantId] })
      // Staged like any other file — see useSaveResource.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

/** Give an account a role. Applies from its next request; there is nothing to deploy. */
export function useSetUserRole(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      setUserRole(tenantId!, userId, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['system', tenantId] }),
  })
}
