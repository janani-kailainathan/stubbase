import { useEffect, useRef, useState } from 'react'
import { streamLiveLogs, type LogEntry } from '@/lib/api'

export type LogStreamStatus = 'connecting' | 'live' | 'error'

/** Mirrors the core's own ring size, so the UI can't outgrow the source. */
const CLIENT_LOG_CAP = 50

/**
 * Subscribes to a project's live request log for as long as the component is
 * mounted. Deliberately not TanStack Query: this is a push stream, not a
 * cacheable fetch, and Query's refetch/retry model would reopen it constantly.
 *
 * Reconnects with a fixed backoff if the stream drops (a redeployed core, a
 * proxy timeout), and drops the oldest entry past the cap so a chatty tenant
 * can't grow the tab's memory without bound.
 */
export function useLiveLogs(tenantId: string | undefined) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [status, setStatus] = useState<LogStreamStatus>('connecting')
  // Survives re-renders so a reconnect doesn't replay entries already shown:
  // the core replays its whole ring to every fresh connection.
  const seen = useRef(new Set<string>())

  useEffect(() => {
    if (!tenantId) return

    const ctrl = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    seen.current = new Set()
    setEntries([])
    setStatus('connecting')

    const connect = () => {
      streamLiveLogs(
        tenantId,
        (entry) => {
          if (seen.current.has(entry.correlationId)) return
          seen.current.add(entry.correlationId)
          setStatus('live')
          setEntries((prev) => [...prev, entry].slice(-CLIENT_LOG_CAP))
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
    }
  }, [tenantId])

  return { entries, status, clear: () => setEntries([]) }
}
