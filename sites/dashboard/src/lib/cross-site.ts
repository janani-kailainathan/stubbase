/**
 * State that has to cross the origin boundary between the marketing site
 * (`stubbase.dev`, static) and this SPA (`app.stubbase.dev`).
 *
 * localStorage is scoped to an *origin*, so neither app can read the other's
 * copy — which is why the landing nav kept offering "Login" to someone who was
 * already signed in, and why a theme picked on one side did not follow you to
 * the other. Cookies scope to the registrable domain instead, so a cookie
 * written here is readable by the landing pages and vice versa.
 *
 * Two cookies, both deliberately non-sensitive:
 *
 *   stubbase_theme    'light' | 'dark'   the chosen theme
 *   stubbase_session  '1'                a *hint* that a session exists
 *
 * The session cookie carries no token and authorises nothing; it exists so a
 * static page can render the right nav. The real session token stays in this
 * origin's localStorage, where the landing site cannot reach it — putting it in
 * a domain-wide cookie would hand every subdomain a bearer credential.
 *
 * A stale hint (the session expired server-side without the SPA noticing) costs
 * exactly one redirect to /login, after which the 401 handler logs out and
 * clears it. Its max-age tracks SESSION_TTL_DAYS so it usually expires on its
 * own first.
 *
 * Keep the cookie names, the domain rule and the theme values in step with the
 * two inline pre-paint scripts that also read them: index.html here, and
 * BaseLayout.astro on the landing site. Neither can import this module — both
 * run before any bundle exists — so the duplication is the price of no flash.
 */

const THEME_COOKIE = 'stubbase_theme'
const SESSION_COOKIE = 'stubbase_session'

const THEME_MAX_AGE = 60 * 60 * 24 * 365
/** Mirrors the Dashboard API's SESSION_TTL_DAYS, so the hint dies with the session. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 30

/**
 * The domain to scope a cookie to, so both apps see it.
 *
 *   app.stubbase.dev       → stubbase.dev        (also covers the apex)
 *   app.stubbase.localhost → stubbase.localhost  (the docker-compose stack)
 *   localhost              → null, host-only     (dev; cookies ignore the port,
 *                                                 so :5173 and :4321 already share)
 *
 * Returning null rather than a domain matters for a bare host: browsers reject
 * a Domain attribute that names a public suffix or an IP, and a rejected
 * Set-Cookie is silent.
 */
function crossSiteDomain(): string | null {
  const host = location.hostname
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return null
  const parts = host.split('.')
  if (parts.length < 2) return null
  return parts.slice(-2).join('.')
}

function writeCookie(name: string, value: string, maxAge: number) {
  const domain = crossSiteDomain()
  const attrs = [
    `${name}=${value}`,
    'path=/',
    `max-age=${maxAge}`,
    'samesite=lax',
    domain ? `domain=${domain}` : '',
    location.protocol === 'https:' ? 'secure' : '',
  ].filter(Boolean)
  document.cookie = attrs.join('; ')
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

export function readThemeCookie(): 'light' | 'dark' | null {
  const value = readCookie(THEME_COOKIE)
  return value === 'light' || value === 'dark' ? value : null
}

export function writeThemeCookie(theme: 'light' | 'dark') {
  writeCookie(THEME_COOKIE, theme, THEME_MAX_AGE)
}

/**
 * Publish (or retract) "someone is signed in" to the landing site. Called from
 * `setAuthToken`, which every session path already funnels through — login,
 * signup, the OAuth callback, rehydration and logout — so there is no route by
 * which the hint and the token can disagree.
 */
export function setSignedInHint(signedIn: boolean) {
  writeCookie(SESSION_COOKIE, signedIn ? '1' : '', signedIn ? SESSION_MAX_AGE : 0)
}
