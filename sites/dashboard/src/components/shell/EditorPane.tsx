import { Suspense, lazy } from 'react'
import { toast } from 'sonner'
import { Check, RefreshCw, Rocket, X, Zap } from 'lucide-react'
import { CORE_PUBLIC_URL } from '@/lib/api'
import { JsonHighlight } from '@/lib/json-highlight'
import { useCurrentProject } from '@/hooks/projects'
import { useResource, useSaveResource } from '@/hooks/resources'
import { SAVE_HINT, useSaveShortcut } from '@/hooks/save-shortcut'
import { useWorkspaceStore, type EditorTab, type LogView, type Method } from '@/stores/workspace'
import { PaneTab, PaneTabs } from './pane-tabs'
import { endpointsFor, type Endpoint } from './ApisRail'
import { EnvActions, EnvView } from './EnvEditor'
import { AiChat, AiComposer } from './AiChat'
import { LiveLogViewer } from './LiveLogViewer'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { DeveloperKeysPanel } from './DeveloperKeysPanel'
import { StarterExamples } from './StarterExamples'
import { StagedChanges } from './StagedChanges'

/** CodeMirror is ~150kB gz — keep it off the initial route. */
const JsonEditor = lazy(() => import('./JsonEditor'))

function stringify(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? ''
}

/**
 * Turn a JSON.parse SyntaxError into a message that names the line, so the
 * toast points at the same spot as the editor's lint marker.
 */
function parseErrorMessage(text: string, err: unknown): string {
  const message = err instanceof Error ? err.message : 'Not valid JSON.'
  const at = /position (\d+)/.exec(message)
  if (!at) return message
  const upTo = text.slice(0, Number(at[1]))
  const line = upTo.split('\n').length
  const column = upTo.length - upTo.lastIndexOf('\n')
  // V8 says both "… in JSON at position N" and "… after JSON at position N",
  // and appends its own "(line X column Y)" — drop all of it, we say it better.
  const reason = message.replace(/\s*(?:in|after) JSON at position[\s\S]*$/, '')
  return `${reason} — line ${line}, column ${column}`
}

/** Sample record body derived from the resource's first record (minus id). */
function sampleBody(data: unknown[] | undefined): string {
  const first = data?.[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const { id: _id, ...rest } = first as Record<string, unknown>
    if (Object.keys(rest).length > 0) return stringify(rest)
  }
  return stringify({ field: 'value' })
}

// ── Edit / Save / Cancel (shared by file view and GET response tab) ─

function ResourceActions({ tenantId, resource }: { tenantId: string; resource: string }) {
  const editing = useWorkspaceStore((s) => s.editing)
  const draft = useWorkspaceStore((s) => s.draft)
  const startEdit = useWorkspaceStore((s) => s.startEdit)
  const stopEdit = useWorkspaceStore((s) => s.stopEdit)
  const { data, refetch, isFetching } = useResource(tenantId, resource)
  const save = useSaveResource(tenantId, resource)

  const onSave = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (err) {
      toast.error(parseErrorMessage(draft, err))
      return
    }
    if (!Array.isArray(parsed)) {
      toast.error('A resource file must be a JSON array of records.')
      return
    }
    save.mutate(parsed, {
      onSuccess: (res) => {
        stopEdit()
        toast.success(`Saved ${resource}.json (${res.records} record${res.records === 1 ? '' : 's'})`)
      },
      onError: (e) => toast.error(`Save failed: ${e.message}`),
    })
  }

  useSaveShortcut(editing && !save.isPending, onSave)

  // Reads are cached for 30s and only invalidated by writes made *here*, so a
  // record created through the project's own API — or by a teammate, or the
  // Co-Pilot — does not show up on its own. This is the manual way to go and
  // look. Deliberately absent while editing: refetching under an open editor
  // would either discard what has been typed or silently disagree with it.
  const onRefresh = () => {
    refetch().then((res) => {
      if (res.error) toast.error(`Could not refresh ${resource}.json: ${res.error.message}`)
    })
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={onRefresh}
          disabled={isFetching}
          title={`Reload ${resource}.json from the server`}
          className="flex cursor-pointer items-center gap-1 px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-primary-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        <button
          onClick={() => startEdit(stringify(data ?? []))}
          disabled={data === undefined}
          className="cursor-pointer px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-primary-accent disabled:opacity-50"
        >
          Edit
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={stopEdit}
        className="flex cursor-pointer items-center gap-1 px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={save.isPending}
        title={`Save (${SAVE_HINT})`}
        className="flex cursor-pointer items-center gap-1 rounded bg-primary px-2 py-1 font-mono text-xs text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        <Check className="h-3.5 w-3.5" />
        {save.isPending ? 'Saving…' : 'Save'}
        <span className="text-primary-foreground/50">{SAVE_HINT}</span>
      </button>
    </div>
  )
}

function ResourceView({ tenantId, resource }: { tenantId: string; resource: string }) {
  const editing = useWorkspaceStore((s) => s.editing)
  const draft = useWorkspaceStore((s) => s.draft)
  const changeDraft = useWorkspaceStore((s) => s.changeDraft)
  const { data, isLoading, error } = useResource(tenantId, resource)

  if (editing) {
    return (
      <Suspense
        fallback={
          <div className="min-h-0 flex-1 bg-code-bg p-4 font-mono text-xs text-faint">
            Loading editor&hellip;
          </div>
        }
      >
        <JsonEditor value={draft} onChange={changeDraft} />
      </Suspense>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-code-bg p-4">
      {isLoading && <p className="font-mono text-xs text-faint">Loading…</p>}
      {error && <p className="font-mono text-xs text-danger-ink">Could not load: {error.message}</p>}
      {data !== undefined && <JsonHighlight raw={stringify(data)} />}
    </div>
  )
}

// ── API endpoint tabs ─────────────────────────────────────────────

function TabButton({ tab, label }: { tab: EditorTab; label: string }) {
  const activeTab = useWorkspaceStore((s) => s.activeTab)
  const setTab = useWorkspaceStore((s) => s.setTab)
  return <PaneTab active={activeTab === tab} label={label} onClick={() => setTab(tab)} />
}

/** The Logs pane's sub-tabs — same widget, same header slot as TabButton. */
function LogTabButton({ view, label }: { view: LogView; label: string }) {
  const logView = useWorkspaceStore((s) => s.logView)
  const setLogView = useWorkspaceStore((s) => s.setLogView)
  return <PaneTab active={logView === view} label={label} onClick={() => setLogView(view)} />
}

function RequestView({ endpoint, tenantId }: { endpoint: Endpoint; tenantId: string }) {
  const { data } = useResource(tenantId, endpoint.resource)
  const hasBody = endpoint.method === 'POST' || endpoint.method === 'PUT'
  const url = `${CORE_PUBLIC_URL}/${tenantId}${endpoint.path}`

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[10px] text-primary-accent">
          {endpoint.method}
        </span>
        <span className="truncate font-mono text-sm text-emphasis">{url}</span>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">
          Headers
        </div>
        {hasBody ? (
          <div className="flex gap-2 font-mono text-xs">
            <span className="text-subtle">Content-Type:</span>
            <span className="text-syntax-str">application/json</span>
          </div>
        ) : (
          <span className="font-mono text-xs text-faint">None required</span>
        )}
      </div>
      {endpoint.method === 'GET' && (
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">
            Query params
          </div>
          <div className="space-y-1">
            {[
              ['_page', '1', 'page number, 1-based (default 10 per page)'],
              ['_limit', '20', 'rows per page'],
              ['_offset', '0', 'raw index alternative to _page'],
              ['_sort', 'price', 'field(s) to sort by, comma-separated'],
              ['_order', 'desc', 'asc (default) or desc'],
              ['_expand', 'users', 'nest the record referenced by <name>Id'],
              ['<field>', 'value', 'exact-match filter on any record field'],
            ].map(([name, value, note]) => (
              <div key={name} className="flex gap-2 font-mono text-xs">
                <span className="text-subtle">{name}:</span>
                <span className={name.startsWith('_') ? 'text-syntax-num' : 'text-syntax-str'}>
                  {value}
                </span>
                <span className="text-faint">— {note}</span>
              </div>
            ))}
            <div className="pt-1 font-mono text-xs text-faint">
              Total row count is returned in the X-Total-Count header.
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">Body</div>
        {hasBody ? (
          <div className="rounded-md border border-border bg-code-bg p-3">
            <JsonHighlight raw={sampleBody(data)} />
          </div>
        ) : (
          <span className="font-mono text-xs text-faint">No body</span>
        )}
      </div>
    </div>
  )
}

function curlFor(endpoint: Endpoint, tenantId: string, data: unknown[] | undefined): string {
  const url = `${CORE_PUBLIC_URL}/${tenantId}${endpoint.path.replace('{id}', '<id>')}`
  if (endpoint.method === 'POST' || endpoint.method === 'PUT') {
    const body = sampleBody(data).replace(/\n\s*/g, ' ')
    return `curl -X ${endpoint.method} ${url} \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`
  }
  return `curl -X ${endpoint.method} ${url}`
}

function LiveView({ endpoint, tenantId }: { endpoint: Endpoint; tenantId: string }) {
  const liveKey = `${tenantId}/${endpoint.resource}`
  const live = useWorkspaceStore((s) => s.live[liveKey]) ?? { status: 'idle' as const }
  const runLive = useWorkspaceStore((s) => s.runLive)
  const { data } = useResource(tenantId, endpoint.resource)

  if (endpoint.method !== 'GET') {
    return (
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <p className="font-mono text-xs text-subtle">
          Mutating requests run against your live data — fire them from your app, tests, or curl:
        </p>
        <div className="overflow-x-auto rounded-md border border-border bg-code-bg p-3">
          <pre className="font-mono text-xs leading-relaxed whitespace-pre text-body">
            {curlFor(endpoint, tenantId, data)}
          </pre>
        </div>
      </div>
    )
  }

  const result = live.status === 'done' ? live.result : undefined

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {live.status === 'idle' && (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <Zap className="h-8 w-8 text-ghost" />
          <span className="font-mono text-xs text-faint">No requests fired yet.</span>
          <button
            onClick={() => runLive(tenantId, endpoint.resource)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <Rocket className="h-3.5 w-3.5" />
            Run request
          </button>
        </div>
      )}
      {live.status === 'loading' && (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <Zap className="h-8 w-8 animate-pulse text-primary-accent" />
          <span className="font-mono text-xs text-subtle">Sending request&hellip;</span>
        </div>
      )}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span
              className={
                result.ok
                  ? 'rounded border border-primary-soft-border bg-primary-soft px-2 py-0.5 font-mono text-xs text-primary-ink'
                  : 'rounded border border-danger-soft-border bg-danger-soft px-2 py-0.5 font-mono text-xs text-danger-ink'
              }
            >
              {result.status || 'ERR'}
            </span>
            <span className="font-mono text-xs text-subtle">{result.latencyMs}ms</span>
            <span className="flex-1" />
            <button
              onClick={() => runLive(tenantId, endpoint.resource)}
              className="cursor-pointer px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-primary-accent"
            >
              Run again
            </button>
          </div>
          <div className="rounded-md border border-border bg-code-bg p-3">
            <JsonHighlight raw={result.body} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Pane ──────────────────────────────────────────────────────────

export function EditorPane() {
  const project = useCurrentProject()
  const selection = useWorkspaceStore((s) => s.selection)
  const activeTab = useWorkspaceStore((s) => s.activeTab)
  const paneMode = useWorkspaceStore((s) => s.paneMode)

  const tenantId = project?.tenantId

  const endpoint: Endpoint | undefined =
    selection?.kind === 'api' && project
      ? endpointsFor(project.resources).find(
          (e) => e.resource === selection.resource && (e.method as Method) === selection.method,
        )
      : undefined

  const label =
    selection?.kind === 'resource'
      ? `${selection.resource}.json`
      : selection?.kind === 'env'
        ? '.env'
        : endpoint && tenantId
          ? `${endpoint.method} /${tenantId}${endpoint.path}`
          : ''

  const aiMode = paneMode === 'ai'
  const logsMode = paneMode === 'logs'
  const diagnosticsMode = paneMode === 'diagnostics'
  const keysMode = paneMode === 'keys'
  // Editor chrome (file actions, request/response tabs) only applies to the
  // editor itself; the other panes own their whole surface.
  const editorMode = paneMode === 'editor'

  const paneLabel = aiMode
    ? 'AI chat'
    : logsMode
      ? 'Live logs'
      : diagnosticsMode
        ? 'Diagnostics & Health'
        : keysMode
          ? 'Developer API keys & MCP'
          : label

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        {/* The mode toggle lives in the top bar; name the mode here instead. */}
        <span className="truncate font-mono text-xs text-muted-foreground">{paneLabel}</span>
        {editorMode && (
          <div className="flex items-center gap-3">
            {selection?.kind === 'resource' && tenantId && (
              <ResourceActions tenantId={tenantId} resource={selection.resource} />
            )}
            {selection?.kind === 'env' && tenantId && <EnvActions tenantId={tenantId} />}
            {endpoint && (
              <PaneTabs>
                <TabButton tab="request" label="Request" />
                <TabButton tab="response" label="Response" />
                <TabButton tab="live" label="Live" />
              </PaneTabs>
            )}
          </div>
        )}
        {logsMode && (
          <PaneTabs>
            <LogTabButton view="raw" label="Raw" />
            <LogTabButton view="pretty" label="Pretty" />
            <LogTabButton view="lifecycle" label="Lifecycle" />
          </PaneTabs>
        )}
      </div>

      {/* Above every mode, not just the editor: an API serving stale data is
          worth knowing about while you are reading its logs or asking the
          Co-Pilot about it, not only while you are editing a file. */}
      <StagedChanges />

      {aiMode ? (
        <AiChat tenantId={tenantId} />
      ) : logsMode ? (
        <LiveLogViewer tenantId={tenantId} />
      ) : diagnosticsMode ? (
        <DiagnosticsPanel tenantId={tenantId} />
      ) : keysMode ? (
        <DeveloperKeysPanel tenantId={tenantId} />
      ) : (
        <>
          {!selection &&
            (tenantId && project?.resources.length === 0 ? (
              <StarterExamples tenantId={tenantId} />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <p className="font-mono text-xs text-faint">
                  {project ? 'Select a file or endpoint.' : 'Create a project to get started.'}
                </p>
              </div>
            ))}

          {selection?.kind === 'resource' && tenantId && (
            <ResourceView tenantId={tenantId} resource={selection.resource} />
          )}

          {selection?.kind === 'env' && tenantId && <EnvView tenantId={tenantId} />}

          {endpoint && tenantId && activeTab === 'request' && (
            <RequestView endpoint={endpoint} tenantId={tenantId} />
          )}
          {endpoint && tenantId && activeTab === 'response' && (
            <>
              {endpoint.method === 'GET' && (
                <div className="flex shrink-0 justify-end px-4 pt-3">
                  <ResourceActions tenantId={tenantId} resource={endpoint.resource} />
                </div>
              )}
              <ResourceView tenantId={tenantId} resource={endpoint.resource} />
            </>
          )}
          {endpoint && tenantId && activeTab === 'live' && (
            <LiveView endpoint={endpoint} tenantId={tenantId} />
          )}
        </>
      )}

      <AiComposer tenantId={tenantId} />
    </div>
  )
}
