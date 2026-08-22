/**
 * The .env editor's parse/compile layer.
 *
 * The UI edits plain KEY=value text; on save it compiles to the tenant's
 * config.json (flat object of string values) written through the files proxy.
 * The raw text — comments, ordering, blank lines — rides along under the
 * `__raw` key so the editor round-trips faithfully; the Core Engine's
 * parseConfig() ignores keys it doesn't know.
 */

export type TenantConfig = Record<string, string>

export const RAW_KEY = '__raw'

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

export interface EnvParseResult {
  env: TenantConfig
  errors: { line: number; text: string }[]
}

export function parseEnvText(text: string): EnvParseResult {
  const env: TenantConfig = {}
  const errors: { line: number; text: string }[] = []
  text.split('\n').forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return
    const m = line.match(LINE_RE)
    if (!m) {
      errors.push({ line: i + 1, text: line.trim() })
      return
    }
    let value = m[2].trim()
    // strip one matching pair of surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    )
      value = value.slice(1, -1)
    env[m[1]] = value
  })
  return { env, errors }
}

/** Keys the Core Engine understands (see ENVIRONMENT.md). */
const KNOWN_KEYS = new Set([
  'PROJECT_STATUS',
  'QA_MODE',
  'AUTH_ENABLED',
  'AUTH_PUBLIC_ROUTES',
  'AUTH_JWT_TTL_SECONDS',
  'AUTH_OAUTH_REDIRECT',
  'AUTH_GOOGLE_CLIENT_ID',
  'AUTH_GOOGLE_SECRET',
  'AUTH_GITHUB_CLIENT_ID',
  'AUTH_GITHUB_SECRET',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM',
])

export const isKnownKey = (key: string) =>
  KNOWN_KEYS.has(key) ||
  /^HOOK_(BEFORE|AFTER)_(INSERT|UPDATE|DELETE)_[A-Z0-9_]+$/.test(key) ||
  /^SCHEMA_[A-Z0-9_]+$/.test(key)

/** Rebuild editor text from a stored config (preferring the raw round-trip). */
export function configToEnvText(config: TenantConfig): string {
  if (typeof config[RAW_KEY] === 'string') return config[RAW_KEY]
  return Object.entries(config)
    .filter(([k, v]) => k !== RAW_KEY && typeof v === 'string')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** Compile editor text into the config object sent to the files proxy. */
export function envTextToConfig(text: string): TenantConfig {
  return { ...parseEnvText(text).env, [RAW_KEY]: text }
}

// ── Display masking (view mode only — edit mode shows real values) ─

const SECRET_KEY_RE = /(SECRET|TOKEN|_KEY|PASSWORD)/i

export function maskValue(key: string, value: string): string {
  // credentials embedded in URLs: scheme://user:password@host
  let v = value.replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1****@')
  if (SECRET_KEY_RE.test(key) && v === value)
    v = v.length > 11 ? `${v.slice(0, 8)}***` : '***'
  return v
}
