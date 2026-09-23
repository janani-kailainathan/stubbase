import { useAuthStore } from '@/stores/auth'

/*
 * The plan's entitlements are read from the session payload rather than
 * derived from a plan table copied into the bundle: there is only one plan
 * table, and it lives on the side that enforces. Everything here is
 * presentational — the server refuses regardless of what the SPA believes.
 */

/** The current plan's display name, for copy that has to name it. */
export function usePlanName(): string {
  return useAuthStore((s) => s.user?.planName ?? 'Free')
}

/** The account's request limit, request packs included — what the core throttles against. */
export function useMonthlyRequests(): number | undefined {
  return useAuthStore((s) => s.user?.monthlyRequests)
}
