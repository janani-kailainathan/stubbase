import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchUsage, type RunResult, type UsageResponse } from '@/lib/api'
import { countsAsUsage } from '@/lib/playground'
import { applyFloor, raiseFloor, type UsageFloor } from '@/lib/usage-floor'

/** Floors raised by this tab's playground Sends, by project — see lib/usage-floor. */
const floors = new Map<string, UsageFloor>()

const usageKey = (tenantId: string | undefined) => ['usage', tenantId] as const

/**
 * Per-project API usage. The core flushes its in-RAM counters about once a
 * minute, so refetch on that cadence rather than on every render. Every fetch
 * is held at or above any floor a recent Send raised, so a poll that lands
 * before the core's flush cannot take a Send back off the panel.
 */
export function useUsage(tenantId: string | undefined) {
  return useQuery({
    queryKey: usageKey(tenantId),
    queryFn: async () => applyFloor(await fetchUsage(tenantId!), floors.get(tenantId!), Date.now()),
    enabled: Boolean(tenantId),
    refetchInterval: 60_000,
  })
}

/**
 * Count a playground Send in the Usage panel now, instead of after the core's
 * next flush and the panel's next poll. Only what the core itself counts —
 * see countsAsUsage — and only once the panel has figures to add to; before
 * that, its own first fetch is moments away.
 */
export function useCountSentRequest() {
  const queryClient = useQueryClient()
  return useCallback(
    (tenantId: string, result: RunResult) => {
      if (!countsAsUsage(result)) return
      const shown = queryClient.getQueryData<UsageResponse>(usageKey(tenantId))
      if (!shown) return
      const now = Date.now()
      // The body's UTF-8 size is what the core meters: the response's content-length.
      const floor = raiseFloor(shown, new Blob([result.body]).size, now)
      floors.set(tenantId, floor)
      queryClient.setQueryData(usageKey(tenantId), applyFloor(shown, floor, now))
    },
    [queryClient],
  )
}
