import { NAME_RE } from "../../lib/names.ts";
import type { AuthConfig } from "./types.ts";

const DEFAULT_JWT_TTL_SEC = 86_400;

/**
 * Reads the AUTH_* keys out of a tenant's flat config object. A malformed value
 * reads as unset rather than failing the tenant load.
 */
export function parseAuthConfig(env: Record<string, unknown>): AuthConfig {
  const str = (k: string) => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
  const pair = (idKey: string, secretKey: string) =>
    str(idKey) && str(secretKey) ? { clientId: str(idKey), secret: str(secretKey) } : undefined;
  return {
    enabled: str("AUTH_ENABLED").toLowerCase() === "true",
    publicRoutes: new Set(
      str("AUTH_PUBLIC_ROUTES")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => NAME_RE.test(s)),
    ),
    jwtTtlSec: Math.max(60, Number(str("AUTH_JWT_TTL_SECONDS")) || DEFAULT_JWT_TTL_SEC),
    oauthRedirect: str("AUTH_OAUTH_REDIRECT"),
    resetUrl: linkBase(str("AUTH_RESET_URL")),
    google: pair("AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_SECRET"),
    github: pair("AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_SECRET"),
  };
}

/** A link that goes into someone's inbox has to be an http(s) URL; anything else is dropped. */
function linkBase(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    /* fall through */
  }
  console.warn(`[core] AUTH_RESET_URL is not an http(s) URL, reset emails will carry the code only`);
  return "";
}
