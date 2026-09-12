/**
 * Stubbase Dashboard Backend
 *
 * Owns users/sessions/projects in SQLite. Passwords are argon2id via
 * Bun.password; sessions are opaque bearer tokens stored hashed. All file
 * writes to the Core Engine go through this service so ADMIN_SECRET never
 * reaches a browser.
 *
 * Routes (auth = `Authorization: Bearer <session token>`):
 *   GET    /                                    health
 *   POST   /auth/signup                         { email, password, name? }
 *   POST   /auth/login                          { email, password }
 *   POST   /auth/logout                         (auth)
 *   GET    /auth/me                             (auth)
 *   GET    /auth/providers                      which OAuth buttons to show
 *   GET    /auth/google|github[/callback]       OAuth sign-in (when configured)
 *   POST   /auth/google/one-tap                  Google One Tap (landing origin)
 *   GET    /projects                            (auth) list own projects
 *   POST   /projects                            (auth) { name, resources?: { [name]: any[] } }
 *   PATCH  /projects/<tenantId>                 (auth) { name } rename
 *   DELETE /projects/<tenantId>                 (auth) deprovision tenant + remove row
 *   PUT    /projects/<tenantId>/files/<res>     (auth) body = JSON array → create/replace file
 *   DELETE /projects/<tenantId>/files/<res>     (auth) delete file
 *   GET    /projects/<tenantId>/live-logs       (auth) SSE proxy of the core's request log
 *   GET    /projects/<tenantId>/diagnostics     (auth) JSON syntax health check
 *   POST   /projects/<tenantId>/ai/chat         (auth) { messages } AI Co-Pilot turn
 *   GET    /projects/<tenantId>/keys            (auth) list developer API keys
 *   POST   /projects/<tenantId>/keys            (auth) { name? } → raw key, shown once
 *   DELETE /projects/<tenantId>/keys/<id>       (auth) revoke a developer API key
 *
 * MCP (developer key, NOT a session token — external agents like Claude Desktop):
 *   GET    /projects/<tenantId>/mcp/sse         SSE proxy of the core's MCP stream
 *   POST   /projects/<tenantId>/mcp/message     JSON-RPC 2.0 inbox
 */
import { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  AIError,
  CO_PILOT_TOOLS,
  createAIService,
  type ChatPart,
  type ChatTurn,
  type FunctionCall,
} from "./ai/index.ts";

const PORT = Number(process.env.PORT ?? 3001);
const DB_PATH = process.env.DB_PATH ?? "./app.sqlite";
const CORE_API_URL = (process.env.CORE_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET;
// Browser origins allowed to call this API cross-origin (the dashboard SPA).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "https://app.stubbase.dev")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 1_048_576); // 1 MiB
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 30);
// Tenants the platform itself serves, which belong to no account and so must
// not be metered against one. `public` is the demo tenant behind the landing
// site's "Try it live" runner and its six free resources — quoting it the Free
// allowance would 429 the marketing site once every visitor together crossed
// 5,000 requests in a month.
const PLATFORM_TENANTS = new Set(
  (process.env.PLATFORM_TENANTS ?? "public")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
// Where the SPA lives — the only place an OAuth sign-in is ever bounced back
// to. Deliberately a constant and never a request parameter: a `?return_to=`
// on the callback would be an open redirect handing out session tokens.
const DASHBOARD_URL = (
  process.env.DASHBOARD_URL ??
  ALLOWED_ORIGINS[0] ??
  "https://app.stubbase.dev"
).replace(/\/$/, "");
// Where a tenant's API is reachable from the outside — not CORE_API_URL, which
// is how *this service* reaches the core (a private address in every
// deployment). Shown to users and told to the Co-Pilot, so it cites real URLs.
const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE ?? "https://api.stubbase.dev").replace(
  /\/$/,
  "",
);

// AI generation (optional). Malformed config fails the boot; a missing API key
// simply disables the feature, so deployments without AI still start.
let aiService: ReturnType<typeof createAIService>["service"] = null;
let aiDisabledReason = "";
try {
  const configured = createAIService();
  aiService = configured.service;
  aiDisabledReason = configured.reason ?? "";
} catch (e) {
  console.error(`[app] invalid AI configuration: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

if (!ADMIN_SECRET) {
  console.error("[app] ADMIN_SECRET is required");
  process.exit(1);
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

// OWASP argon2id baseline; memoryCost is KiB (19 MiB transient per hash),
// sized so a couple of concurrent logins stay comfortable on the 1GB box.
const ARGON = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;

// ── SQLite ────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    password_hash TEXT,          -- NULL for accounts created by OAuth
    oauth_provider TEXT,         -- provider that first created the row
    plan          TEXT NOT NULL DEFAULT 'free',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    tenant_id  TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    name       TEXT NOT NULL,
    resources  TEXT NOT NULL DEFAULT '[]',  -- JSON array of resource names
    dirty      INTEGER NOT NULL DEFAULT 0,  -- 1 when a draft is staged but not deployed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS api_usage (
    tenant_id       TEXT NOT NULL,
    date            TEXT NOT NULL,  -- YYYY-MM-DD
    request_count   INTEGER NOT NULL DEFAULT 0,
    bandwidth_bytes INTEGER NOT NULL DEFAULT 0,
    user_id         INTEGER,        -- account charged when counted; NULL for platform tenants
    PRIMARY KEY (tenant_id, date)
  );
  -- Long-lived developer keys: what an external MCP client (Claude Desktop,
  -- an IDE) authenticates with, instead of a browser session token.
  CREATE TABLE IF NOT EXISTS developer_api_keys (
    id         INTEGER PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES projects(tenant_id),
    key_hash   TEXT NOT NULL UNIQUE,  -- sha256 of the key; see hashApiKey()
    prefix     TEXT NOT NULL,         -- leading chars, so the UI can tell keys apart
    name       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS developer_api_keys_tenant ON developer_api_keys(tenant_id);
`);
// Migrate pre-auth databases (users table without the new columns).
const userCols = (db.query("PRAGMA table_info(users)").all() as { name: string }[]).map(
  (c) => c.name,
);
if (!userCols.includes("password_hash")) db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
if (!userCols.includes("name")) db.exec("ALTER TABLE users ADD COLUMN name TEXT");
// Which provider first created the row. Informational — the join between an
// OAuth identity and an account is the verified email address, never this.
if (!userCols.includes("oauth_provider"))
  db.exec("ALTER TABLE users ADD COLUMN oauth_provider TEXT");
// Whether a draft is staged but not yet deployed. Existing rows come back 0, so
// a project sitting on an undeployed draft right now reads clean until its next
// save — a one-time blind spot, and the alternative (assuming every project is
// dirty) would warn about changes most of them do not have.
const projectCols = (db.query("PRAGMA table_info(projects)").all() as { name: string }[]).map(
  (c) => c.name,
);
if (!projectCols.includes("dirty"))
  db.exec("ALTER TABLE projects ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0");
// Which account a usage row was charged to. The monthly allowance is one pool
// per account (see quotaFor), and a row has to remember its account itself:
// joining through `projects` would forget every project deleted this month,
// and deleting and recreating a project would reset the count. Existing rows
// are backfilled once from today's owners — a project already gone by then has
// no owner left to find — and platform tenants are never charged to anyone.
const usageCols = (db.query("PRAGMA table_info(api_usage)").all() as { name: string }[]).map(
  (c) => c.name,
);
if (!usageCols.includes("user_id")) {
  db.exec("ALTER TABLE api_usage ADD COLUMN user_id INTEGER");
  db.exec(
    `UPDATE api_usage SET user_id =
       (SELECT user_id FROM projects WHERE projects.tenant_id = api_usage.tenant_id)`,
  );
  const uncharge = db.query("UPDATE api_usage SET user_id = NULL WHERE tenant_id = ?");
  for (const tenantId of PLATFORM_TENANTS) uncharge.run(tenantId);
}
db.exec("CREATE INDEX IF NOT EXISTS api_usage_user_date ON api_usage(user_id, date)");

// ── Plans and entitlements ────────────────────────────────────────
//
// The three tiers the pricing page sells (sites/landing/src/pages/pricing.astro
// is the copy; this is the contract). There is no payment gateway yet, so a
// plan is set on the row — `UPDATE users SET plan = 'pro_ai' WHERE email = ?`
// — and scripts/seed-dev-users.ts creates one account per tier locally.
//
// This service owns the table because it owns users. The Core Engine is
// deliberately plan-blind: it is multi-tenant infrastructure that has never
// heard of an account, so it is told a *number* (this tenant's monthly request
// allowance) rather than a tier name. See the usage-flush reply below.
//
// Plans differ in one thing: the monthly request allowance, gated at REQUEST
// time in the core because that is the only thing in the traffic path. Every
// project feature — auth and roles, webhooks, QA mode — is on every plan, so
// nothing a project's .env or rbac.json can switch on is refused here. The one
// exception is the AI Co-Pilot, which costs money on every turn and stays on
// Pro + AI for now (see aiChat).

type PlanId = "free" | "pro" | "pro_ai";
/**
 * Capabilities a plan can unlock. Only the Co-Pilot: project features are the
 * same on every plan, which differ by request allowance alone.
 */
type Feature = "ai";

interface Plan {
  id: PlanId;
  name: string;
  monthlyRequests: number;
  features: readonly Feature[];
}

const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyRequests: 5_000,
    features: [],
  },
  pro: {
    id: "pro",
    name: "Pro QA",
    monthlyRequests: 50_000,
    features: [],
  },
  pro_ai: {
    id: "pro_ai",
    name: "Pro + AI",
    monthlyRequests: 250_000,
    features: ["ai"],
  },
};

const DEFAULT_PLAN: PlanId = "free";

/** An unknown or NULL plan string reads as Free — never as unlimited. */
const planOf = (u: { plan: string }): Plan => PLANS[u.plan as PlanId] ?? PLANS[DEFAULT_PLAN];

const hasFeature = (u: { plan: string }, feature: Feature) =>
  planOf(u).features.includes(feature);

/** The cheapest plan that includes a feature — so a refusal can name it. */
const cheapestPlanWith = (feature: Feature): Plan =>
  (Object.values(PLANS).find((p) => p.features.includes(feature)) ?? PLANS.pro_ai);

// ── Auth ──────────────────────────────────────────────────────────

interface User {
  id: number;
  email: string;
  name: string | null;
  plan: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// Verified against when the email doesn't exist, so login latency doesn't
// reveal which emails are registered.
const DUMMY_HASH = await Bun.password.hash("stubbase-dummy-password", ARGON);

function createSession(userId: number): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  db.query("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
  ).run(sha256hex(token), userId, `+${SESSION_TTL_DAYS} days`);
  return token;
}

function authenticate(req: Request): User | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return (
    (db
      .query(
        `SELECT u.id, u.email, u.name, u.plan FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
      )
      .get(sha256hex(header.slice(7))) as User | null) ?? null
  );
}

// The SPA needs the entitlements, not just the tier name: it disables the
// Co-Pilot composer rather than hiding it, and the usage panel draws the
// monthly allowance as a target. Sent resolved so the browser never has to
// keep its own copy of the plan table — and so it cannot disagree with the
// server that actually enforces.
const publicUser = (u: User) => {
  const plan = planOf(u);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: plan.id,
    planName: plan.name,
    monthlyRequests: plan.monthlyRequests,
    features: plan.features,
  };
};

async function signup(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const email = typeof (body as any)?.email === "string" ? (body as any).email.trim().toLowerCase() : "";
  const password = typeof (body as any)?.password === "string" ? (body as any).password : "";
  const name = typeof (body as any)?.name === "string" ? (body as any).name.trim() || null : null;

  if (!EMAIL_RE.test(email)) return err(400, "valid 'email' is required");
  if (password.length < MIN_PASSWORD_LEN)
    return err(400, `'password' must be at least ${MIN_PASSWORD_LEN} characters`);

  const hash = await Bun.password.hash(password, ARGON);
  try {
    db.query("INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)").run(
      email,
      name,
      hash,
    );
  } catch {
    return err(409, "email already registered");
  }
  const user = db
    .query("SELECT id, email, name, plan FROM users WHERE email = ?")
    .get(email) as User;
  return json({ token: createSession(user.id), user: publicUser(user) }, 201);
}

async function login(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const email = typeof (body as any)?.email === "string" ? (body as any).email.trim().toLowerCase() : "";
  const password = typeof (body as any)?.password === "string" ? (body as any).password : "";

  const row = db
    .query("SELECT id, email, name, plan, password_hash FROM users WHERE email = ?")
    .get(email) as (User & { password_hash: string | null }) | null;

  const valid = await Bun.password.verify(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !row.password_hash || !valid) return err(401, "invalid email or password");

  return json({ token: createSession(row.id), user: publicUser(row) });
}

function logout(req: Request): Response {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer "))
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256hex(header.slice(7)));
  return json({ ok: true });
}

// ── OAuth sign-in (Google / GitHub) ───────────────────────────────
// Stubbase's own OAuth apps, for signing in to the dashboard. Not to be
// confused with the per-tenant AUTH_GOOGLE_*/AUTH_GITHUB_* credentials a
// *project* keeps in its config.json: those log a tenant's end users into the
// tenant's API, are supplied by the tenant, and never come from this process's
// environment. These four env vars are ours, and a provider with either half
// missing simply never appears on the login page.
//
// The browser is redirected here by a top-level navigation, so nothing in this
// flow is CORS-relevant and no session token is ever read from a query string:
// the finished session rides back to the SPA in a URL *fragment*, which is not
// sent to servers and does not reach proxy logs.

type OauthProvider = "google" | "github";

const OAUTH_APPS: Record<OauthProvider, { clientId: string; secret: string }> = {
  google: {
    clientId: process.env.DASHBOARD_GOOGLE_CLIENT_ID ?? "",
    secret: process.env.DASHBOARD_GOOGLE_SECRET ?? "",
  },
  github: {
    clientId: process.env.DASHBOARD_GITHUB_CLIENT_ID ?? "",
    secret: process.env.DASHBOARD_GITHUB_SECRET ?? "",
  },
};

// Endpoint bases are env-overridable strictly so tests and the local stack can
// point them at a mock — exactly as the core does for tenant OAuth.
const OAUTH_ENDPOINTS: Record<
  OauthProvider,
  { authUrl: string; tokenUrl: string; userUrl: string; emailsUrl?: string; scope: string }
> = {
  google: {
    authUrl: process.env.OAUTH_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.OAUTH_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    userUrl:
      process.env.OAUTH_GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo",
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

const oauthConfigured = (p: OauthProvider) =>
  Boolean(OAUTH_APPS[p].clientId && OAUTH_APPS[p].secret);

/**
 * The origin the provider will call back on. Derived from the request the same
 * way the core derives a tenant's, so dev/docker/prod each work without extra
 * config; OAUTH_CALLBACK_BASE overrides it for setups where the browser reaches
 * this service through a path prefix (the Vite proxy's /api/app in dev).
 */
function callbackBase(req: Request): string {
  const override = process.env.OAUTH_CALLBACK_BASE;
  if (override) return override.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

const callbackUrl = (req: Request, provider: OauthProvider) =>
  `${callbackBase(req)}/auth/${provider}/callback`;

// CSRF state: an HMAC over provider + timestamp + nonce, valid 10 minutes. The
// key is derived from ADMIN_SECRET rather than being it, and binding the
// provider in means a state minted for Google cannot be replayed at GitHub's
// callback.
const OAUTH_STATE_KEY = createHash("sha256").update(`oauth-state:${ADMIN_SECRET}`).digest();
const OAUTH_STATE_TTL_MS = 10 * 60_000;

const signState = (provider: OauthProvider, ts: string, nonce: string) =>
  createHmac("sha256", OAUTH_STATE_KEY).update(`${provider}:${ts}:${nonce}`).digest();

function oauthState(provider: OauthProvider): string {
  const ts = Date.now().toString();
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
  return `${ts}.${nonce}.${signState(provider, ts, nonce).toString("base64url")}`;
}

function oauthStateValid(provider: OauthProvider, raw: string): boolean {
  const [ts, nonce, sig] = raw.split(".");
  if (!ts || !nonce || !sig || !/^\d+$/.test(ts)) return false;
  if (Date.now() - Number(ts) > OAUTH_STATE_TTL_MS) return false;
  const expected = signState(provider, ts, nonce);
  const given = Buffer.from(sig, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 302 back to the SPA with the outcome in the fragment. */
const toDashboard = (path: string, fragment: string) =>
  new Response(null, { status: 302, headers: { location: `${DASHBOARD_URL}${path}#${fragment}` } });

// Failures land on the login page, not on a JSON error page hosted on the API
// domain: the person who clicked the button is a browser, not a client library.
const oauthFailed = (code: string) => toDashboard("/login", `error=${encodeURIComponent(code)}`);

interface OauthIdentity {
  email: string;
  name: string | null;
}

/** Exchanges the code and resolves a *verified* email address, or null. */
async function fetchOauthIdentity(
  req: Request,
  provider: OauthProvider,
  code: string,
): Promise<OauthIdentity | null> {
  const ep = OAUTH_ENDPOINTS[provider];
  const app = OAUTH_APPS[provider];

  const tokenRes = await fetch(ep.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.secret,
      redirect_uri: callbackUrl(req, provider),
      grant_type: "authorization_code",
    }).toString(),
  }).catch(() => null);
  const accessToken = (tokenRes?.ok ? ((await tokenRes.json().catch(() => null)) as any) : null)
    ?.access_token;
  if (typeof accessToken !== "string") return null;

  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "user-agent": "stubbase-dashboard", // GitHub's API requires a User-Agent
  };
  const profRes = await fetch(ep.userUrl, { headers, signal: AbortSignal.timeout(10_000) }).catch(
    () => null,
  );
  const profile = profRes?.ok ? ((await profRes.json().catch(() => null)) as any) : null;
  if (!profile) return null;

  const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : null;

  // An unverified address is an account takeover primitive: anyone can put
  // someone else's email on a provider profile, and this service links an
  // OAuth identity to an existing account *by email*. Both providers say
  // whether they verified it; if they don't say yes, the sign-in fails.
  if (provider === "google") {
    const verified = profile.email_verified === true || profile.email_verified === "true";
    if (!verified || typeof profile.email !== "string") return null;
    return EMAIL_RE.test(profile.email) ? { email: profile.email, name } : null;
  }

  // GitHub's profile email is whatever the user typed as "public email" and is
  // not necessarily verified, so the emails endpoint is the only source here.
  const emailRes = await fetch(ep.emailsUrl!, {
    headers,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const list = emailRes?.ok ? ((await emailRes.json().catch(() => null)) as any) : null;
  if (!Array.isArray(list)) return null;
  const primary = list.find((e) => e?.primary && e?.verified) ?? list.find((e) => e?.verified);
  const email = primary?.email;
  return typeof email === "string" && EMAIL_RE.test(email) ? { email, name } : null;
}

function oauthStart(req: Request, provider: OauthProvider): Response {
  if (!oauthConfigured(provider)) return err(404, `${provider} sign-in is not configured`);
  const ep = OAUTH_ENDPOINTS[provider];
  const query = new URLSearchParams({
    client_id: OAUTH_APPS[provider].clientId,
    redirect_uri: callbackUrl(req, provider),
    response_type: "code",
    scope: ep.scope,
    state: oauthState(provider),
  });
  return new Response(null, {
    status: 302,
    headers: { location: `${ep.authUrl}?${query}` },
  });
}

async function oauthCallback(req: Request, provider: OauthProvider): Promise<Response> {
  if (!oauthConfigured(provider)) return err(404, `${provider} sign-in is not configured`);
  const url = new URL(req.url);
  if (url.searchParams.get("error")) return oauthFailed("access_denied");

  const code = url.searchParams.get("code");
  if (!code || !oauthStateValid(provider, url.searchParams.get("state") ?? ""))
    return oauthFailed("invalid_state");

  const identity = await fetchOauthIdentity(req, provider, code);
  if (!identity) return oauthFailed("provider_rejected");
  return signInWithIdentity(identity, provider);
}

/**
 * Turn a *verified* provider identity into a dashboard session.
 *
 * Shared by the redirect callback and by One Tap so the two can never drift on
 * how an account is chosen. The join key is the verified email address and not
 * the provider's subject id: someone who signs in with Google today and GitHub
 * tomorrow is one customer with one project list. That is only safe because
 * every caller has already refused an unverified address.
 */
function signInWithIdentity(identity: OauthIdentity, provider: OauthProvider): Response {
  const email = identity.email.trim().toLowerCase();

  const find = () =>
    db.query("SELECT id, email, name, plan FROM users WHERE email = ?").get(email) as User | null;
  let user = find();
  if (!user) {
    try {
      db.query("INSERT INTO users (email, name, oauth_provider) VALUES (?, ?, ?)").run(
        email,
        identity.name,
        provider,
      );
    } catch {
      // Two callbacks for a brand-new address can race; UNIQUE(email) settles
      // it and the loser just reads the row the winner inserted.
    }
    user = find();
  }
  if (!user) return oauthFailed("provider_rejected");

  return toDashboard("/auth/callback", `token=${createSession(user.id)}`);
}

// ── Google One Tap ────────────────────────────────────────────────
// The prompt Google renders in the corner of the *landing* site. It ends in
// the same session as /auth/google and only the first leg differs: instead of
// us bouncing the browser to Google and exchanging a code, a signed Google ID
// token is posted straight here. So there is no `state` to validate and no
// client secret in play — the token's own signature and `aud` are the whole
// proof, which is why every claim below is checked rather than assumed.
//
// The poster is Home's own One Tap callback, not Google. One Tap ignores
// `ux_mode`/`login_uri` (they configure the rendered *button*), and under FedCM
// the browser returns the credential to the page, so the page form-POSTs it
// here. Nothing about the checks below changes: an ID token is proof or it is
// not, whichever leg carried it.
//
// This endpoint is reached at https://stubbase.dev/auth/google/one-tap — on
// the *landing* origin, not on api.app.stubbase.dev — and Caddy proxies that
// one path here. That is forced, not a preference: `g_csrf_token` is a
// host-only cookie, so a POST to any other host (a sibling subdomain included)
// arrives without it and could never pass the double-submit check below.

const GOOGLE_CERTS_URL =
  process.env.OAUTH_GOOGLE_CERTS_URL ?? "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const ID_TOKEN_SKEW_MS = 60_000;

// Google's published signing keys, cached for as long as Google says. Kept as
// imported CryptoKeys rather than raw JWKs so a burst of sign-ins doesn't
// re-import the same key each time.
let googleKeyCache: { keys: Map<string, CryptoKey>; expires: number } | null = null;

async function googleSigningKey(kid: string): Promise<CryptoKey | null> {
  const cached = googleKeyCache;
  if (cached && cached.expires > Date.now()) {
    const hit = cached.keys.get(kid);
    // Only a *hit* short-circuits: an unknown kid on a live cache is what a
    // key rotation looks like, so fall through and refetch.
    if (hit) return hit;
  }

  const res = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10_000) }).catch(
    () => null,
  );
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { keys?: unknown[] } | null;
  if (!Array.isArray(body?.keys)) return null;

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys as any[]) {
    if (typeof jwk?.kid !== "string" || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle
      .importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
      .catch(() => null);
    if (key) keys.set(jwk.kid, key);
  }

  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1]);
  const ttlSec = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 300;
  googleKeyCache = { keys, expires: Date.now() + ttlSec * 1000 };
  return keys.get(kid) ?? null;
}

/**
 * Verify a Google-issued ID token and return the identity it asserts.
 *
 * Every check here is load-bearing. The signature proves Google minted it;
 * `aud` proves it was minted for *us*, since a token issued to any other
 * site's client id is a perfectly valid Google token and must still be
 * refused; `exp` bounds replay; and `email_verified` is the same rule the
 * redirect flow enforces, because signInWithIdentity links by email and an
 * unverified address is an account-takeover primitive.
 */
async function verifyGoogleIdToken(raw: string): Promise<OauthIdentity | null> {
  const [headerB64, payloadB64, sigB64, ...rest] = raw.split(".");
  if (!headerB64 || !payloadB64 || !sigB64 || rest.length) return null;

  const decode = (s: string): any => {
    try {
      return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  };
  const header = decode(headerB64);
  const claims = decode(payloadB64);
  if (!header || !claims) return null;
  // Pin the algorithm: accepting whatever `alg` says is how "alg: none" and
  // HMAC-with-the-public-key forgeries get in.
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const key = await googleSigningKey(header.kid);
  if (!key) return null;
  const signed = await crypto.subtle
    .verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(sigB64, "base64url"),
      Buffer.from(`${headerB64}.${payloadB64}`),
    )
    .catch(() => false);
  if (!signed) return null;

  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) return null;
  if (!OAUTH_APPS.google.clientId || claims.aud !== OAUTH_APPS.google.clientId) return null;
  const expMs = Number(claims.exp) * 1000;
  if (!Number.isFinite(expMs) || Date.now() > expMs + ID_TOKEN_SKEW_MS) return null;

  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!verified || typeof claims.email !== "string" || !EMAIL_RE.test(claims.email)) return null;

  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;
  return { email: claims.email, name };
}

/** Read one cookie off a request. One value, no cookie jar, no dependency. */
function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function googleOneTap(req: Request): Promise<Response> {
  if (!oauthConfigured("google")) return err(404, "google sign-in is not configured");

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return err(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return err(413, "body too large");
  const form = new URLSearchParams(text);

  // Double-submit CSRF: only a page on the origin that set the cookie can read
  // it back, so a matching pair proves this POST came from our own page rather
  // than an attacker's form. Home mints the pair (Google sets `g_csrf_token`
  // only on the leg where Google itself posts), which changes nothing here —
  // the guarantee is the host-only cookie, not who generated the value. Both
  // halves must exist: two absent values are equal, and treating that as a
  // match would delete the check.
  const posted = form.get("g_csrf_token") ?? "";
  const cookie = readCookie(req, "g_csrf_token") ?? "";
  if (!posted || !cookie) return oauthFailed("invalid_state");
  const a = Buffer.from(posted);
  const b = Buffer.from(cookie);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return oauthFailed("invalid_state");

  const credential = form.get("credential") ?? "";
  if (!credential) return oauthFailed("provider_rejected");
  const identity = await verifyGoogleIdToken(credential);
  if (!identity) return oauthFailed("provider_rejected");

  return signInWithIdentity(identity, "google");
}

// ── Core Engine admin client ──────────────────────────────────────

async function coreAdmin(
  method: "GET" | "POST" | "DELETE",
  tenantId: string,
  resource: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/files/${resource}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

/** Non-file admin actions on the core: "flush" | "deploy". */
async function coreAdminAction(
  tenantId: string,
  action: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

/** The core's read-only system plane: the list of feature files, or one of them. */
async function coreAdminSystem(
  tenantId: string,
  name?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/system${name ? `/${name}` : ""}`, {
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

/**
 * The core's status plane: whether a tenant's public plane is serving. With no
 * `next` it reads; with one it sets. Status is not config — see applyProjectStatus.
 */
async function coreAdminStatus(
  tenantId: string,
  next?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(
    `${CORE_API_URL}/${tenantId}/_admin/status`,
    next === undefined
      ? { headers: { authorization: `Bearer ${ADMIN_SECRET}` } }
      : {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
          body: JSON.stringify({ status: next }),
        },
  );
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

/**
 * Snapshot of the core's in-RAM request log, newest last. The SSE proxy is for
 * a human watching a stream; the Co-Pilot needs the same ring as plain data
 * inside one request, and must not leave a subscriber behind to get it.
 */
async function coreLogSnapshot(tenantId: string, limit: number): Promise<LogEntry[]> {
  try {
    const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/logs?_limit=${limit}`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { entries?: unknown } | null;
    return Array.isArray(data?.entries) ? (data.entries as LogEntry[]) : [];
  } catch {
    return []; // a log read must never be the reason a diagnosis fails
  }
}

/** The subset of the core's log entry this service reads. */
interface LogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  lifecycle: { stage: string; ok: boolean; note?: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (status: number, message: string) => json({ error: message }, status);

async function readJsonBody(req: Request): Promise<unknown | Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return err(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return err(413, "body too large");
  try {
    return JSON.parse(text);
  } catch {
    return err(400, "invalid JSON body");
  }
}

function newTenantId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const suffix = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
  return `${slug || "project"}-${suffix}`;
}

interface ProjectRow {
  tenant_id: string;
  name: string;
  resources: string;
  dirty: number;
  created_at: string;
}

function ownedProject(tenantId: string, userId: number): ProjectRow | null {
  return db
    .query(
      "SELECT tenant_id, name, resources, dirty, created_at FROM projects WHERE tenant_id = ? AND user_id = ?",
    )
    .get(tenantId, userId) as ProjectRow | null;
}

const projectJson = (r: ProjectRow) => ({
  ...r,
  resources: JSON.parse(r.resources),
  dirty: r.dirty === 1,
});

/** The resources column as a string[], tolerating a legacy/corrupt value. */
function parseResources(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Add/remove one name in a project's `resources` column.
 *
 * Both re-read the column and write it back with **no `await` in between**, so
 * the whole read-modify-write runs in a single synchronous turn and concurrent
 * requests cannot interleave inside it. That is the entire point of these
 * helpers: putFile and deleteFile each hold a project row from *before* their
 * call out to the core, and a row fetched on the far side of an `await` is a
 * stale snapshot — two creates landing together would each write back a list
 * that never contained the other, and a delete would write back one that never
 * contained a resource created moments earlier, silently un-listing a file that
 * is really on disk. Never rebuild this list from a row read before an await.
 *
 * Deliberately not part of the ownership check, for the same reason as
 * markDirty: a caller has passed ownedProject by the time it writes anything,
 * and the tenant id is the primary key.
 */
function addResources(tenantId: string, names: string[]): void {
  const row = db
    .query("SELECT resources FROM projects WHERE tenant_id = ?")
    .get(tenantId) as { resources: string } | null;
  if (!row) return;
  const resources = parseResources(row.resources);
  const added = names.filter((n) => !resources.includes(n));
  if (added.length === 0) return;
  db.query("UPDATE projects SET resources = ? WHERE tenant_id = ?").run(
    JSON.stringify([...resources, ...added]),
    tenantId,
  );
}

function removeResource(tenantId: string, name: string): void {
  const row = db
    .query("SELECT resources FROM projects WHERE tenant_id = ?")
    .get(tenantId) as { resources: string } | null;
  if (!row) return;
  const resources = parseResources(row.resources);
  if (!resources.includes(name)) return;
  db.query("UPDATE projects SET resources = ? WHERE tenant_id = ?").run(
    JSON.stringify(resources.filter((r) => r !== name)),
    tenantId,
  );
}

/**
 * Mark the project as holding an undeployed draft — what the dashboard's
 * "not live yet" strip reads.
 *
 * A flag rather than anything derived from disk, because draft_*.json is not a
 * usable signal: deploy copies a draft over its live file and leaves the draft
 * in place, so "a draft exists" means "was edited once", not "differs from
 * live". This records the edit instead, and deploy clears it.
 *
 * That makes every writer of a draft responsible for calling this. There are
 * exactly two — putFile and the Co-Pilot's stage_schema_drafts, which writes
 * through coreAdmin directly — and anything added later that stages a draft
 * without calling it will silently under-report. Nothing on disk can correct
 * that, so route new draft writers through here.
 *
 * Deliberately not part of the ownership check: a caller has already passed
 * ownedProject by the time it stages anything, and the tenant id is the primary
 * key, so these are safe as plain updates.
 */
function markDirty(tenantId: string): void {
  db.query("UPDATE projects SET dirty = 1 WHERE tenant_id = ?").run(tenantId);
}

/** Everything staged is now live. Called only from promoteDrafts, on success. */
function clearDirty(tenantId: string): void {
  db.query("UPDATE projects SET dirty = 0 WHERE tenant_id = ?").run(tenantId);
}

// ── Projects ──────────────────────────────────────────────────────

/** A `# ── Title ───` rule, padded so every section header ends in the same column. */
const envSection = (title: string) => `# ── ${title} ${"─".repeat(Math.max(3, 68 - title.length))}`;

/**
 * The `.env` a new project starts with: every setting the Core Engine reads,
 * grouped by feature and commented out, so switching a feature on means
 * uncommenting its lines rather than looking up key names.
 *
 * Commented out is the point. A template line is documentation, not config:
 * this text compiles to an empty object, so a new project is exactly as plain
 * as before the template existed. Whether the API is serving is deliberately
 * absent — that is system/status.json, which only Start/Stop writes.
 *
 * tests/dashboard-api.test.ts holds it to the keys the core reads (ENVIRONMENT.md
 * §2). The OAuth callbacks it names are this project's real ones.
 */
function envTemplate(tenantId: string): string {
  const callback = (provider: string) => `${PUBLIC_API_BASE}/${tenantId}/auth/${provider}/callback`;
  return [
    "# Project settings",
    "#",
    "# Every feature below is off. To switch one on, delete the \"# \" in front of",
    "# its setting lines, put in your own values, Save, then Deploy.",
    "# Put the \"# \" back to switch it off again — your values stay in the file.",
    "#",
    "# Starting and stopping the API is not a setting: use the Start / Stop button.",
    "",
    envSection("Auth: sign-up and login for your users"),
    "# The switch. Every request then needs a token, and /auth/signup, /auth/login",
    "# and /auth/change-password go live. Accounts show up in the system folder.",
    "# AUTH_ENABLED=true",
    "",
    "# Resources anyone may read without a token, comma-separated.",
    "# AUTH_PUBLIC_ROUTES=posts,comments",
    "",
    "# How long a login lasts, in seconds. Default 86400 (24 hours), minimum 60.",
    "# AUTH_JWT_TTL_SECONDS=86400",
    "",
    envSection("Auth: roles and permissions (needs AUTH_ENABLED=true)"),
    "# Who may do what with your API: roles, each a set of permissions, written in",
    "# rbac.json. Switch this on, Save, and rbac.json appears in the system folder.",
    "# RBAC_ENABLED=true",
    "",
    envSection("Auth: Google login (needs AUTH_ENABLED=true)"),
    "# Your own Google OAuth app. Both values together turn on /auth/google.",
    "# Register this callback URL in the Google console:",
    `#   ${callback("google")}`,
    "# AUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com",
    "# AUTH_GOOGLE_SECRET=GOCSPX-your-secret",
    "",
    envSection("Auth: GitHub login (needs AUTH_ENABLED=true)"),
    "# Your own GitHub OAuth app. Both values together turn on /auth/github.",
    "# Register this callback URL in the GitHub OAuth app:",
    `#   ${callback("github")}`,
    "# AUTH_GITHUB_CLIENT_ID=Iv1.a1b2c3d4e5f6",
    "# AUTH_GITHUB_SECRET=your-github-secret",
    "",
    "# Where Google and GitHub login send the user afterwards, with #token=… attached.",
    "# Left out, the token comes back as JSON instead.",
    "# AUTH_OAUTH_REDIRECT=https://your-app.com/login",
    "",
    envSection("Auth: password reset (needs AUTH_ENABLED=true and RESEND_API_KEY)"),
    "# /auth/forgot-password emails a 6-digit code, /auth/reset-password redeems it.",
    "# It sends through RESEND_API_KEY in the Email section below.",
    "# Optional: a page of yours the email links to, with #email=…&code=… attached.",
    "# AUTH_RESET_URL=https://your-app.com/reset-password",
    "",
    envSection("Email through Resend"),
    "# Sends password reset codes, and turns on POST /_notify/email",
    "# (which, like all of /_notify, needs AUTH_ENABLED=true).",
    "# RESEND_API_KEY=re_your_resend_key",
    "# RESEND_FROM=Your App <no-reply@your-app.com>",
    "",
    envSection("SMS through Twilio"),
    "# All three together turn on POST /_notify/sms (needs AUTH_ENABLED=true).",
    "# TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "# TWILIO_AUTH_TOKEN=your-twilio-auth-token",
    "# TWILIO_FROM=+15551234567",
    "",
    envSection("QA: simulate slow, failing and empty responses"),
    "# Lets a request ask for trouble with the x-stubbase-delay, x-stubbase-status,",
    "# x-stubbase-error-rate and x-stubbase-empty headers. Ignored while this is off.",
    "# QA_MODE=true",
    "",
    envSection("Validation: a JSON Schema per resource"),
    "# SCHEMA_<RESOURCE> holds a JSON Schema on one line. A POST or PUT body that",
    "# does not match gets a 400. Add one line per resource.",
    '# SCHEMA_POSTS={"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}',
    "",
    envSection("Webhooks"),
    "# HOOK_<BEFORE|AFTER>_<INSERT|UPDATE|DELETE>_<RESOURCE>=<url>",
    "# A BEFORE hook must answer 200 or the write is refused.",
    "# An AFTER hook is told about the write once it has happened.",
    "# HOOK_BEFORE_INSERT_POSTS=https://your-app.com/hooks/check-post",
    "# HOOK_AFTER_UPDATE_ORDERS=https://your-app.com/hooks/order-changed",
    "",
  ].join("\n");
}

async function createProject(req: Request, user: User): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const name = typeof (body as any)?.name === "string" ? (body as any).name.trim() : "";
  if (!name) return err(400, "'name' is required");

  // A new project starts genuinely empty — no placeholder resource. Callers
  // that want seed data pass `resources` explicitly (the AI generator does).
  const raw = (body as any).resources;
  const resources: Record<string, any[]> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const [rName, data] of Object.entries(resources)) {
    if (!NAME_RE.test(rName)) return err(400, `invalid resource name: ${rName}`);
    if (!Array.isArray(data)) return err(400, `resource '${rName}' seed data must be an array`);
  }

  const tenantId = newTenantId(name);

  // New projects start stopped: nothing is public until the owner has looked at
  // the data and pressed Deploy. Written before anything else, so there is no
  // moment in which seeded records are served — and it is what gives the tenant
  // a folder on the core, so it exists as soon as it is created.
  const stopped = await coreAdminStatus(tenantId, "stopped");
  if (!stopped.ok) return err(502, `core engine refused the initial status (status ${stopped.status})`);

  const provisioned: string[] = [];
  for (const [rName, data] of Object.entries(resources)) {
    const res = await coreAdmin("POST", tenantId, rName, data);
    if (!res.ok) {
      // roll back partial provisioning so we don't leave orphan files
      for (const done of provisioned) await coreAdmin("DELETE", tenantId, done);
      return err(502, `core engine refused to provision '${rName}' (status ${res.status})`);
    }
    provisioned.push(rName);
  }

  // The .env editor's text: every setting, commented out (see envTemplate).
  const cfg = await coreAdmin("POST", tenantId, "config", { __raw: envTemplate(tenantId) });
  if (!cfg.ok) {
    for (const done of provisioned) await coreAdmin("DELETE", tenantId, done);
    return err(502, `core engine refused the initial settings (status ${cfg.status})`);
  }

  db.query(
    "INSERT INTO projects (tenant_id, user_id, name, resources) VALUES (?, ?, ?, ?)",
  ).run(tenantId, user.id, name, JSON.stringify(provisioned));

  return json(
    {
      tenantId,
      name,
      resources: provisioned,
      apiBase: `${PUBLIC_API_BASE}/${tenantId}`,
    },
    201,
  );
}

async function renameProject(req: Request, user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const name = typeof (body as any)?.name === "string" ? (body as any).name.trim() : "";
  if (!name) return err(400, "'name' is required");
  db.query("UPDATE projects SET name = ? WHERE tenant_id = ? AND user_id = ?").run(
    name,
    tenantId,
    user.id,
  );
  return json(projectJson(ownedProject(tenantId, user.id)!));
}

/**
 * Whether the tenant is serving. A tenant with no status file reads as active,
 * exactly as the core treats it — and so does an unreachable core, since the
 * callers guard destructive actions and "active" is the refusing answer.
 */
async function projectStatus(tenantId: string): Promise<string> {
  const res = await coreAdminStatus(tenantId);
  const status = (res.data as { status?: unknown } | null)?.status;
  return res.ok && typeof status === "string" ? status : "active";
}

/** GET /projects/<id>/status — what the dashboard's status badge and Start/Stop show. */
async function getProjectStatus(user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const res = await coreAdminStatus(tenantId);
  const status = (res.data as { status?: unknown } | null)?.status;
  if (!res.ok || typeof status !== "string")
    return err(502, `core engine refused the status read (status ${res.status})`);
  return json({ tenant: tenantId, status });
}

async function deleteProject(user: User, tenantId: string): Promise<Response> {
  const row = ownedProject(tenantId, user.id);
  if (!row) return err(404, "project not found");

  // Refuse while the API is serving. Deleting is irreversible and takes a live
  // endpoint down under whatever is calling it, so stopping first has to be a
  // deliberate separate act. Enforced here, not just in the dashboard, because
  // a guard only the UI knows about is not a guard.
  const status = await projectStatus(tenantId);
  if (status === "active")
    return err(409, "project is running — stop the API before deleting it");

  for (const rName of JSON.parse(row.resources) as string[]) {
    await coreAdmin("DELETE", tenantId, `${DRAFT_PREFIX}${rName}`); // best-effort draft cleanup
    const res = await coreAdmin("DELETE", tenantId, rName);
    if (!res.ok && res.status !== 404)
      return err(502, `core engine failed to delete '${rName}' (status ${res.status})`);
  }
  for (const settings of ["config", "rbac"]) {
    await coreAdmin("DELETE", tenantId, settings);
    await coreAdmin("DELETE", tenantId, `${DRAFT_PREFIX}${settings}`);
  }
  // Keys die with the project. Leaving them behind would keep credentials
  // valid for a tenant id that no longer belongs to anyone.
  db.query("DELETE FROM developer_api_keys WHERE tenant_id = ?").run(tenantId);
  db.query("DELETE FROM projects WHERE tenant_id = ?").run(tenantId);
  return json({ ok: true, tenantId, deleted: true });
}

// ── Files proxy (keeps ADMIN_SECRET server-side) ──────────────────

// Draft model: UI saves land as draft_<name>.json (invisible to the public
// plane — the core skips draft_* on load); POST /projects/:id/deploy promotes
// drafts over their production files and deletes them. Reads prefer whichever
// copy `dirty` says is current — the draft while an edit is staged, the live
// file otherwise — and fall back to the other, never 404ing when only one
// exists. See getFile: preferring the draft unconditionally is what hid a
// project's own API writes behind a stranded snapshot. A caller that needs the
// *deployed* file rather than the edit in progress asks for `?source=live`,
// which reads the production copy alone.
//
// `config` is the tenant's env-style settings (the dashboard's .env editor
// compiles to it): an object, not a record array, and never a CRUD resource —
// so it bypasses the resources-column sync and array validation.

const DRAFT_PREFIX = "draft_";

function invalidResourceName(resource: string): Response | null {
  if (!NAME_RE.test(resource)) return err(400, "invalid resource name");
  if (resource.startsWith(DRAFT_PREFIX))
    return err(400, "resource names must not start with draft_");
  return null;
}

async function getFile(
  user: User,
  tenantId: string,
  resource: string,
  liveOnly = false,
): Promise<Response> {
  const row = ownedProject(tenantId, user.id);
  if (!row) return err(404, "project not found");
  const invalid = invalidResourceName(resource);
  if (invalid) return invalid;
  // `dirty` chooses which copy wins, but both are always tried.
  //
  // Preferring the draft unconditionally is what hid a project's own API writes:
  // deploys made before drafts were consumed stranded one for every resource
  // ever edited, and that frozen snapshot then shadowed the live file forever.
  // Reading live first whenever nothing is staged makes those leftovers inert
  // without having to hunt them down — the next promote sweeps the file itself.
  //
  // The fallback is not optional, in either direction. `dirty` is only a hint:
  // it was added by ALTER TABLE defaulting to 0 and deliberately not
  // back-filled, so a project older than the column reads "clean" even while
  // holding genuinely un-deployed drafts — and some hold resources that exist
  // *only* as a draft, which trusting the flag alone would turn into a 404.
  //
  // `?source=live` (liveOnly) asks a different question, and gets a different
  // answer: not "what am I editing" but "what is the public API serving right
  // now". The APIs rail asks it — the routes a project exposes follow its
  // *deployed* config, so an un-deployed AUTH_ENABLED must neither add the
  // auth routes to that list nor, switched off, take them away before the
  // deploy that actually retires them. There is no fallback in this mode, for
  // the same reason: a file that exists only as a draft is not live, and 404
  // is the honest answer rather than the draft standing in for one.
  const order = liveOnly
    ? [resource]
    : row.dirty === 1
      ? [`${DRAFT_PREFIX}${resource}`, resource]
      : [resource, `${DRAFT_PREFIX}${resource}`];
  let res = await coreAdmin("GET", tenantId, order[0]);
  if (order[1] !== undefined && res.status === 404)
    res = await coreAdmin("GET", tenantId, order[1]);
  if (res.status === 404) return err(404, "file not found");
  if (!res.ok) return err(502, `core engine refused the read (status ${res.status})`);
  return json(res.data);
}

/**
 * Whether roles are switched on in the settings being edited: the staged
 * draft_config if there is one, else the live config. rbac.json is saved and
 * deployed alongside those settings, so they are the ones it has to agree with.
 */
async function rbacSwitchedOn(tenantId: string): Promise<boolean> {
  let res = await coreAdmin("GET", tenantId, `${DRAFT_PREFIX}config`);
  if (res.status === 404) res = await coreAdmin("GET", tenantId, "config");
  const env =
    res.ok && res.data && typeof res.data === "object" && !Array.isArray(res.data)
      ? (res.data as Record<string, unknown>)
      : {};
  const on = (key: string) => String(env[key] ?? "").trim().toLowerCase() === "true";
  return on("AUTH_ENABLED") && on("RBAC_ENABLED");
}

async function putFile(
  req: Request,
  user: User,
  tenantId: string,
  resource: string,
): Promise<Response> {
  const row = ownedProject(tenantId, user.id);
  if (!row) return err(404, "project not found");
  const invalid = invalidResourceName(resource);
  if (invalid) return invalid;

  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  // Settings files are objects the core parses, never record arrays, and never
  // resources: config (the .env editor) and rbac (roles and permissions).
  const isSettings = resource === "config" || resource === "rbac";
  if (resource === "config") {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return err(400, "config must be a JSON object");
    // env-style keys are strings; `resources` is the one structured key
    // (per-resource JSON Schemas), which the .env editor spells SCHEMA_<NAME>.
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === "resources") {
        if (v === null || typeof v !== "object" || Array.isArray(v))
          return err(400, "config 'resources' must be a JSON object");
        continue;
      }
      if (typeof v !== "string") return err(400, "config values must be strings");
    }
  } else if (resource === "rbac") {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return err(400, "rbac.json must be a JSON object");
    // Roles have their own switch, and rbac.json exists only while it is on.
    if (!(await rbacSwitchedOn(tenantId)))
      return err(
        409,
        "rbac.json can be created only while RBAC_ENABLED=true and AUTH_ENABLED=true are set in the .env",
      );
  } else if (!Array.isArray(body)) {
    return err(400, "body must be a JSON array of records");
  }

  const res = await coreAdmin("POST", tenantId, `${DRAFT_PREFIX}${resource}`, body);
  // The core validates rules where they are written; its reasons are the user's to read.
  if (res.status === 400) return json(res.data ?? { error: "the core engine refused the file" }, 400);
  if (!res.ok) return err(502, `core engine refused the write (status ${res.status})`);

  // The draft is on disk, so the live API is now behind — recorded after the
  // write rather than before, so a refused write never leaves the project
  // claiming changes it does not have.
  markDirty(tenantId);

  // Re-read inside addResources rather than reusing `row`: that snapshot was
  // taken before the core write above, so it is stale by the time we get here.
  if (!isSettings) addResources(tenantId, [resource]);
  const records = Array.isArray(body) ? body.length : Object.keys(body as object).length;
  return json({ ok: true, tenant: tenantId, resource, records, draft: true });
}

async function deleteFile(user: User, tenantId: string, resource: string): Promise<Response> {
  const row = ownedProject(tenantId, user.id);
  if (!row) return err(404, "project not found");
  const invalid = invalidResourceName(resource);
  if (invalid) return invalid;

  await coreAdmin("DELETE", tenantId, `${DRAFT_PREFIX}${resource}`); // best-effort draft cleanup
  const res = await coreAdmin("DELETE", tenantId, resource);
  if (!res.ok && res.status !== 404)
    return err(502, `core engine failed to delete (status ${res.status})`);

  // Deliberately does not clear the flag. A delete applies to the live file
  // immediately, so it stages nothing — but with one boolean for the whole
  // project there is no way to tell whether *other* resources are still
  // staged, and clearing would hide them. Leaving it costs at most one
  // redeploy that promotes nothing.

  // Same reason as putFile: `row` predates the core calls above, so filtering
  // it would write back a list missing anything created in the meantime.
  removeResource(tenantId, resource);
  return json({ ok: true, tenant: tenantId, resource, deleted: true });
}

// ── System files (read-only) ──────────────────────────────────────
// A project's system/ folder holds what its features own — auth's users.json
// and reset-password.json. The dashboard shows them so an owner can see who has
// signed up, but never writes them: they change only through the feature's own
// routes on the public plane (signup, reset-password, …), so there is no PUT or
// DELETE here and nothing to keep in the `resources` column. The core strips
// credentials before either response leaves it.

async function listSystemFiles(user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const res = await coreAdminSystem(tenantId);
  if (!res.ok) return err(502, `core engine refused the read (status ${res.status})`);
  const files = (res.data as { files?: unknown } | null)?.files;
  return json({ files: Array.isArray(files) ? files.filter((f) => typeof f === "string") : [] });
}

/**
 * PUT /projects/<id>/system/users/<userId>/role — the owner setting an account's
 * role, which is how a project's first admin is made. The core decides whether
 * the role exists; its 400 and 404 are passed through for the user to read.
 */
async function setUserRole(req: Request, user: User, tenantId: string, userId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  if (!NAME_RE.test(userId)) return err(400, "invalid user id");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/users/${userId}/role`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ role: (body as { role?: unknown } | null)?.role }),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 400 || res.status === 404)
    return json(data ?? { error: "the core engine refused the role" }, res.status);
  if (!res.ok) return err(502, `core engine refused the role change (status ${res.status})`);
  return json(data);
}

async function getSystemFile(user: User, tenantId: string, name: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  if (!NAME_RE.test(name)) return err(400, "invalid file name");
  const res = await coreAdminSystem(tenantId, name);
  if (res.status === 404) return err(404, "file not found");
  if (!res.ok) return err(502, `core engine refused the read (status ${res.status})`);
  return json(res.data);
}

// ── AI Co-Pilot ───────────────────────────────────────────────────
// A conversational agent, not a generator: the model answers in prose and may
// ask to run one of the four tools in CO_PILOT_TOOLS. This service executes
// them (it is the only side that knows which tenant the session owns), feeds
// the results back, and calls the model again until it has a text answer.
//
// Two rules make that safe:
//   1. The tenant is taken from the authenticated URL path — never from a tool
//      argument. The model chooses *what* to do, never *whose* project.
//   2. Every tool argument is untrusted input, validated exactly like a request
//      body would be. Writes can only ever land as draft_* files.

const AI_MAX_TURNS = 40; // conversation length the client may send back
const AI_MAX_PARTS = 16; // parts in one turn
const AI_MAX_TEXT = 8_000; // characters in one text part
const AI_MAX_HISTORY_CHARS = 200_000; // whole serialized history
const AI_MAX_TOOL_ROUNDS = 4; // tool → model round trips per request
/**
 * Wall-clock budget for one chat turn. A turn is several provider calls now,
 * each up to AI_TIMEOUT_MS, and nothing is written to the socket while they
 * run — so without this a slow multi-tool turn could out-wait Bun's idleTimeout
 * (capped at 255s) and have the connection dropped mid-answer. Past the budget
 * the loop stops asking for tools and goes straight to the closing reply.
 */
const AI_TURN_BUDGET_MS = 180_000;
const AI_MAX_TABLES = 12;
const AI_MAX_RECORDS = 50;
const AI_MAX_LOG_ENTRIES = 15; // recent requests handed to get_diagnostics
const AI_MAX_LOG_BODY = 300;
/** Names the core treats as settings or routes — never generatable tables. */
const RESERVED_TABLES = new Set(["config", "rbac", "stubbase", "env", "auth"]);

// ── History validation ────────────────────────────────────────────

/**
 * The browser round-trips the whole conversation, so `messages` is untrusted
 * input with a shape the provider must accept. This rejects anything that is
 * not a well-formed turn and caps the size, so a crafted history can't turn
 * into an unbounded (billed) upstream request.
 *
 * A forged history is not a privilege escalation — every tool is scoped to the
 * caller's own project either way — but a fabricated tool *call* in the history
 * is never executed: the loop only ever runs calls from a live model reply.
 */
function validateHistory(raw: unknown): ChatTurn[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "'messages' must be a non-empty array";
  if (raw.length > AI_MAX_TURNS) return `conversation is too long (max ${AI_MAX_TURNS} turns)`;

  const turns: ChatTurn[] = [];
  for (const turn of raw) {
    const role = (turn as any)?.role;
    if (role !== "user" && role !== "model" && role !== "function")
      return "each message needs a role of 'user', 'model' or 'function'";
    const rawParts = (turn as any)?.parts;
    if (!Array.isArray(rawParts) || rawParts.length === 0 || rawParts.length > AI_MAX_PARTS)
      return "each message needs between 1 and 16 parts";

    const parts: ChatPart[] = [];
    for (const part of rawParts) {
      if (part === null || typeof part !== "object" || Array.isArray(part))
        return "message parts must be objects";
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") {
        if (p.text.length > AI_MAX_TEXT) return `a message is too long (max ${AI_MAX_TEXT} chars)`;
      } else if (!p.functionCall && !p.functionResponse) {
        return "message parts must carry text, a functionCall or a functionResponse";
      }
      // Provider metadata (Gemini's thoughtSignature) rides along untouched —
      // dropping it makes the next turn 400.
      parts.push(p as ChatPart);
    }
    turns.push({ role, parts });
  }

  if (turns[turns.length - 1].role !== "user")
    return "the last message must be from the user";
  if (JSON.stringify(turns).length > AI_MAX_HISTORY_CHARS)
    return "conversation is too large — start a new chat";
  return turns;
}

// ── Tools ─────────────────────────────────────────────────────────

/** What a tool hands back to the model, plus whether the SPA's caches are stale. */
interface ToolOutcome {
  result: Record<string, unknown>;
  /** True when the tool changed server state the dashboard is displaying. */
  changed?: boolean;
}

/**
 * Model output is untrusted input: a prompt-injected or hallucinated table name
 * like "config" or "draft_x" would clobber tenant settings, so names are
 * validated against the same rules the core enforces. Nested values are dropped
 * (the schema must stay flat/relational) and reported back as warnings — the
 * model sees what was rejected and can tell the user.
 */
function sanitizeTables(raw: unknown[]): {
  tables: { name: string; records: Record<string, unknown>[] }[];
  warnings: string[];
} {
  const tables: { name: string; records: Record<string, unknown>[] }[] = [];
  const warnings: string[] = [];

  for (const entry of raw) {
    if (tables.length >= AI_MAX_TABLES) {
      warnings.push(`ignored extra tables beyond the limit of ${AI_MAX_TABLES}`);
      break;
    }
    const rawName = (entry as any)?.name;
    if (typeof rawName !== "string") {
      warnings.push("skipped a table with no name");
      continue;
    }
    const name = rawName.trim().toLowerCase();
    if (!NAME_RE.test(name) || name.startsWith(DRAFT_PREFIX) || RESERVED_TABLES.has(name)) {
      warnings.push(`skipped table '${rawName}': not a usable resource name`);
      continue;
    }

    // Most models send an array; some hand back the array as a JSON string.
    let rawRecords = (entry as any)?.records;
    if (typeof rawRecords === "string") {
      try {
        rawRecords = JSON.parse(rawRecords);
      } catch {
        /* falls through to the not-an-array warning below */
      }
    }
    if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
      warnings.push(`skipped table '${name}': no records`);
      continue;
    }

    const records: Record<string, unknown>[] = [];
    for (const rawRecord of rawRecords.slice(0, AI_MAX_RECORDS)) {
      if (rawRecord === null || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
        warnings.push(`dropped a non-object record from '${name}'`);
        continue;
      }
      const record: Record<string, unknown> = {};
      let dropped = false;
      for (const [field, value] of Object.entries(rawRecord)) {
        const ok =
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean";
        if (ok) record[field] = value;
        else dropped = true;
      }
      if (dropped) warnings.push(`dropped nested field(s) from a '${name}' record`);
      if (record.id === undefined || record.id === null || record.id === "")
        record.id = crypto.randomUUID();
      records.push(record);
    }
    if (rawRecords.length > AI_MAX_RECORDS)
      warnings.push(`trimmed '${name}' to ${AI_MAX_RECORDS} records`);
    if (records.length > 0) tables.push({ name, records });
  }
  return { tables, warnings: [...new Set(warnings)] };
}

/** stage_schema_drafts — write draft_<table>.json files. Never touches live data. */
async function toolStageSchemaDrafts(
  args: Record<string, unknown>,
  tenantId: string,
): Promise<ToolOutcome> {
  // Phrased as a capability limit, not a schema complaint. Told "your arguments
  // were malformed", a model retries with something structurally valid — which
  // is how "clear all data" once produced a fabricated `placeholders` table and
  // a claim that the data had been cleared.
  const CANNOT_DELETE =
    "This tool only creates or replaces tables; it cannot delete or empty them. " +
    "Use delete_resources for that. Do not invent a filler table to satisfy the request.";

  if (!Array.isArray(args.tables) || args.tables.length === 0)
    return { result: { error: `no tables were supplied. ${CANNOT_DELETE}` } };

  const { tables, warnings } = sanitizeTables(args.tables);
  if (tables.length === 0)
    return { result: { error: `none of the supplied tables were usable. ${CANNOT_DELETE}`, warnings } };

  const staged: { name: string; records: number; fields: string[] }[] = [];
  for (const table of tables) {
    const res = await coreAdmin("POST", tenantId, `${DRAFT_PREFIX}${table.name}`, table.records);
    if (!res.ok) {
      console.warn(`[ai] core refused draft_${table.name} (status ${res.status})`);
      warnings.push(`could not stage '${table.name}'`);
      continue;
    }
    staged.push({
      name: table.name,
      records: table.records.length,
      fields: [...new Set(table.records.flatMap((r) => Object.keys(r)))],
    });
  }
  if (staged.length === 0) return { result: { error: "nothing could be staged", warnings } };

  // This tool writes drafts through coreAdmin rather than putFile, so it is the
  // second of the two places that has to record them as undeployed.
  markDirty(tenantId);

  // Keep the sidebar in sync: the new tables are real resources once deployed.
  addResources(tenantId, staged.map((t) => t.name));

  return {
    changed: true,
    result: {
      staged,
      warnings,
      // Without this the model invents a plausible-looking base path (/api/…)
      // and tells the user to call a URL that does not exist.
      apiBase: `${PUBLIC_API_BASE}/${tenantId}`,
      note: "Staged as drafts. They are not reachable on the public API until the project is deployed.",
    },
  };
}

/**
 * set_server_status — start or stop the tenant's public plane.
 *
 * Note what is *not* a parameter: the tenant. It comes from the authenticated
 * route, so the model picks the action and never the project it lands on.
 */
async function toolSetServerStatus(
  args: Record<string, unknown>,
  tenantId: string,
): Promise<ToolOutcome> {
  const status = args.status;
  // Only the two states the tool declares. "maintenance" exists in the engine
  // but is not in the enum the model was given, so accepting it here would let
  // a hallucinated argument reach the status file.
  if (status !== "active" && status !== "stopped")
    return { result: { error: "'status' must be 'active' or 'stopped'" } };

  const failure = await applyProjectStatus(tenantId, status);
  if (failure) return { result: { error: failure } };
  return {
    changed: true,
    result: {
      status,
      note:
        status === "active"
          ? "The public API is serving traffic again."
          : "Every public endpoint now answers 503.",
    },
  };
}

/** deploy_project — promote every staged draft to production. */
async function toolDeployProject(tenantId: string): Promise<ToolOutcome> {
  const out = await promoteDrafts(tenantId);
  if ("error" in out) return { result: { error: out.error } };
  return {
    changed: true,
    result: {
      promoted: out.promoted,
      apiBase: `${PUBLIC_API_BASE}/${tenantId}`,
      note:
        out.promoted.length === 0
          ? "Nothing was staged, so nothing changed."
          : "Drafts are live and the RAM cache was flushed.",
    },
  };
}

/**
 * delete_resources — *proposes* clearing or removing tables. Deletes nothing.
 *
 * The one tool the model cannot execute. Destroying a user's data on a fuzzy
 * instruction ("clear all data") is not something an agent should do off its
 * own bat, so this returns a proposal, the dashboard renders it as a
 * confirmation, and the deletion is carried out by the user's click against the
 * ordinary files routes. The model can ask; only a human can pull the trigger.
 *
 * Names are matched against what the project actually has, so a hallucinated
 * table is reported back rather than silently acted on — and there is
 * deliberately no wildcard, so wiping everything requires having listed it.
 */
async function toolDeleteResources(
  args: Record<string, unknown>,
  user: User,
  tenantId: string,
): Promise<ToolOutcome> {
  const mode = args.mode;
  if (mode !== "empty" && mode !== "remove")
    return { result: { error: "'mode' must be 'empty' or 'remove'" } };
  if (!Array.isArray(args.names) || args.names.length === 0)
    return {
      result: {
        error:
          "'names' must list the tables to act on. There is no wildcard — " +
          "call get_diagnostics to find out what this project has.",
      },
    };

  const existing = parseResources(ownedProject(tenantId, user.id)!.resources);
  const names: string[] = [];
  const unknown: string[] = [];
  for (const raw of args.names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().toLowerCase();
    if (!existing.includes(name)) unknown.push(raw);
    else if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0)
    return {
      result: {
        error: "none of those tables exist in this project",
        resources: existing,
      },
    };

  return {
    result: {
      pendingConfirmation: { mode, names },
      ...(unknown.length > 0 ? { ignoredUnknown: unknown } : {}),
      note:
        "NOTHING HAS BEEN DELETED YET. This is a proposal shown to the user as a " +
        "confirmation prompt in the dashboard. Tell them it is waiting for their " +
        "confirmation, and do not claim the data is gone.",
    },
  };
}

/** get_diagnostics — syntax health, server status and recent traffic. */
async function toolGetDiagnostics(user: User, tenantId: string): Promise<ToolOutcome> {
  const project = ownedProject(tenantId, user.id)!;
  const [{ syntaxErrors, checked }, status, logs] = await Promise.all([
    collectSyntaxErrors(tenantId, project),
    projectStatus(tenantId),
    coreLogSnapshot(tenantId, AI_MAX_LOG_ENTRIES),
  ]);

  const recent = logs.slice(-AI_MAX_LOG_ENTRIES).map((e) => {
    const rejected = Array.isArray(e.lifecycle) ? e.lifecycle.find((s) => !s.ok) : undefined;
    const failed = e.status >= 400;
    return {
      ts: e.ts,
      method: e.method,
      path: e.path,
      status: e.status,
      durationMs: e.durationMs,
      ...(rejected ? { rejectedAt: rejected.stage, reason: rejected.note ?? null } : {}),
      ...(failed && e.requestBody ? { requestBody: e.requestBody.slice(0, AI_MAX_LOG_BODY) } : {}),
      ...(failed && e.responseBody
        ? { responseBody: e.responseBody.slice(0, AI_MAX_LOG_BODY) }
        : {}),
    };
  });

  // Edge conditions the user never sees while editing files. Derived from the
  // log ring rather than by probing the public API: a diagnosis must not
  // manufacture traffic against the user's own quota.
  const warnings: string[] = [];
  if (status !== "active")
    warnings.push(`The API is ${status} — every public endpoint answers 503.`);
  if (recent.some((e) => e.status === 429))
    warnings.push("Recent requests were rate limited (429).");
  if (recent.some((e) => e.status === 413))
    warnings.push("Recent requests exceeded the body size cap (413).");
  if (recent.some((e) => e.status >= 500))
    warnings.push("The engine returned 5xx for a recent request.");

  return {
    result: {
      status,
      resources: parseResources(project.resources),
      apiBase: `${PUBLIC_API_BASE}/${tenantId}`,
      filesChecked: checked,
      syntaxErrors,
      warnings,
      recentRequests: recent,
      ...(recent.length === 0
        ? { note: "No requests have hit this project's public API recently." }
        : {}),
    },
  };
}

async function runTool(call: FunctionCall, user: User, tenantId: string): Promise<ToolOutcome> {
  try {
    switch (call.name) {
      case "stage_schema_drafts":
        return await toolStageSchemaDrafts(call.args, tenantId);
      case "set_server_status":
        return await toolSetServerStatus(call.args, tenantId);
      case "deploy_project":
        return await toolDeployProject(tenantId);
      case "delete_resources":
        return await toolDeleteResources(call.args, user, tenantId);
      case "get_diagnostics":
        return await toolGetDiagnostics(user, tenantId);
      default:
        return { result: { error: `unknown tool '${call.name}'` } };
    }
  } catch (e) {
    console.error(`[ai] tool ${call.name} failed:`, e);
    return { result: { error: "the tool failed to run" } };
  }
}

// ── The agent loop ────────────────────────────────────────────────

/**
 * POST /projects/<tenantId>/ai/chat — one conversational turn, including any
 * tool calls it takes to answer.
 *
 * Loops: ask the model → it either replies with text (done) or asks for tools →
 * run them → feed the results back → ask again. Bounded by AI_MAX_TOOL_ROUNDS,
 * after which the model is asked once more with no tools available, so a
 * confused agent still ends the request with a sentence for the user instead of
 * spending provider calls in a circle.
 */
async function aiChat(req: Request, user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  // Entitlement before configuration: a Free account gets the same answer
  // whether or not this deployment happens to hold a provider key, so the
  // refusal never doubles as a probe of the server's setup. 402 rather than
  // 403 — the request is well-formed and the caller is who they say they are;
  // what is missing is the plan.
  if (!hasFeature(user, "ai"))
    return err(
      402,
      `The AI Co-Pilot is part of ${cheapestPlanWith("ai").name}. Your account is on ${planOf(user).name}.`,
    );
  if (!aiService)
    return err(503, `The AI Co-Pilot is not configured on this server (${aiDisabledReason})`);

  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const history = validateHistory((body as any)?.messages);
  if (typeof history === "string") return err(400, history);

  const messages: ChatTurn[] = [...history];
  const toolsUsed: string[] = [];
  const deadline = Date.now() + AI_TURN_BUDGET_MS;
  let changed = false;

  for (let round = 0; round <= AI_MAX_TOOL_ROUNDS; round++) {
    // The last round — or the first one past the time budget — runs tool-less,
    // so it can only come back as prose and the turn ends.
    const spent = Date.now() > deadline;
    const tools = round === AI_MAX_TOOL_ROUNDS || spent ? [] : CO_PILOT_TOOLS;

    let reply;
    try {
      reply = await aiService.chat(messages, tools);
    } catch (e) {
      if (e instanceof AIError) {
        console.warn(`[ai] ${e.kind}: ${e.message}${e.detail ? ` — ${e.detail}` : ""}`);
        if (e.kind === "timeout")
          return err(504, "The AI Co-Pilot took too long to respond, please try again.");
        return err(502, "The AI Co-Pilot could not answer, please try again.");
      }
      console.error("[ai] unexpected failure:", e);
      return err(502, "The AI Co-Pilot could not answer, please try again.");
    }

    messages.push(reply.turn);

    if (reply.calls.length === 0)
      return json({
        ok: true,
        tenant: tenantId,
        provider: aiService.provider,
        model: aiService.model,
        text: reply.text,
        messages,
        toolsUsed,
        changed,
      });

    const parts: ChatPart[] = [];
    for (const call of reply.calls) {
      const outcome = await runTool(call, user, tenantId);
      toolsUsed.push(call.name);
      changed = changed || outcome.changed === true;
      parts.push({
        functionResponse: {
          name: call.name,
          response: { result: outcome.result },
          ...(call.id ? { id: call.id } : {}),
        },
      });
    }
    messages.push({ role: "function", parts });
  }

  // Unreachable: the tool-less final round cannot ask for a tool.
  return err(502, "The AI Co-Pilot could not finish its work, please try again.");
}

// ── Usage analytics ───────────────────────────────────────────────
// The Core Engine aggregates request counts in RAM and POSTs them here every
// minute (and on eviction/shutdown). This service owns the SQLite file, so it
// is the only writer to api_usage — the core's sandbox cannot touch it.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCoreAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(ADMIN_SECRET!).digest();
  return timingSafeEqual(a, b);
}

// A day's row keeps the account it was first charged to.
const upsertUsage = db.query(
  `INSERT INTO api_usage (tenant_id, date, request_count, bandwidth_bytes, user_id)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(tenant_id, date) DO UPDATE SET
     request_count   = request_count   + excluded.request_count,
     bandwidth_bytes = bandwidth_bytes + excluded.bandwidth_bytes,
     user_id         = COALESCE(api_usage.user_id, excluded.user_id)`,
);

/**
 * The account a tenant's usage is charged to: its owner, or nobody — for a
 * platform tenant, whose traffic belongs to no customer's allowance, and for a
 * tenant whose project row is already gone.
 */
function usageAccount(tenantId: string): number | null {
  if (PLATFORM_TENANTS.has(tenantId)) return null;
  const row = db.query("SELECT user_id FROM projects WHERE tenant_id = ?").get(tenantId) as {
    user_id: number;
  } | null;
  return row?.user_id ?? null;
}

/** An account's requests this calendar month, across every project it has been charged for. */
function accountMonthRequests(userId: number): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(request_count), 0) AS n FROM api_usage
       WHERE user_id = ? AND date >= date('now', 'start of month')`,
    )
    .get(userId) as { n: number };
  return row.n;
}

const applyUsage = db.transaction(
  (rows: { tenantId: string; date: string; requests: number; bytes: number }[]) => {
    for (const r of rows)
      upsertUsage.run(r.tenantId, r.date, r.requests, r.bytes, usageAccount(r.tenantId));
  },
);

async function ingestUsage(req: Request): Promise<Response> {
  if (!isCoreAuthorized(req)) return err(401, "unauthorized");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const raw = (body as any)?.rows;
  if (!Array.isArray(raw)) return err(400, "'rows' must be an array");
  if (raw.length > 5_000) return err(413, "too many rows in one batch");

  const rows: { tenantId: string; date: string; requests: number; bytes: number }[] = [];
  for (const r of raw) {
    const tenantId = r?.tenantId;
    const date = r?.date;
    const requests = Number(r?.requests);
    const bytes = Number(r?.bytes);
    if (typeof tenantId !== "string" || !NAME_RE.test(tenantId)) continue;
    if (typeof date !== "string" || !DATE_RE.test(date)) continue;
    if (!Number.isFinite(requests) || !Number.isFinite(bytes) || requests < 0 || bytes < 0) continue;
    rows.push({ tenantId, date, requests: Math.floor(requests), bytes: Math.floor(bytes) });
  }
  if (rows.length > 0) applyUsage(rows);
  // The reply is the entitlement channel. Usage flows one way and the tenant's
  // allowance flows back on the same trip, so the core learns what it may serve
  // without ever being taught what a plan or a user is — it gets one number per
  // tenant, refreshed every flush. That also means a plan change takes effect
  // within one USAGE_FLUSH_MS rather than needing anything pushed.
  // Platform tenants are simply left out of the reply: the core has no entry
  // for them and its fail-open path serves them, so exemption needs no
  // sentinel value and no special case on the core side.
  //
  // Every project of an account that reported is quoted, not only the ones in
  // this batch. The allowance is one pool per account, so when one project
  // spends it, the account's idle projects have to hear so on this same trip —
  // otherwise each would keep serving on a stale count until its own next flush.
  const quoted = new Set(rows.map((r) => r.tenantId));
  const accounts = new Set<number>();
  for (const tenantId of quoted) {
    const account = usageAccount(tenantId);
    if (account !== null) accounts.add(account);
  }
  for (const account of accounts)
    for (const { tenant_id } of db
      .query("SELECT tenant_id FROM projects WHERE user_id = ?")
      .all(account) as { tenant_id: string }[])
      quoted.add(tenant_id);
  return json({
    ok: true,
    applied: rows.length,
    skipped: raw.length - rows.length,
    quotas: [...quoted].filter((id) => !PLATFORM_TENANTS.has(id)).map(quotaFor),
  });
}

/**
 * A tenant's monthly request allowance and what has been spent against it.
 *
 * Both belong to the owning account, not the project. The plan is the
 * account's, and so is the spend: one pool across every project it has been
 * charged for this month, deleted ones included — otherwise each new project
 * would be a fresh allowance, and deleting and recreating one would reset the
 * count. Every project of an account is therefore quoted the same `used`, and
 * they all stop together.
 *
 * A tenant whose project row has gone (deleted mid-flight) reports the Free
 * allowance against its own spend rather than nothing: the core still has
 * counters for it, and the honest answer for an unknown tenant is the smallest
 * plan, never unlimited.
 */
function quotaFor(tenantId: string): { tenantId: string; limit: number; used: number } {
  const owner = db
    .query(
      `SELECT u.id AS id, u.plan AS plan FROM projects p JOIN users u ON u.id = p.user_id
       WHERE p.tenant_id = ?`,
    )
    .get(tenantId) as { id: number; plan: string } | null;
  if (owner)
    return { tenantId, limit: planOf(owner).monthlyRequests, used: accountMonthRequests(owner.id) };

  const orphan = db
    .query(
      `SELECT COALESCE(SUM(request_count), 0) AS n FROM api_usage
       WHERE tenant_id = ? AND date >= date('now', 'start of month')`,
    )
    .get(tenantId) as { n: number };
  return { tenantId, limit: planOf({ plan: DEFAULT_PLAN }).monthlyRequests, used: orphan.n };
}

/** Per-project usage: daily rows (newest first) plus a current-month total. */
function projectUsage(user: User, tenantId: string): Response {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const daily = db
    .query(
      `SELECT date, request_count, bandwidth_bytes FROM api_usage
       WHERE tenant_id = ? AND date >= date('now', '-30 days')
       ORDER BY date DESC`,
    )
    .all(tenantId) as { date: string; request_count: number; bandwidth_bytes: number }[];
  const month = db
    .query(
      `SELECT COALESCE(SUM(request_count), 0) AS requests,
              COALESCE(SUM(bandwidth_bytes), 0) AS bytes
       FROM api_usage WHERE tenant_id = ? AND date >= date('now', 'start of month')`,
    )
    .get(tenantId) as { requests: number; bytes: number };
  // `month` is this project's own traffic; `account` is what `limit` applies to.
  return json({
    tenantId,
    month,
    daily,
    limit: planOf(user).monthlyRequests,
    account: { requests: accountMonthRequests(user.id) },
  });
}

// ── Live logs (SSE proxy) ─────────────────────────────────────────

/**
 * GET /projects/<tenantId>/live-logs — pipes the core's admin SSE stream to the
 * browser after checking the session owns the project. The core's log stream
 * sits behind ADMIN_SECRET, which must never reach a browser, so this proxy is
 * the only way a dashboard user can watch their own traffic.
 *
 * The upstream body is passed through untouched (no buffering) and the client's
 * abort signal is forwarded, so closing the tab tears down the core-side
 * subscriber instead of leaking it.
 */
async function liveLogs(req: Request, user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");

  let upstream: Response;
  try {
    upstream = await fetch(`${CORE_API_URL}/${tenantId}/_admin/sse-logs`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      signal: req.signal,
    });
  } catch {
    return err(502, "core engine is unreachable");
  }
  if (!upstream.ok || !upstream.body)
    return err(502, `core engine refused the log stream (status ${upstream.status})`);

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ── Diagnostics ───────────────────────────────────────────────────

/**
 * GET /projects/<tenantId>/diagnostics — reads every JSON file the core holds
 * for this tenant and reports the ones that fail to parse. Malformed JSON is
 * otherwise invisible: the core skips unreadable files with a console warning
 * and simply serves nothing, which looks like "my data vanished" from the UI.
 *
 * Runs entirely over the core's admin files plane — this service cannot read
 * TENANTS_DIR itself (its systemd unit has no such ReadWritePath).
 */
async function collectSyntaxErrors(
  tenantId: string,
  project: ProjectRow,
): Promise<{ syntaxErrors: { file: string; message: string }[]; checked: number }> {
  // The resources column tracks live files; drafts and config are checked too
  // because a broken draft blocks a deploy and a broken config silently
  // reverts every tenant setting to its default.
  const live = parseResources(project.resources);
  const names = [...new Set([...live, ...live.map((r) => `${DRAFT_PREFIX}${r}`), "config", "rbac"])];

  const syntaxErrors: { file: string; message: string }[] = [];
  await Promise.all(
    names.map(async (name) => {
      const res = await coreAdmin("GET", tenantId, name);
      // 404 just means the file isn't there (no draft staged, no config yet).
      if (res.status === 404) return;
      if (!res.ok) {
        const message = (res.data as any)?.error ?? `core returned ${res.status}`;
        syntaxErrors.push({ file: `${name}.json`, message: String(message) });
      }
    }),
  );
  syntaxErrors.sort((a, b) => a.file.localeCompare(b.file));
  return { syntaxErrors, checked: names.length };
}

async function projectDiagnostics(user: User, tenantId: string): Promise<Response> {
  const project = ownedProject(tenantId, user.id);
  if (!project) return err(404, "project not found");
  return json({ tenantId, ...(await collectSyntaxErrors(tenantId, project)) });
}

// ── Deploy & project status ───────────────────────────────────────

/**
 * Promote every staged draft over its production file. Shared by the Deploy
 * button's route and the Co-Pilot's deploy_project tool, so "deploy" means
 * exactly one thing however it was asked for.
 */
async function promoteDrafts(
  tenantId: string,
): Promise<{ promoted: string[] } | { error: string }> {
  const res = await coreAdminAction(tenantId, "deploy");
  // A project with nothing written yet has no tenant folder on the core, which
  // answers 404. Ownership is already verified by the caller, so that is not an
  // error: this service owns "the project exists", and there is simply nothing
  // staged to promote. Without this, Deploy fails on every brand-new project.
  if (res.status === 404) return { promoted: [] };
  if (!res.ok) return { error: `core engine refused the deploy (status ${res.status})` };
  // Cleared here rather than in deployProject so the Deploy button and the
  // Co-Pilot's deploy_project tool cannot disagree about what a deploy means.
  // Only on success: a refused deploy returns above with the flag standing,
  // which is the safe direction — a project that over-reports staged changes
  // costs a redundant redeploy, one that under-reports serves stale data
  // silently. The core promotes every draft it finds, including any staged
  // before this column existed, so clearing the whole set is right.
  clearDirty(tenantId);
  return { promoted: ((res.data as any)?.promoted ?? []) as string[] };
}

async function deployProject(user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const out = await promoteDrafts(tenantId);
  if ("error" in out) return err(502, out.error);
  return json({ ok: true, tenant: tenantId, promoted: out.promoted });
}

/**
 * Start or stop the tenant's public plane. Shared by the start/stop route and
 * the Co-Pilot's set_server_status tool. Returns null on success.
 *
 * One write to one file, and it applies immediately. Status is not config: it
 * is never staged, never deployed and has no line in the .env text, so there is
 * no draft to keep in step and nothing a later Save or Deploy can overwrite.
 */
async function applyProjectStatus(tenantId: string, status: string): Promise<string | null> {
  const res = await coreAdminStatus(tenantId, status);
  return res.ok ? null : `core engine refused the status write (status ${res.status})`;
}

async function setProjectStatus(req: Request, user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const status = (body as any)?.status;
  if (status !== "active" && status !== "stopped" && status !== "maintenance")
    return err(400, "status must be 'active', 'stopped' or 'maintenance'");

  const failure = await applyProjectStatus(tenantId, status);
  if (failure) return err(502, failure);
  return json({ ok: true, tenant: tenantId, status });
}

// ── Developer API keys ────────────────────────────────────────────
// Long-lived per-project credentials for external MCP clients. A browser
// session token is the wrong instrument: it expires on SESSION_TTL_DAYS, dies
// on logout, and would have to be pasted into a desktop config file.

const API_KEY_PREFIX = "sk_stub_";
const API_KEY_PREVIEW_CHARS = API_KEY_PREFIX.length + 6;
const MAX_KEYS_PER_PROJECT = 20;
const MAX_KEY_NAME_LEN = 64;

/**
 * Developer keys are hashed with sha256, not argon2id — deliberately.
 *
 * Bun.password (argon2id, 19 MiB) exists to make *low-entropy, human-chosen*
 * passwords expensive to brute-force offline. A developer key is 256 bits of
 * CSPRNG output that this service generates itself: there is no dictionary to
 * run against it, so slow hashing buys no security here. What it would cost is
 * real — argon2 salts every hash, so a key could not be found *by* its hash.
 * Every request would have to load the project's keys and argon2-verify them
 * one by one, at ~19 MiB and tens of milliseconds each. MCP is chatty (every
 * JSON-RPC message is a POST), so on the 1GB box that is a denial of service
 * wearing a security hat.
 *
 * This is the same reasoning already applied to session tokens above, which are
 * likewise high-entropy bearer secrets stored via sha256hex(). Same kind of
 * secret, same treatment. User passwords keep argon2id — they are passwords.
 */
const hashApiKey = (key: string) => sha256hex(key);

interface KeyRow {
  id: number;
  tenant_id: string;
  prefix: string;
  name: string | null;
  created_at: string;
}

const keyJson = (r: KeyRow) => ({
  id: r.id,
  prefix: r.prefix,
  name: r.name,
  createdAt: r.created_at,
});

function listKeys(user: User, tenantId: string): Response {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const rows = db
    .query(
      "SELECT id, tenant_id, prefix, name, created_at FROM developer_api_keys WHERE tenant_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all(tenantId) as KeyRow[];
  return json(rows.map(keyJson));
}

async function createKey(req: Request, user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const rawName = (body as any)?.name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== "string")
    return err(400, "name must be a string");
  const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_KEY_NAME_LEN) : "";

  const count = (
    db.query("SELECT COUNT(*) AS n FROM developer_api_keys WHERE tenant_id = ?").get(tenantId) as {
      n: number;
    }
  ).n;
  if (count >= MAX_KEYS_PER_PROJECT)
    return err(409, `a project may hold at most ${MAX_KEYS_PER_PROJECT} keys — revoke one first`);

  // 256 bits from the CSPRNG, same generator as createSession().
  const key =
    API_KEY_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const prefix = key.slice(0, API_KEY_PREVIEW_CHARS);
  const inserted = db
    .query(
      "INSERT INTO developer_api_keys (tenant_id, key_hash, prefix, name) VALUES (?, ?, ?, ?) RETURNING id, tenant_id, prefix, name, created_at",
    )
    .get(tenantId, hashApiKey(key), prefix, name || null) as KeyRow;

  // The raw key is returned exactly once and never stored — only its hash is.
  return json({ ...keyJson(inserted), key }, 201);
}

function revokeKey(user: User, tenantId: string, rawId: string): Response {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return err(400, "invalid key id");
  // tenant_id in the WHERE clause as well as id: an id belonging to someone
  // else's project must not be revocable by guessing the number.
  const { changes } = db
    .query("DELETE FROM developer_api_keys WHERE id = ? AND tenant_id = ?")
    .run(id, tenantId);
  if (changes === 0) return err(404, "key not found");
  return json({ ok: true, id, revoked: true });
}

/**
 * Resolves a developer key to the project it belongs to. Returns false for a
 * missing, malformed or unknown key, and for a key issued against a *different*
 * project — the tenant always comes from the URL path, never from the key row,
 * so a valid key can never be redirected at another tenant's data.
 */
function developerKeyAuthorizes(req: Request, tenantId: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const row = db
    .query("SELECT id FROM developer_api_keys WHERE key_hash = ? AND tenant_id = ?")
    .get(hashApiKey(header.slice(7)), tenantId) as { id: number } | null;
  return row !== null;
}

// ── MCP proxy ─────────────────────────────────────────────────────
// The public face of the Core Engine's MCP transport. External agents cannot
// reach the core's _admin plane (it needs ADMIN_SECRET, which never leaves this
// box), so they authenticate here with a developer key and this service adds
// the admin credential on the way through.
//
//   GET  /projects/<tenantId>/mcp/sse       → core /<tenantId>/_admin/mcp/sse
//   POST /projects/<tenantId>/mcp/message   → core /<tenantId>/_admin/mcp/message

/** Endpoint frames name the core's admin path; clients must be told ours. */
function rewriteEndpointFrame(frame: string, tenantId: string): string {
  return frame.replace(
    new RegExp(`^(data:\\s*)/${tenantId}/_admin/mcp/message`, "m"),
    `$1/projects/${tenantId}/mcp/message`,
  );
}

/**
 * Rewrites the `endpoint` event — and only that one — then gets out of the way.
 *
 * MCP's HTTP+SSE transport opens with an `endpoint` frame telling the client
 * where to POST. The core names its own admin route there, which no external
 * client can reach, so the first frame has to be rebased onto this service's
 * public path. The path stays relative, so it resolves against whatever origin
 * the client connected to (dev proxy, *.localhost, production) without this
 * service needing to know its own public hostname.
 *
 * Everything after the first frame is forwarded byte-for-byte with no
 * buffering, so streaming latency is unaffected.
 */
function endpointRewriteStream(tenantId: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let done = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return controller.enqueue(chunk); // pass-through, untouched
      buffered += decoder.decode(chunk, { stream: true });
      const end = buffered.indexOf("\n\n");
      // The frame is ~80 bytes; if a frame boundary hasn't arrived by this
      // much, something is wrong upstream — stop rewriting rather than buffer
      // the stream indefinitely.
      if (end === -1) {
        if (buffered.length <= 8192) return;
        done = true;
        return controller.enqueue(encoder.encode(buffered));
      }
      const first = rewriteEndpointFrame(buffered.slice(0, end + 2), tenantId);
      const rest = buffered.slice(end + 2);
      buffered = "";
      done = true;
      controller.enqueue(encoder.encode(first + rest));
    },
    flush(controller) {
      if (!done && buffered) controller.enqueue(encoder.encode(buffered));
    },
  });
}

async function mcpSse(req: Request, tenantId: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${CORE_API_URL}/${tenantId}/_admin/mcp/sse`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      signal: req.signal, // a disconnecting agent tears down the core-side session
    });
  } catch {
    return err(502, "core engine is unreachable");
  }
  if (!upstream.ok || !upstream.body)
    return err(502, `core engine refused the MCP stream (status ${upstream.status})`);

  return new Response(upstream.body.pipeThrough(endpointRewriteStream(tenantId)), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function mcpMessage(req: Request, tenantId: string, url: URL): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;

  // Only the session id rides along; nothing else from the client's query
  // string reaches the admin plane.
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const target = new URL(`${CORE_API_URL}/${tenantId}/_admin/mcp/message`);
  target.searchParams.set("sessionId", sessionId);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch {
    return err(502, "core engine is unreachable");
  }
  const data = await upstream.json().catch(() => ({}));
  return json(data, upstream.status);
}

/**
 * Developer-key-authenticated MCP routes. Dispatched before the session check
 * in route(), because these callers are desktop agents holding a developer key,
 * not browsers holding a session token.
 */
async function mcpRoute(req: Request, tenantId: string, action: string, url: URL): Promise<Response> {
  if (!NAME_RE.test(tenantId)) return err(400, "invalid project id");
  if (!developerKeyAuthorizes(req, tenantId)) {
    // Same body either way: whether a project exists is not something an
    // unauthenticated caller gets to learn by probing.
    const res = err(401, "a valid developer API key is required");
    res.headers.set("www-authenticate", 'Bearer realm="stubbase-mcp"');
    return res;
  }
  if (action === "sse" && req.method === "GET") return mcpSse(req, tenantId);
  if (action === "message" && req.method === "POST") return mcpMessage(req, tenantId, url);
  return err(404, "not found");
}

// ── CORS ──────────────────────────────────────────────────────────

function withCors(res: Response, req: Request): Response {
  const origin = req.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return res;
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("vary", "Origin");
  return res;
}

function preflight(req: Request): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.headers.set("access-control-allow-headers", "authorization, content-type");
  res.headers.set("access-control-max-age", "86400");
  return withCors(res, req);
}

// ── Server ────────────────────────────────────────────────────────

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 0) return json({ service: "stubbase-dashboard-api" });

  // Core Engine → this service (ADMIN_SECRET, never a browser session)
  if (segments[0] === "_internal") {
    if (req.method === "POST" && segments[1] === "usage" && segments.length === 2)
      return ingestUsage(req);
    return err(404, "not found");
  }

  if (segments[0] === "auth") {
    if (req.method === "POST" && segments[1] === "signup" && segments.length === 2)
      return signup(req);
    if (req.method === "POST" && segments[1] === "login" && segments.length === 2)
      return login(req);

    // OAuth: unauthenticated by definition — the caller is a browser being
    // bounced between us and the provider, and it has no session yet.
    if (req.method === "GET" && segments[1] === "providers" && segments.length === 2)
      return json({ google: oauthConfigured("google"), github: oauthConfigured("github") });
    // One Tap posts here from the landing origin; see the block comment on
    // googleOneTap for why it cannot live on the API subdomain.
    if (
      req.method === "POST" &&
      segments[1] === "google" &&
      segments[2] === "one-tap" &&
      segments.length === 3
    )
      return googleOneTap(req);
    if (req.method === "GET" && (segments[1] === "google" || segments[1] === "github")) {
      const provider = segments[1] as OauthProvider;
      if (segments.length === 2) return oauthStart(req, provider);
      if (segments.length === 3 && segments[2] === "callback")
        return oauthCallback(req, provider);
    }

    const user = authenticate(req);
    if (!user) return err(401, "unauthorized");
    if (req.method === "POST" && segments[1] === "logout" && segments.length === 2)
      return logout(req);
    if (req.method === "GET" && segments[1] === "me" && segments.length === 2)
      return json({ user: publicUser(user) });
    return err(404, "not found");
  }

  if (segments[0] === "projects") {
    // MCP first: these callers are external agents authenticating with a
    // developer key, so they must not be met by the session-token check below.
    if (segments.length === 4 && segments[2] === "mcp")
      return mcpRoute(req, segments[1], segments[3], url);

    const user = authenticate(req);
    if (!user) return err(401, "unauthorized");

    if (segments.length === 1) {
      if (req.method === "GET") {
        const rows = db
          .query(
            "SELECT tenant_id, name, resources, dirty, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC",
          )
          .all(user.id) as ProjectRow[];
        return json(rows.map(projectJson));
      }
      if (req.method === "POST") return createProject(req, user);
    }

    if (segments.length === 2) {
      if (req.method === "PATCH") return renameProject(req, user, segments[1]);
      if (req.method === "DELETE") return deleteProject(user, segments[1]);
    }

    if (segments.length === 3 && req.method === "POST") {
      if (segments[2] === "deploy") return deployProject(user, segments[1]);
      if (segments[2] === "status") return setProjectStatus(req, user, segments[1]);
    }

    if (segments.length === 3 && req.method === "GET") {
      if (segments[2] === "usage") return projectUsage(user, segments[1]);
      if (segments[2] === "live-logs") return liveLogs(req, user, segments[1]);
      if (segments[2] === "diagnostics") return projectDiagnostics(user, segments[1]);
      if (segments[2] === "keys") return listKeys(user, segments[1]);
      if (segments[2] === "system") return listSystemFiles(user, segments[1]);
      if (segments[2] === "status") return getProjectStatus(user, segments[1]);
    }

    if (segments.length === 4 && req.method === "GET" && segments[2] === "system")
      return getSystemFile(user, segments[1], segments[3]);

    if (
      segments.length === 6 &&
      req.method === "PUT" &&
      segments[2] === "system" &&
      segments[3] === "users" &&
      segments[5] === "role"
    )
      return setUserRole(req, user, segments[1], segments[4]);

    if (segments.length === 3 && req.method === "POST" && segments[2] === "keys")
      return createKey(req, user, segments[1]);

    if (segments.length === 4 && req.method === "DELETE" && segments[2] === "keys")
      return revokeKey(user, segments[1], segments[3]);

    if (segments.length === 4 && req.method === "POST" && segments[2] === "ai" && segments[3] === "chat")
      return aiChat(req, user, segments[1]);

    if (segments.length === 4 && segments[2] === "files") {
      if (req.method === "GET")
        return getFile(user, segments[1], segments[3], url.searchParams.get("source") === "live");
      if (req.method === "PUT") return putFile(req, user, segments[1], segments[3]);
      if (req.method === "DELETE") return deleteFile(user, segments[1], segments[3]);
    }
  }

  return err(404, "not found");
}

const server = Bun.serve({
  port: PORT,
  // Bun idles connections out after 10s by default, which would drop a slow
  // Co-Pilot turn mid-flight: nothing is written to the socket while the agent
  // loop runs. 255s is the maximum Bun accepts, and AI_TURN_BUDGET_MS is set
  // below it so the loop always finishes on our terms rather than the socket's.
  idleTimeout: 255,
  async fetch(req) {
    if (req.method === "OPTIONS") return preflight(req);
    return withCors(await route(req), req);
  },
  error(e) {
    console.error("[app] unhandled:", e);
    return err(500, "internal error");
  },
});

console.log(
  `[app] listening on :${server.port} — db: ${DB_PATH}, core: ${CORE_API_URL}, ` +
    `ai: ${aiService ? `${aiService.provider} ${aiService.model}` : `disabled (${aiDisabledReason})`}`,
);
