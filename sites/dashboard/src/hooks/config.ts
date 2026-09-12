import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  fetchLiveTenantConfig,
  fetchProjectStatus,
  fetchTenantConfig,
  saveTenantConfig,
  setProjectStatus,
  type ProjectStatus,
} from '@/lib/api'
import type { TenantConfig } from '@/lib/env'
import { useWorkspaceStore } from '@/stores/workspace'

/** The tenant's config.json; a project without one reads as empty. */
export function useTenantConfig(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['config', tenantId],
    queryFn: async (): Promise<TenantConfig> => {
      try {
        return await fetchTenantConfig(tenantId!)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return {}
        throw e
      }
    },
    enabled: Boolean(tenantId),
  })
}

/**
 * The deployed config. Same shape, different question: `useTenantConfig` reads
 * the edit in progress, this reads what the running API is configured with. A
 * project with nothing deployed yet reads as empty, like one with no config.
 *
 * Keyed under the same prefix as the editor's copy on purpose — a config write
 * or a deploy invalidates `['config', tenantId]` and refreshes both.
 */
export function useLiveTenantConfig(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['config', tenantId, 'live'],
    queryFn: async (): Promise<TenantConfig> => {
      try {
        return await fetchLiveTenantConfig(tenantId!)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return {}
        throw e
      }
    },
    enabled: Boolean(tenantId),
  })
}

export function useSaveTenantConfig(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (config: TenantConfig) => saveTenantConfig(tenantId!, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config', tenantId] })
      // Staged like any other file — see useSaveResource.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}

/**
 * Whether the tenant's API is serving traffic. Read from its own route rather
 * than from config: status is not a setting, so it is never staged or deployed
 * and nothing in the .env can say otherwise. Reads as active until it loads.
 */
export function useProjectStatus(tenantId: string | undefined): ProjectStatus {
  const { data } = useQuery({
    queryKey: ['status', tenantId],
    queryFn: async () => (await fetchProjectStatus(tenantId!)).status,
    enabled: Boolean(tenantId),
  })
  return data === 'stopped' || data === 'maintenance' ? data : 'active'
}

/** Start/stop the tenant's API. Applies immediately on the core. */
export function useSetProjectStatus(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (status: ProjectStatus) => setProjectStatus(tenantId!, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['status', tenantId] }),
  })
}
