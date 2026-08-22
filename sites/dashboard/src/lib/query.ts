import { QueryClient } from '@tanstack/react-query'

/** Shared client so non-component code (auth store) can clear the cache on logout. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})
