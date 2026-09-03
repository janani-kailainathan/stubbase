import { create } from 'zustand'
import { runGet, type ChatTurn, type RunResult } from '@/lib/api'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type Selection =
  | { kind: 'resource'; resource: string }
  | { kind: 'api'; resource: string; method: Method }
  | { kind: 'env' }
  | null

export type EditorTab = 'request' | 'response' | 'live'

/** The log viewer's sub-tabs — the Logs pane's equivalent of EditorTab. */
export type LogView = 'raw' | 'pretty' | 'lifecycle'

/**
 * What the centre pane shows: the file/endpoint editor, the AI chat, the live
 * request log, the diagnostics report, or developer API keys / MCP setup.
 */
export type PaneMode = 'editor' | 'ai' | 'logs' | 'diagnostics' | 'keys'

/**
 * One item in the chat transcript.
 *
 * `turn` entries are the real conversation in the exact shape the Dashboard
 * API expects back — the transcript *is* the request body, so there is no
 * second display-only copy to drift out of sync. `error` entries are local
 * only (a failed request never became a turn) and are dropped from what we
 * send upstream.
 */
export type ChatEntry =
  | { id: string; kind: 'turn'; turn: ChatTurn }
  | { id: string; kind: 'error'; text: string }
  // The outcome of something the *user* did from the transcript (confirming or
  // cancelling a proposed deletion). Local like `error`: it records a human
  // action, not a turn of the conversation, so it never goes to the model —
  // which can always re-check the real state with get_diagnostics.
  | { id: string; kind: 'notice'; text: string; tone: 'done' | 'cancelled' }

export interface LiveState {
  status: 'idle' | 'loading' | 'done'
  result?: RunResult
}

/**
 * Client-only UI state. Server data (projects, resource contents) lives in
 * TanStack Query via src/hooks/*.
 */
interface WorkspaceState {
  selection: Selection
  editing: boolean
  draft: string
  activeTab: EditorTab
  /** Lives here beside activeTab so the Logs pane header can own its tabs. */
  logView: LogView
  paneMode: PaneMode
  dataExpanded: boolean
  newProjectOpen: boolean
  /** Live-run results keyed by `${tenantId}/${resource}`. */
  live: Record<string, LiveState>
  /** AI chat history keyed by tenantId, so switching projects keeps context. */
  chat: Record<string, ChatEntry[]>
  /**
   * Composer text. Lives here rather than in component state because a
   * generation invalidates the projects query, which can remount the
   * composer — half-typed prompts must survive that.
   */
  chatInput: string
  /**
   * Whether the "changes aren't live yet" strip has been dismissed.
   *
   * Deliberately transient and *not* the flag itself — the project's `dirty`
   * is server-owned and outlives the tab; this only says "I have seen it for
   * now". It comes back on the two events the user cares about: another save
   * (hooks/resources.ts, hooks/config.ts, hooks/ai.ts all clear it) and
   * revisiting the project, which `leaveProject` and a reload both cover.
   */
  stagedDismissed: boolean

  /**
   * Drop the view state that belonged to the project we just navigated away
   * from. Which project is *open* is the URL's business (hooks/projects.ts) —
   * this store only holds what is on screen inside one.
   */
  leaveProject: () => void
  /** Hide the staged-changes strip until the next save or project visit. */
  dismissStaged: () => void
  /** Put it back — called wherever a new change is staged. */
  resurfaceStaged: () => void
  /** Clear all per-user state (called on logout). */
  reset: () => void
  select: (selection: Selection) => void
  setTab: (tab: EditorTab) => void
  setLogView: (view: LogView) => void
  setPaneMode: (mode: PaneMode) => void
  toggleData: () => void
  setNewProjectOpen: (open: boolean) => void
  startEdit: (initial: string) => void
  changeDraft: (draft: string) => void
  stopEdit: () => void
  addChatEntry: (tenantId: string, entry: ChatEntry) => void
  /** Replace the transcript with the conversation the server just returned. */
  setChatTurns: (tenantId: string, turns: ChatTurn[]) => void
  setChatInput: (text: string) => void
  runLive: (tenantId: string, resource: string) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selection: null,
  editing: false,
  draft: '',
  activeTab: 'response',
  logView: 'lifecycle',
  paneMode: 'editor',
  dataExpanded: true,
  newProjectOpen: false,
  live: {},
  chat: {},
  chatInput: '',
  stagedDismissed: false,

  // Dismissing is scoped to one visit of one project, so leaving clears it.
  leaveProject: () => set({ selection: null, editing: false, stagedDismissed: false }),

  dismissStaged: () => set({ stagedDismissed: true }),

  resurfaceStaged: () => set({ stagedDismissed: false }),

  reset: () =>
    set({
      selection: null,
      editing: false,
      draft: '',
      paneMode: 'editor',
      live: {},
      chat: {}, // prompts and generated data must not leak between users
      chatInput: '',
      stagedDismissed: false,
    }),

  select: (selection) =>
    set({
      selection,
      editing: false,
      activeTab: selection?.kind === 'api' ? 'request' : 'response',
      paneMode: 'editor', // picking a file means you want to look at it
    }),

  setTab: (tab) => set({ activeTab: tab }),

  setLogView: (view) => set({ logView: view }),

  setPaneMode: (mode) => set({ paneMode: mode }),

  toggleData: () => set((s) => ({ dataExpanded: !s.dataExpanded })),

  setNewProjectOpen: (open) => set({ newProjectOpen: open }),

  startEdit: (initial) => set({ editing: true, draft: initial }),

  changeDraft: (draft) => set({ draft }),

  stopEdit: () => set({ editing: false }),

  addChatEntry: (tenantId, entry) =>
    set((s) => ({ chat: { ...s.chat, [tenantId]: [...(s.chat[tenantId] ?? []), entry] } })),

  // The server is authoritative about the conversation: it appends the model's
  // turn and any tool turns, so a successful reply replaces the transcript
  // rather than being pushed onto it. Local error entries drop away with it.
  setChatTurns: (tenantId, turns) =>
    set((s) => ({
      chat: {
        ...s.chat,
        [tenantId]: turns.map((turn, i) => ({ id: `${tenantId}-${i}`, kind: 'turn', turn })),
      },
    })),

  setChatInput: (text) => set({ chatInput: text }),

  runLive: async (tenantId, resource) => {
    const key = `${tenantId}/${resource}`
    set((s) => ({ live: { ...s.live, [key]: { status: 'loading' } } }))
    const result = await runGet(tenantId, resource).catch(
      (e): RunResult => ({ ok: false, status: 0, latencyMs: 0, body: String(e) }),
    )
    set((s) => ({ live: { ...s.live, [key]: { status: 'done', result } } }))
  },
}))
