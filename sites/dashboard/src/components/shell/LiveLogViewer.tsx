import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowDown, CheckCircle2, Radio, Trash2 } from 'lucide-react'
import { useLiveLogs } from '@/hooks/logs'
import { useWorkspaceStore, type LogView } from '@/stores/workspace'
import type { LogEntry } from '@/lib/api'

const statusColor = (status: number) =>
  status >= 500
    ? 'text-danger-ink'
    : status >= 400
      ? 'text-warning-ink'
      : 'text-primary-ink'

/** One request, rendered per the active view. */
function LogRow({ entry, view }: { entry: LogEntry; view: LogView }) {
  const time = entry.ts.slice(11, 23)

  return (
    <div className="border-b border-border-soft px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] text-faint">{time}</span>
        <span className="shrink-0 rounded border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {entry.method}
        </span>
        <span className={`shrink-0 font-mono text-[10px] font-semibold ${statusColor(entry.status)}`}>
          {entry.status}
        </span>
        {/* The summary line stays one scannable row; the full URL is on hover
            and, unabridged, in the Raw/Pretty views below. */}
        <span
          title={`${entry.path}${entry.query}`}
          className="min-w-0 truncate font-mono text-xs text-body"
        >
          {entry.path}
          <span className="text-faint">{entry.query}</span>
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
          {entry.durationMs}ms
        </span>
      </div>

      {/* Long entries wrap rather than scroll: a per-row overflow container
          would clip the payload and give every row its own scrollbar, which
          makes the log unreadable exactly when it matters most. */}
      {view === 'raw' && (
        <pre className="mt-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-subtle">
          {JSON.stringify(entry)}
        </pre>
      )}

      {view === 'pretty' && (
        <pre className="mt-1.5 rounded-md border border-border bg-code-bg p-2.5 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(entry, null, 2)}
        </pre>
      )}

      {view === 'lifecycle' && (
        <div className="mt-2 flex flex-col gap-0">
          {entry.lifecycle.map((step, i) => (
            <div key={`${step.stage}-${i}`} className="flex items-start gap-2">
              <div className="flex flex-col items-center">
                {step.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary-accent" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger-solid" />
                )}
                {i < entry.lifecycle.length - 1 && (
                  <div className="my-0.5 h-3 w-px bg-muted" aria-hidden />
                )}
              </div>
              <div className="pb-1">
                <span
                  className={`font-mono text-[11px] ${step.ok ? 'text-muted-foreground' : 'text-danger-ink'}`}
                >
                  {step.stage}
                </span>
                <span className="ml-2 font-mono text-[10px] text-faint">{step.ms}ms</span>
                {step.note && (
                  <span
                    className={`ml-2 font-mono text-[10px] ${
                      step.ok ? 'text-faint' : 'text-danger-ink/80'
                    }`}
                  >
                    {step.note}
                  </span>
                )}
              </div>
            </div>
          ))}
          {entry.lifecycle.length === 0 && (
            <p className="font-mono text-[11px] text-faint">No pipeline stages recorded.</p>
          )}
        </div>
      )}
    </div>
  )
}

export function LiveLogViewer({ tenantId }: { tenantId: string | undefined }) {
  const { entries, status, clear } = useLiveLogs(tenantId)
  // The Raw/Pretty/Lifecycle tabs are rendered by the pane header, exactly like
  // the editor's Request/Response/Live, so the selection lives in the store.
  const view = useWorkspaceStore((s) => s.logView)
  const scroller = useRef<HTMLDivElement>(null)
  // Only auto-scroll while the user is already at the bottom — yanking the
  // viewport away mid-read is worse than missing the newest line.
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    if (!pinned) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, view, pinned])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <Radio
            className={`h-3 w-3 ${status === 'live' ? 'text-primary-accent' : status === 'error' ? 'text-danger-solid' : 'text-faint'}`}
          />
          <span className="text-subtle">
            {status === 'live' ? 'streaming' : status === 'error' ? 'reconnecting…' : 'connecting…'}
          </span>
        </span>

        <span className="flex-1" />
        {!pinned && (
          <button
            onClick={() => setPinned(true)}
            className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-subtle hover:text-emphasis"
          >
            <ArrowDown className="h-3 w-3" />
            Follow
          </button>
        )}
        <span className="font-mono text-[10px] text-faint">{entries.length}/50</span>
        <button
          onClick={clear}
          title="Clear the view (the server-side ring is untouched)"
          className="cursor-pointer text-faint hover:text-emphasis"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-center font-mono text-xs text-faint">
              No requests yet. Call your API and they will appear here live.
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <LogRow key={entry.correlationId} entry={entry} view={view} />
          ))
        )}
      </div>
    </div>
  )
}
