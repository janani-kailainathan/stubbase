import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as api from '@/lib/api'
import { setAuthToken, setUnauthorizedHandler, type ApiUser } from '@/lib/api'
import { queryClient } from '@/lib/query'
import { useWorkspaceStore } from '@/stores/workspace'

interface AuthState {
  token: string | null
  user: ApiUser | null
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name?: string) => Promise<void>
  /** Adopt a session minted by the OAuth callback (arrives in a URL fragment). */
  adoptSession: (token: string) => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,

      login: async (email, password) => {
        const res = await api.login(email, password)
        setAuthToken(res.token)
        set({ token: res.token, user: res.user })
      },

      signup: async (email, password, name) => {
        const res = await api.signup(email, password, name)
        setAuthToken(res.token)
        set({ token: res.token, user: res.user })
      },

      adoptSession: async (token) => {
        setAuthToken(token)
        try {
          // The redirect carries only the token, so the profile it belongs to
          // has to be fetched before the session counts as established.
          const { user } = await api.me()
          set({ token, user })
        } catch (error) {
          setAuthToken(null)
          set({ token: null, user: null })
          throw error
        }
      },

      logout: () => {
        if (get().token) api.logout().catch(() => {}) // best-effort server-side revoke
        setAuthToken(null)
        set({ token: null, user: null })
        useWorkspaceStore.getState().reset() // next user must not inherit selection
        queryClient.clear() // …nor the previous user's cached server data
      },
    }),
    {
      name: 'stubbase-auth',
      partialize: (s) => ({ token: s.token, user: s.user }),
      onRehydrateStorage: () => (state) => setAuthToken(state?.token ?? null),
    },
  ),
)

// Expired/revoked session on any API call → drop the local session too.
setUnauthorizedHandler(() => useAuthStore.getState().logout())
