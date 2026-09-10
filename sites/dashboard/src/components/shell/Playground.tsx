import { Suspense, lazy, useId } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, ScrollText, Send, X } from 'lucide-react'
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
import { useWorkspaceStore } from '@/stores/workspace'

/** CodeMirror is ~150kB gz — the same lazy chunk EditorPane loads for file editing. */
const JsonEditor = lazy(() => import('./JsonEditor'))

/** Query keys every list route understands; field names are added from the records. */
const LIST_PARAMS = ['_page', '_limit', '_offset', '_sort', '_order', '_expand']

const inputClass = 'h-7 font-mono text-xs md:text-xs'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">{children}</div>
  )
}

/** A fixed name on the left, its editable (or fixed) value on the right. */
function HeaderRow({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 truncate font-mono text-xs text-subtle">{name}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  )
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

/**
 * The Live tab: send a real request to one of the project's routes and see
 * the deployed API's answer.
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
  const domId = useId()
  const key = playgroundKey(tenantId, endpoint)
  const isCrud = endpoint.kind === 'crud'

  const live = useLiveResource(tenantId, isCrud ? endpoint.resource : undefined)
  const { data: liveConfig } = useLiveTenantConfig(tenantId)
  const auth = authEnabled(liveConfig)
  const qaMode = String(liveConfig?.QA_MODE ?? '').trim().toLowerCase() === 'true'

  const stored = useWorkspaceStore((s) => s.playgroundInputs[key])
  const run = useWorkspaceStore((s) => s.playgroundRuns[key])
  const token = useWorkspaceStore((s) => s.testTokens[tenantId]) ?? ''
  const setPlaygroundInputs = useWorkspaceStore((s) => s.setPlaygroundInputs)
  const setTestToken = useWorkspaceStore((s) => s.setTestToken)
  const runPlayground = useWorkspaceStore((s) => s.runPlayground)
  const openLog = useWorkspaceStore((s) => s.openLog)

  const records = live.data
  const inputs = stored ?? initialInputs(endpoint, records)
  const update = (patch: Partial<PlaygroundInputs>) =>
    setPlaygroundInputs(key, { ...inputs, ...patch })
  const updateParam = (index: number, patch: Partial<QueryParam>) =>
    update({ query: inputs.query.map((p, i) => (i === index ? { ...p, ...patch } : p)) })

  // Only a resource can be missing from the deployed API. The auth routes are
  // listed from the deployed config itself, so whenever they show they are live.
  const checking = isCrud && live.isLoading
  const undeployed = isCrud && live.data === null
  const idError = endpoint.needsId ? idProblem(inputs.id) : null
  const loading = run?.status === 'loading'
  const blocked = checking || undeployed || idError !== null || loading

  const path = requestPath(tenantId, endpoint, inputs.id)
  const query = requestQuery(endpoint, inputs.query)
  const shownPath = endpoint.needsId && inputs.id === '' ? `/${tenantId}${endpoint.path}` : path
  const url = `${CORE_PUBLIC_URL}${shownPath}${query}`

  const send = async () => {
    if (blocked) return
    const result = await runPlayground(key, () =>
      runRequest(`${path}${query}`, {
        method: endpoint.method,
        headers: requestHeaders(endpoint, inputs, { token, authEnabled: auth, qaMode }),
        body: hasBody(endpoint) ? inputs.body : undefined,
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

  const suggestions = endpoint.needsId
    ? ['_expand']
    : [...LIST_PARAMS, ...fieldNames(records).filter((f) => !LIST_PARAMS.includes(f))]
  const result = run?.result
  const hasHeaders = hasBody(endpoint) || auth || qaMode

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-5 p-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[10px] text-primary-accent">
              {endpoint.method}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-emphasis" title={url}>
              {url}
            </span>
            <button
              onClick={send}
              disabled={blocked}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
          {undeployed && (
            <p className="rounded-md border border-warning-soft-border bg-warning-soft px-3 py-2 font-mono text-xs text-warning-emphasis">
              <span className="font-semibold">{endpoint.resource}</span> is not deployed yet, so
              your live API has no route for it. Deploy to test it.
            </p>
          )}
        </div>

        {endpoint.needsId && (
          <div>
            <SectionTitle>Path</SectionTitle>
            <HeaderRow name="id">
              <Input
                value={inputs.id}
                onChange={(e) => update({ id: e.target.value })}
                list={`${domId}-ids`}
                placeholder="record id"
                aria-invalid={idError !== null && inputs.id !== '' ? true : undefined}
                className={inputClass}
              />
              <datalist id={`${domId}-ids`}>
                {recordIds(records).map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </HeaderRow>
            {idError && <p className="mt-1.5 font-mono text-[11px] text-danger-ink">{idError}</p>}
          </div>
        )}

        {acceptsQuery(endpoint) && (
          <div>
            <SectionTitle>Query params</SectionTitle>
            <div className="space-y-1.5">
              {inputs.query.map((param, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={param.key}
                    onChange={(e) => updateParam(i, { key: e.target.value })}
                    list={`${domId}-params`}
                    placeholder="name"
                    className={`${inputClass} w-40 shrink-0`}
                  />
                  <Input
                    value={param.value}
                    onChange={(e) => updateParam(i, { value: e.target.value })}
                    placeholder="value"
                    className={inputClass}
                  />
                  <button
                    onClick={() => update({ query: inputs.query.filter((_, j) => j !== i) })}
                    title="Remove this param"
                    className="shrink-0 cursor-pointer text-faint hover:text-emphasis"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <datalist id={`${domId}-params`}>
                {suggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button
                onClick={() => update({ query: [...inputs.query, { key: '', value: '' }] })}
                className="flex cursor-pointer items-center gap-1 py-0.5 font-mono text-xs text-subtle hover:text-primary-accent"
              >
                <Plus className="h-3.5 w-3.5" />
                Add param
              </button>
            </div>
          </div>
        )}

        <div>
          <SectionTitle>Headers</SectionTitle>
          {hasHeaders ? (
            <div className="space-y-1.5">
              {hasBody(endpoint) && (
                <HeaderRow name="content-type">
                  <span className="font-mono text-xs text-syntax-str">application/json</span>
                </HeaderRow>
              )}
              {auth && (
                <HeaderRow name="authorization">
                  <span className="shrink-0 font-mono text-xs text-subtle">Bearer</span>
                  <Input
                    value={token}
                    onChange={(e) => setTestToken(tenantId, e.target.value)}
                    placeholder="token from /auth/login"
                    spellCheck={false}
                    className={inputClass}
                  />
                </HeaderRow>
              )}
              {qaMode &&
                CHAOS_HEADERS.map(({ name, hint }) => (
                  <HeaderRow key={name} name={`x-stubbase-${name}`}>
                    <Input
                      value={inputs.chaos[name] ?? ''}
                      onChange={(e) => update({ chaos: { ...inputs.chaos, [name]: e.target.value } })}
                      placeholder={hint}
                      className={inputClass}
                    />
                  </HeaderRow>
                ))}
            </div>
          ) : (
            <span className="font-mono text-xs text-faint">None required</span>
          )}
        </div>

        {hasBody(endpoint) && (
          <div>
            <SectionTitle>Body</SectionTitle>
            <div className="flex h-60 flex-col overflow-hidden rounded-md border border-border">
              <Suspense
                fallback={
                  <div className="flex-1 bg-code-bg p-3 font-mono text-xs text-faint">
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
        )}

        <div>
          <SectionTitle>Response</SectionTitle>
          {!result && (
            <p className="font-mono text-xs text-faint">
              {loading ? 'Sending request…' : 'Nothing sent yet.'}
            </p>
          )}
          {result && (
            <div className={`space-y-3 ${loading ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
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
                {result.totalCount !== null && (
                  <span className="font-mono text-xs text-subtle">
                    X-Total-Count: <span className="text-syntax-num">{result.totalCount}</span>
                  </span>
                )}
                <span className="flex-1" />
                {result.correlationId && (
                  <button
                    onClick={() => openLog(result.correlationId!)}
                    title={`Correlation id ${result.correlationId}`}
                    className="flex cursor-pointer items-center gap-1 px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-primary-accent"
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                    Open in logs
                  </button>
                )}
              </div>
              {result.status === 0 ? (
                <p className="font-mono text-xs text-danger-ink">
                  No response: the request did not reach your API (offline, or blocked by the
                  browser). {result.body}
                </p>
              ) : result.body ? (
                // Scrolls on its own: a signup's JWT is one unbreakable line,
                // and without this it drags the whole request form sideways.
                <div className="overflow-x-auto rounded-md border border-border bg-code-bg p-3">
                  <JsonHighlight raw={result.body} />
                </div>
              ) : (
                <p className="font-mono text-xs text-faint">Empty body.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
