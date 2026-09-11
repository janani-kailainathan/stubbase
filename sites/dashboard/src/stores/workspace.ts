import { create } from 'zustand'
import type { ChatTurn, RunResult } from '@/lib/api'
import type { PlaygroundInputs } from '@/lib/playground'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type Selection =
  | { kind: 'resource'; resource: string }
  // `path` is what identifies the endpoint: the auth group holds two POSTs,
  // so resource + method is no longer unique.
  | { kind: 'api'; resource: string; method: Method; path: string }
  | { kind: 'env' }
  | null

export type EditorTab = 'docs' | 'live'

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

/** One endpoint's last playground request. The previous result stays up while the next one is sending. */
export interface PlaygroundRun {
  status: 'loading' | 'done'
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
  /**
   * The endpoint pane's Docs / Live tab. A preference, not part
   * of a selection: picking another endpoint keeps it, so someone working in
   * Live stays in Live while they walk the rail. Files and .env never read it.
   * Starts on Live: clicking an endpoint is usually wanting to call it.
   */
  activeTab: EditorTab
  /** Lives here beside activeTab so the Logs pane header can own its tabs. */
  logView: LogView
  paneMode: PaneMode
  dataExpanded: boolean
  newProjectOpen: boolean
  /**
   * Playground edits, keyed by `playgroundKey` (tenant + method + path — the
   * auth group holds two POSTs, so resource alone would share them). Absent
   * until the user changes something; until then the playground derives its
   * values from the deployed records.
   */
  playgroundInputs: Record<string, PlaygroundInputs>
  /** Playground responses, keyed the same way. */
  playgroundRuns: Record<string, PlaygroundRun>
  /**
   * The tenant token the playground sends, per project. Memory only, never
   * localStorage: it is a real credential for the project's API, and `reset`
   * drops it on logout so it cannot outlive the account that obtained it.
   */
  testTokens: Record<string, string>
  /** The log entry the playground's "Open in logs" jumped to. */
  focusLog: string | null
  /**
   * The playground's layout — request pane height as a percentage, and whether
   * the response pane is folded away. A preference, not per-endpoint state, so
   * it holds while you move between routes; not user data, so `reset` keeps it.
   */
  playgroundSplit: number
  playgroundCollapsed: boolean
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
  setPlaygroundInputs: (key: string, inputs: PlaygroundInputs) => void
  setTestToken: (tenantId: string, token: string) => void
  /** Record a playground request under `key` while `send` runs, and resolve with its result. */
  runPlayground: (key: string, send: () => Promise<RunResult>) => Promise<RunResult>
  /** Switch to the Logs pane with this request's entry highlighted. */
  openLog: (correlationId: string) => void
  setPlaygroundSplit: (split: number) => void
  setPlaygroundCollapsed: (collapsed: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selection: null,
  editing: false,
  draft: '',
  activeTab: 'live',
  // Pretty is the only Logs view offered for now (LOG_TABS in EditorPane), so it
  // must also be where the pane opens — a hidden view could not be left.
  logView: 'pretty',
  paneMode: 'editor',
  dataExpanded: true,
  newProjectOpen: false,
  playgroundInputs: {},
  playgroundRuns: {},
  testTokens: {},
  focusLog: null,
  playgroundSplit: 55,
  playgroundCollapsed: false,
  chat: {},
  chatInput: '',
  stagedDismissed: false,

  // Dismissing is scoped to one visit of one project, so leaving clears it.
  leaveProject: () =>
    set({ selection: null, editing: false, stagedDismissed: false, focusLog: null }),

  dismissStaged: () => set({ stagedDismissed: true }),

  resurfaceStaged: () => set({ stagedDismissed: false }),

  reset: () =>
    set({
      selection: null,
      editing: false,
      draft: '',
      paneMode: 'editor',
      // Request bodies, responses and tenant tokens are another user's data.
      playgroundInputs: {},
      playgroundRuns: {},
      testTokens: {},
      focusLog: null,
      chat: {}, // prompts and generated data must not leak between users
      chatInput: '',
      stagedDismissed: false,
    }),

  select: (selection) =>
    // activeTab is deliberately left alone — see its declaration.
    set({
      selection,
      editing: false,
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

  setPlaygroundInputs: (key, inputs) =>
    set((s) => ({ playgroundInputs: { ...s.playgroundInputs, [key]: inputs } })),

  setTestToken: (tenantId, token) =>
    set((s) => ({ testTokens: { ...s.testTokens, [tenantId]: token } })),

  runPlayground: async (key, send) => {
    set((s) => ({
      playgroundRuns: {
        ...s.playgroundRuns,
        [key]: { status: 'loading', result: s.playgroundRuns[key]?.result },
      },
    }))
    const result = await send()
    set((s) => ({ playgroundRuns: { ...s.playgroundRuns, [key]: { status: 'done', result } } }))
    return result
  },

  openLog: (correlationId) =>
    set({ paneMode: 'logs', logView: 'pretty', focusLog: correlationId }),

  setPlaygroundSplit: (split) => set({ playgroundSplit: split }),

  setPlaygroundCollapsed: (collapsed) => set({ playgroundCollapsed: collapsed }),
}))
