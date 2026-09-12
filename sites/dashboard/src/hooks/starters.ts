import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, createProject, fetchTenantConfig, saveRbac, saveTenantConfig } from '@/lib/api'
import { mergeEnv } from '@/lib/env'
import type { Starter } from '@/lib/starters'

/**
 * Provision a brand-new project straight from a starter, for the screen shown
 * when the account has no projects at all.
 *
 * The resources ride along on the create call, so the API writes them as it
 * provisions the tenant and rolls the whole thing back if any one of them
 * fails. (The other entry point — a starter picked inside an existing project —
 * stages drafts instead, because there is already live data not to disturb.)
 */
export function useCreateProjectFromStarter() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (starter: Starter) => {
      const created = await createProject(starter.title, starter.resources)
      if (starter.config) {
        // Merge, never replace: the .env the project was created with has to
        // survive the starter turning auth on. mergeEnv also writes the
        // settings into that text, uncommenting the template's lines.
        let current: Record<string, string> = {}
        try {
          current = (await fetchTenantConfig(created.tenantId)) as Record<string, string>
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e
        }
        await saveTenantConfig(created.tenantId, mergeEnv(current, starter.config))
      }
      // After the config, never before: rbac.json is refused until the
      // RBAC_ENABLED it depends on has been staged.
      if (starter.rbac) await saveRbac(created.tenantId, starter.rbac)
      return created
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}
