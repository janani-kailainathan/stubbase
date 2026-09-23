import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, CORE_PUBLIC_URL, createProject, fetchTenantConfig, saveRbac, saveTenantConfig } from '@/lib/api'
import { CREATE_PROJECT_KEY, useSelectInEditor } from '@/hooks/projects'
import { useSaveTenantConfig, useTenantConfig } from '@/hooks/config'
import { useSaveRbac } from '@/hooks/rbac'
import { useCreateResources } from '@/hooks/resources'
import { mergeEnv } from '@/lib/env'
import type { Starter } from '@/lib/starters'

/**
 * Stage a starter into an existing, empty project: its resources as drafts,
 * its settings merged over the project's own, then its rules. The starter
 * cards on a project's empty state and the Co-Pilot's use_starter
 * confirmation both come through here, so a starter lands the same way
 * whoever picked it.
 */
export function useApplyStarter(tenantId: string) {
  const create = useCreateResources(tenantId)
  const { data: config } = useTenantConfig(tenantId)
  const saveConfig = useSaveTenantConfig(tenantId)
  const saveRules = useSaveRbac(tenantId)
  const select = useSelectInEditor()

  const apply = async (starter: Starter) => {
    const names = Object.keys(starter.resources)
    await create.mutateAsync(starter.resources)
    // Merged over what is already there, so the project's own settings
    // survive the starter turning auth on; and into the .env text as well,
    // so the editor shows those lines switched on.
    if (starter.config)
      await saveConfig.mutateAsync(
        mergeEnv(config ?? {}, starter.config, { tenantBase: `${CORE_PUBLIC_URL}/${tenantId}` }),
      )
    // After the config: rbac.json is refused until RBAC_ENABLED is staged.
    if (starter.rbac) await saveRules.mutateAsync(starter.rbac)
    return names
  }

  return {
    apply,
    /** Opens the starter's first resource in the editor. */
    open: (names: string[]) => select({ kind: 'resource', resource: names[0] }),
    busy: create.isPending || saveConfig.isPending || saveRules.isPending,
  }
}

/**
 * Provision a brand-new project straight from a starter, for the New project
 * form (the project menu's dialog, and the screen shown when the account has
 * no projects at all). `name` falls back to the starter's title.
 *
 * The resources ride along on the create call, so the API writes them as it
 * provisions the tenant and rolls the whole thing back if any one of them
 * fails. (The other entry point — a starter picked inside an existing project —
 * stages drafts instead, because there is already live data not to disturb.)
 */
export function useCreateProjectFromStarter() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: CREATE_PROJECT_KEY,
    mutationFn: async ({ starter, name }: { starter: Starter; name?: string }) => {
      const created = await createProject(name ?? starter.title, starter.resources)
      if (starter.config) {
        // Merge, never replace: the .env the project was created with has to
        // survive the starter turning auth on. mergeEnv also writes the
        // settings into that text, uncommenting the template's lines — and,
        // when the starter turns auth on, the Google and GitHub key lines too.
        let current: Record<string, string> = {}
        try {
          current = (await fetchTenantConfig(created.tenantId)) as Record<string, string>
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e
        }
        await saveTenantConfig(
          created.tenantId,
          mergeEnv(current, starter.config, { tenantBase: `${CORE_PUBLIC_URL}/${created.tenantId}` }),
        )
      }
      // After the config, never before: rbac.json is refused until the
      // RBAC_ENABLED it depends on has been staged.
      if (starter.rbac) await saveRbac(created.tenantId, starter.rbac)
      return created
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })
}
