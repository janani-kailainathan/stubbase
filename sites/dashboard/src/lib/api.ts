/**
 * HTTP client for the two Bun backends.
 *
 * - Dashboard API (projects/billing):  APP_API_URL  → api.app.stubbase.dev
 * - Core Tenant Engine (JSON CRUD):    CORE_API_URL → api.stubbase.dev
 *
 * In dev both default to same-origin paths proxied by Vite (see
 * vite.config.ts) so the browser never makes a cross-origin call.
 * Production cross-origin calls additionally require CORS headers on the
 * backends/Caddy — not shipped yet.
 */

import { setSignedInHint } from '@/lib/cross-site'

const DEV = import.meta.env.DEV

export const APP_API_URL: string =
  import.meta.env.VITE_APP_API_URL ?? (DEV ? '/api/app' : 'https://api.app.stubbase.dev')
export const CORE_API_URL: string =
  import.meta.env.VITE_CORE_API_URL ?? (DEV ? '/api/core' : 'https://api.stubbase.dev')
/**
 * Public base used for display (endpoint docs, curl samples). Defaults to the
 * actual call URL when that's absolute (e.g. the .localhost Docker stack), so
 * displayed URLs are copy-paste-able there; falls back to the production
 * domain in dev mode where CORE_API_URL is a relative proxy path.
 */
export const CORE_PUBLIC_URL: string =
  import.meta.env.VITE_CORE_PUBLIC_URL ??
  (CORE_API_URL.startsWith('http') ? CORE_API_URL : 'https://api.stubbase.dev')
/**
 * Public base of the *Dashboard API*, for display only — the MCP URL a user
 * pastes into an external agent's config. Same trick as CORE_PUBLIC_URL: prefer
 * the real call URL when it's absolute, else the production domain, because in
 * dev APP_API_URL is a relative Vite proxy path that no desktop app could
 * resolve.
 */
export const APP_PUBLIC_URL: string =
  import.meta.env.VITE_APP_PUBLIC_URL ??
  (APP_API_URL.startsWith('http') ? APP_API_URL : 'https://api.app.stubbase.dev')
/** The marketing site (auth pages link back to it). */
export const LANDING_URL: string = import.meta.env.VITE_LANDING_URL ?? 'https://stubbase.dev'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Session token for the Dashboard API. Owned by the auth store (which also
// persists it); kept here so every request can attach it without an import
// cycle between this module and the store.
//
// This is also the one place every session path converges — login, signup, the
// OAuth callback, rehydration, logout and the 401 handler — so the landing
// site's "someone is signed in" hint cookie is published from here rather than
// from each caller, where one missed path would leave the two disagreeing.
let authToken: string | null = null
export const setAuthToken = (token: string | null) => {
  authToken = token
  setSignedInHint(token !== null)
}

// Called when the Dashboard API rejects the session (expired/revoked) so the
// auth store can log out. Registered by the store module.
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && url.startsWith(APP_API_URL) && !url.includes('/auth/')) {
      onUnauthorized?.()
    }
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

function appHeaders(hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (hasBody) headers['content-type'] = 'application/json'
  if (authToken) headers.authorization = `Bearer ${authToken}`
  return headers
}

// ── Dashboard API: auth ───────────────────────────────────────────

/** Capabilities a plan unlocks. Mirrors the Feature union in server-app.ts. */
export type PlanFeature = 'chaos' | 'auth' | 'webhooks' | 'ai'

/**
 * The signed-in account, with its plan already resolved by the server.
 *
 * `features` and `monthlyRequests` arrive rather than being looked up here on
 * purpose: the browser must never hold its own copy of the plan table, because
 * a stale copy would disagree with the side that actually enforces. Everything
 * the UI does with these is presentational — the server refuses the call
 * regardless of what the SPA believes.
 */
export interface ApiUser {
  id: number
  email: string
  name: string | null
  plan: string
  planName: string
  monthlyRequests: number
  features: PlanFeature[]
}

export interface AuthResponse {
  token: string
  user: ApiUser
}

export const signup = (email: string, password: string, name?: string) =>
  request<AuthResponse>(`${APP_API_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  })

export const login = (email: string, password: string) =>
  request<AuthResponse>(`${APP_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

export const logout = () =>
  request<{ ok: boolean }>(`${APP_API_URL}/auth/logout`, {
    method: 'POST',
    headers: appHeaders(),
  })

export const me = () => request<{ user: ApiUser }>(`${APP_API_URL}/auth/me`, { headers: appHeaders() })

export type OauthProvider = 'google' | 'github'

/**
 * Where to send the browser to start an OAuth sign-in. Deliberately a URL for
 * a top-level navigation rather than a fetch: the flow is a chain of redirects
 * through the provider, which no XHR could follow.
 */
export const oauthStartUrl = (provider: OauthProvider) => `${APP_API_URL}/auth/${provider}`

/** Which sign-in buttons the backend actually holds credentials for. */
export const authProviders = () =>
  request<Record<OauthProvider, boolean>>(`${APP_API_URL}/auth/providers`)

// ── Dashboard API: projects ───────────────────────────────────────

export interface ProjectRow {
  tenant_id: string
  name: string
  resources: string[]
  created_at: string
}

export interface CreatedProject {
  tenantId: string
  name: string
  resources: string[]
  apiBase: string
}

export const listProjects = () =>
  request<ProjectRow[]>(`${APP_API_URL}/projects`, { headers: appHeaders() })

// `resources` is optional — the Dashboard API seeds a single `items` resource
// when it is omitted, and more can be added from the sidebar afterwards.
export const createProject = (name: string, resources?: Record<string, unknown[]>) =>
  request<CreatedProject>(`${APP_API_URL}/projects`, {
    method: 'POST',
    headers: appHeaders(true),
    body: JSON.stringify(resources ? { name, resources } : { name }),
  })

export const renameProject = (tenantId: string, name: string) =>
  request<ProjectRow>(`${APP_API_URL}/projects/${tenantId}`, {
    method: 'PATCH',
    headers: appHeaders(true),
    body: JSON.stringify({ name }),
  })

export const deleteProject = (tenantId: string) =>
  request<{ ok: boolean; tenantId: string }>(`${APP_API_URL}/projects/${tenantId}`, {
    method: 'DELETE',
    headers: appHeaders(),
  })

// ── Core Tenant Engine ────────────────────────────────────────────

/** Matches the server-side NAME_RE for tenant ids and resource names. */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/**
 * Editor read path: goes through the authed files proxy, which prefers the
 * draft (draft_<name>.json) over the deployed file — the editor always shows
 * staged state. The Live tab (`runGet`) still hits the public CRUD plane.
 */
export const fetchResource = (tenantId: string, resource: string) =>
  request<unknown[]>(`${APP_API_URL}/projects/${tenantId}/files/${resource}`, {
    headers: appHeaders(),
  })

/**
 * Create or replace a resource file wholesale. Goes through the Dashboard
 * API's authenticated files proxy so ADMIN_SECRET stays server-side.
 */
export const saveResourceFile = (tenantId: string, resource: string, data: unknown[]) =>
  request<{ ok: boolean; records: number }>(
    `${APP_API_URL}/projects/${tenantId}/files/${resource}`,
    {
      method: 'PUT',
      headers: appHeaders(true),
      body: JSON.stringify(data),
    },
  )

/**
 * Tenant config (the .env editor's storage). Not a CRUD resource — the core
 * hides it from the public plane, so reads also go through the files proxy.
 */
export const fetchTenantConfig = (tenantId: string) =>
  request<Record<string, string>>(`${APP_API_URL}/projects/${tenantId}/files/config`, {
    headers: appHeaders(),
  })

export const saveTenantConfig = (tenantId: string, config: Record<string, string>) =>
  request<{ ok: boolean; records: number }>(`${APP_API_URL}/projects/${tenantId}/files/config`, {
    method: 'PUT',
    headers: appHeaders(true),
    body: JSON.stringify(config),
  })

export const deleteResourceFile = (tenantId: string, resource: string) =>
  request<{ ok: boolean; deleted: boolean }>(
    `${APP_API_URL}/projects/${tenantId}/files/${resource}`,
    {
      method: 'DELETE',
      headers: appHeaders(),
    },
  )

/** Promote every draft file over its production equivalent. */
export const deployProject = (tenantId: string) =>
  request<{ ok: boolean; promoted: string[] }>(`${APP_API_URL}/projects/${tenantId}/deploy`, {
    method: 'POST',
    headers: appHeaders(),
  })

export type ProjectStatus = 'active' | 'stopped' | 'maintenance'

/** Start/stop the virtual server (applies immediately, drafts and live). */
export const setProjectStatus = (tenantId: string, status: ProjectStatus) =>
  request<{ ok: boolean; status: ProjectStatus }>(`${APP_API_URL}/projects/${tenantId}/status`, {
    method: 'POST',
    headers: appHeaders(true),
    body: JSON.stringify({ status }),
  })

// ── Usage analytics ───────────────────────────────────────────────

export interface UsageDay {
  date: string
  request_count: number
  bandwidth_bytes: number
}

export interface UsageResponse {
  tenantId: string
  month: { requests: number; bytes: number }
  daily: UsageDay[]
  /** The plan's monthly request allowance — what the core throttles against. */
  limit: number
}

export const fetchUsage = (tenantId: string) =>
  request<UsageResponse>(`${APP_API_URL}/projects/${tenantId}/usage`, { headers: appHeaders() })

// ── AI Co-Pilot ───────────────────────────────────────────────────

export interface GeneratedTable {
  name: string
  records: number
  fields: string[]
}

/** A tool the model asked the server to run. */
export interface FunctionCall {
  name: string
  args?: Record<string, unknown>
}

/** What the server's tool returned, wrapped the way the provider expects. */
export interface FunctionResponse {
  name: string
  response: { result?: Record<string, unknown> }
}

/**
 * One part of a turn. The index signature matters: the provider attaches
 * opaque metadata (Gemini signs its reasoning) that must survive the round
 * trip untouched, so parts are stored and re-sent verbatim rather than rebuilt.
 */
export interface ChatPart {
  text?: string
  functionCall?: FunctionCall
  functionResponse?: FunctionResponse
  [key: string]: unknown
}

export interface ChatTurn {
  role: 'user' | 'model' | 'function'
  parts: ChatPart[]
}

export interface CoPilotResponse {
  ok: boolean
  tenant: string
  provider: string
  model: string
  /** The assistant's prose answer for this turn. */
  text: string
  /** The full conversation, including tool turns — send it back next time. */
  messages: ChatTurn[]
  /** Names of the tools that ran, in order. */
  toolsUsed: string[]
  /** True when a tool changed server state the dashboard is showing. */
  changed: boolean
}

/**
 * One Co-Pilot turn. The whole conversation goes up each time (this API keeps
 * no server-side session), and comes back with the model's reply plus any tool
 * turns appended. A turn that runs tools makes several provider calls, so
 * 10–30s is normal.
 */
export const chatWithCoPilot = (tenantId: string, messages: ChatTurn[]) =>
  request<CoPilotResponse>(`${APP_API_URL}/projects/${tenantId}/ai/chat`, {
    method: 'POST',
    headers: appHeaders(true),
    body: JSON.stringify({ messages }),
  })

// ── Live runner ───────────────────────────────────────────────────

export interface RunResult {
  ok: boolean
  status: number
  latencyMs: number
  body: string
}

/** Fire a real GET at a tenant resource and time it. */
export async function runGet(tenantId: string, resource: string): Promise<RunResult> {
  const t0 = performance.now()
  const res = await fetch(`${CORE_API_URL}/${tenantId}/${resource}`)
  const body = await res.text()
  return { ok: res.ok, status: res.status, latencyMs: Math.round(performance.now() - t0), body }
}

// ── Live logs (SSE) ───────────────────────────────────────────────

export interface LogLifecycleStep {
  stage: string
  ok: boolean
  ms: number
  note?: string
}

export interface LogEntry {
  correlationId: string
  ts: string
  tenantId: string
  method: string
  path: string
  query: string
  status: number
  durationMs: number
  requestBody: string | null
  responseBody: string | null
  lifecycle: LogLifecycleStep[]
}

/**
 * Subscribes to the Dashboard API's live-log stream.
 *
 * Deliberately `fetch` + ReadableStream rather than `EventSource`: EventSource
 * cannot set an Authorization header, and the alternative — putting the session
 * token in the query string — would leak it into proxy and access logs.
 *
 * Resolves when the stream ends; abort the signal to stop it.
 */
export async function streamLiveLogs(
  tenantId: string,
  onEntry: (entry: LogEntry) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${APP_API_URL}/projects/${tenantId}/live-logs`, {
    headers: appHeaders(),
    signal,
  })
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.()
    throw new ApiError(res.status, `log stream unavailable (HTTP ${res.status})`)
  }
  if (!res.body) throw new ApiError(500, 'log stream returned no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    // SSE frames are separated by a blank line; the tail may be a partial frame.
    const frames = buffered.split('\n\n')
    buffered = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue // keep-alive comment (": ping")
      try {
        onEntry(JSON.parse(line.slice(6)) as LogEntry)
      } catch {
        // A truncated frame is not worth tearing the stream down for.
      }
    }
  }
}

// ── Diagnostics ───────────────────────────────────────────────────

export interface JsonSyntaxError {
  file: string
  message: string
}

export interface DiagnosticsResponse {
  tenantId: string
  syntaxErrors: JsonSyntaxError[]
  checked: number
}

export const fetchDiagnostics = (tenantId: string) =>
  request<DiagnosticsResponse>(`${APP_API_URL}/projects/${tenantId}/diagnostics`, {
    headers: appHeaders(),
  })

// ── Developer API keys (MCP) ──────────────────────────────────────

export interface DeveloperKey {
  id: number
  /** Leading characters of the key, so a listed key is identifiable. */
  prefix: string
  name: string | null
  createdAt: string
}

/** The create response — the only time the raw `key` is ever available. */
export interface CreatedDeveloperKey extends DeveloperKey {
  key: string
}

export const listDeveloperKeys = (tenantId: string) =>
  request<DeveloperKey[]>(`${APP_API_URL}/projects/${tenantId}/keys`, { headers: appHeaders() })

export const createDeveloperKey = (tenantId: string, name: string) =>
  request<CreatedDeveloperKey>(`${APP_API_URL}/projects/${tenantId}/keys`, {
    method: 'POST',
    headers: appHeaders(true),
    body: JSON.stringify({ name }),
  })

export const revokeDeveloperKey = (tenantId: string, id: number) =>
  request<{ ok: boolean }>(`${APP_API_URL}/projects/${tenantId}/keys/${id}`, {
    method: 'DELETE',
    headers: appHeaders(),
  })

/** The MCP endpoint an external agent connects to for this project. */
export const mcpUrl = (tenantId: string) => `${APP_PUBLIC_URL}/projects/${tenantId}/mcp/sse`

export interface EdgeProbe {
  status: number
  /** Network-level failure (CORS, DNS, offline) — no HTTP status came back. */
  unreachable: boolean
}

/**
 * Silent GET against the project's own public API, used by the Diagnostics tab
 * to surface edge failures (429 rate limit, 413 payload too large) that never
 * show up while editing files. Never throws — a dead endpoint is a result.
 */
export async function probeEdge(tenantId: string, resource: string): Promise<EdgeProbe> {
  try {
    const res = await fetch(`${CORE_API_URL}/${tenantId}/${resource}`, { method: 'GET' })
    return { status: res.status, unreachable: false }
  } catch {
    return { status: 0, unreachable: true }
  }
}
