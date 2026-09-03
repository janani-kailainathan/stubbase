import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { chatWithCoPilot, type ChatTurn } from '@/lib/api'
import { useWorkspaceStore } from '@/stores/workspace'

export const aiChatKey = (tenantId: string | undefined) => ['ai-chat', tenantId]

/** True while a Co-Pilot turn is in flight, from any component. */
export function useIsCoPilotThinking(tenantId: string | undefined) {
  return useIsMutating({ mutationKey: aiChatKey(tenantId) }) > 0
}

/**
 * One Co-Pilot turn. The whole conversation is sent and the server returns it
 * with the reply appended.
 *
 * A turn can run tools, which is why the invalidation is broad: staging drafts
 * rewrites resource files and the project's resource list, deploying changes
 * what the live API serves, and start/stop rewrites config. `changed` tells us
 * a tool actually did something, so a purely conversational answer costs no
 * refetches.
 */
export function useCoPilotChat(tenantId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: aiChatKey(tenantId),
    mutationFn: (messages: ChatTurn[]) => chatWithCoPilot(tenantId!, messages),
    onSuccess: (res) => {
      if (!res.changed) return
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['resource', tenantId] })
      queryClient.invalidateQueries({ queryKey: ['config', tenantId] })
      queryClient.invalidateQueries({ queryKey: ['diagnostics', tenantId] })
      // A tool that staged drafts is a new change, so an earlier dismissal of
      // the staged-changes strip no longer applies.
      useWorkspaceStore.getState().resurfaceStaged()
    },
  })
}
