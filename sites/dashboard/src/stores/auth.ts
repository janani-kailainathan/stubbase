import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as api from '@/lib/api'
import { setAuthToken, setUnauthorizedHandler, type ApiUser, type PendingSignup } from '@/lib/api'
import { forgetAllTabLogs } from '@/lib/log-storage'
import { queryClient } from '@/lib/query'
import { useWorkspaceStore } from '@/stores/workspace'

interface AuthState {
  token: string | null
  user: ApiUser | null
  login: (email: string, password: string) => Promise<void>
  /** Starts a sign-up; no session yet — the account exists once its emailed code is verified. */
  signup: (email: string, password: string, name?: string) => Promise<PendingSignup>
  /** Finishes a sign-up with the code from the email, which is what opens the session. */
  verifySignup: (verificationId: string, code: string) => Promise<void>
  /** Sets a new password with the emailed reset code; every other session ends and this one starts. */
  resetPassword: (email: string, code: string, password: string) => Promise<void>
  /** Signed in, with the current password. This session stays; every other one ends. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  /** Re-reads the account from /auth/me — the stored copy may predate a field or a change. */
  refreshUser: () => Promise<void>
  /** Renames the account; an empty name clears it. */
  updateName: (name: string) => Promise<void>
  /** Deletes the account with its password, then forgets it here. */
  deleteAccount: (password: string) => Promise<void>
  /** Adopt a session minted by the OAuth callback (arrives in a URL fragment). */
  adoptSession: (token: string) => Promise<void>
  /**
   * Forgets the session here. `revoke: false` skips the server-side logout, for
   * when the server has already ended the session and would only answer 401.
   */
  logout: (options?: { revoke?: boolean }) => void
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

      signup: (email, password, name) => api.signup(email, password, name),

      verifySignup: async (verificationId, code) => {
        const res = await api.verifySignup(verificationId, code)
        setAuthToken(res.token)
        set({ token: res.token, user: res.user })
      },

      resetPassword: async (email, code, password) => {
        const res = await api.resetPassword(email, code, password)
        setAuthToken(res.token)
        set({ token: res.token, user: res.user })
      },

      changePassword: async (currentPassword, newPassword) => {
        const { user } = await api.changePassword(currentPassword, newPassword)
        set({ user })
      },

      refreshUser: async () => {
        const token = get().token
        if (!token) return
        const { user } = await api.me()
        // Only for the session that asked: a logout (or another sign-in) while
        // this was in flight must not have an account written back over it.
        if (get().token === token) set({ user })
      },

      updateName: async (name) => {
        const token = get().token
        const { user } = await api.updateAccount(name)
        if (get().token === token) set({ user })
      },

      deleteAccount: async (password) => {
        await api.deleteAccount(password)
        get().logout({ revoke: false })
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

      logout: ({ revoke = true } = {}) => {
        if (revoke && get().token) api.logout().catch(() => {}) // best-effort server-side revoke
        setAuthToken(null)
        set({ token: null, user: null })
        useWorkspaceStore.getState().reset() // next user must not inherit selection
        queryClient.clear() // …nor the previous user's cached server data
        forgetAllTabLogs() // …nor the request logs this tab kept for them
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
