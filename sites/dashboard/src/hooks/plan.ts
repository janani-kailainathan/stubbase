import { useAuthStore } from '@/stores/auth'
import type { PlanFeature } from '@/lib/api'

/**
 * Whether the signed-in account's plan includes a feature.
 *
 * Presentational only. The server refuses an off-plan call regardless of what
 * this returns (402 from the files proxy for config features, from the AI route
 * for the Co-Pilot), so a stale or tampered value costs a nicer error message,
 * never access. That is why the entitlements are read from the session payload
 * rather than derived from a plan table copied into the bundle: there is only
 * one plan table, and it lives on the side that enforces.
 */
export function useHasFeature(feature: PlanFeature): boolean {
  return useAuthStore((s) => s.user?.features?.includes(feature) ?? false)
}

/** The current plan's display name, for copy that has to name it. */
export function usePlanName(): string {
  return useAuthStore((s) => s.user?.planName ?? 'Free')
}

/** The plan's monthly request allowance — what the core throttles against. */
export function useMonthlyRequests(): number | undefined {
  return useAuthStore((s) => s.user?.monthlyRequests)
}
