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
// PROJECT_STATUS is deliberately absent: status is not a setting (it lives in
// the project's system/status.json), so a line for it here does nothing.
const KNOWN_KEYS = new Set([
  'QA_MODE',
  'AUTH_ENABLED',
  'AUTH_EMAIL_VERIFICATION',
  'AUTH_PUBLIC_ROUTES',
  'AUTH_JWT_TTL_SECONDS',
  'AUTH_REFRESH_TTL_SECONDS',
  'AUTH_OAUTH_REDIRECT',
  'AUTH_RESET_URL',
  'RBAC_ENABLED',
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

/**
 * Whether Google or GitHub sign-in is fully set up: both halves of at least one
 * pair, which is exactly what makes the core route /auth/google or /auth/github.
 * tests/starters.test.ts holds this against a real core.
 */
export function socialLoginConfigured(config: TenantConfig | undefined): boolean {
  const set = (key: string) => String(config?.[key] ?? '').trim() !== ''
  return (
    (set('AUTH_GOOGLE_CLIENT_ID') && set('AUTH_GOOGLE_SECRET')) ||
    (set('AUTH_GITHUB_CLIENT_ID') && set('AUTH_GITHUB_SECRET'))
  )
}

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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Set KEY=value in .env text: replace the live line, else uncomment the
 * template's `# KEY=…` line where it stands, else append. A new project's .env
 * lists every setting commented out, so uncommenting keeps a key in its
 * documented section.
 */
export function setEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const name = escapeRegExp(key)
  const live = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, 'm')
  if (live.test(text)) return text.replace(live, () => line)
  const commented = new RegExp(`^\\s*#\\s*${name}\\s*=.*$`, 'm')
  if (commented.test(text)) return text.replace(commented, () => line)
  return text.trim() ? `${text.replace(/\n+$/, '')}\n${line}` : line
}

/**
 * Merge settings into a stored config without letting its two copies disagree.
 *
 * The keys are what the core acts on; `__raw` is what the editor shows and
 * re-compiles on Save. Merging the keys alone would leave a setting live but
 * invisible — still commented out in the text — and the next Save from the
 * editor would silently switch it back off.
 */
export function mergeEnv(
  config: TenantConfig,
  patch: TenantConfig,
  options: { tenantBase?: string } = {},
): TenantConfig {
  const merged: TenantConfig = { ...config, ...patch }
  const raw = config[RAW_KEY]
  if (typeof raw !== 'string') return merged

  let text = Object.entries(patch).reduce((t, [key, value]) => setEnvLine(t, key, value), raw)
  // Switching auth on is when Google and GitHub become the next thing to set
  // up, so their lines come out of the comments — and into the keys as well,
  // so the object still says what the text compiles to.
  if (String(patch.AUTH_ENABLED ?? '').trim().toLowerCase() === 'true' && !socialLoginConfigured(merged)) {
    text = exposeSocialLogin(text, options.tenantBase)
    for (const key of SOCIAL_PROVIDERS.flatMap((p) => p.keys)) if (!(key in merged)) merged[key] = ''
  }
  merged[RAW_KEY] = text
  return merged
}

/** Where the .env's social login comments send an owner for the keys. Canonical: the text is stored with the project. */
export const OAUTH_KEYS_GUIDE = 'https://stubbase.dev/guides/google-github-oauth-keys'

const SOCIAL_PROVIDERS = [
  { name: 'Google', slug: 'google', keys: ['AUTH_GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_SECRET'] },
  { name: 'GitHub', slug: 'github', keys: ['AUTH_GITHUB_CLIENT_ID', 'AUTH_GITHUB_SECRET'] },
] as const

/**
 * Put the Google and GitHub key lines in front of the owner: uncommented and
 * empty, because they are what to fill in next and a commented line reads as
 * nothing to do. Empty is safe — the core routes a provider only when both its
 * values are non-empty (features/auth/config.ts), so nothing turns on early.
 *
 * A line that is already live is left exactly as it is. A commented template
 * line is uncommented where it stands, placeholder dropped, under the
 * template's own callback and guide comments. A .env without the lines gets a
 * block carrying those comments, naming this project's callback URLs when
 * `tenantBase` (the project's public API address) is known.
 */
export function exposeSocialLogin(text: string, tenantBase?: string): string {
  let out = text
  for (const provider of SOCIAL_PROVIDERS) {
    const missing: string[] = []
    for (const key of provider.keys) {
      const name = escapeRegExp(key)
      if (new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm').test(out)) continue
      const commented = new RegExp(`^\\s*#\\s*${name}\\s*=.*$`, 'm')
      if (commented.test(out)) out = out.replace(commented, () => `${key}=`)
      else missing.push(key)
    }
    if (missing.length === 0) continue
    const block = [
      `# ${provider.name} login: fill in both values, Save, then Deploy.`,
      ...(tenantBase
        ? [
            `# Register this callback URL in your ${provider.name} OAuth app:`,
            `#   ${tenantBase}/auth/${provider.slug}/callback`,
          ]
        : []),
      `# How to get the keys: ${OAUTH_KEYS_GUIDE}`,
      ...missing.map((key) => `${key}=`),
    ].join('\n')
    out = out.trim() ? `${out.replace(/\n+$/, '')}\n\n${block}\n` : `${block}\n`
  }
  return out
}

// ── Display masking (view mode only — edit mode shows real values) ─

const SECRET_KEY_RE = /(SECRET|TOKEN|_KEY|PASSWORD)/i

export function maskValue(key: string, value: string): string {
  // credentials embedded in URLs: scheme://user:password@host
  let v = value.replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1****@')
  // An empty secret stays empty: masked, an unfilled AUTH_GOOGLE_SECRET= would read as set.
  if (SECRET_KEY_RE.test(key) && v === value && v !== '')
    v = v.length > 11 ? `${v.slice(0, 8)}***` : '***'
  return v
}
