import type { LogEntry } from './api'

/**
 * The Logs pane's per-tab copy of a project's request log, kept in
 * sessionStorage so it outlives what the core holds: a reload, switching to
 * the Editor and back, and the save or deploy that evicts the project and
 * takes the core's ring with it.
 *
 * sessionStorage, not localStorage, on purpose. It is scoped to one tab and
 * gone when the tab closes, so two tabs on the same project each keep their
 * own copy and can never overwrite each other, and nothing lingers after the
 * work is done. It is only ever written while the Logs pane is open — the
 * hook that calls this is mounted by that pane alone.
 *
 * Three rules, each held by tests/log-storage.test.ts:
 *   - no credential is stored. A signup or login response carries the
 *     project's user token, which the dashboard otherwise keeps in memory
 *     only, so `/auth/*` entries are written without their bodies.
 *   - Clear sticks. The core replays its whole ring on every connect, so a
 *     cleared copy records `clearedAt` and older entries stay out.
 *   - logout forgets every project's copy, and a store opened before the
 *     logout can never write again — the pane unmounts a render after the
 *     logout, and its final flush must not put the logs straight back.
 *
 * React-free so the suite can import it; every storage call is guarded, since
 * sessionStorage can be missing, blocked or full, and then the pane simply
 * works from memory as it did before.
 */

export const LOG_STORAGE_PREFIX = 'stubbase_logs:'

/** Mirrors the core's ring size (LOG_CAP), so the copy can't outgrow the source. */
export const LOG_ENTRY_CAP = 50

export interface StoredLog {
  entries: LogEntry[]
  /** Server time of the newest entry the user cleared; nothing at or before it is kept. */
  clearedAt: string | null
}

const emptyLog = (): StoredLog => ({ entries: [], clearedAt: null })

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null // a sandboxed frame can throw on mere access
  }
}

/** Matches the core's own routing: `/<tenant>/auth/…`. */
export function isAuthEntry(entry: Pick<LogEntry, 'path'>): boolean {
  return entry.path.split('/').filter(Boolean)[1] === 'auth'
}

/**
 * The entry as it may be written down. Both bodies go, not just the response:
 * the core does not log auth request bodies today, but a password must not
 * start reaching storage the day it does.
 */
export function forStorage(entry: LogEntry): LogEntry {
  return isAuthEntry(entry) ? { ...entry, requestBody: null, responseBody: null } : entry
}

/** Whether an entry survives the user's last Clear. */
export function afterClear(entry: Pick<LogEntry, 'ts'>, clearedAt: string | null): boolean {
  return clearedAt === null || entry.ts > clearedAt
}

/**
 * The cut for a Clear: the newest server timestamp on screen. Server time, not
 * the browser clock — a clock running ahead would hide requests that happen
 * after the click. With nothing on screen the previous cut stands.
 */
export function clearedAtFor(entries: LogEntry[], previous: string | null): string | null {
  let newest = previous
  for (const entry of entries) if (newest === null || entry.ts > newest) newest = entry.ts
  return newest
}

const byTime = (a: LogEntry, b: LogEntry) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)

/**
 * Add one entry, in server-time order, keeping the newest LOG_ENTRY_CAP.
 * Returns the same array when the entry is already there: the core replays its
 * ring on every connect, so most of a reconnect's entries are duplicates of the
 * restored copy.
 */
export function mergeEntry(entries: LogEntry[], entry: LogEntry): LogEntry[] {
  if (entries.some((e) => e.correlationId === entry.correlationId)) return entries
  // A stable sort keeps arrival order for entries stamped in the same millisecond.
  return [...entries, entry].sort(byTime).slice(-LOG_ENTRY_CAP)
}

/** Enough shape for the pane to render without throwing. */
function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.correlationId === 'string' &&
    typeof e.ts === 'string' &&
    typeof e.method === 'string' &&
    typeof e.path === 'string' &&
    typeof e.query === 'string' &&
    typeof e.status === 'number' &&
    typeof e.durationMs === 'number' &&
    Array.isArray(e.lifecycle)
  )
}

function loadLog(tenantId: string): StoredLog {
  const store = storage()
  if (!store) return emptyLog()
  try {
    const raw = store.getItem(LOG_STORAGE_PREFIX + tenantId)
    if (!raw) return emptyLog()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return emptyLog()
    const { entries, clearedAt } = parsed as Record<string, unknown>
    const cut = typeof clearedAt === 'string' ? clearedAt : null
    const kept = Array.isArray(entries)
      ? entries
          .filter(isEntry)
          .map(forStorage) // whatever wrote this copy, it is re-held to the rules
          .filter((entry) => afterClear(entry, cut))
          .sort(byTime)
          .slice(-LOG_ENTRY_CAP)
      : []
    return { entries: kept, clearedAt: cut }
  } catch {
    return emptyLog() // unreadable copy: start over rather than fail the pane
  }
}

function saveLog(tenantId: string, log: StoredLog) {
  const store = storage()
  if (!store) return
  try {
    store.setItem(
      LOG_STORAGE_PREFIX + tenantId,
      JSON.stringify({ clearedAt: log.clearedAt, entries: log.entries.map(forStorage) }),
    )
  } catch {
    // Quota or blocked storage: the pane keeps working from memory.
  }
}

/** Bumped by every logout, so a store opened before one can no longer write. */
let epoch = 0

export interface TabLogStore {
  load: () => StoredLog
  save: (log: StoredLog) => void
}

/** Open this tab's copy of one project's log. */
export function openTabLogStore(tenantId: string): TabLogStore {
  const opened = epoch
  return {
    load: () => loadLog(tenantId),
    save: (log) => {
      if (opened === epoch) saveLog(tenantId, log)
    },
  }
}

/** Logout: drop every project's copy in this tab, and disarm every open store. */
export function forgetAllTabLogs() {
  epoch++
  const store = storage()
  if (!store) return
  try {
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key?.startsWith(LOG_STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) store.removeItem(key)
  } catch {
    // Nothing more can be done; the copies still end with the tab.
  }
}
