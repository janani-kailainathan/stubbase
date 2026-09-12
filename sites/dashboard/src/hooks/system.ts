import { useQuery } from '@tanstack/react-query'
import { fetchSystemFile, fetchSystemFiles } from '@/lib/api'

/**
 * Which system files the project has. Everything here sits under
 * `['system', tenantId]`, so a playground call to an auth route — which is what
 * writes these files — refreshes the list and every open file at once.
 */
export function useSystemFiles(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['system', tenantId],
    queryFn: async () => (await fetchSystemFiles(tenantId!)).files,
    enabled: Boolean(tenantId),
    staleTime: 30_000,
  })
}

/** One system file's rows, read-only. */
export function useSystemFile(tenantId: string | undefined, name: string | undefined) {
  return useQuery({
    queryKey: ['system', tenantId, name],
    queryFn: () => fetchSystemFile(tenantId!, name!),
    enabled: Boolean(tenantId && name),
    staleTime: 30_000,
  })
}
