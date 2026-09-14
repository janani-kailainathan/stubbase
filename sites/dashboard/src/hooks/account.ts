import { useQuery } from '@tanstack/react-query'
import { fetchAccount } from '@/lib/api'

/**
 * The account's read-only facts, usage included. Refetched each minute while
 * shown — the core flushes its counts about that often — and never persisted,
 * unlike the signed-in user, so the used figure is never a stored snapshot.
 */
export function useAccountSummary() {
  return useQuery({
    queryKey: ['account', 'summary'],
    queryFn: fetchAccount,
    select: (res) => res.account,
    refetchInterval: 60_000,
  })
}
