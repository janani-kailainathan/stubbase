import { useMutation, useQuery } from '@tanstack/react-query'
import { fetchDiagnostics, probeEdge } from '@/lib/api'

/**
 * JSON syntax health for a project. Cheap (the Dashboard API reads the files
 * over the core's admin plane), but not free — refetched on focus rather than
 * on a timer, since files only change when the user changes them.
 */
export function useDiagnostics(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['diagnostics', tenantId],
    queryFn: () => fetchDiagnostics(tenantId!),
    enabled: Boolean(tenantId),
  })
}

/**
 * GET against the project's public API, to catch edge conditions the editor
 * never shows: 429 (rate limited), 413 (payload too large), or the API being
 * unreachable entirely.
 *
 * Deliberately a mutation, not a query: this is the one check that hits the
 * tenant's *public* plane, so it is metered as their usage and shows up in
 * their own live log. Firing it automatically on mount (and worse, on an
 * interval) meant opening a tab silently manufactured traffic against the
 * user's API and billed them for it. It now runs only when asked.
 */
export function useEdgeProbe(tenantId: string | undefined, resource: string | undefined) {
  return useMutation({
    mutationFn: () => probeEdge(tenantId!, resource!),
  })
}
