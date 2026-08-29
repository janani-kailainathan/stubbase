// Cross-app URLs. Overridable per build mode (see .env.docker for the local
// Caddy stack); production defaults are the canonical domains.
export const APP_URL: string = import.meta.env.PUBLIC_APP_URL ?? 'https://app.stubbase.dev'
export const CORE_URL: string = import.meta.env.PUBLIC_CORE_URL ?? 'https://api.stubbase.dev'

// Google's OAuth client id, for the One Tap prompt on Home. Public by design —
// it is the `aud` the Dashboard API checks a returned ID token against, not a
// secret (that is DASHBOARD_GOOGLE_SECRET, which stays server-side). Empty is
// the deliberate default: an unconfigured deployment renders no prompt and
// loads nothing from Google, rather than shipping a broken one.
export const GOOGLE_CLIENT_ID: string = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID ?? ''
