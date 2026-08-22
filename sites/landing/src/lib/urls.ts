// Cross-app URLs. Overridable per build mode (see .env.docker for the local
// Caddy stack); production defaults are the canonical domains.
export const APP_URL: string = import.meta.env.PUBLIC_APP_URL ?? 'https://app.stubbase.dev'
export const CORE_URL: string = import.meta.env.PUBLIC_CORE_URL ?? 'https://api.stubbase.dev'
