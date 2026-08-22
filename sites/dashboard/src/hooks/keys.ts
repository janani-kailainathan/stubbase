import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createDeveloperKey,
  listDeveloperKeys,
  revokeDeveloperKey,
  type CreatedDeveloperKey,
} from '@/lib/api'

/**
 * Developer API keys for one project. Only ever the metadata — the raw key
 * exists in one response, once, and the server cannot produce it again.
 */
export function useDeveloperKeys(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['keys', tenantId],
    queryFn: () => listDeveloperKeys(tenantId!),
    enabled: Boolean(tenantId),
  })
}

export function useCreateDeveloperKey(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation<CreatedDeveloperKey, Error, string>({
    mutationFn: (name: string) => createDeveloperKey(tenantId!, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys', tenantId] }),
  })
}

export function useRevokeDeveloperKey(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => revokeDeveloperKey(tenantId!, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys', tenantId] }),
  })
}
