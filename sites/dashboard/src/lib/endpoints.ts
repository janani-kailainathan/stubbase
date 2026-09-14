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
   * records (the body sample) has to use `sample` instead.
   */
  kind: 'crud' | 'auth'
  /** A documented request body, for endpoints with no resource file behind them. */
  sample?: { request: object }
  /** Served only while email verification is on — see `emailVerificationEnabled`. */
  verification?: boolean
}

export function endpointsFor(resources: string[]): Endpoint[] {
  return resources.flatMap((resource): Endpoint[] => [
    { resource, method: 'GET', path: `/${resource}`, needsId: false, kind: 'crud' },
    { resource, method: 'GET', path: `/${resource}/{id}`, needsId: true, kind: 'crud' },
    { resource, method: 'POST', path: `/${resource}`, needsId: false, kind: 'crud' },
    { resource, method: 'PUT', path: `/${resource}/{id}`, needsId: true, kind: 'crud' },
    { resource, method: 'DELETE', path: `/${resource}/{id}`, needsId: true, kind: 'crud' },
  ])
}

/**
 * The one account every auth sample uses, so a signup, then a login, a password
 * change or a reset all work in the playground without retyping anything. The
 * domain is example.com because it is reserved (RFC 2606) and can never be
 * somebody's inbox: a project with RESEND_API_KEY really sends these emails, and
 * a plausible-looking address on a real provider would put codes in a
 * stranger's mail. Without a key the code shows in the Logs tab.
 * tests/playground.test.ts sends every sample to a real core.
 */
const SAMPLE_EMAIL = 'testuser@example.com'
const SAMPLE_PASSWORD = 'password123'
const SAMPLE_NEW_PASSWORD = 'password456'

/**
 * The tenant's auth plane. These routes are not resources — they appear and
 * disappear with AUTH_ENABLED rather than with a file, which is why they are a
 * fixed list here instead of coming from the project's `resources`.
 */
export const AUTH_ENDPOINTS: Endpoint[] = [
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/signup',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { email: SAMPLE_EMAIL, password: SAMPLE_PASSWORD, name: 'Test User' },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/signup/verify',
    needsId: false,
    kind: 'auth',
    verification: true,
    sample: {
      request: { verificationId: 'the verificationId from signup', code: '123456' },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/signup/resend',
    needsId: false,
    kind: 'auth',
    verification: true,
    sample: {
      request: { verificationId: 'the verificationId from signup' },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/login',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { email: SAMPLE_EMAIL, password: SAMPLE_PASSWORD },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/refresh',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { refreshToken: 'the refreshToken from signup or login' },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/logout',
    needsId: false,
    kind: 'auth',
    // The bearer token names the session to end; a refreshToken here does too.
    sample: {
      request: {},
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/change-password',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { currentPassword: SAMPLE_PASSWORD, password: SAMPLE_NEW_PASSWORD },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/forgot-password',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { email: SAMPLE_EMAIL },
    },
  },
  {
    resource: 'auth',
    method: 'POST',
    path: '/auth/reset-password',
    needsId: false,
    kind: 'auth',
    sample: {
      request: { email: SAMPLE_EMAIL, code: '123456', password: SAMPLE_NEW_PASSWORD },
    },
  },
  // Account management — answered only for a role with `_users` rights in rbac.json.
  {
    resource: 'auth',
    method: 'GET',
    path: '/auth/users',
    needsId: false,
    kind: 'auth',
  },
  {
    resource: 'auth',
    method: 'PUT',
    path: '/auth/users/{id}/role',
    needsId: true,
    kind: 'auth',
    sample: {
      // `user` is a role in every project without rules; with rules, use one of yours.
      request: { role: 'user' },
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

/**
 * Read AUTH_EMAIL_VERIFICATION as the Core Engine does: on with auth unless it
 * is a literal `false`, so the verify routes show exactly while they are served.
 */
export const emailVerificationEnabled = (config: TenantConfig | undefined) =>
  authEnabled(config) &&
  String(config?.AUTH_EMAIL_VERIFICATION ?? '')
    .trim()
    .toLowerCase() !== 'false'

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
  if (!authEnabled(config)) return groups
  const verifying = emailVerificationEnabled(config)
  const auth = AUTH_ENDPOINTS.filter((endpoint) => verifying || !endpoint.verification)
  return [...groups, { resource: 'auth', endpoints: auth }]
}
