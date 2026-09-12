/**
 * Tenant ids and resource names: path-traversal-safe by construction.
 *
 * This is the only path-traversal defence — every id and name must pass it
 * before any filesystem path is built from it, in the core and in every feature.
 */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
