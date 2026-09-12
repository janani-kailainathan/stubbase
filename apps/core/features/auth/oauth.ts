/**
 * OAuth (Google / GitHub) for a tenant's end users.
 *
 * Tenants bring their own OAuth app (client id/secret in config.json) and
 * register `<origin>/<tenant>/auth/<provider>/callback` with the provider
 * themselves. Endpoint bases are env-overridable so the local stack can point
 * them at mocks.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { err, json } from "../../lib/http.ts";
import { newTimestamps } from "../../lib/timestamps.ts";
import { EMAIL_RE, findByEmail, safeUser, type AuthContext } from "./identity.ts";
import type { AuthTenant, UserRecord } from "./types.ts";

interface OauthProvider {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  emailsUrl?: string;
  scope: string;
}

const OAUTH_PROVIDERS: Record<"google" | "github", OauthProvider> = {
  google: {
    authUrl: process.env.OAUTH_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.OAUTH_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    userUrl: process.env.OAUTH_GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
  },
  github: {
    authUrl: process.env.OAUTH_GITHUB_AUTH_URL ?? "https://github.com/login/oauth/authorize",
    tokenUrl: process.env.OAUTH_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
    userUrl: process.env.OAUTH_GITHUB_USER_URL ?? "https://api.github.com/user",
    emailsUrl: process.env.OAUTH_GITHUB_EMAILS_URL ?? "https://api.github.com/user/emails",
    scope: "read:user user:email",
  },
};
export type Provider = keyof typeof OAUTH_PROVIDERS;

// CSRF state: HMAC-signed timestamp, verified on callback, valid 10 minutes
function oauthState(key: Buffer): string {
  const ts = Date.now().toString();
  const sig = createHmac("sha256", key).update(`state:${ts}`).digest("base64url");
  return `${ts}.${sig}`;
}

function oauthStateValid(key: Buffer, s: string): boolean {
  const [ts, sig] = s.split(".");
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Date.now() - Number(ts) > 10 * 60_000) return false;
  const expected = createHmac("sha256", key).update(`state:${ts}`).digest();
  const given = Buffer.from(sig, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleOauth<T extends AuthTenant>(
  ctx: AuthContext<T>,
  provider: Provider,
  isCallback: boolean,
): Promise<Response> {
  const { req, tenantId, tenant, host, jwt } = ctx;
  const cfg = tenant.config.auth;
  const creds = provider === "google" ? cfg.google : cfg.github;
  if (!creds) return err(404, `${provider} oauth is not configured`);
  const p = OAUTH_PROVIDERS[provider];
  const redirectUri = `${host.requestOrigin(req)}/${tenantId}/auth/${provider}/callback`;
  const stateKey = jwt.key(tenantId);

  if (!isCallback) {
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: p.scope,
      state: oauthState(stateKey),
    });
    return new Response(null, { status: 302, headers: { location: `${p.authUrl}?${q}` } });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const st = url.searchParams.get("state") ?? "";
  if (!code || !oauthStateValid(stateKey, st)) return err(400, "missing or invalid oauth code/state");

  const tokenRes = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  }).catch(() => null);
  const tokenBody = tokenRes?.ok ? ((await tokenRes.json().catch(() => null)) as any) : null;
  const accessToken = tokenBody?.access_token;
  if (typeof accessToken !== "string") return err(502, "oauth code exchange failed");

  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "user-agent": "stubbase-core", // GitHub's API requires a User-Agent
  };
  const profRes = await fetch(p.userUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) }).catch(
    () => null,
  );
  const profile = profRes?.ok ? ((await profRes.json().catch(() => null)) as any) : null;
  if (!profile) return err(502, "oauth profile fetch failed");

  let email: unknown = profile.email;
  if (provider === "github" && typeof email !== "string" && p.emailsUrl) {
    const er = await fetch(p.emailsUrl, { headers: authHeaders, signal: AbortSignal.timeout(10_000) }).catch(
      () => null,
    );
    const list = er?.ok ? ((await er.json().catch(() => null)) as any[]) : null;
    if (Array.isArray(list)) email = (list.find((e) => e?.primary && e?.verified) ?? list[0])?.email;
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return err(502, "oauth profile has no usable email");

  let user = findByEmail(tenant.identity, email);
  if (!user) {
    const created: UserRecord = {
      id: crypto.randomUUID(),
      email,
      ...(typeof profile.name === "string" && profile.name ? { name: profile.name } : {}),
      role: host.defaultRole(tenant),
      provider,
      ...newTimestamps(),
    };
    tenant.identity.users.push(created);
    await host.saveUsers(tenantId, tenant);
    user = created;
  }
  const token = jwt.sign(tenantId, user, cfg.jwtTtlSec);
  if (cfg.oauthRedirect)
    return new Response(null, { status: 302, headers: { location: `${cfg.oauthRedirect}#token=${token}` } });
  return json({ token, user: safeUser(user) });
}
