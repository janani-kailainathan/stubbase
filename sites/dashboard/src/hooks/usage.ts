import { useQuery } from '@tanstack/react-query'
import { fetchUsage } from '@/lib/api'

/**
 * Per-project API usage. The core flushes its in-RAM counters about once a
 * minute, so refetch on that cadence rather than on every render.
 */
export function useUsage(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['usage', tenantId],
    queryFn: () => fetchUsage(tenantId!),
    enabled: Boolean(tenantId),
    refetchInterval: 60_000,
  })
}
