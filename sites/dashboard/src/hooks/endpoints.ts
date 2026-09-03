import { useLiveTenantConfig } from '@/hooks/config'
import { useCurrentProject } from '@/hooks/projects'
import { groupEndpoints, type EndpointGroup } from '@/lib/endpoints'

/**
 * Every endpoint the open project serves, grouped the way the rail shows them.
 * Shared with the editor pane so a selected endpoint is looked up in the same
 * list that offered it — the auth plane is conditional, and one list means the
 * two can never disagree about whether it is there.
 *
 * Read from the *deployed* config, not the staged one: this list is what the
 * public API answers to right now. Saving AUTH_ENABLED does not add the auth
 * routes and clearing it does not take them away — the deploy that puts the
 * change live is what moves them, in both directions.
 */
export function useEndpointGroups(): EndpointGroup[] {
  const project = useCurrentProject()
  const { data: config } = useLiveTenantConfig(project?.tenantId)
  if (!project) return []
  return groupEndpoints(project.resources, config)
}
