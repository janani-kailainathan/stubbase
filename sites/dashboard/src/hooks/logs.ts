import { useEffect, useRef, useState } from 'react'
import { streamLiveLogs, type LogEntry } from '@/lib/api'
import {
  afterClear,
  clearedAtFor,
  mergeEntry,
  openTabLogStore,
  type StoredLog,
  type TabLogStore,
} from '@/lib/log-storage'

export type LogStreamStatus = 'connecting' | 'live' | 'error'

/** Writes are coalesced: a reconnect replays up to fifty entries in one burst. */
const SAVE_DELAY_MS = 200

/**
 * Subscribes to a project's live request log for as long as the component is
 * mounted. Deliberately not TanStack Query: this is a push stream, not a
 * cacheable fetch, and Query's refetch/retry model would reopen it constantly.
 *
 * Starts from this tab's stored copy (lib/log-storage) and merges the stream
 * into it, so what was on screen survives a reload, a trip to the Editor, and
 * the core dropping its ring. Only mounted by the Logs pane, so the copy is
 * only ever written while Logs is open.
 *
 * Reconnects with a fixed backoff if the stream drops (a redeployed core, a
 * proxy timeout), and keeps the newest LOG_ENTRY_CAP entries so a chatty
 * tenant can't grow the tab's memory without bound.
 */
export function useLiveLogs(tenantId: string | undefined) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [status, setStatus] = useState<LogStreamStatus>('connecting')
  // The stream callback and clear() read these without re-subscribing.
  const log = useRef<StoredLog>({ entries: [], clearedAt: null })
  const store = useRef<TabLogStore | null>(null)

  useEffect(() => {
    if (!tenantId) return

    const ctrl = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const tabStore = openTabLogStore(tenantId)
    store.current = tabStore

    log.current = tabStore.load()
    setEntries(log.current.entries)
    setStatus('connecting')

    const save = () => {
      saveTimer = undefined
      tabStore.save(log.current)
    }

    const connect = () => {
      streamLiveLogs(
        tenantId,
        (entry) => {
          if (ctrl.signal.aborted) return
          setStatus('live')
          if (!afterClear(entry, log.current.clearedAt)) return
          const next = mergeEntry(log.current.entries, entry)
          if (next === log.current.entries) return // replayed, already shown
          log.current = { ...log.current, entries: next }
          setEntries(next)
          saveTimer ??= setTimeout(save, SAVE_DELAY_MS)
        },
        ctrl.signal,
      )
        .then(() => {
          if (!ctrl.signal.aborted) retry = setTimeout(connect, 2_000) // clean EOF
        })
        .catch(() => {
          if (ctrl.signal.aborted) return
          setStatus('error')
          retry = setTimeout(connect, 3_000)
        })
    }
    connect()

    return () => {
      ctrl.abort()
      if (retry) clearTimeout(retry)
      // Flush what is pending. After a logout this store is disarmed, so the
      // flush cannot put the logs back.
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        save()
      }
      if (store.current === tabStore) store.current = null
    }
  }, [tenantId])

  /**
   * Empties the pane and this tab's copy, and remembers where the cut was so
   * the core's replay on the next connect cannot bring the entries back. The
   * core's own ring is untouched.
   */
  const clear = () => {
    log.current = {
      entries: [],
      clearedAt: clearedAtFor(log.current.entries, log.current.clearedAt),
    }
    setEntries([])
    store.current?.save(log.current)
  }

  return { entries, status, clear }
}
