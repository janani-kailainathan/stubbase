/**
 * The Live tab's request model: which parts of a request to one of the
 * project's routes a user may change, and how those become a URL and headers.
 *
 * The route itself is not one of them. Method and path come from the endpoint
 * the APIs rail offered, so the playground can only ever call a route the rail
 * lists — the user fills in the record id, query params, the allowed headers
 * and the body, never the URL.
 *
 * React-free so tests/playground.test.ts can hold that guarantee without a
 * browser: whatever is typed into the id field, the request still lands on the
 * route that was shown.
 */

import type { Endpoint } from './endpoints'

export interface QueryParam {
  key: string
  value: string
  /** Unticked rows stay in the table but are not sent. Absent means sent. */
  enabled?: boolean
}

/** The four QA simulation headers, by their suffix after `x-stubbase-`. */
export const CHAOS_HEADERS = [
  { name: 'delay', hint: 'milliseconds to wait before answering' },
  { name: 'status', hint: 'answer with this status instead' },
  { name: 'error-rate', hint: '0–1, chance of a simulated 503' },
  { name: 'empty', hint: 'true answers a GET with no records' },
] as const

export type ChaosHeader = (typeof CHAOS_HEADERS)[number]['name']

/** Everything the user can edit about one endpoint's request. */
export interface PlaygroundInputs {
  id: string
  query: QueryParam[]
  body: string
  chaos: Partial<Record<ChaosHeader, string>>
}

export const hasBody = (endpoint: Endpoint) =>
  endpoint.method === 'POST' || endpoint.method === 'PUT'

/**
 * Query params only mean something on a read: list routes filter, sort and
 * paginate, and a single-record read still takes `_expand`. A write ignores
 * them, so they are not offered there.
 */
export const acceptsQuery = (endpoint: Endpoint) =>
  endpoint.kind === 'crud' && endpoint.method === 'GET'

/**
 * Why this id cannot be sent, or null when it can.
 *
 * Percent-encoding keeps a typed `/` inside the one path segment, but it cannot
 * stop the URL parser collapsing `.` and `..` segments before the request
 * leaves — `PUT …/users/..` would really be sent to `…/<tenant>/`, a different
 * route from the one on screen. Those two are refused rather than encoded.
 */
export function idProblem(id: string): string | null {
  if (id === '') return 'Enter the id of a record.'
  if (id === '.' || id === '..') return `"${id}" cannot be used as an id.`
  return null
}

/** The request path relative to the core's base URL: `/<tenant>/users/42`. */
export function requestPath(tenantId: string, endpoint: Endpoint, id: string): string {
  const path = endpoint.needsId
    ? endpoint.path.replace('{id}', encodeURIComponent(id))
    : endpoint.path
  return `/${tenantId}${path}`
}

/** `?key=value…` for a route that takes query params; empty for any other. */
export function requestQuery(endpoint: Endpoint, query: QueryParam[]): string {
  if (!acceptsQuery(endpoint)) return ''
  const params = new URLSearchParams()
  for (const { key, value, enabled } of query) {
    const name = key.trim()
    if (name && enabled !== false) params.append(name, value)
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * The headers a playground request carries. A fixed set, and it has to be:
 * the core's public preflight allows exactly `content-type`, `authorization`
 * and the four `x-stubbase-*` headers, and a browser refuses to send a
 * cross-origin request carrying anything else — the user would see a network
 * error instead of their API's answer.
 *
 * The token rides only when the deployed config has auth on, and the QA
 * headers only when it has QA_MODE on: the core ignores both otherwise, and a
 * header that does nothing should not look like it did something.
 */
export function requestHeaders(
  endpoint: Endpoint,
  inputs: Pick<PlaygroundInputs, 'chaos'>,
  options: { token: string; authEnabled: boolean; qaMode: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (hasBody(endpoint)) headers['content-type'] = 'application/json'
  const token = options.token.trim()
  if (options.authEnabled && token) headers.authorization = `Bearer ${token}`
  if (options.qaMode) {
    for (const { name } of CHAOS_HEADERS) {
      const value = inputs.chaos[name]?.trim()
      if (value) headers[`x-stubbase-${name}`] = value
    }
  }
  return headers
}

/**
 * The tenant token a successful signup or login answered with. The playground
 * adopts it so the protected routes can be tried next without copying it
 * across by hand.
 */
export function tokenFrom(endpoint: Endpoint, status: number, body: string): string | null {
  if (endpoint.kind !== 'auth' || status < 200 || status >= 300) return null
  try {
    const parsed: unknown = JSON.parse(body)
    const token = parsed && typeof parsed === 'object' ? (parsed as { token?: unknown }).token : null
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

const stringify = (data: unknown) => JSON.stringify(data, null, 2) ?? ''

/** A request body modelled on the resource's first record, minus its id. */
export function sampleRecordBody(records: unknown[] | undefined | null): string {
  const first = records?.[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const { id: _id, ...rest } = first as Record<string, unknown>
    if (Object.keys(rest).length > 0) return stringify(rest)
  }
  return stringify({ field: 'value' })
}

/** The ids of the given records, as the core compares them (stringified). */
export function recordIds(records: unknown[] | undefined | null, cap = 100): string[] {
  const ids: string[] = []
  for (const row of records ?? []) {
    if (ids.length >= cap) break
    const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined
    if (id !== undefined && id !== null) ids.push(String(id))
  }
  return ids
}

/**
 * Starting values for an endpoint nobody has edited yet: the first deployed
 * record's id, and a body shaped like the deployed records (or the documented
 * shape, for an auth route).
 */
export function initialInputs(
  endpoint: Endpoint,
  records: unknown[] | undefined | null,
): PlaygroundInputs {
  return {
    id: endpoint.needsId ? (recordIds(records, 1)[0] ?? '') : '',
    query: [],
    body: hasBody(endpoint)
      ? endpoint.sample?.request
        ? stringify(endpoint.sample.request)
        : sampleRecordBody(records)
      : '',
    chaos: {},
  }
}

/** Identifies one endpoint's playground state — path, not resource: auth holds two POSTs. */
export const playgroundKey = (tenantId: string, endpoint: Pick<Endpoint, 'method' | 'path'>) =>
  `${tenantId} ${endpoint.method} ${endpoint.path}`
