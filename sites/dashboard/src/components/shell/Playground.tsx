import { Suspense, lazy, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, Copy, Lock, ScrollText, Send, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { CORE_PUBLIC_URL, runRequest } from '@/lib/api'
import { authEnabled, type Endpoint } from '@/lib/endpoints'
import { JsonHighlight } from '@/lib/json-highlight'
import {
  CHAOS_HEADERS,
  acceptsQuery,
  hasBody,
  idProblem,
  initialInputs,
  playgroundKey,
  recordIds,
  requestHeaders,
  requestPath,
  requestQuery,
  tokenFrom,
  type PlaygroundInputs,
  type QueryParam,
} from '@/lib/playground'
import { useLiveTenantConfig } from '@/hooks/config'
import { useLiveResource } from '@/hooks/resources'
import { isMac } from '@/hooks/save-shortcut'
import { useWorkspaceStore, type Method } from '@/stores/workspace'

/** CodeMirror is ~150kB gz — the same lazy chunk EditorPane loads for file editing. */
const JsonEditor = lazy(() => import('./JsonEditor'))

/** Query keys every list route understands; field names are added from the records. */
const LIST_PARAMS = ['_page', '_limit', '_offset', '_sort', '_direction', '_expand']

const SEND_HINT = isMac ? '⌘↵' : 'Ctrl+Enter'

/** Method colour, matching the APIs rail's badges so a route reads the same in both places. */
const METHOD_INK: Record<Method, string> = {
  GET: 'text-primary-ink',
  POST: 'text-info-ink',
  PUT: 'text-warning-emphasis',
  DELETE: 'text-danger-ink',
}

/** Reason phrases for the statuses the core (and its QA headers) actually produce. */
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  418: "I'm a teapot",
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** Same bands as the Logs pane, so a status reads the same colour in both. */
const statusInk = (status: number) =>
  status === 0 || status >= 500
    ? 'text-danger-ink'
    : status >= 400
      ? 'text-warning-ink'
      : status >= 300
        ? 'text-info-ink'
        : 'text-primary-ink'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MIN_SPLIT = 20
const MAX_SPLIT = 80
const clampSplit = (value: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value))

type RequestTab = 'path' | 'query' | 'auth' | 'headers' | 'body'
type ResponseTab = 'body' | 'headers'

/** A borderless input that fills its table cell — the cell draws the grid. */
const cellInput =
  'h-8 w-full min-w-0 bg-transparent px-2.5 font-mono text-xs text-emphasis outline-none placeholder:text-faint focus:bg-primary-soft-weak aria-[invalid=true]:text-danger-ink'

// ── Building blocks ───────────────────────────────────────────────

interface TabDef<T extends string> {
  id: T
  label: string
  badge?: React.ReactNode
}

/**
 * An underlined tab row, the API-client convention. Arrow keys move between
 * tabs, per the ARIA tabs pattern, so the strip is one stop in the tab order.
 */
function TabStrip<T extends string>({
  label,
  tabs,
  active,
  onChange,
}: {
  label: string
  tabs: TabDef<T>[]
  active: T
  onChange: (tab: T) => void
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const index = tabs.findIndex((t) => t.id === active)
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onChange(next.id)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex min-w-0 items-stretch gap-5 overflow-x-auto"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative flex shrink-0 cursor-pointer items-center gap-1.5 font-mono text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
              selected ? 'text-heading' : 'text-subtle hover:text-emphasis'
            }`}
          >
            {tab.label}
            {tab.badge}
            <span
              aria-hidden
              className={`absolute inset-x-0 bottom-0 h-0.5 rounded-full ${selected ? 'bg-primary' : ''}`}
            />
          </button>
        )
      })}
    </div>
  )
}

function PanelHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold text-body">{children}</h3>
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center font-mono text-xs text-muted-foreground">{children}</p>
}

/**
 * Key / Value grid with a narrow state column on the left (checkbox or lock)
 * and a narrow action column on the right, like every API client's params and
 * headers tables.
 */
function KeyValueTable({
  label,
  edges = true,
  children,
}: {
  label: string
  /** The state and action columns. A read-only table has neither, so it drops them. */
  edges?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded border border-border">
      <table aria-label={label} className="w-full table-fixed border-collapse">
        <colgroup>
          {edges && <col className="w-9" />}
          <col className="w-[36%]" />
          <col />
          {edges && <col className="w-9" />}
        </colgroup>
        <thead>
          <tr className="border-b border-border bg-panel text-left">
            {edges && (
              <th scope="col">
                <span className="sr-only">State</span>
              </th>
            )}
            <th
              scope="col"
              className={`px-2.5 py-2 text-xs font-semibold text-subtle ${edges ? 'border-l border-border' : ''}`}
            >
              Key
            </th>
            <th scope="col" className="border-l border-border px-2.5 py-2 text-xs font-semibold text-subtle">
              Value
            </th>
            {edges && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function KeyValueRow({
  lead,
  name,
  value,
  trail,
  edges = true,
}: {
  lead?: React.ReactNode
  name: React.ReactNode
  value: React.ReactNode
  trail?: React.ReactNode
  /** Must match the table's `edges`. */
  edges?: boolean
}) {
  return (
    <tr className="group border-b border-border last:border-b-0">
      {edges && <td className="text-center align-middle">{lead}</td>}
      <td className={`p-0 align-middle ${edges ? 'border-l border-border' : ''}`}>{name}</td>
      <td className="border-l border-border p-0 align-middle">{value}</td>
      {edges && <td className="text-center align-middle">{trail}</td>}
    </tr>
  )
}

/** A cell that shows a value rather than editing it. */
function CellText({ children, tone = 'text-body', title }: { children: React.ReactNode; tone?: string; title?: string }) {
  return (
    <div title={title} className={`flex h-8 items-center truncate px-2.5 font-mono text-xs ${tone}`}>
      <span className="truncate">{children}</span>
    </div>
  )
}

/** The lock on a row this request sets itself, which the user cannot change here. */
function Locked({ reason }: { reason: string }) {
  return (
    <span title={reason} className="inline-flex">
      <Lock aria-label={reason} className="h-3 w-3 text-faint" />
    </span>
  )
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/

/**
 * `field[op]` suggestions that fit what the records hold: `[contains]` for
 * text and lists of text, `[gte]` / `[lte]` for numbers and ISO dates.
 */
function operatorKeys(records: unknown[] | null | undefined): string[] {
  const text = new Set<string>()
  const range = new Set<string>()
  for (const row of (records ?? []).slice(0, 20)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    for (const [key, value] of Object.entries(row)) {
      if (key === 'id') continue
      if (typeof value === 'number' || (typeof value === 'string' && ISO_DATE_RE.test(value)))
        range.add(key)
      else if (typeof value === 'string' || (Array.isArray(value) && value.some((v) => typeof v === 'string')))
        text.add(key)
    }
  }
  return [
    ...[...text].map((key) => `${key}[contains]`),
    ...[...range].flatMap((key) => [`${key}[gte]`, `${key}[lte]`]),
  ]
}

/** Field names across the first records, for filter suggestions. */
function fieldNames(records: unknown[] | null | undefined): string[] {
  const names = new Set<string>()
  for (const row of (records ?? []).slice(0, 20)) {
    if (row && typeof row === 'object' && !Array.isArray(row))
      for (const key of Object.keys(row)) names.add(key)
  }
  return [...names]
}

// ── Request tabs ──────────────────────────────────────────────────

/** Only offered on routes with an `{id}` segment. */
function PathPanel({
  inputs,
  update,
  records,
  idError,
}: {
  inputs: PlaygroundInputs
  update: (patch: Partial<PlaygroundInputs>) => void
  records: unknown[] | null | undefined
  idError: string | null
}) {
  const domId = useId()
  return (
    <div>
      <KeyValueTable label="Path variables">
        <KeyValueRow
          name={<CellText>id</CellText>}
          value={
            <>
              <input
                value={inputs.id}
                onChange={(e) => update({ id: e.target.value })}
                list={`${domId}-ids`}
                placeholder="Value"
                aria-label="id"
                aria-invalid={idError !== null && inputs.id !== ''}
                spellCheck={false}
                className={cellInput}
              />
              <datalist id={`${domId}-ids`}>
                {recordIds(records).map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </>
          }
        />
      </KeyValueTable>
      {/* An empty id needs no sentence: the blank field and the tab's red dot
          already say it. Only an id that was typed and refused is explained. */}
      {idError && inputs.id !== '' && (
        <p className="mt-1.5 font-mono text-[11px] text-danger-ink">{idError}</p>
      )}
    </div>
  )
}

/** Only offered on reads — see `acceptsQuery`. */
function QueryPanel({
  endpoint,
  inputs,
  update,
  records,
}: {
  endpoint: Endpoint
  inputs: PlaygroundInputs
  update: (patch: Partial<PlaygroundInputs>) => void
  records: unknown[] | null | undefined
}) {
  const domId = useId()
  const setParam = (index: number, patch: Partial<QueryParam>) =>
    update({ query: inputs.query.map((p, i) => (i === index ? { ...p, ...patch } : p)) })
  // Typing into the blank last row turns it into a real one. It keeps the
  // same React key, so the input under the cursor is the same element and
  // focus stays where it was.
  const addParam = (patch: Partial<QueryParam>) =>
    update({ query: [...inputs.query, { key: '', value: '', enabled: true, ...patch }] })
  const suggestions = endpoint.needsId
    ? ['_expand']
    : [
        ...LIST_PARAMS,
        ...fieldNames(records).filter((f) => !LIST_PARAMS.includes(f)),
        ...operatorKeys(records),
      ]

  return (
    <div>
      <KeyValueTable label="Query params">
        {inputs.query.map((param, i) => (
          <KeyValueRow
            key={i}
            lead={
              <input
                type="checkbox"
                checked={param.enabled !== false}
                onChange={(e) => setParam(i, { enabled: e.target.checked })}
                aria-label={`Send ${param.key || 'this param'}`}
                className="h-3.5 w-3.5 cursor-pointer accent-primary"
              />
            }
            name={
              <input
                value={param.key}
                onChange={(e) => setParam(i, { key: e.target.value })}
                list={`${domId}-params`}
                placeholder="Key"
                aria-label="Param key"
                spellCheck={false}
                className={`${cellInput} ${param.enabled === false ? 'text-faint' : ''}`}
              />
            }
            value={
              <input
                value={param.value}
                onChange={(e) => setParam(i, { value: e.target.value })}
                placeholder="Value"
                aria-label="Param value"
                spellCheck={false}
                className={`${cellInput} ${param.enabled === false ? 'text-faint' : ''}`}
              />
            }
            trail={
              <button
                type="button"
                onClick={() => update({ query: inputs.query.filter((_, j) => j !== i) })}
                aria-label={`Remove ${param.key || 'param'}`}
                className="inline-flex cursor-pointer text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-emphasis focus-visible:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            }
          />
        ))}
        <KeyValueRow
          key={inputs.query.length}
          name={
            <input
              value=""
              onChange={(e) => addParam({ key: e.target.value })}
              list={`${domId}-params`}
              placeholder="Key"
              aria-label="New param key"
              spellCheck={false}
              className={cellInput}
            />
          }
          value={
            <input
              value=""
              onChange={(e) => addParam({ value: e.target.value })}
              placeholder="Value"
              aria-label="New param value"
              spellCheck={false}
              className={cellInput}
            />
          }
        />
      </KeyValueTable>
      <datalist id={`${domId}-params`}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  )
}

/** Only offered when the deployed config has auth on — see `requestTabs`. */
function AuthPanel({ token, onToken }: { token: string; onToken: (token: string) => void }) {
  const domId = useId()
  return (
    <div className="grid gap-5 @2xl:grid-cols-[13rem_minmax(0,1fr)]">
      <div>
        <PanelHeading>Auth Type</PanelHeading>
        <div className="flex h-8 items-center rounded border border-border bg-panel px-2.5 font-mono text-xs text-emphasis">
          Bearer Token
        </div>
      </div>
      <div>
        <label htmlFor={`${domId}-token`} className="mb-2 block text-xs font-semibold text-body">
          Token
        </label>
        <Input
          id={`${domId}-token`}
          value={token}
          onChange={(e) => onToken(e.target.value)}
          placeholder="Auto generated"
          spellCheck={false}
          autoComplete="off"
          // No focus ring: in a dense panel shadcn's 3px glow reads as an
          // alert. The border still turns --ring, which marks focus on its own.
          className="h-8 rounded font-mono text-xs placeholder:text-faint focus-visible:ring-0 md:text-xs"
        />
      </div>
    </div>
  )
}

function HeadersPanel({
  endpoint,
  auth,
  token,
  qaMode,
  inputs,
  update,
}: {
  endpoint: Endpoint
  auth: boolean
  token: string
  qaMode: boolean
  inputs: PlaygroundInputs
  update: (patch: Partial<PlaygroundInputs>) => void
}) {
  const trimmed = token.trim()

  // Only rendered when the route sends headers at all — see `needsHeaders`.
  return (
    <KeyValueTable label="Headers">
      {hasBody(endpoint) && (
        <KeyValueRow
          lead={<Locked reason="Set for a JSON body" />}
          name={<CellText tone="text-subtle">content-type</CellText>}
          value={<CellText tone="text-subtle">application/json</CellText>}
        />
      )}
      {/* Listed whenever auth is on, token or not: the tab must not appear
          only once a login has filled one in. */}
      {auth && (
        <KeyValueRow
          lead={<Locked reason="Set from the Authorization tab" />}
          name={<CellText tone="text-subtle">authorization</CellText>}
          value={
            <CellText tone={trimmed ? 'text-subtle' : 'text-faint'} title={trimmed ? `Bearer ${trimmed}` : undefined}>
              Bearer {trimmed}
            </CellText>
          }
        />
      )}
      {qaMode &&
        CHAOS_HEADERS.map(({ name, hint }) => (
          <KeyValueRow
            key={name}
            name={<CellText>{`x-stubbase-${name}`}</CellText>}
            value={
              <input
                value={inputs.chaos[name] ?? ''}
                onChange={(e) => update({ chaos: { ...inputs.chaos, [name]: e.target.value } })}
                placeholder={hint}
                aria-label={`x-stubbase-${name}`}
                spellCheck={false}
                className={cellInput}
              />
            }
          />
        ))}
    </KeyValueTable>
  )
}

// ── Response ──────────────────────────────────────────────────────

function ResponseEmpty({ sending }: { sending: boolean }) {
  return (
    <div className="flex h-full min-h-28 flex-col items-center justify-center gap-3 px-4 text-center">
      <Send
        strokeWidth={1.25}
        className={`h-9 w-9 ${sending ? 'animate-pulse text-primary-accent' : 'text-ghost'}`}
      />
      <p className="font-mono text-xs text-muted-foreground">
        {sending ? 'Sending request…' : 'Click Send to get a response'}
      </p>
    </div>
  )
}

// ── Playground ────────────────────────────────────────────────────

/**
 * The Live tab: send a real request to one of the project's routes and see
 * the deployed API's answer, laid out the way API clients are — a request bar,
 * tabs for what can be set, and a resizable response pane underneath.
 *
 * The route is fixed — method and path come from the endpoint the rail
 * offered, and only the record id, query params, the allowed headers and the
 * body are editable (lib/playground.ts). It calls the deployed API and nothing
 * else, so a resource the rail lists but the API does not route yet — saved,
 * never deployed — cannot be sent; everything that is sent is real traffic,
 * metered and logged like any other client's.
 */
export function Playground({ endpoint, tenantId }: { endpoint: Endpoint; tenantId: string }) {
  const queryClient = useQueryClient()
  const root = useRef<HTMLDivElement>(null)
  const key = playgroundKey(tenantId, endpoint)
  const isCrud = endpoint.kind === 'crud'
  const withBody = hasBody(endpoint)

  const [tab, setTab] = useState<RequestTab>(
    withBody ? 'body' : endpoint.needsId ? 'path' : 'query',
  )
  const [responseTab, setResponseTab] = useState<ResponseTab>('body')

  const live = useLiveResource(tenantId, isCrud ? endpoint.resource : undefined)
  const { data: liveConfig } = useLiveTenantConfig(tenantId)
  const auth = authEnabled(liveConfig)
  const qaMode = String(liveConfig?.QA_MODE ?? '').trim().toLowerCase() === 'true'

  const stored = useWorkspaceStore((s) => s.playgroundInputs[key])
  const run = useWorkspaceStore((s) => s.playgroundRuns[key])
  const token = useWorkspaceStore((s) => s.testTokens[tenantId]) ?? ''
  const split = useWorkspaceStore((s) => s.playgroundSplit)
  const collapsed = useWorkspaceStore((s) => s.playgroundCollapsed)
  const setPlaygroundInputs = useWorkspaceStore((s) => s.setPlaygroundInputs)
  const setTestToken = useWorkspaceStore((s) => s.setTestToken)
  const runPlayground = useWorkspaceStore((s) => s.runPlayground)
  const openLog = useWorkspaceStore((s) => s.openLog)
  const setSplit = useWorkspaceStore((s) => s.setPlaygroundSplit)
  const setCollapsed = useWorkspaceStore((s) => s.setPlaygroundCollapsed)

  const records = live.data
  const inputs = stored ?? initialInputs(endpoint, records)
  const update = (patch: Partial<PlaygroundInputs>) =>
    setPlaygroundInputs(key, { ...inputs, ...patch })

  // Only a resource can be missing from the deployed API. The auth routes are
  // listed from the deployed config itself, so whenever they show they are live.
  const checking = isCrud && live.isLoading
  const undeployed = isCrud && live.data === null
  const idError = endpoint.needsId ? idProblem(inputs.id) : null
  const loading = run?.status === 'loading'
  const blocked = checking || undeployed || idError !== null || loading

  const path = requestPath(tenantId, endpoint, inputs.id)
  const query = requestQuery(endpoint, inputs.query)
  const url = `${CORE_PUBLIC_URL}${endpoint.needsId && inputs.id === '' ? `/${tenantId}${endpoint.path}` : path}${query}`
  const headers = requestHeaders(endpoint, inputs, { token, authEnabled: auth, qaMode })

  const send = async () => {
    if (blocked) return
    const result = await runPlayground(key, () =>
      runRequest(`${path}${query}`, {
        method: endpoint.method,
        headers,
        body: withBody ? inputs.body : undefined,
      }),
    )
    const issued = tokenFrom(endpoint, result.status, result.body)
    if (issued) setTestToken(tenantId, issued)
    // A write through the public API changes the deployed file, which is also
    // what the editor shows whenever nothing is staged — refetch both rather
    // than keep showing the records from before this request.
    if (result.ok && endpoint.method !== 'GET')
      queryClient.invalidateQueries({
        queryKey: ['resource', tenantId, isCrud ? endpoint.resource : 'users'],
      })
  }

  // Captured before the body editor sees it: CodeMirror binds Mod-Enter to
  // "insert blank line", and sending must win wherever the focus is.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !(isMac ? e.metaKey : e.ctrlKey)) return
    e.preventDefault()
    e.stopPropagation()
    void send()
  }

  const copyUrl = () =>
    navigator.clipboard.writeText(url).then(
      () => toast.success('URL copied'),
      () => toast.error('Could not copy the URL'),
    )

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = root.current?.getBoundingClientRect()
    if (!box) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setSplit(clampSplit(((ev.clientY - box.top) / box.height) * 100))
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const onResizeKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    setSplit(clampSplit(split + (e.key === 'ArrowDown' ? 5 : -5)))
  }

  const hasQuery = inputs.query.some((p) => p.enabled !== false && p.key.trim() !== '')
  const headerCount = Object.keys(headers).length
  const dot = <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
  // A tab with nothing to set is not offered. Authorization needs auth on in
  // the deployed config; a route without a body has no Body tab; and one that
  // can send no headers — no JSON body, and neither auth nor QA_MODE deployed —
  // has no Headers tab. Every route keeps at least one: an id, a query or a body.
  const needsHeaders = withBody || auth || qaMode
  const requestTabs: TabDef<RequestTab>[] = [
    ...(endpoint.needsId
      ? [
          {
            id: 'path' as const,
            label: 'Path Variables',
            // Red while the id cannot be sent, so a disabled Send has a
            // visible reason from whichever tab is open.
            badge: idError ? (
              <>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger-solid" />
                <span className="sr-only">(needs attention)</span>
              </>
            ) : (
              dot
            ),
          },
        ]
      : []),
    ...(acceptsQuery(endpoint)
      ? [{ id: 'query' as const, label: 'Query Params', badge: hasQuery ? dot : undefined }]
      : []),
    ...(auth ? [{ id: 'auth' as const, label: 'Authorization' }] : []),
    ...(needsHeaders
      ? [
          {
            id: 'headers' as const,
            label: 'Headers',
            badge: headerCount > 0 ? <span className="text-primary-ink">({headerCount})</span> : undefined,
          },
        ]
      : []),
    ...(withBody
      ? [{ id: 'body' as const, label: 'Body', badge: inputs.body.trim() !== '' ? dot : undefined }]
      : []),
  ]
  // A deploy can retire a tab while it is open (QA_MODE switched off), so fall
  // back to the first one rather than render a tab the strip no longer offers.
  const activeTab = requestTabs.some((t) => t.id === tab) ? tab : requestTabs[0].id

  const result = run?.result
  const responseTabs: TabDef<ResponseTab>[] = [
    { id: 'body', label: 'Body' },
    {
      id: 'headers',
      label: 'Headers',
      badge: result?.headers.length ? <span className="text-primary-ink">({result.headers.length})</span> : undefined,
    },
  ]

  const [pathBefore, pathAfter] = endpoint.needsId ? endpoint.path.split('{id}') : [endpoint.path, '']

  return (
    <div
      ref={root}
      data-slot="playground"
      onKeyDownCapture={onKeyDownCapture}
      className="@container flex min-h-0 flex-1 flex-col"
    >
      {/* ── Request ─────────────────────────────────────────────── */}
      <div
        className="flex min-h-0 flex-col"
        style={collapsed ? { flex: '1 1 0%' } : { height: `${split}%` }}
      >
        <div className="shrink-0 px-4 pt-3">
          <div className="flex items-stretch gap-2">
            <div className="flex h-9 min-w-0 flex-1 items-stretch overflow-hidden rounded border border-border bg-panel">
              <span
                className={`flex w-20 shrink-0 items-center border-r border-border px-3 font-mono text-xs font-semibold ${METHOD_INK[endpoint.method]}`}
              >
                {endpoint.method}
              </span>
              <div
                title={url}
                aria-label="Request URL"
                className="flex min-w-0 flex-1 items-center truncate px-3 font-mono text-[13px] text-emphasis select-text"
              >
                <span className="truncate">
                  <span className="text-body">
                    {CORE_PUBLIC_URL}/{tenantId}
                  </span>
                  {pathBefore}
                  {endpoint.needsId &&
                    (inputs.id === '' ? (
                      <span className="text-faint">{'{id}'}</span>
                    ) : (
                      <span className="text-syntax-num">{encodeURIComponent(inputs.id)}</span>
                    ))}
                  {pathAfter}
                  {query && <span className="text-subtle">{query}</span>}
                </span>
              </div>
              <button
                type="button"
                onClick={copyUrl}
                aria-label="Copy URL"
                title="Copy URL"
                className="flex w-9 shrink-0 cursor-pointer items-center justify-center text-subtle transition-colors hover:text-emphasis focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={blocked}
              title={`Send (${SEND_HINT})`}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded bg-primary px-5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
          {undeployed && (
            <p className="mt-2 rounded-md border border-warning-soft-border bg-warning-soft px-3 py-2 font-mono text-xs text-warning-emphasis">
              <span className="font-semibold">{endpoint.resource}</span> is not deployed yet, so
              your live API has no route for it. Deploy to test it.
            </p>
          )}
        </div>

        <div className="mt-2 flex h-10 shrink-0 items-stretch border-b border-border px-4">
          <TabStrip label="Request" tabs={requestTabs} active={activeTab} onChange={setTab} />
        </div>

        {activeTab === 'body' && withBody ? (
          <div role="tabpanel" className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-border">
              <div className="flex h-8 shrink-0 items-center border-b border-border bg-panel px-2.5 font-mono text-[11px] text-subtle">
                raw · JSON
              </div>
              <Suspense
                fallback={
                  <div className="flex-1 bg-code-bg p-3 font-mono text-xs text-muted-foreground">
                    Loading editor&hellip;
                  </div>
                }
              >
                <JsonEditor
                  value={inputs.body}
                  onChange={(body) => update({ body })}
                  autoFocus={false}
                />
              </Suspense>
            </div>
          </div>
        ) : (
          <div role="tabpanel" className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {activeTab === 'path' && (
              <PathPanel inputs={inputs} update={update} records={records} idError={idError} />
            )}
            {activeTab === 'query' && (
              <QueryPanel endpoint={endpoint} inputs={inputs} update={update} records={records} />
            )}
            {activeTab === 'auth' && (
              <AuthPanel token={token} onToken={(t) => setTestToken(tenantId, t)} />
            )}
            {activeTab === 'headers' && (
              <HeadersPanel
                endpoint={endpoint}
                auth={auth}
                token={token}
                qaMode={qaMode}
                inputs={inputs}
                update={update}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Divider ─────────────────────────────────────────────── */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize request and response"
          aria-valuemin={MIN_SPLIT}
          aria-valuemax={MAX_SPLIT}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
          className="group relative z-10 h-0 shrink-0 cursor-row-resize outline-none"
        >
          <span aria-hidden className="absolute inset-x-0 -top-1.5 h-3" />
          <span
            aria-hidden
            className="absolute inset-x-0 -top-px h-0.5 transition-colors group-hover:bg-primary-soft-border-strong group-focus-visible:bg-primary"
          />
        </div>
      )}

      {/* ── Response ────────────────────────────────────────────── */}
      <section
        aria-label="Response"
        className={collapsed ? 'shrink-0' : 'flex min-h-0 flex-1 flex-col'}
      >
        <div className="flex h-10 shrink-0 items-stretch gap-5 border-t border-border px-4">
          <span className="flex shrink-0 items-center text-xs font-semibold text-body">Response</span>
          {result && !collapsed && (
            <TabStrip label="Response" tabs={responseTabs} active={responseTab} onChange={setResponseTab} />
          )}
          <span className="flex-1" />
          {result && (
            <div className="flex shrink-0 items-center gap-3 font-mono text-xs tabular-nums">
              <span data-slot="response-status" className={`font-semibold ${statusInk(result.status)}`}>
                {result.status === 0
                  ? 'No response'
                  : `${result.status} ${STATUS_TEXT[result.status] ?? ''}`.trim()}
              </span>
              <span className="text-subtle">{result.latencyMs} ms</span>
              {result.status !== 0 && (
                <span className="text-subtle">{formatBytes(new Blob([result.body]).size)}</span>
              )}
              {result.correlationId && (
                <button
                  type="button"
                  onClick={() => openLog(result.correlationId!)}
                  title={`Correlation id ${result.correlationId}`}
                  className="flex cursor-pointer items-center gap-1 text-subtle transition-colors hover:text-primary-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ScrollText className="h-3.5 w-3.5" />
                  Open in logs
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand response' : 'Collapse response'}
            className="flex shrink-0 cursor-pointer items-center text-subtle transition-colors hover:text-emphasis focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {!collapsed && (
          <div role="tabpanel" className={`min-h-0 flex-1 overflow-auto ${loading && result ? 'opacity-60' : ''}`}>
            {!result ? (
              <ResponseEmpty sending={loading} />
            ) : result.status === 0 ? (
              <p className="px-4 py-3 font-mono text-xs text-danger-ink">
                The request did not reach your API (offline, or blocked by the browser). {result.body}
              </p>
            ) : responseTab === 'headers' ? (
              <div className="px-4 py-3">
                {result.headers.length === 0 ? (
                  <PanelNote>No readable response headers.</PanelNote>
                ) : (
                  <KeyValueTable label="Response headers" edges={false}>
                    {result.headers.map(([name, value]) => (
                      <KeyValueRow
                        key={name}
                        edges={false}
                        name={<CellText>{name}</CellText>}
                        value={
                          <CellText tone="text-emphasis" title={value}>
                            {value}
                          </CellText>
                        }
                      />
                    ))}
                  </KeyValueTable>
                )}
              </div>
            ) : result.body ? (
              // w-max so the code ground extends under a long unbroken line
              // (a signup's JWT) instead of ending at the viewport edge.
              <div data-slot="response-body" className="min-h-full w-max min-w-full bg-code-bg px-4 py-3">
                <JsonHighlight raw={result.body} />
              </div>
            ) : (
              <PanelNote>Empty body.</PanelNote>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
