/**
 * The endpoint model behind the APIs rail: what a project's public API
 * exposes, derived from its resources and its deployed config.
 *
 * React-free on purpose — the rail renders it, the editor pane looks a
 * selection up in it, and `hooks/endpoints.ts` assembles it for the open
 * project.
 */

import type { TenantConfig } from '@/lib/env'
import type { Method } from '@/stores/workspace'

export interface Endpoint {
  /** The group this endpoint hangs under: a resource name, or `auth`. */
  resource: string
  method: Method
  /** Display path relative to the tenant base — unique across all endpoints. */
  path: string
  needsId: boolean
  /**
   * `auth` routes are served by the Core Engine itself, not by a JSON file:
   * there is no `auth.json` to read, so anything that would fetch the group's
   * records (the Response tab, the body sample) has to use `sample` instead.
   */
  kind: 'crud' | 'auth'
  /** Documented shapes, for endpoints with no resource file behind them. */
  sample?: { request?: object; response: object }
}

export function endpointsFor(resources: string[]): Endpoint[] {
  return resources.flatMap((resource): Endpoint[] => [
    { resource, method: 'GET', path: `/${resource}`, needsId: false, kind: 'crud' },
    { resource, method: 'POST', path: `/${resource}`, needsId: false, kind: 'crud' },
    { resource, method: 'PUT', path: `/${resource}/{id}`, needsId: true, kind: 'crud' },
    { resource, method: 'DELETE', path: `/${resource}/{id}`, needsId: true, kind: 'crud' },
  ])
}

/** What a signup or login answers with — `passwordHash` never leaves the core. */
const AUTH_RESPONSE = {
  token: '<jwt>',
  user: {
    id: '<uuid>',
    email: 'ada@example.com',
    name: 'Ada',
    role: 'user',
    createdAt: '<iso-8601>',
  },
}

/**
 * The tenant's auth plane. These two routes are not resources — they appear
 * and disappear with AUTH_ENABLED rather than with a file, which is why they
 * are a fixed list here instead of coming from the project's `resources`.
 */
export const AUTH_ENDPOINTS: Endpoint[] = [
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/signup',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { email: 'ada@example.com', password: 'at least 8 chars', name: 'Ada' },
      response: AUTH_RESPONSE,
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/login',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { email: 'ada@example.com', password: 'at least 8 chars' },
      response: AUTH_RESPONSE,
    },
  },
]

/**
 * Read AUTH_ENABLED exactly as the Core Engine does — anything but a literal
 * `true` is off, so the rail can never advertise a route that 404s.
 */
export const authEnabled = (config: TenantConfig | undefined) =>
  String(config?.AUTH_ENABLED ?? '')
    .trim()
    .toLowerCase() === 'true'

export interface EndpointGroup {
  resource: string
  endpoints: Endpoint[]
}

/** Group the endpoints of a project, given its resources and its live config. */
export function groupEndpoints(
  resources: string[],
  config: TenantConfig | undefined,
): EndpointGroup[] {
  const groups = resources.map((resource) => ({ resource, endpoints: endpointsFor([resource]) }))
  return authEnabled(config) ? [...groups, { resource: 'auth', endpoints: AUTH_ENDPOINTS }] : groups
}
