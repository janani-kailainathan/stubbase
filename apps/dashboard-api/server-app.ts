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
 *   POST   /auth/signup                         { email, password, name? } → 202, code emailed
 *   POST   /auth/signup/verify                  { verificationId, code } → session
 *   POST   /auth/signup/resend                  { verificationId } → 202, new code emailed
 *   POST   /auth/login                          { email, password }
 *   POST   /auth/forgot-password                { email } → 202 for every address, code emailed
 *   POST   /auth/reset-password                 { email, code, password } → session
 *   POST   /auth/change-password                (auth) { currentPassword, newPassword } → { user }
 *   POST   /auth/logout                         (auth)
 *   GET    /auth/me                             (auth)
 *   PATCH  /auth/me                             (auth) { name } → { user }
 *   GET    /auth/account                        (auth) read-only facts: plan, add-ons, limits, requests used, member since
 *   POST   /auth/delete-account                 (auth) { password } → account removed, every session ended
 *   GET    /auth/sessions                       (auth) this account's signed-in devices
 *   DELETE /auth/sessions/<id>                  (auth) sign one device out
 *   DELETE /auth/sessions/others                (auth) sign out every device but this one
 *   GET    /auth/providers                      which OAuth buttons to show
 *   GET    /auth/google|github[/callback]       OAuth sign-in (when configured)
 *   POST   /auth/google/one-tap                  Google One Tap (landing origin)
 *   GET    /projects                            (auth) list own projects
 *   POST   /projects                            (auth) { name, resources?: { [name]: any[] } }
 *   PATCH  /projects/<tenantId>                 (auth) { name } rename
 *   DELETE /projects/<tenantId>                 (auth) deprovision tenant + remove row
 *   POST   /projects/<tenantId>/duplicate       (auth) { name, copyEnv? } → a new project from this one
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
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  addUsage,
  AIError,
  CO_PILOT_TOOLS,
  createAIService,
  STARTER_CATALOGUE,
  NO_USAGE,
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
// 10,000 requests in a month.
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
  const configured = await createAIService();
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

// Throwaway mail providers, refused at sign-up. Off with
// DASHBOARD_BLOCK_DISPOSABLE_EMAIL=false, which is what a deployment that
// would rather take the sign-ups sets.
const BLOCK_DISPOSABLE_EMAIL =
  (process.env.DASHBOARD_BLOCK_DISPOSABLE_EMAIL ?? "true").trim().toLowerCase() !== "false";
const domainList = (raw: string | undefined) =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );
// The escape hatches, both immediate: a 75,000-domain community list will
// eventually sweep in somebody real, and waiting for a new list file to be
// vendored and deployed is no answer to a customer who cannot sign up. The
// allow-list wins over everything, including the extra block-list.
const EMAIL_DOMAIN_ALLOWLIST = domainList(process.env.DASHBOARD_EMAIL_DOMAIN_ALLOWLIST);
const EMAIL_DOMAIN_BLOCKLIST = domainList(process.env.DASHBOARD_EMAIL_DOMAIN_BLOCKLIST);

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
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at    TEXT           -- set when the owner deleted the account; see deleteAccount
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    id           TEXT,           -- random handle the settings page names a session by
    user_agent   TEXT,           -- the browser that signed in, so a device can be recognised
    last_used_at TEXT            -- refreshed at most every SESSION_TOUCH_MINUTES
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
  -- A password sign-up waiting for its email code. Not an account: the users
  -- row is only written when the code comes back (see verifySignup).
  CREATE TABLE IF NOT EXISTS signup_verifications (
    id              TEXT PRIMARY KEY,   -- handle held by the browser that signed up
    email           TEXT NOT NULL,
    name            TEXT,
    password_hash   TEXT NOT NULL,
    code_hash       TEXT NOT NULL,      -- HMAC of the code; '' once locked by wrong guesses
    code_expires_at TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS signup_verifications_email ON signup_verifications(email);
  -- One row per verification email sent, kept an hour: the per-address throttle.
  CREATE TABLE IF NOT EXISTS signup_email_sends (
    email   TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS signup_email_sends_email ON signup_email_sends(email);
  -- One live "forgot password" code per account; a new request replaces it.
  CREATE TABLE IF NOT EXISTS password_resets (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    code_hash  TEXT NOT NULL,           -- HMAC of the code; '' once locked by wrong guesses
    expires_at TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  -- One row per reset email sent, kept an hour: the per-address throttle.
  CREATE TABLE IF NOT EXISTS password_reset_sends (
    email   TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS password_reset_sends_email ON password_reset_sends(email);
  -- Request packs an account has been granted, one row per pack; see ADDONS.
  -- Written by hand until there is a payment gateway, like users.plan. A pack
  -- is a pool: used grows as traffic past the plan's monthly allowance draws
  -- it down, and it lapses PACK_VALID_MONTHS after granted_at.
  CREATE TABLE IF NOT EXISTS request_packs (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    addon      TEXT NOT NULL,                -- an ADDONS id; anything else adds nothing
    used       INTEGER NOT NULL DEFAULT 0,   -- requests drawn from the pack so far
    granted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS request_packs_user ON request_packs(user_id, granted_at);
  -- The monthly add-ons the packs replaced. Nothing was deployed on them.
  DROP TABLE IF EXISTS account_addons;
  -- AI Co-Pilot credits, one row per grant; see creditGrantsOf. A grant's size
  -- and lifetime come from its source, so a row holds only how much of it has
  -- been spent: 'gift' (given once, at sign-up), 'monthly:YYYY-MM' (a plan's
  -- monthly credits, made on first use in the month) or an AI_PACKS id
  -- (bought, granted by hand until there is a payment gateway).
  CREATE TABLE IF NOT EXISTS ai_credits (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    source     TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,   -- credits spent from this grant
    granted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ai_credits_user ON ai_credits(user_id);
  -- One gift per account and one monthly grant per month: INSERT OR IGNORE
  -- against this is what makes both idempotent. Packs stack, so they are not in it.
  CREATE UNIQUE INDEX IF NOT EXISTS ai_credits_once ON ai_credits(user_id, source)
    WHERE source = 'gift' OR source LIKE 'monthly:%';
  -- Throwaway mail providers, refused at sign-up. Loaded from the vendored
  -- blocked-email-domains.txt (see loadBlockedEmailDomains), which is why it
  -- lives in SQLite rather than a Set: 75,000 domains cost about 9 MB held in
  -- the process and about 2 MB as a table the page cache dips into, and this
  -- box has a gigabyte. WITHOUT ROWID — the domain is the whole row.
  CREATE TABLE IF NOT EXISTS blocked_email_domains (
    domain TEXT PRIMARY KEY
  ) WITHOUT ROWID;
  -- Small key/value scratch for things that describe the database itself
  -- rather than an account: currently the fingerprint of the domain list
  -- that was loaded, so a boot can tell whether the file has changed.
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
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
// Set on an account its owner deleted, whose row stays behind emptied (see deleteAccount).
if (!userCols.includes("deleted_at")) db.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT");
// An HMAC of the address a deleted account was reached at, and the only trace
// of it left on the row: `email` is overwritten so the address is free to sign
// up again, and this is what recognises it when it does, so the returning
// account comes back on its original id and keeps the month's usage (see
// createOrReviveUser). A hash rather than the address itself — someone who
// asked to be deleted should not still be readable in the table.
if (!userCols.includes("deleted_email_hash"))
  db.exec("ALTER TABLE users ADD COLUMN deleted_email_hash TEXT");
// One dormant row per address: reviving clears the hash and deleting sets it
// again on the same row, so a lineage never forks and a returning account can
// never find two ids to come back on. Partial, since live rows all hold NULL.
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS users_deleted_email_hash ON users(deleted_email_hash) WHERE deleted_email_hash IS NOT NULL",
);
// What the settings page shows a session as. A session from before these columns
// gets its id now; it has no device to show, and no last use until its next request.
const sessionCols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
  (c) => c.name,
);
for (const col of ["id", "user_agent", "last_used_at"])
  if (!sessionCols.includes(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
db.exec("UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sessions_id ON sessions(id)");
db.exec("CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)");
// Whether a draft is staged but not yet deployed. Existing rows come back 0, so
// a project sitting on an undeployed draft right now reads clean until its next
// save — a one-time blind spot, and the alternative (assuming every project is
// dirty) would warn about changes most of them do not have.
const projectCols = (db.query("PRAGMA table_info(projects)").all() as { name: string }[]).map(
  (c) => c.name,
);
if (!projectCols.includes("dirty"))
  db.exec("ALTER TABLE projects ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0");
// Live tables the owner removed, waiting for the deploy that removes them. A
// table's records are saved live, but whether the table exists is published by
// Deploy — so a removal is recorded here and carried out there (promoteDrafts).
if (!projectCols.includes("removing"))
  db.exec("ALTER TABLE projects ADD COLUMN removing TEXT NOT NULL DEFAULT '[]'");
// What undoes a record change the Co-Pilot made: the core's before-images,
// kept here and never handed to the model (see "Record tools"). One row per
// change, spent by its Undo, and gone after AI_UNDO_TTL_HOURS either way.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_undo (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    tenant_id  TEXT NOT NULL,
    table_name TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
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
// The two self-serve tiers the pricing page sells (sites/landing/src/pages/pricing.astro
// is the copy; this is the contract). Enterprise is a "let's talk" card there
// and has no plan here: it is sold by conversation, not by a row. There is no
// payment gateway yet, so a plan is set on the row —
// `UPDATE users SET plan = 'pro' WHERE email = ?` — and
// scripts/seed-dev-users.ts creates one account per tier locally.
//
// This service owns the table because it owns users. The Core Engine is
// deliberately plan-blind: it is multi-tenant infrastructure that has never
// heard of an account, so it is told *numbers* (this tenant's monthly request
// allowance and per-second limit) rather than a tier name. See the usage-flush
// reply below.
//
// Plans differ in their request limits alone — how many a month, and how many a
// second with a burst on top — both gated at REQUEST time in the core because
// that is the only thing in the traffic path. Request packs (ADDONS) add a pool
// of requests on Pro; nothing raises the per-second limit, which is what
// keeps one account's peak from taking the box down for everyone. Every
// project feature — auth and roles, webhooks, QA mode — is on every plan, so
// nothing a project's .env or rbac.json can switch on is refused here. The AI
// Co-Pilot is on every plan too, metered in credits rather than gated by plan
// (see AI credits below): Pro differs only in getting credits every month.

type PlanId = "free" | "pro";

interface Plan {
  id: PlanId;
  name: string;
  monthlyRequests: number;
  /** Sustained requests per second, one bucket shared by every project of the account. */
  requestsPerSecond: number;
  /** Requests that may arrive at once before the per-second rate applies. */
  burst: number;
  /** Whether request packs are drawn on. A pack held on a plan without them sits idle. */
  requestPacks: boolean;
  /** AI credits granted each calendar month. They do not roll over. */
  monthlyAiCredits: number;
}

// Bursts are generous on purpose: one page load fires several calls at once, and
// a test runner several workers, and neither should meet a 429 for it.
const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyRequests: 10_000,
    requestsPerSecond: 5,
    burst: 20,
    requestPacks: false,
    monthlyAiCredits: 0,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyRequests: 250_000,
    requestsPerSecond: 50,
    burst: 150,
    requestPacks: true,
    monthlyAiCredits: 1_000,
  },
};


const DEFAULT_PLAN: PlanId = "free";

/**
 * An unknown or NULL plan string reads as Free — never as unlimited. Own keys
 * only: a plain index would read `constructor` as a plan with no limits at all.
 */
const planOf = (u: { plan: string }): Plan =>
  Object.hasOwn(PLANS, u.plan) ? PLANS[u.plan as PlanId] : PLANS[DEFAULT_PLAN];


// ── Add-ons ───────────────────────────────────────────────────────
//
// Request packs: a pool of requests bought once, for Pro. Traffic comes out of
// the plan's monthly allowance first, and only what goes past it draws a pack
// down; what is left carries from month to month until the pack lapses,
// PACK_VALID_MONTHS after it was granted. Packs stack, and the one that lapses
// soonest is drawn first. They raise the number of requests and nothing else.
// Monthly volume is cheap for the box (a million requests averages 0.4 a
// second over a month); what it cannot absorb is a peak, so the per-second
// limit stays the plan's.
//
// Pro only, on purpose: a Free account that needs more requests needs Pro, and
// a cheap pack must not stand in for the subscription. A pack held on a plan
// without `requestPacks` — bought on Pro, then downgraded — is neither counted
// nor drawn on, and keeps lapsing on schedule.
//
// Like a plan, a pack is a row set by hand until there is a payment gateway:
//
//   INSERT INTO request_packs (user_id, addon)
//   VALUES ((SELECT id FROM users WHERE email = ?), 'requests_250k');
//
// The prices are the pricing page's (sites/landing/src/pages/pricing.astro);
// this is the contract. An id missing from ADDONS adds nothing, so retiring a
// pack is deleting its entry, never granting whatever the row says.

type AddonId = "requests_250k" | "requests_1m";

interface Addon {
  id: AddonId;
  name: string;
  requests: number;
}

const ADDONS: Record<AddonId, Addon> = {
  requests_250k: { id: "requests_250k", name: "+250,000 requests", requests: 250_000 },
  requests_1m: { id: "requests_1m", name: "+1,000,000 requests", requests: 1_000_000 },
};

const PACK_VALID_MONTHS = 12;

interface HeldPack {
  id: number;
  addon: AddonId;
  name: string;
  requests: number;
  remaining: number;
  /** YYYY-MM-DD, UTC: the first day the pack no longer counts. */
  expiresOn: string;
}

/**
 * The packs an account holds that still count for something: sold, not lapsed,
 * not used up. Soonest-lapsing first, which is also the order they are drawn.
 */
function packsOf(userId: number): HeldPack[] {
  const rows = db
    .query(
      `SELECT id, addon, used, date(granted_at, '+${PACK_VALID_MONTHS} months') AS expires_on
       FROM request_packs
       WHERE user_id = ? AND datetime(granted_at, '+${PACK_VALID_MONTHS} months') > datetime('now')
       ORDER BY granted_at, id`,
    )
    .all(userId) as { id: number; addon: string; used: number; expires_on: string }[];
  return rows.flatMap(({ id, addon, used, expires_on }) => {
    if (!Object.hasOwn(ADDONS, addon)) return [];
    const pack = ADDONS[addon as AddonId];
    const remaining = pack.requests - Math.max(0, Math.floor(Number(used) || 0));
    if (remaining <= 0) return [];
    return [{ id, addon: pack.id, name: pack.name, requests: pack.requests, remaining, expiresOn: expires_on }];
  });
}

/**
 * Draws `requests` from an account's packs, soonest-lapsing first. Called from
 * inside applyUsage's transaction, so a draw and the usage it pays for land
 * together and two flushes cannot spend the same requests. Whatever the packs
 * cannot cover is simply not recorded: the core has already been told to stop.
 */
function drawPacks(userId: number, requests: number) {
  let owed = requests;
  for (const pack of packsOf(userId)) {
    if (owed <= 0) break;
    const take = Math.min(owed, pack.remaining);
    db.query("UPDATE request_packs SET used = used + ? WHERE id = ?").run(take, pack.id);
    owed -= take;
  }
}

/**
 * Everything an account may use: its plan's limits, and the requests left in
 * its packs where the plan draws on them. allowanceOf and limitOf are the one
 * place the two are combined — quotaFor, /auth/me, /auth/account and the usage
 * view all read them, so the figure a person is shown is the one their API is
 * held to.
 */
function allowanceOf(u: { id: number; plan: string }) {
  const plan = planOf(u);
  const packs = packsOf(u.id);
  return {
    plan,
    packs,
    /** Requests left in packs this plan draws on; 0 on a plan without them. */
    packRequests: plan.requestPacks ? packs.reduce((n, p) => n + p.remaining, 0) : 0,
    requestsPerSecond: plan.requestsPerSecond,
    burst: plan.burst,
  };
}

/**
 * The month's limit, given what the account has used. Past the plan's
 * allowance, `used` already includes what the packs paid for (and their
 * `remaining` has dropped by as much), so the limit is the larger of the two
 * plus what the packs still hold. With nothing left, the limit is `used` and
 * the core stops.
 */
const limitOf = (allowance: ReturnType<typeof allowanceOf>, used: number) =>
  Math.max(used, allowance.plan.monthlyRequests) + allowance.packRequests;

// ── AI credits ────────────────────────────────────────────────────
//
// The Co-Pilot costs a provider call on every round of every turn, so it is
// metered: 1 credit = TOKENS_PER_CREDIT tokens (input, output and thinking), a
// turn charged once when it ends for everything its rounds used, rounded up.
// Charging tokens rather than turns is what keeps "seed 5,000 rows" from
// costing the same as "rename a field".
//
// Credits come from three places, all in the ai_credits table:
//   - a gift of GIFT_CREDITS, once per account at sign-up, lasting
//     GIFT_VALID_MONTHS. A revived account does not get another: its lineage
//     already had one, and a gift per sign-up would be a gift per deletion.
//   - a plan's monthlyAiCredits, as a 'monthly:YYYY-MM' row made on first use
//     in the month and gone at its end. Counted only while the plan still
//     grants them, so a downgrade mid-month does not keep Pro's credits.
//   - packs (AI_PACKS), bought on any plan, lasting AI_PACK_VALID_MONTHS.
//     Granted by hand until there is a payment gateway:
//       INSERT INTO ai_credits (user_id, source)
//       VALUES ((SELECT id FROM users WHERE email = ?), 'credits_5k');
// They are spent soonest-expiring first, so the month's credits and the gift
// go before anything that was paid for. The prices are the pricing page's;
// this is the contract, and a source missing from it adds nothing.

type AiPackId = "credits_5k" | "credits_20k" | "credits_60k";

const AI_PACKS: Record<AiPackId, { id: AiPackId; name: string; credits: number }> = {
  credits_5k: { id: "credits_5k", name: "Starter pack", credits: 5_000 },
  credits_20k: { id: "credits_20k", name: "Builder pack", credits: 20_000 },
  credits_60k: { id: "credits_60k", name: "Scale pack", credits: 60_000 },
};

const TOKENS_PER_CREDIT = 1_000;
const GIFT_CREDITS = 100;
const GIFT_VALID_MONTHS = 3;
const AI_PACK_VALID_MONTHS = 12;

interface CreditGrant {
  id: number;
  name: string;
  credits: number;
  remaining: number;
  /** ISO timestamp, UTC: when the grant stops counting. */
  expiresAt: string;
}

/**
 * The grants an account can still spend, soonest-expiring first — the order
 * they are spent in. Makes this month's plan grant first if the plan has one,
 * which is the only write here, and idempotent.
 */
function creditGrantsOf(user: { id: number; plan: string }): CreditGrant[] {
  const plan = planOf(user);
  if (plan.monthlyAiCredits > 0)
    db.query(
      "INSERT OR IGNORE INTO ai_credits (user_id, source) VALUES (?, 'monthly:' || strftime('%Y-%m', 'now'))",
    ).run(user.id);
  const rows = db
    .query(
      `SELECT * FROM (
         SELECT id, source, used,
                CASE
                  WHEN source = 'gift' THEN datetime(granted_at, '+${GIFT_VALID_MONTHS} months')
                  WHEN source LIKE 'monthly:%' THEN datetime(substr(source, 9) || '-01', '+1 month')
                  ELSE datetime(granted_at, '+${AI_PACK_VALID_MONTHS} months')
                END AS expires_at
         FROM ai_credits WHERE user_id = ?)
       WHERE expires_at > datetime('now')
       ORDER BY expires_at, id`,
    )
    .all(user.id) as { id: number; source: string; used: number; expires_at: string }[];
  return rows.flatMap(({ id, source, used, expires_at }) => {
    let name: string;
    let credits: number;
    if (source === "gift") [name, credits] = ["Gift credits", GIFT_CREDITS];
    else if (source.startsWith("monthly:")) [name, credits] = [`${plan.name} monthly credits`, plan.monthlyAiCredits];
    else if (Object.hasOwn(AI_PACKS, source)) {
      const pack = AI_PACKS[source as AiPackId];
      [name, credits] = [pack.name, pack.credits];
    } else return [];
    const remaining = credits - Math.max(0, Math.floor(Number(used) || 0));
    if (remaining <= 0) return [];
    return [{ id, name, credits, remaining, expiresAt: isoUtc(expires_at)! }];
  });
}

const creditBalance = (user: { id: number; plan: string }) =>
  creditGrantsOf(user).reduce((n, g) => n + g.remaining, 0);

/** The balance and what it is made of, as /auth/account and the chat route report it. */
function aiCreditsOf(user: { id: number; plan: string }) {
  const grants = creditGrantsOf(user);
  return {
    balance: grants.reduce((n, g) => n + g.remaining, 0),
    monthly: planOf(user).monthlyAiCredits,
    grants: grants.map(({ name, credits, remaining, expiresAt }) => ({ name, credits, remaining, expiresAt })),
  };
}

/**
 * Spends `credits` soonest-expiring first, in one synchronous transaction.
 * A turn that cost more than was left stops the balance at zero rather than
 * below it: the overrun is bounded by the turn's round limit, and a debt would
 * be a Co-Pilot that stays off after the next grant arrives.
 */
const spendCredits = db.transaction((user: { id: number; plan: string }, credits: number) => {
  let owed = credits;
  for (const grant of creditGrantsOf(user)) {
    if (owed <= 0) break;
    const take = Math.min(owed, grant.remaining);
    db.query("UPDATE ai_credits SET used = used + ? WHERE id = ?").run(take, grant.id);
    owed -= take;
  }
});

// ── Auth ──────────────────────────────────────────────────────────

interface User {
  id: number;
  email: string;
  name: string | null;
  plan: string;
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ── Disposable email domains ──────────────────────────────────────
//
// A throwaway address is a free account with nobody behind it, and every one
// of them carries a monthly request allowance. The list is vendored
// (blocked-email-domains.txt beside this file) rather than fetched: sign-up
// must not depend on somebody else's uptime, and a list that changes without
// a commit is a list nobody reviewed.
//
// It lives in SQLite rather than a Set because of the box. Measured on the
// 75,000-domain list: about 18 MB held as a Set of strings, about 9 MB as one
// string with an offset index, about 2 MB as this table, where the cost is
// page cache that is bounded and shared with every other query. A lookup is a
// few microseconds against a sign-up that already spends ~100 ms in argon2.
//
// Reloaded only when the file changes. The fingerprint of the exact bytes
// that were loaded is kept in app_meta, so an unchanged file costs one hash
// at boot and no writes, and a refreshed file is picked up with no migration
// to remember to write.
const BLOCKED_DOMAINS_FILE = join(import.meta.dir, "blocked-email-domains.txt");

async function loadBlockedEmailDomains(): Promise<void> {
  if (!BLOCK_DISPOSABLE_EMAIL) return;
  const file = Bun.file(BLOCKED_DOMAINS_FILE);
  if (!(await file.exists())) {
    // Not fatal: the allow/block-list env knobs still work, and refusing to
    // boot over a missing data file would take the dashboard down for
    // everyone to stop a sign-up abuse it is only meant to discourage.
    console.error(`[app] ${BLOCKED_DOMAINS_FILE} is missing; disposable-email blocking is inactive`);
    return;
  }
  const text = await file.text();
  const fingerprint = sha256hex(text);
  const loaded = db.query("SELECT value FROM app_meta WHERE key = 'blocked_email_domains'").get() as
    | { value: string }
    | null;
  if (loaded?.value === fingerprint) return;

  const insert = db.prepare("INSERT OR IGNORE INTO blocked_email_domains (domain) VALUES (?)");
  // Scanned in place rather than split into an array: 75,000 short-lived
  // strings is the allocation this design exists to avoid.
  db.transaction(() => {
    db.query("DELETE FROM blocked_email_domains").run();
    let i = 0;
    while (i < text.length) {
      let nl = text.indexOf("\n", i);
      if (nl < 0) nl = text.length;
      const domain = text.slice(i, nl).trim().toLowerCase();
      if (domain && !domain.startsWith("#")) insert.run(domain);
      i = nl + 1;
    }
    db.query(
      "INSERT INTO app_meta (key, value) VALUES ('blocked_email_domains', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(fingerprint);
  })();
  const { n } = db.query("SELECT COUNT(*) AS n FROM blocked_email_domains").get() as { n: number };
  console.log(`[app] loaded ${n} disposable email domains`);
}

const blockedDomainQuery = db.prepare("SELECT 1 FROM blocked_email_domains WHERE domain = ?");

/**
 * Whether this address is a throwaway one.
 *
 * The domain and every parent of it down to two labels are checked, so
 * listing mailinator.com also covers anything.mailinator.com. It stops at two
 * because one label is a TLD: a list that ever contained a bare "com" would
 * otherwise refuse the internet. The vendored file holds no bare TLD and no
 * public suffix, and a refresh should be diffed for both.
 *
 * Takes an address already normalised the way every sign-in path normalises
 * one, and expects it to have passed EMAIL_RE.
 */
function disposableEmail(email: string): boolean {
  if (!BLOCK_DISPOSABLE_EMAIL) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!domain) return false;
  const labels = domain.split(".");
  for (let i = 0; i + 1 < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (EMAIL_DOMAIN_ALLOWLIST.has(candidate)) return false;
    if (EMAIL_DOMAIN_BLOCKLIST.has(candidate)) return true;
    if (blockedDomainQuery.get(candidate) !== null) return true;
  }
  return false;
}

const DISPOSABLE_EMAIL_ERROR =
  "that email provider is not accepted: please sign up with a permanent address";

// ── Coming back to a deleted account ──────────────────────────────
//
// A deleted account keeps its row and its id (deleteAccount), and every
// api_usage row it was ever charged for names that id — so an address that
// signs up again is put back on its own row rather than given a new one, and
// the month's usage carries over instead of resetting. Delete-and-resignup is
// therefore not a way to buy a second monthly allowance.
//
// The row remembers the address only as this HMAC. It is keyed off
// ADMIN_SECRET like the reset codes, so a copy of the database alone cannot be
// asked whether some address once had an account; the cost is that rotating
// ADMIN_SECRET orphans every dormant lineage, and those accounts would come
// back fresh. That rotation already invalidates every tenant's JWT signing key,
// so it is not a thing done lightly.
const EMAIL_LINEAGE_KEY = createHash("sha256").update(`account-email:${ADMIN_SECRET}`).digest();

/**
 * The key a deleted account is found by if its owner comes back. The address is
 * normalised exactly as every sign-in path normalises it, so the lookup matches
 * the same string a sign-up would have stored.
 */
const emailLineageHash = (email: string) =>
  createHmac("sha256", EMAIL_LINEAGE_KEY).update(email.trim().toLowerCase()).digest("base64url");

/**
 * Make the account, or bring back the one this address already had.
 *
 * The only things that survive a deletion are the id and the usage history
 * hanging off it. Everything a sign-up would decide is decided again here: the
 * plan drops back to free (the add-ons went with the account), created_at is
 * the day *this* account started, and the credential is whichever one just
 * proved the mailbox.
 *
 * The read and the write are one synchronous turn, with no await between them,
 * for the reason addResources is: Bun.serve interleaves requests at every await.
 * `deleted_at IS NOT NULL` on the update is the same belt and braces as the
 * UNIQUE(email) it stands in for on this path — unreachable while this is the
 * only process writing, and the thing that keeps a second one from handing one
 * dormant row to two sign-ups.
 *
 * Throws when the address is already taken — both callers already handle that,
 * since UNIQUE(email) threw here before.
 */
function createOrReviveUser(
  email: string,
  name: string | null,
  credential: { passwordHash?: string | null; oauthProvider?: string | null },
): void {
  const passwordHash = credential.passwordHash ?? null;
  const oauthProvider = credential.oauthProvider ?? null;
  const dormant = db
    .query("SELECT id FROM users WHERE deleted_email_hash = ?")
    .get(emailLineageHash(email)) as { id: number } | null;
  if (!dormant) {
    const { lastInsertRowid } = db
      .query("INSERT INTO users (email, name, password_hash, oauth_provider) VALUES (?, ?, ?, ?)")
      .run(email, name, passwordHash, oauthProvider);
    // The one gift the account's lineage ever gets: a revived row, below, has had it.
    db.query("INSERT OR IGNORE INTO ai_credits (user_id, source) VALUES (?, 'gift')").run(lastInsertRowid);
    return;
  }
  const { changes } = db
    .query(
      `UPDATE users
          SET email = ?, name = ?, password_hash = ?, oauth_provider = ?,
              plan = 'free', created_at = datetime('now'),
              deleted_at = NULL, deleted_email_hash = NULL
        WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .run(email, name, passwordHash, oauthProvider, dormant.id);
  if (changes === 0) throw new Error("email already registered");
}

// Verified against when the email doesn't exist, so login latency doesn't
// reveal which emails are registered.
const DUMMY_HASH = await Bun.password.hash("stubbase-dummy-password", ARGON);

// How stale a session's last_used_at may get before a request writes it again.
// Writing it on every request would make every dashboard call a write; this is
// still precise enough to tell a device in use now from one left last week.
const SESSION_TOUCH_MINUTES = 5;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/** An authenticated request's bearer token, hashed as its sessions row stores it. */
const sessionHashOf = (req: Request) => sha256hex((req.headers.get("authorization") ?? "").slice(7));

/**
 * Opens a session for the browser making `req`. Its user agent is kept so the
 * settings page can tell one device from another; the random `id` is what that
 * page names the session by, since the token hash never leaves this service.
 */
function createSession(userId: number, req: Request): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
  db.query("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, id, user_agent, last_used_at)
     VALUES (?, ?, datetime('now', ?), ?, ?, datetime('now'))`,
  ).run(sha256hex(token), userId, `+${SESSION_TTL_DAYS} days`, id, userAgent);
  return token;
}

function authenticate(req: Request): User | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const tokenHash = sha256hex(header.slice(7));
  // deleted_at is belt and braces: deleting an account ends its sessions in the
  // same transaction, so no row should ever match one.
  const row = db
    .query(
      `SELECT u.id, u.email, u.name, u.plan,
              s.last_used_at IS NULL OR s.last_used_at <= datetime('now', ?) AS stale
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.deleted_at IS NULL`,
    )
    .get(`-${SESSION_TOUCH_MINUTES} minutes`, tokenHash) as (User & { stale: number }) | null;
  if (!row) return null;
  const { stale, ...user } = row;
  if (stale)
    db.query("UPDATE sessions SET last_used_at = datetime('now') WHERE token_hash = ?").run(tokenHash);
  return user;
}

// The SPA needs the entitlements, not just the tier name: it disables the
// Co-Pilot composer rather than hiding it, and the usage panel draws the
// monthly allowance as a target. Sent resolved so the browser never has to
// keep its own copy of the plan table — and so it cannot disagree with the
// server that actually enforces.
const publicUser = (u: User) => {
  const allowance = allowanceOf(u);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: allowance.plan.id,
    planName: allowance.plan.name,
    // The plan's allowance with any request packs on top: what the core
    // throttles on at the moment this was answered.
    monthlyRequests: limitOf(allowance, accountMonthRequests(u.id)),
    requestsPerSecond: allowance.requestsPerSecond,
    burst: allowance.burst,
    // Whether the account can sign in with a password at all. An account made
    // by Google or GitHub cannot, so the account menu offers "Set a password"
    // (by emailed code) instead of "Change password" (by current password).
    hasPassword:
      (db.query("SELECT password_hash IS NOT NULL AS p FROM users WHERE id = ?").get(u.id) as {
        p: number;
      } | null)?.p === 1,
  };
};

// ── Email verification (password sign-up) ─────────────────────────
//
// A password sign-up is not an account until the mailbox has answered. Signup
// stores a *pending* sign-up and emails a 6-digit code through Stubbase's own
// Resend account; verifySignup trades the code for the users row and a session.
// OAuth needs none of this — both providers are only accepted with an address
// they verified themselves.
//
// This is what makes signInWithIdentity's join-by-email safe for password
// accounts. Without it, anyone could register a victim's address with their own
// password, and the victim's later Google sign-in would link into an account
// the attacker can still log in to.
//
// A code and never a link, and the code completes only the pending sign-up it
// was issued for — the one whose id the signing-up browser holds. A link would
// carry that id to whoever clicks it: an attacker who signs up with your address
// mails you a link, and clicking it creates *their* account (their password) on
// your address. With a code, the attacker's email carries a code for a sign-up
// you do not hold, and typing it into your own is simply wrong.
//
// Six digits are guessable, so the limits are the security, as for tenant
// password reset: a code lives SIGNUP_CODE_TTL_MIN, SIGNUP_MAX_ATTEMPTS wrong
// guesses lock it, and an address gets at most SIGNUP_MAX_SENDS_PER_HOUR emails
// (sign-ups and resends together), persisted so a restart does not reset it.
// Codes are stored as an HMAC under a key derived from ADMIN_SECRET, never a
// bare hash: a million candidates is nothing to brute-force from a leaked file.

// Stubbase's own Resend account — not a tenant's RESEND_API_KEY, which lives in
// that project's config.json and mails that project's users.
const RESEND_API_KEY = process.env.DASHBOARD_RESEND_API_KEY ?? "";
// A subdomain of its own, so account mail keeps a sending reputation apart from
// stubbase.dev and from any marketing mail. Resend matches the from domain
// exactly: notify.stubbase.dev is the domain verified there, not stubbase.dev.
const EMAIL_FROM = process.env.DASHBOARD_EMAIL_FROM || "Stubbase <no-reply@notify.stubbase.dev>";
// Env-overridable strictly so tests and the local stack can point it at a mock.
const RESEND_API_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
/** Local dev and tests only: write each sign-up and password reset code to the log. NEVER set in production. */
const LOG_EMAIL_CODES = process.env.DASHBOARD_EMAIL_LOG_CODES === "true";

const SIGNUP_CODE_TTL_MIN = 15;
const SIGNUP_PENDING_TTL_HOURS = 24;
const SIGNUP_MAX_ATTEMPTS = 5;
const SIGNUP_MAX_SENDS_PER_HOUR = 5;
const SIGNUP_ID_RE = /^[0-9a-f]{32}$/;
const SIGNUP_CODE_RE = /^\d{6}$/;
const SIGNUP_CODE_KEY = createHash("sha256").update(`signup-code:${ADMIN_SECRET}`).digest();

if (LOG_EMAIL_CODES)
  console.warn(
    "[app] DASHBOARD_EMAIL_LOG_CODES=true: sign-up and password reset codes are written to this log. Local dev and tests only.",
  );
else if (!RESEND_API_KEY)
  console.warn(
    "[app] DASHBOARD_RESEND_API_KEY is unset: email sign-up and password reset answer 503 until it is set (OAuth sign-in is unaffected).",
  );

const accountEmailAvailable = () => Boolean(RESEND_API_KEY) || LOG_EMAIL_CODES;

/** Bound to the pending sign-up as well as the code, so a hash can never be moved to another row. */
const signupCodeHash = (id: string, code: string) =>
  createHmac("sha256", SIGNUP_CODE_KEY).update(`${id}:${code}`).digest("base64url");

const pendingSignup = (id: string, email: string) => ({
  verificationId: id,
  email,
  expiresIn: SIGNUP_CODE_TTL_MIN * 60,
});

const userExists = (email: string) =>
  db.query("SELECT 1 FROM users WHERE email = ?").get(email) !== null;

/** The two per-address send logs. Constant table names, never input, so safe to interpolate. */
type EmailSendLog = "signup_email_sends" | "password_reset_sends";

/**
 * Counts one email against the address's hourly allowance in `log`, or refuses.
 * Callers run it in the same synchronous turn as the write it guards, so
 * concurrent requests cannot all read the same count.
 */
function claimEmailSend(log: EmailSendLog, email: string, perHour: number): boolean {
  db.query(`DELETE FROM ${log} WHERE sent_at <= datetime('now', '-1 hour')`).run();
  const { n } = db.query(`SELECT COUNT(*) AS n FROM ${log} WHERE email = ?`).get(email) as { n: number };
  if (n >= perHour) return false;
  db.query(`INSERT INTO ${log} (email) VALUES (?)`).run(email);
  return true;
}

/** Mails (and, with LOG_EMAIL_CODES, logs) a code. False when Resend refused it. */
async function deliverSignupCode(email: string, code: string): Promise<boolean> {
  if (LOG_EMAIL_CODES) console.log(`[app] sign-up verification code for ${email} is ${code}`);
  if (!RESEND_API_KEY) return true;

  const text = [
    `Your Stubbase verification code is ${code}.`,
    `Enter it on the sign-up page to finish creating your account. It expires in ${SIGNUP_CODE_TTL_MIN} minutes.`,
    "If you did not try to create a Stubbase account, ignore this email: no account is created without this code.",
  ].join("\n\n");
  const html = [
    `<p>Your Stubbase verification code is <strong style="font-size:1.25em;letter-spacing:0.1em">${code}</strong>.</p>`,
    `<p>Enter it on the sign-up page to finish creating your account. It expires in ${SIGNUP_CODE_TTL_MIN} minutes.</p>`,
    `<p>If you did not try to create a Stubbase account, ignore this email: no account is created without this code.</p>`,
  ].join("\n");

  return sendAccountEmail(email, "Your Stubbase verification code", text, html);
}

/** One email through Stubbase's Resend account. False when Resend refused it or was unreachable. */
async function sendAccountEmail(to: string, subject: string, text: string, html: string): Promise<boolean> {
  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, text, html }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (res?.ok) return true;
  // Resend explains itself (an unverified sending domain, a bad key), and the
  // operator reading this log is the only person who can fix either.
  const reason = res ? `${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}` : "unreachable";
  console.error(`[app] Resend did not accept "${subject}" for ${to}: ${reason}`);
  return false;
}

async function signup(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const email = typeof (body as any)?.email === "string" ? (body as any).email.trim().toLowerCase() : "";
  const password = typeof (body as any)?.password === "string" ? (body as any).password : "";
  const name = typeof (body as any)?.name === "string" ? (body as any).name.trim() || null : null;

  if (!EMAIL_RE.test(email)) return err(400, "valid 'email' is required");
  if (disposableEmail(email)) return err(400, DISPOSABLE_EMAIL_ERROR);
  if (password.length < MIN_PASSWORD_LEN)
    return err(400, `'password' must be at least ${MIN_PASSWORD_LEN} characters`);
  // Fails closed: an account nobody verified is exactly what this exists to stop.
  if (!accountEmailAvailable())
    return err(503, "email sign-up is not available: this server has no email provider configured");
  // Before the hash, so a taken address costs no 19 MiB argon2 run…
  if (userExists(email)) return err(409, "email already registered");

  const hash = await Bun.password.hash(password, ARGON);

  // …and again after it, because the hash yielded. From here to the INSERT is
  // one synchronous turn, so the throttle count cannot be raced.
  if (userExists(email)) return err(409, "email already registered");
  if (!claimEmailSend("signup_email_sends", email, SIGNUP_MAX_SENDS_PER_HOUR))
    return err(429, "too many verification emails for this address; try again in an hour");

  db.query("DELETE FROM signup_verifications WHERE created_at <= datetime('now', ?)").run(
    `-${SIGNUP_PENDING_TTL_HOURS} hours`,
  );
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.query(
    `INSERT INTO signup_verifications (id, email, name, password_hash, code_hash, code_expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
  ).run(id, email, name, hash, signupCodeHash(id, code), `+${SIGNUP_CODE_TTL_MIN} minutes`);

  if (!(await deliverSignupCode(email, code))) {
    // Nobody received a code, so there is nothing to verify. The send still
    // counts: failures must not become a way around the hourly limit.
    db.query("DELETE FROM signup_verifications WHERE id = ?").run(id);
    return err(502, "could not send the verification email; try again shortly");
  }
  return json(pendingSignup(id, email), 202);
}

/**
 * Trades a sign-up's code for the account and a session.
 *
 * Everything after the body is read is synchronous — bun:sqlite never yields —
 * so two requests racing with the same code cannot both pass the comparison:
 * the first deletes the row before the second can read it.
 */
async function verifySignup(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const id = typeof (body as any)?.verificationId === "string" ? (body as any).verificationId : "";
  const code = typeof (body as any)?.code === "string" ? (body as any).code.trim() : "";
  if (!SIGNUP_ID_RE.test(id)) return err(400, "'verificationId' is required");
  if (!SIGNUP_CODE_RE.test(code)) return err(400, "'code' must be the 6-digit code from the email");

  // One answer for every way a code can be wrong, so none of them can be told apart.
  const invalid = () => err(400, "invalid or expired verification code");
  const row = db
    .query(
      `SELECT email, name, password_hash, code_hash, code_expires_at > datetime('now') AS live
       FROM signup_verifications WHERE id = ? AND created_at > datetime('now', ?)`,
    )
    .get(id, `-${SIGNUP_PENDING_TTL_HOURS} hours`) as {
    email: string;
    name: string | null;
    password_hash: string;
    code_hash: string;
    live: number;
  } | null;
  if (!row || !row.code_hash || !row.live) return invalid();

  const given = Buffer.from(signupCodeHash(id, code), "base64url");
  const stored = Buffer.from(row.code_hash, "base64url");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    // `attempts` on the right-hand side is the value before this update.
    db.query(
      `UPDATE signup_verifications
       SET attempts = attempts + 1,
           code_hash = CASE WHEN attempts + 1 >= ? THEN '' ELSE code_hash END
       WHERE id = ?`,
    ).run(SIGNUP_MAX_ATTEMPTS, id);
    return invalid();
  }

  // Every pending sign-up for the address goes, not just this one: the mailbox
  // has answered, so a sign-up someone else started for it must never complete.
  db.query("DELETE FROM signup_verifications WHERE email = ?").run(row.email);
  try {
    createOrReviveUser(row.email, row.name, { passwordHash: row.password_hash });
  } catch {
    // An OAuth sign-in created the account while this code was in flight.
    return err(409, "email already registered");
  }
  const user = db
    .query("SELECT id, email, name, plan FROM users WHERE email = ?")
    .get(row.email) as User;
  return json({ token: createSession(user.id, req), user: publicUser(user) }, 201);
}

/** A fresh code for a pending sign-up: replaces the last one and resets its guesses. */
async function resendSignupCode(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const id = typeof (body as any)?.verificationId === "string" ? (body as any).verificationId : "";
  if (!SIGNUP_ID_RE.test(id)) return err(400, "'verificationId' is required");
  if (!accountEmailAvailable())
    return err(503, "email sign-up is not available: this server has no email provider configured");

  const row = db
    .query("SELECT email FROM signup_verifications WHERE id = ? AND created_at > datetime('now', ?)")
    .get(id, `-${SIGNUP_PENDING_TTL_HOURS} hours`) as { email: string } | null;
  if (!row) return err(404, "this sign-up has expired; start again");
  if (!claimEmailSend("signup_email_sends", row.email, SIGNUP_MAX_SENDS_PER_HOUR))
    return err(429, "too many verification emails for this address; try again in an hour");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.query(
    `UPDATE signup_verifications
     SET code_hash = ?, code_expires_at = datetime('now', ?), attempts = 0
     WHERE id = ?`,
  ).run(signupCodeHash(id, code), `+${SIGNUP_CODE_TTL_MIN} minutes`, id);

  if (!(await deliverSignupCode(row.email, code)))
    return err(502, "could not send the verification email; try again shortly");
  return json(pendingSignup(id, row.email), 202);
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

  // A password reset can land while the hash above was verifying. A session
  // opened on the old password after that would outlive the reset that was
  // meant to end every session, so the password must still be the one checked.
  const current = db.query("SELECT password_hash FROM users WHERE id = ?").get(row.id) as {
    password_hash: string | null;
  } | null;
  if (current?.password_hash !== row.password_hash) return err(401, "invalid email or password");

  return json({ token: createSession(row.id, req), user: publicUser(row) });
}

function logout(req: Request): Response {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer "))
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256hex(header.slice(7)));
  return json({ ok: true });
}

// ── Password reset ────────────────────────────────────────────────
//
// "Forgot password?" on the login page. Sign-up verification's twin, with the
// same limits, because it is the same proof: whoever reads the mailbox owns the
// account.
//
//   POST /auth/forgot-password  { email }                  → 202, for every address
//   POST /auth/reset-password   { email, code, password }  → { token, user }
//
// forgot-password answers before any email is sent and says the same thing for
// every address, throttled or not, so neither its body nor its latency tells a
// caller who has an account. A failed send is logged rather than reported for
// the same reason: only a real account could fail. (Sign-up's 409 is still an
// oracle of its own; that is no reason to add a second one here.)
//
// The email carries the code and a link to <DASHBOARD_URL>/forgot-password with
// the email and code in the fragment. The link's origin is the DASHBOARD_URL
// constant, never the request's Host: a reset link built from a header is a link
// an attacker can point at their own server. The fragment never reaches a
// server, and the page still asks for the new password, so a mail scanner that
// opens the link spends nothing.
//
// One code per account (a new request replaces it), RESET_CODE_TTL_MIN long,
// locked by RESET_MAX_ATTEMPTS wrong guesses, at most RESET_MAX_SENDS_PER_HOUR
// emails per address, stored as an HMAC bound to the account. It is spent before
// the new password's hash awaits, so two requests racing with it cannot both
// win, and a reset ends every session the account has — whoever knew the old
// password is who a reset is usually meant to lock out. An account created by
// OAuth can reset too, which gives it a password: the mailbox is the same proof.

const RESET_CODE_TTL_MIN = 15;
const RESET_MAX_ATTEMPTS = 5;
const RESET_MAX_SENDS_PER_HOUR = 5;
const RESET_CODE_RE = /^\d{6}$/;
const RESET_CODE_KEY = createHash("sha256").update(`password-reset:${ADMIN_SECRET}`).digest();

/** Bound to the account as well as the code, so a hash can never be moved to another row. */
const resetCodeHash = (userId: number, code: string) =>
  createHmac("sha256", RESET_CODE_KEY).update(`${userId}:${code}`).digest("base64url");

function resetEmail(email: string, code: string) {
  const link = `${DASHBOARD_URL}/forgot-password#${new URLSearchParams({ email, code })}`;
  const text = [
    `Your Stubbase password reset code is ${code}.`,
    `Enter it with a new password on the reset page, or open this link to have it filled in: ${link}`,
    `It expires in ${RESET_CODE_TTL_MIN} minutes and works once.`,
    "If you did not ask to reset your password, ignore this email: your password has not changed.",
  ].join("\n\n");
  const html = [
    `<p>Your Stubbase password reset code is <strong style="font-size:1.25em;letter-spacing:0.1em">${code}</strong>.</p>`,
    `<p>Enter it with a new password on the reset page, or <a href="${link.replace(/&/g, "&amp;")}">choose a new password here</a>.</p>`,
    `<p>It expires in ${RESET_CODE_TTL_MIN} minutes and works once.</p>`,
    "<p>If you did not ask to reset your password, ignore this email: your password has not changed.</p>",
  ].join("\n");
  return { subject: "Reset your Stubbase password", text, html };
}

async function forgotPassword(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const email = typeof (body as any)?.email === "string" ? (body as any).email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return err(400, "valid 'email' is required");
  // Nothing about this depends on who asked, so it gives nobody away.
  if (!accountEmailAvailable())
    return err(503, "password reset is not available: this server has no email provider configured");

  const accepted = () =>
    json({ ok: true, message: "If that email has a Stubbase account, a reset code is on its way." }, 202);

  const user = db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | null;
  // Throttled quietly: a 429 only an existing account could earn would give the
  // account away. An unknown address writes nothing, so it cannot grow the log.
  if (!user || !claimEmailSend("password_reset_sends", email, RESET_MAX_SENDS_PER_HOUR)) return accepted();

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.query(
    `INSERT INTO password_resets (user_id, code_hash, expires_at, attempts)
     VALUES (?, ?, datetime('now', ?), 0)
     ON CONFLICT(user_id) DO UPDATE
       SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
  ).run(user.id, resetCodeHash(user.id, code), `+${RESET_CODE_TTL_MIN} minutes`);

  if (LOG_EMAIL_CODES) console.log(`[app] password reset code for ${email} is ${code}`);
  if (RESEND_API_KEY) {
    const mail = resetEmail(email, code);
    // Not awaited: the reply must not wait on a path only a real account takes.
    void sendAccountEmail(email, mail.subject, mail.text, mail.html);
  }
  return accepted();
}

async function resetPassword(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const email = typeof (body as any)?.email === "string" ? (body as any).email.trim().toLowerCase() : "";
  const code = typeof (body as any)?.code === "string" ? (body as any).code.trim() : "";
  const password = typeof (body as any)?.password === "string" ? (body as any).password : "";
  if (!EMAIL_RE.test(email)) return err(400, "valid 'email' is required");
  if (!RESET_CODE_RE.test(code)) return err(400, "'code' must be the 6-digit code from the email");
  if (password.length < MIN_PASSWORD_LEN)
    return err(400, `'password' must be at least ${MIN_PASSWORD_LEN} characters`);

  // One answer for every way a code can be wrong, an unknown address included.
  const invalid = () => err(400, "invalid or expired reset code");
  const row = db
    .query(
      `SELECT u.id, r.code_hash, r.expires_at > datetime('now') AS live
       FROM users u JOIN password_resets r ON r.user_id = u.id
       WHERE u.email = ?`,
    )
    .get(email) as { id: number; code_hash: string; live: number } | null;
  if (!row || !row.code_hash || !row.live) return invalid();

  const given = Buffer.from(resetCodeHash(row.id, code), "base64url");
  const stored = Buffer.from(row.code_hash, "base64url");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    // `attempts` on the right-hand side is the value before this update.
    db.query(
      `UPDATE password_resets
       SET attempts = attempts + 1,
           code_hash = CASE WHEN attempts + 1 >= ? THEN '' ELSE code_hash END
       WHERE user_id = ?`,
    ).run(RESET_MAX_ATTEMPTS, row.id);
    return invalid();
  }

  // Spent before anything yields: two requests racing with the same code must
  // not both get past this line, and the hash below awaits.
  db.query("DELETE FROM password_resets WHERE user_id = ?").run(row.id);

  const hash = await Bun.password.hash(password, ARGON);
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.id);
  // Every session on every device ends with the old password.
  db.query("DELETE FROM sessions WHERE user_id = ?").run(row.id);
  const user = db.query("SELECT id, email, name, plan FROM users WHERE id = ?").get(row.id) as User;
  return json({ token: createSession(user.id, req), user: publicUser(user) });
}

// ── Change password (signed in) ───────────────────────────────────
//
// The account menu's "Change password". A session alone is not enough: the
// current password is asked for, so an unlocked laptop or a stolen session
// token can neither lock the owner out nor turn itself into a lasting login.
// For the same reason an account with no password (made by Google or GitHub)
// cannot set one here — it uses the emailed reset code, which proves the mailbox.
//
// Every other session ends; the one making the change stays signed in. An
// outstanding reset code dies too, so a code requested before the change cannot
// quietly undo it. The UPDATE lands only over the hash that was verified, so two
// changes racing from the same current password — or a reset landing during the
// awaits — cannot be overwritten by a request that checked a password now gone.

async function changePassword(req: Request, user: User): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const currentPassword =
    typeof (body as any)?.currentPassword === "string" ? (body as any).currentPassword : "";
  const newPassword = typeof (body as any)?.newPassword === "string" ? (body as any).newPassword : "";
  if (!currentPassword) return err(400, "'currentPassword' is required");
  if (newPassword.length < MIN_PASSWORD_LEN)
    return err(400, `'newPassword' must be at least ${MIN_PASSWORD_LEN} characters`);
  if (newPassword === currentPassword)
    return err(400, "the new password must be different from the current one");

  const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(user.id) as {
    password_hash: string | null;
  } | null;
  if (!row?.password_hash)
    return err(409, "this account has no password yet: set one with a code sent to your email");
  if (!(await Bun.password.verify(currentPassword, row.password_hash)))
    return err(403, "current password is incorrect");

  const hash = await Bun.password.hash(newPassword, ARGON);
  const changed = db
    .query("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?")
    .run(hash, user.id, row.password_hash);
  if (changed.changes === 0)
    return err(409, "your password was changed by another request; sign in again and retry");

  const token = (req.headers.get("authorization") ?? "").slice(7);
  db.query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(user.id, sha256hex(token));
  db.query("DELETE FROM password_resets WHERE user_id = ?").run(user.id);
  return json({ user: publicUser(user) });
}

// ── Account settings (signed in) ──────────────────────────────────
//
// The settings page: the account's name and the devices signed in to it.
//
// A session is named by its random `id`, never its token_hash. The hash is not a
// credential — authenticate hashes whatever it is given — but it is the key every
// session lookup runs on, and nothing in a browser needs it. Every query here is
// scoped by user_id as well as the id, so an id lifted from another account ends
// nothing: the same rule as a developer key's tenant clause.
//
// Ending sessions needs only a session, unlike changing the password. A stolen
// token can sign the owner out, but that locks nobody out — the owner signs back
// in with the password, and "sign out every other device" ends the thief's.

const MAX_ACCOUNT_NAME = 100;

/** SQLite's datetime('now') text is UTC with no zone marker; a browser has to be told. */
const isoUtc = (s: string | null) => (s ? `${s.replace(" ", "T")}Z` : null);

async function updateAccount(req: Request, user: User): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const raw = (body as any)?.name;
  if (typeof raw !== "string") return err(400, "'name' is required");
  const name = raw.trim();
  if (name.length > MAX_ACCOUNT_NAME)
    return err(400, `'name' must be at most ${MAX_ACCOUNT_NAME} characters`);
  db.query("UPDATE users SET name = ? WHERE id = ?").run(name || null, user.id);
  return json({ user: publicUser({ ...user, name: name || null }) });
}

/**
 * GET /auth/account — the facts the settings page shows but nobody edits there.
 *
 * `requestsUsed` is accountMonthRequests, the same sum quotaFor hands the core,
 * so the figure a person reads is the one their API is throttled on — deleted
 * projects' traffic included. It is its own route rather than a field of
 * /auth/me because the SPA persists that response, and a stored usage count
 * would be stale from the moment it was written.
 *
 * `monthlyRequests` is quotaFor's `limit` for the same reason, request packs
 * included. `planMonthlyRequests` and `packRequests` are its parts, so the page
 * can say where the number comes from, and `requestPacks` lists every pack still
 * holding requests — on Free too, where `packRequests` is 0 because the plan
 * does not draw on them. `aiCredits` is the Co-Pilot's balance and the grants
 * it is made of, in the order they will be spent.
 */
function accountSummary(user: User): Response {
  const allowance = allowanceOf(user);
  const used = accountMonthRequests(user.id);
  const row = db
    .query(
      `SELECT created_at, date('now', 'start of month', '+1 month') AS resets_on
       FROM users WHERE id = ?`,
    )
    .get(user.id) as { created_at: string; resets_on: string };
  return json({
    account: {
      email: user.email,
      plan: allowance.plan.id,
      planName: allowance.plan.name,
      monthlyRequests: limitOf(allowance, used),
      planMonthlyRequests: allowance.plan.monthlyRequests,
      packRequests: allowance.packRequests,
      requestPacks: allowance.packs.map(({ name, requests, remaining, expiresOn }) => ({
        name,
        requests,
        remaining,
        expiresOn,
      })),
      requestsPerSecond: allowance.requestsPerSecond,
      burst: allowance.burst,
      requestsUsed: used,
      // Fresh on every read, like the usage: the Co-Pilot pane and this card
      // both show the balance a turn will be refused on.
      aiCredits: aiCreditsOf(user),
      // UTC calendar months, as the allowance counts them.
      resetsOn: row.resets_on,
      memberSince: isoUtc(row.created_at),
    },
  });
}

function listSessions(req: Request, user: User): Response {
  const rows = db
    .query(
      `SELECT id, user_agent, created_at, last_used_at, expires_at, token_hash = ? AS current
       FROM sessions
       WHERE user_id = ? AND expires_at > datetime('now')
       ORDER BY current DESC, COALESCE(last_used_at, created_at) DESC`,
    )
    .all(sessionHashOf(req), user.id) as {
    id: string;
    user_agent: string | null;
    created_at: string;
    last_used_at: string | null;
    expires_at: string;
    current: number;
  }[];
  return json({
    sessions: rows.map((r) => ({
      id: r.id,
      userAgent: r.user_agent,
      createdAt: isoUtc(r.created_at),
      lastUsedAt: isoUtc(r.last_used_at),
      expiresAt: isoUtc(r.expires_at),
      current: r.current === 1,
    })),
  });
}

function endSession(user: User, id: string): Response {
  if (!SESSION_ID_RE.test(id)) return err(404, "session not found");
  const ended = db.query("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(id, user.id);
  if (ended.changes === 0) return err(404, "session not found");
  return json({ ok: true });
}

function endOtherSessions(req: Request, user: User): Response {
  const ended = db
    .query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
    .run(user.id, sessionHashOf(req));
  return json({ ok: true, ended: ended.changes });
}

// ── Delete account ────────────────────────────────────────────────
//
// Irreversible, so it asks for what change-password asks for: the password, not
// just a session — an unlocked laptop or a stolen token must not be able to
// erase the account. An account with no password (made by Google or GitHub)
// sets one first, by emailed code, rather than getting a session-only way out.
//
// Refused while the account owns a project. Projects go one at a time through
// deleteProject and its stop-it-first guard, so a live API is never taken down
// as a side effect of this route, and a core failure part-way through a list of
// projects can never leave half an account behind.
//
// The users row is emptied, not deleted: email, name and password go, and the
// row keeps its id, plan and deleted_at. `id INTEGER PRIMARY KEY` gives the next
// insert the highest id once that row is gone, so deleting the newest account
// would hand its id — and every row still keyed by it, this month's api_usage
// included — to whoever signs up next.
//
// The freed `email` is a sentinel rather than NULL because the column is NOT
// NULL and UNIQUE; `deleted:<id>` can never collide with a real address, since
// every route that looks an account up by email requires EMAIL_RE first, so no
// lookup can reach a dormant row.
//
// The address is free again at once, but the row remembers it as an HMAC in
// deleted_email_hash, so signing up with it again lands back on this same id
// and this month's usage carries over rather than resetting (createOrReviveUser).
// Nothing else comes back: the plan returns to free and the add-ons are deleted
// here. Accounts deleted before that column existed have no hash and come back
// as new ones — a one-off, since their address was already overwritten.
//
// The checks run again after the hash yields, in one transaction with the
// writes, so a password change or a new project landing during the verify stops it.

async function deleteAccount(req: Request, user: User): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const password = typeof (body as any)?.password === "string" ? (body as any).password : "";
  if (!password) return err(400, "'password' is required");

  const projectCount = () =>
    (db.query("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(user.id) as { n: number }).n;
  const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(user.id) as {
    password_hash: string | null;
  } | null;
  if (!row?.password_hash)
    return err(409, "this account has no password yet: set one with a code sent to your email first");
  const projects = projectCount();
  if (projects > 0)
    return err(409, `delete your ${projects} project${projects === 1 ? "" : "s"} before deleting the account`);
  if (!(await Bun.password.verify(password, row.password_hash))) return err(403, "password is incorrect");

  const outcome = db.transaction(() => {
    const now = db.query("SELECT password_hash, deleted_at FROM users WHERE id = ?").get(user.id) as {
      password_hash: string | null;
      deleted_at: string | null;
    } | null;
    if (!now || now.deleted_at) return "gone";
    if (now.password_hash !== row.password_hash) return "changed";
    if (projectCount() > 0) return "projects";
    db.query("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    db.query("DELETE FROM password_resets WHERE user_id = ?").run(user.id);
    db.query("DELETE FROM request_packs WHERE user_id = ?").run(user.id);
    db.query("DELETE FROM ai_credits WHERE user_id = ?").run(user.id);
    db.query(
      `UPDATE users
       SET email = ?, name = NULL, password_hash = NULL, oauth_provider = NULL,
           deleted_at = datetime('now'), deleted_email_hash = ?
       WHERE id = ?`,
    ).run(`deleted:${user.id}`, emailLineageHash(user.email), user.id);
    return "deleted";
  })();

  if (outcome === "gone") return err(409, "this account has already been deleted");
  if (outcome === "changed")
    return err(409, "your password was changed by another request; sign in again and retry");
  if (outcome === "projects") return err(409, "a project was created meanwhile; delete it first");
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
  return signInWithIdentity(req, identity, provider);
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
function signInWithIdentity(req: Request, identity: OauthIdentity, provider: OauthProvider): Response {
  const email = identity.email.trim().toLowerCase();

  const find = () =>
    db.query("SELECT id, email, name, plan FROM users WHERE email = ?").get(email) as User | null;
  let user = find();
  if (!user) {
    // Only on the way in. Someone who already has an account signs in
    // whatever their domain: the list is for stopping new throwaway accounts,
    // not for locking out a customer whose provider was added to it later —
    // and a returning deleted account is a sign-up, so it is checked here too.
    if (disposableEmail(email)) return oauthFailed("disposable_email");
    try {
      createOrReviveUser(email, identity.name, { oauthProvider: provider });
    } catch {
      // Two callbacks for one address can race; UNIQUE(email), or a revive that
      // found the row already taken back, settles it and the loser just reads
      // the row the winner left behind.
    }
    user = find();
  }
  if (!user) return oauthFailed("provider_rejected");

  return toDashboard("/auth/callback", `token=${createSession(user.id, req)}`);
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

  return signInWithIdentity(req, identity, "google");
}

// ── Core Engine admin client ──────────────────────────────────────

/**
 * One call to the core's `_admin/files` plane. `revision` is the file's, as the
 * core reports it on a read (x-revision) or a write (in the body); `ifMatch`
 * makes a write conditional on the file still being that revision — the core
 * answers 409 otherwise. HEAD asks whether a file exists without reading it
 * across the wire.
 */
async function coreAdmin(
  method: "GET" | "HEAD" | "POST" | "DELETE",
  tenantId: string,
  resource: string,
  body?: unknown,
  options: { ifMatch?: string | null } = {},
): Promise<{ ok: boolean; status: number; data: unknown; revision: string | null }> {
  const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/files/${resource}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      "content-type": "application/json",
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = method === "HEAD" ? null : await res.json().catch(() => null);
  const revision =
    res.headers.get("x-revision") ?? (typeof (data as any)?.revision === "string" ? (data as any).revision : null);
  return { ok: res.ok, status: res.status, data, revision };
}

/** Whether a table is live — its production file exists — without reading it. */
async function isLiveTable(tenantId: string, resource: string): Promise<boolean> {
  return (await coreAdmin("HEAD", tenantId, resource)).ok;
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
/**
 * The core's data models (models/ — see "Data models" there): per table, the
 * fields its records carry, their types and which are declared required. GET
 * reads them all; POST declares `required` on one resource's fields.
 */
async function coreAdminModels(
  tenantId: string,
  declare?: { resource: string; required: Record<string, boolean> },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(
    `${CORE_API_URL}/${tenantId}/_admin/models${declare ? `/${encodeURIComponent(declare.resource)}` : ""}`,
    declare
      ? {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
          body: JSON.stringify({ required: declare.required }),
        }
      : { headers: { authorization: `Bearer ${ADMIN_SECRET}` } },
  );
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

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
  /** JSON string[]: live tables removed by the owner, gone at the next deploy. */
  removing: string;
  created_at: string;
}

function ownedProject(tenantId: string, userId: number): ProjectRow | null {
  return db
    .query(
      "SELECT tenant_id, name, resources, dirty, removing, created_at FROM projects WHERE tenant_id = ? AND user_id = ?",
    )
    .get(tenantId, userId) as ProjectRow | null;
}

const projectJson = (r: ProjectRow) => ({
  ...r,
  resources: JSON.parse(r.resources),
  dirty: r.dirty === 1,
  removing: parseResources(r.removing ?? "[]"),
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
 * Mark or unmark a live table for removal at the next deploy. Same
 * single-synchronous-turn read-modify-write as addResources, for the same
 * reason.
 */
function setRemoving(tenantId: string, name: string, removing: boolean): void {
  const row = db
    .query("SELECT removing FROM projects WHERE tenant_id = ?")
    .get(tenantId) as { removing: string } | null;
  if (!row) return;
  const list = parseResources(row.removing);
  if (list.includes(name) === removing) return;
  db.query("UPDATE projects SET removing = ? WHERE tenant_id = ?").run(
    JSON.stringify(removing ? [...list, name] : list.filter((n) => n !== name)),
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

/** The guide the .env's social login comments point to for getting OAuth keys. */
const OAUTH_KEYS_GUIDE = "https://stubbase.dev/guides/google-github-oauth-keys";

/** A `# ══ 1. Title ═══` rule for a top-level section, padded so every header ends in the same column. */
const envChapter = (title: string) => `# ══ ${title} ${"═".repeat(Math.max(3, 68 - title.length))}`;
/** A `# ── 1.1 Title ───` rule for a section inside one. The third level is a numbered comment line. */
const envSection = (title: string) => `# ── ${title} ${"─".repeat(Math.max(3, 68 - title.length))}`;

/**
 * The `.env` a new project starts with: every setting the Core Engine reads,
 * grouped by feature and commented out, so switching a feature on means
 * uncommenting its lines rather than looking up key names.
 *
 * Commented out is the point. A template line is documentation, not config:
 * this text compiles to an empty object, so a new project is exactly as plain
 * as before the template existed. Whether the API is serving is deliberately
 * absent — that is system/status.json, which only the status route writes.
 *
 * tests/dashboard-api.test.ts holds it to the keys the core reads (ENVIRONMENT.md
 * §2), and its sections to their numbering: 1., 1.1, 1.1.1, in the order the
 * contents list at the top gives. The OAuth callbacks it names are this
 * project's real ones.
 */
function envTemplate(tenantId: string): string {
  const callback = (provider: string) => `${PUBLIC_API_BASE}/${tenantId}/auth/${provider}/callback`;
  return [
    "# Project settings",
    "#",
    "# Every setting below is switched off. To turn one on, delete the \"# \" in",
    "# front of its line, put in your own value, Save, then Deploy.",
    "# Put the \"# \" back to switch it off again — your value stays in the file.",
    "#",
    "# Sections, in order:",
    "#   1. Auth",
    "#      1.1 Sign-up, login and sessions",
    "#      1.2 Email verification",
    "#      1.3 Password reset",
    "#      1.4 Roles and permissions",
    "#      1.5 Google and GitHub login",
    "#          1.5.1 Google",
    "#          1.5.2 GitHub",
    "#      1.6 Who may sign up",
    "#   2. Email and SMS",
    "#      2.1 Email through Resend",
    "#      2.2 SMS through Twilio",
    "#   3. QA: simulate slow, failing and empty responses",
    "#   4. Validation: a JSON Schema per resource",
    "#   5. Webhooks",
    "#",
    "# Going live is not a setting: Deploy publishes your changes and starts the",
    "# API, and Stop takes it offline.",
    "",
    envChapter("1. Auth"),
    "",
    envSection("1.1 Sign-up, login and sessions"),
    "# The switch for everything in section 1. Every request then needs a token,",
    "# and these routes go live:",
    "#   POST /auth/signup   /auth/login    /auth/refresh   /auth/logout",
    "#   POST /auth/change-password   /auth/forgot-password   /auth/reset-password",
    "# Accounts and sessions show up in the system folder, read-only.",
    "# AUTH_ENABLED=true",
    "",
    "# Resources anyone may read without a token, comma-separated, no spaces.",
    "# Writes to them still need a token. Ignored while roles are on (1.4).",
    "# AUTH_PUBLIC_ROUTES=posts,comments",
    "",
    "# How long a token lasts, in seconds. Default 86400 (24 hours), minimum 60.",
    "# AUTH_JWT_TTL_SECONDS=86400",
    "",
    "# How long someone stays signed in without using their refresh token, in",
    "# seconds. Every refresh starts it again. Default 2592000 (30 days), minimum 3600.",
    "# AUTH_REFRESH_TTL_SECONDS=2592000",
    "",
    envSection("1.2 Email verification (on whenever AUTH_ENABLED=true)"),
    "# Nothing to uncomment to use it. /auth/signup answers 202 with a",
    "# verificationId and sends a 6-digit code; the account is created only when",
    "#   POST /auth/signup/verify   { verificationId, code }",
    "# gets that code back (POST /auth/signup/resend sends a new one).",
    "# Where the code goes:",
    "#   - with RESEND_API_KEY (2.1): emailed to the address that signed up;",
    "#   - without it: shown in this project's Logs tab — only you can see it.",
    "# Set to false to create accounts straight away, with no code.",
    "# AUTH_EMAIL_VERIFICATION=false",
    "",
    envSection("1.3 Password reset (on whenever AUTH_ENABLED=true)"),
    "# Nothing to uncomment to use it. /auth/forgot-password sends a 6-digit code",
    "# and /auth/reset-password trades it for a new password. Like verification,",
    "# the code is emailed with RESEND_API_KEY (2.1), and shown in the Logs tab without.",
    "# Optional: a page of yours the email links to, with #email=…&code=… attached.",
    "# AUTH_RESET_URL=https://your-app.com/reset-password",
    "",
    envSection("1.4 Roles and permissions (needs AUTH_ENABLED=true)"),
    "# Who may do what with your API: roles, each a set of permissions, written in",
    "# rbac.json. Switch this on, Save, and rbac.json appears in the system folder.",
    "# RBAC_ENABLED=true",
    "",
    envSection("1.5 Google and GitHub login (needs AUTH_ENABLED=true)"),
    "# Off until a provider has both its values: fill in either pair, Save, then",
    "# Deploy. A starter that switches auth on uncomments these lines for you.",
    "",
    "# Where Google and GitHub login send the user afterwards, with #token=… attached.",
    "# Left out, the token comes back as JSON instead. Shared by 1.5.1 and 1.5.2.",
    "# AUTH_OAUTH_REDIRECT=https://your-app.com/login",
    "",
    "# 1.5.1 Google — fill in both values to turn on /auth/google.",
    "# Register this callback URL in your Google OAuth app:",
    `#   ${callback("google")}`,
    `# How to get the keys: ${OAUTH_KEYS_GUIDE}`,
    "# AUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com",
    "# AUTH_GOOGLE_SECRET=GOCSPX-your-secret",
    "",
    "# 1.5.2 GitHub — fill in both values to turn on /auth/github.",
    "# Register this callback URL in your GitHub OAuth app:",
    `#   ${callback("github")}`,
    `# How to get the keys: ${OAUTH_KEYS_GUIDE}`,
    "# AUTH_GITHUB_CLIENT_ID=Iv1.a1b2c3d4e5f6",
    "# AUTH_GITHUB_SECRET=your-github-secret",
    "",
    envSection("1.6 Who may sign up (needs AUTH_ENABLED=true)"),
    "# Which email addresses may open an account on your API. Everyone, until",
    "# you set one of these. They apply to /auth/signup and to Google and GitHub",
    "# login, and only where an account would be created — somebody who already",
    "# has one keeps signing in whatever their address.",
    "",
    "# Only these domains may sign up; every other address is refused. For an",
    "# internal tool or a staging project. Comma-separated, no spaces.",
    "# AUTH_EMAIL_DOMAINS_ONLY=your-company.com",
    "",
    "# Domains always refused, when you are not restricting sign-up to a list.",
    "# A domain covers its subdomains: rival.com also refuses mail.rival.com.",
    "# AUTH_EMAIL_DOMAINS_BLOCKED=rival.com",
    "",
    "# Domains that beat both refusals below and above — the exception list.",
    "# AUTH_EMAIL_DOMAINS_ALLOWED=partner.com",
    "",
    "# Refuse throwaway providers: mailinator, guerrillamail and ~75,000 more.",
    "# Off by default, because a demo or a workshop API is a fair use of one.",
    "# AUTH_BLOCK_DISPOSABLE_EMAIL=true",
    "",
    envChapter("2. Email and SMS"),
    "",
    envSection("2.1 Email through Resend"),
    "# Emails verification and password reset codes to your users (without it they",
    "# appear in the Logs tab), and turns on POST /_notify/email (which, like all",
    "# of /_notify, needs AUTH_ENABLED=true).",
    "# RESEND_API_KEY=re_your_resend_key",
    "# Who the emails are from. Left out, Resend's onboarding address.",
    "# RESEND_FROM=Your App <no-reply@your-app.com>",
    "",
    envSection("2.2 SMS through Twilio"),
    "# All three together turn on POST /_notify/sms (needs AUTH_ENABLED=true).",
    "# TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "# TWILIO_AUTH_TOKEN=your-twilio-auth-token",
    "# TWILIO_FROM=+15551234567",
    "",
    envChapter("3. QA: simulate slow, failing and empty responses"),
    "# Lets a request ask for trouble with the x-stubbase-delay, x-stubbase-status,",
    "# x-stubbase-error-rate and x-stubbase-empty headers. Ignored while this is off.",
    "# QA_MODE=true",
    "",
    envChapter("4. Validation: a JSON Schema per resource"),
    "# SCHEMA_<RESOURCE> holds a JSON Schema on one line. A POST or PUT body that",
    "# does not match gets a 400. Add one line per resource.",
    '# SCHEMA_POSTS={"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}',
    "",
    envChapter("5. Webhooks"),
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
  // The .env editor's text: every setting, commented out (see envTemplate).
  return provisionProject(user, tenantId, name, Object.entries(resources), {
    config: { __raw: envTemplate(tenantId) },
  });
}

/**
 * Thrown by a resource source that cannot supply a file. provisionProject rolls
 * back and answers 502 with its message; anything else thrown is a bug, and is
 * left to the server's error handler.
 */
class ProvisionError extends Error {}

/**
 * Brings a tenant into being on the core and records it. Shared by create and
 * duplicate, so a project is born one way whatever made it: stopped, then its
 * resources, then its settings, then the row.
 *
 * Resources may arrive as an async iterable, which is how a duplicate reads its
 * source one resource at a time instead of holding the whole project in memory.
 */
async function provisionProject(
  user: User,
  tenantId: string,
  name: string,
  resources: Iterable<[string, unknown]> | AsyncIterable<[string, unknown]>,
  settings: {
    config: Record<string, unknown>;
    rbac?: unknown;
    /** Per resource, the fields declared required in its data model. */
    declared?: Record<string, Record<string, boolean>>;
  },
): Promise<Response> {
  // New projects start stopped: nothing is public until the owner has looked at
  // the data and pressed Deploy. Written before anything else, so there is no
  // moment in which seeded records are served — and it is what gives the tenant
  // a folder on the core, so it exists as soon as it is created.
  const stopped = await coreAdminStatus(tenantId, "stopped");
  if (!stopped.ok) return err(502, `core engine refused the initial status (status ${stopped.status})`);

  const provisioned: string[] = [];
  // Roll back partial provisioning so we don't leave orphan files.
  const rollback = async () => {
    for (const done of [...provisioned, "config", "rbac"]) await coreAdmin("DELETE", tenantId, done);
  };

  try {
    for await (const [rName, data] of resources) {
      const res = await coreAdmin("POST", tenantId, rName, data);
      if (!res.ok) {
        await rollback();
        return err(502, `core engine refused to provision '${rName}' (status ${res.status})`);
      }
      provisioned.push(rName);
    }
  } catch (e) {
    if (!(e instanceof ProvisionError)) throw e;
    await rollback();
    return err(502, e.message);
  }

  const cfg = await coreAdmin("POST", tenantId, "config", settings.config);
  if (!cfg.ok) {
    await rollback();
    return err(502, `core engine refused the initial settings (status ${cfg.status})`);
  }
  if (settings.rbac !== undefined) {
    const rules = await coreAdmin("POST", tenantId, "rbac", settings.rbac);
    if (!rules.ok) {
      await rollback();
      return err(502, `core engine refused the roles file (status ${rules.status})`);
    }
  }
  for (const [resource, required] of Object.entries(settings.declared ?? {})) {
    if (!provisioned.includes(resource)) continue;
    const res = await coreAdminModels(tenantId, { resource, required });
    if (!res.ok) {
      await rollback();
      return err(502, `core engine refused the data model of '${resource}' (status ${res.status})`);
    }
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

/**
 * A copied .env, pointed at its new project. Anything in it under the source's
 * own API base belongs to the source — the OAuth callback URLs the template
 * tells you to register, above all — so it moves to the copy's base, in the
 * text and the compiled keys alike: the SPA compiles one from the other, and
 * the two must never disagree. The trailing slash keeps `blog-1a2b3c4d` from
 * matching inside a longer id.
 */
function retargetEnv(config: Record<string, unknown>, fromId: string, toId: string) {
  const from = `${PUBLIC_API_BASE}/${fromId}/`;
  const to = `${PUBLIC_API_BASE}/${toId}/`;
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, typeof v === "string" ? v.split(from).join(to) : v]),
  );
}

/**
 * POST /projects/<id>/duplicate — { name, copyEnv? } → a new project, created
 * the way any project is (see provisionProject), holding a copy of this one.
 *
 * What is copied is what the source's *editor* shows (readEdited): a staged
 * edit rather than the live file behind it. The copy is written as live files
 * and starts clean — it has never been deployed, so there is nothing for it to
 * be behind — and stopped, so none of it is served until its own Deploy.
 *
 * The .env only when asked, since it carries credentials and webhook URLs a
 * copy may not want pointed at the same places; rbac.json travels with it,
 * because it is saved and deployed alongside those settings and means nothing
 * under a template that switches roles off.
 *
 * Never copied, whatever is asked: the system/ files a feature owns (accounts,
 * sessions, pending sign-ups, reset codes) — they are the source API's users,
 * bound to its tenant id, and nothing but their feature may write them — and
 * developer keys, which are credentials for one tenant id alone.
 */
async function duplicateProject(req: Request, user: User, sourceId: string): Promise<Response> {
  const source = ownedProject(sourceId, user.id);
  if (!source) return err(404, "project not found");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const name = typeof (body as any)?.name === "string" ? (body as any).name.trim() : "";
  if (!name) return err(400, "'name' is required");
  const copyEnv = (body as any)?.copyEnv ?? false;
  if (typeof copyEnv !== "boolean") return err(400, "'copyEnv' must be true or false");

  const tenantId = newTenantId(name);
  let config: Record<string, unknown> = { __raw: envTemplate(tenantId) };
  let rbac: unknown;
  if (copyEnv) {
    const cfg = await readEdited(source, "config");
    if (cfg.ok && cfg.data && typeof cfg.data === "object" && !Array.isArray(cfg.data))
      config = retargetEnv(cfg.data as Record<string, unknown>, sourceId, tenantId);
    else if (cfg.status !== 404)
      return err(502, `core engine refused to read the .env (status ${cfg.status})`);
    const rules = await readEdited(source, "rbac");
    if (rules.ok) rbac = rules.data;
    else if (rules.status !== 404)
      return err(502, `core engine refused to read rbac.json (status ${rules.status})`);
  }

  // Which fields the user declared required is their intent, not something the
  // copy can rebuild from its records — so it comes along, from the model of
  // what the editor shows (the draft's, while one is staged).
  const declared: Record<string, Record<string, boolean>> = {};
  const models = await coreAdminModels(sourceId);
  if (models.ok) {
    const all = ((models.data as any)?.models ?? {}) as Record<string, { fields?: Record<string, { required?: boolean }> }>;
    for (const rName of JSON.parse(source.resources) as string[]) {
      const model = all[`draft_${rName}`] ?? all[rName];
      const required = Object.entries(model?.fields ?? {}).filter(([, f]) => f?.required === true);
      if (required.length > 0) declared[rName] = Object.fromEntries(required.map(([field]) => [field, true]));
    }
  } else return err(502, `core engine refused to read the data models (status ${models.status})`);

  async function* copies(): AsyncGenerator<[string, unknown]> {
    for (const rName of JSON.parse(source!.resources) as string[]) {
      const res = await readEdited(source!, rName);
      if (res.status === 404) continue; // listed, but there is no file to copy
      if (!res.ok || !Array.isArray(res.data))
        throw new ProvisionError(`core engine refused to read '${rName}' (status ${res.status})`);
      yield [rName, res.data];
    }
  }

  return provisionProject(user, tenantId, name, copies(), { config, rbac, declared });
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

/** GET /projects/<id>/status — what the dashboard's status badge, Deploy/Redeploy label and Stop show. */
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

// Save model: data is live when saved, structure and settings when deployed.
//   - Records of a live table are saved straight to its production file,
//     conditional on the revision the editor loaded (If-Match), so a save can
//     never overwrite records the public API wrote meanwhile.
//   - A new table is staged as draft_<name>.json — its endpoint does not exist
//     until Deploy promotes it — and edits to it go to that draft.
//   - Removing a live table marks it (`removing`); Deploy removes it.
//   - Settings (config, rbac) are staged as drafts and deployed, as before.
// A draft over a live table therefore never arises; one left from before this
// model is ignored by reads and discarded by the core's deploy rather than
// promoted over newer records. A caller that needs the *deployed* file rather
// than the edit in progress asks for `?source=live`, which reads the
// production copy alone.
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

/**
 * The copies of a file to try, in order, for "what is being edited": the draft
 * first while an edit is staged, the live file first otherwise. getFile explains
 * why both are always tried; duplicateProject shares the order, so a copy starts
 * as exactly what the source's editor shows.
 */
function editedOrder(row: ProjectRow, name: string): [string, string] {
  // A table's records are edited live, so its production file is what the
  // editor shows; the draft is read only for a table that is not live yet.
  if (name !== "config" && name !== "rbac") return [name, `${DRAFT_PREFIX}${name}`];
  return row.dirty === 1 ? [`${DRAFT_PREFIX}${name}`, name] : [name, `${DRAFT_PREFIX}${name}`];
}

/** The edited copy of a file (see editedOrder), as the core answered for it. */
async function readEdited(row: ProjectRow, name: string) {
  const [first, second] = editedOrder(row, name);
  const res = await coreAdmin("GET", row.tenant_id, first);
  return res.status === 404 ? coreAdmin("GET", row.tenant_id, second) : res;
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
  const order = liveOnly ? [resource] : editedOrder(row, resource);
  let res = await coreAdmin("GET", tenantId, order[0]);
  if (order[1] !== undefined && res.status === 404)
    res = await coreAdmin("GET", tenantId, order[1]);
  if (res.status === 404) return err(404, "file not found");
  if (!res.ok) return err(502, `core engine refused the read (status ${res.status})`);
  // The revision goes back with the save (If-Match), which is what makes a
  // save of a live table refuse to overwrite records written since this read.
  const out = json(res.data);
  if (res.revision) out.headers.set("x-revision", res.revision);
  return out;
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

  // Records of a live table are saved live; anything else — settings, and a
  // table not deployed yet — is staged as a draft.
  const live = !isSettings && (await isLiveTable(tenantId, resource));
  const target = live ? resource : `${DRAFT_PREFIX}${resource}`;
  const res = await coreAdmin("POST", tenantId, target, body, { ifMatch: req.headers.get("if-match") });
  // Someone wrote the file since the editor read it: the caller reloads and
  // makes the change again, rather than this save erasing theirs.
  if (res.status === 409) return json(res.data ?? { error: "the file changed since it was read" }, 409);
  // The core validates rules where they are written; its reasons are the user's to read.
  if (res.status === 400) return json(res.data ?? { error: "the core engine refused the file" }, 400);
  if (!res.ok) return err(502, `core engine refused the write (status ${res.status})`);

  if (live) {
    // A draft over a live table is a leftover from before records were saved
    // live; nothing should read it again, and deploy would discard it anyway.
    await coreAdmin("DELETE", tenantId, `${DRAFT_PREFIX}${resource}`);
  } else {
    // A draft is on disk, so the live API is now behind — recorded after the
    // write rather than before, so a refused write never leaves the project
    // claiming changes it does not have.
    markDirty(tenantId);
  }

  // Re-read inside addResources rather than reusing `row`: that snapshot was
  // taken before the core write above, so it is stale by the time we get here.
  if (!isSettings) addResources(tenantId, [resource]);
  const records = Array.isArray(body) ? body.length : Object.keys(body as object).length;
  return json({ ok: true, tenant: tenantId, resource, records, draft: !live, revision: res.revision });
}

/**
 * DELETE /projects/<id>/files/<res> — remove a table. A live one is only marked:
 * its endpoint keeps serving until the next deploy removes it, because whether
 * a table exists is published by Deploy, like its creation. A table not live
 * yet exists only as a draft, and goes at once.
 */
async function deleteFile(user: User, tenantId: string, resource: string): Promise<Response> {
  const row = ownedProject(tenantId, user.id);
  if (!row) return err(404, "project not found");
  const invalid = invalidResourceName(resource);
  if (invalid) return invalid;

  if (await isLiveTable(tenantId, resource)) {
    setRemoving(tenantId, resource, true);
    markDirty(tenantId);
    return json({ ok: true, tenant: tenantId, resource, pendingRemoval: true });
  }

  const res = await coreAdmin("DELETE", tenantId, `${DRAFT_PREFIX}${resource}`);
  if (!res.ok && res.status !== 404)
    return err(502, `core engine failed to delete (status ${res.status})`);
  // Same reason as putFile: `row` predates the core calls above, so filtering
  // it would write back a list missing anything created in the meantime.
  removeResource(tenantId, resource);
  return json({ ok: true, tenant: tenantId, resource, deleted: true });
}

/** POST /projects/<id>/files/<res>/restore — take back a removal before it is deployed. */
function restoreFile(user: User, tenantId: string, resource: string): Response {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const invalid = invalidResourceName(resource);
  if (invalid) return invalid;
  // The flag stays: other changes may still be staged, and one boolean cannot
  // say — over-reporting costs a redundant deploy, see markDirty.
  setRemoving(tenantId, resource, false);
  return json({ ok: true, tenant: tenantId, resource, restored: true });
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
    "This tool only creates new tables; it cannot delete or empty them, or change the records " +
    "of a table that is live. Use delete_resources to remove or empty a table, and the record " +
    "tools to change records. Do not invent a filler table to satisfy the request.";

  if (!Array.isArray(args.tables) || args.tables.length === 0)
    return { result: { error: `no tables were supplied. ${CANNOT_DELETE}` } };

  const { tables, warnings } = sanitizeTables(args.tables);
  if (tables.length === 0)
    return { result: { error: `none of the supplied tables were usable. ${CANNOT_DELETE}`, warnings } };

  const staged: { name: string; records: number; fields: string[] }[] = [];
  for (const table of tables) {
    // A live table's records are the project's real data, saved live — never
    // replaced wholesale by generated seed rows. Only a table not deployed yet
    // (a draft, still being designed) may be staged over.
    if (await isLiveTable(tenantId, table.name)) {
      warnings.push(
        `skipped '${table.name}': it is a live table holding real records. Use the record tools to change them.`,
      );
      continue;
    }
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
  if (staged.length === 0) return { result: { error: `nothing could be staged. ${CANNOT_DELETE}`, warnings } };

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

// ── Settings and starters: proposals the user confirms ─────────────
//
// Like delete_resources, these two decide and never do. A settings change
// written by the agent would be a tenant setting changed unreviewed — and the
// agent reads text strangers wrote (get_diagnostics hands it failed requests'
// bodies), so a prompt injection could otherwise switch auth off or open a
// project's sign-up. Each returns a `pendingConfirmation` the dashboard shows
// as a card; the user's click applies it through the ordinary files routes,
// staged like any edit, and it goes live only on a deploy.

const bool = (v: string) => (v === "true" || v === "false" ? null : "must be true or false");
const atLeast = (min: number) => (v: string) =>
  /^\d{1,9}$/.test(v) && Number(v) >= min ? null : `must be a whole number of seconds, at least ${min}`;
const nameList = (v: string) =>
  v === "" || v.split(",").every((n) => NAME_RE.test(n))
    ? null
    : "must be table names separated by commas, with no spaces";
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const domainListSetting = (v: string) =>
  v === "" || v.split(",").every((d) => DOMAIN_RE.test(d))
    ? null
    : "must be domains separated by commas, with no spaces";

/**
 * The settings the agent may propose, each with its value check. Switches,
 * lifetimes and lists only: nothing here is a credential or a URL, because a
 * proposal is a click away from being staged and those are exfiltration and
 * phishing routes. Keep in step with the persona's SETTINGS list.
 */
const AGENT_SETTINGS: Record<string, (value: string) => string | null> = {
  AUTH_ENABLED: bool,
  AUTH_EMAIL_VERIFICATION: bool,
  AUTH_PUBLIC_ROUTES: nameList,
  AUTH_JWT_TTL_SECONDS: atLeast(60),
  AUTH_REFRESH_TTL_SECONDS: atLeast(3600),
  RBAC_ENABLED: bool,
  AUTH_EMAIL_DOMAINS_ONLY: domainListSetting,
  AUTH_EMAIL_DOMAINS_BLOCKED: domainListSetting,
  AUTH_EMAIL_DOMAINS_ALLOWED: domainListSetting,
  AUTH_BLOCK_DISPOSABLE_EMAIL: bool,
  QA_MODE: bool,
};

/** Settings that exist but only the user may set: credentials, and URLs a request would be sent to. */
const USER_ONLY_SETTING_RE =
  /^(AUTH_GOOGLE_CLIENT_ID|AUTH_GOOGLE_SECRET|AUTH_GITHUB_CLIENT_ID|AUTH_GITHUB_SECRET|RESEND_API_KEY|RESEND_FROM|TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_FROM|AUTH_OAUTH_REDIRECT|AUTH_RESET_URL|HOOK_(BEFORE|AFTER)_(INSERT|UPDATE|DELETE)_[A-Z0-9_]+)$/;

const SCHEMA_KEY_RE = /^SCHEMA_[A-Z0-9_]{1,64}$/;
const AI_MAX_SETTINGS = 20;
const AI_MAX_SCHEMA_CHARS = 4_000;

/** Why a proposed setting is refused, or null when it may be proposed. */
function settingRefusal(key: string, value: string): string | null {
  if (Object.hasOwn(AGENT_SETTINGS, key)) return AGENT_SETTINGS[key](value);
  if (SCHEMA_KEY_RE.test(key)) {
    if (value.length > AI_MAX_SCHEMA_CHARS) return `must be at most ${AI_MAX_SCHEMA_CHARS} characters`;
    if (/[\r\n]/.test(value)) return "must be a JSON Schema on one line";
    try {
      const schema = JSON.parse(value);
      if (schema && typeof schema === "object" && !Array.isArray(schema)) return null;
    } catch {}
    return "must be a JSON Schema object";
  }
  if (USER_ONLY_SETTING_RE.test(key))
    return "is a credential or a URL, which only the user sets: tell them to fill in this line in the .env editor themselves";
  return "is not a Stubbase setting. There is no feature by that name — tell the user it does not exist";
}

/** change_settings — validates a proposal and hands it to the user; changes nothing. */
function toolChangeSettings(args: Record<string, unknown>): ToolOutcome {
  const raw = Array.isArray(args.settings) ? args.settings.slice(0, AI_MAX_SETTINGS) : [];
  if (raw.length === 0)
    return { result: { error: "no settings were supplied; name each setting and its new value" } };

  const set: Record<string, string> = {};
  const refused: { key: string; reason: string }[] = [];
  for (const entry of raw) {
    const key = typeof (entry as any)?.key === "string" ? (entry as any).key.trim().toUpperCase() : "";
    const v = (entry as any)?.value;
    const value = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
    if (!key || value === null) {
      refused.push({ key: key || "(unnamed)", reason: "needs a key and a value" });
      continue;
    }
    const reason = settingRefusal(key, value);
    if (reason) refused.push({ key, reason });
    else set[key] = value;
  }

  const supported = [...Object.keys(AGENT_SETTINGS), "SCHEMA_<TABLE>"];
  if (Object.keys(set).length === 0)
    return { result: { error: "none of those settings can be proposed", refused, supported } };
  return {
    result: {
      pendingConfirmation: { kind: "settings", set },
      ...(refused.length > 0 ? { refused } : {}),
      note:
        "NOTHING HAS CHANGED YET. The user is shown these settings to confirm in the dashboard; " +
        "once confirmed they are staged, and they go live when the project is deployed. " +
        "Tell them both, and do not claim the settings are on.",
    },
  };
}

/** use_starter — proposes filling an empty project from a starter; changes nothing. */
function toolUseStarter(args: Record<string, unknown>, user: User, tenantId: string): ToolOutcome {
  const starter = STARTER_CATALOGUE.find((s) => s.id === args.id);
  if (!starter)
    return {
      result: {
        error: "there is no starter by that id",
        starters: STARTER_CATALOGUE.map((s) => s.id),
      },
    };
  const existing = parseResources(ownedProject(tenantId, user.id)!.resources);
  if (existing.length > 0)
    return {
      result: {
        error:
          "this project already has tables, and a starter only fills an empty project. " +
          "Design what the user asked for with stage_schema_drafts instead.",
        resources: existing,
      },
    };
  return {
    result: {
      pendingConfirmation: { kind: "starter", id: starter.id, title: starter.title, tables: starter.tables },
      note:
        "NOTHING HAS CHANGED YET. The user is shown this starter to confirm in the dashboard; " +
        "once confirmed its tables are staged as drafts, and they go live when the project is " +
        "deployed. Tell them it is waiting for their confirmation.",
    },
  };
}

/**
 * A project's settings as the agent may see them: the value of every setting
 * it could propose, and only the NAMES of the rest. Credentials never reach the
 * provider — and a webhook URL is named but not shown, since it can carry a
 * token in its query string.
 */
function visibleSettings(env: unknown): { values: Record<string, string>; alsoSet: string[] } {
  const values: Record<string, string> = {};
  const alsoSet: string[] = [];
  if (!env || typeof env !== "object" || Array.isArray(env)) return { values, alsoSet };
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (key === "__raw" || typeof value !== "string" || value.trim() === "") continue;
    if (Object.hasOwn(AGENT_SETTINGS, key) || SCHEMA_KEY_RE.test(key)) values[key] = value;
    else alsoSet.push(key);
  }
  return { values, alsoSet: alsoSet.sort() };
}

async function readSettings(tenantId: string, name: string) {
  const res = await coreAdmin("GET", tenantId, name);
  return res.ok ? visibleSettings(res.data) : null;
}

// ── Record tools ───────────────────────────────────────────────────
// The Co-Pilot's hands on the data: create, update, delete and count records,
// through the core's `_admin/records` plane. The chat is the confirmation —
// what the user asked for happens — with three things around it:
//   - Nothing about the records goes to the model. A tool answers with counts
//     and new ids; records are named with `where` in the public API's filter
//     language, which the model can write without reading anything.
//   - A change to more than AI_BULK_THRESHOLD records needs the user's answer:
//     the first call returns the count and a confirmation that is valid only
//     in a LATER chat request, so the model has to stop and ask.
//   - Every change is undoable from its chat card. The core returns the
//     before-images, which are kept here (ai_undo) and never sent to the model.

const AI_BULK_THRESHOLD = 20;
const AI_MAX_CREATE = 200;
const AI_MAX_RECORD_CHARS = 10_000;
const AI_UNDO_TTL_HOURS = 24;
const AI_MAX_UNDO_CHARS = 5_000_000;
const AI_CONFIRM_TTL_MS = 30 * 60_000;

/** A bulk change waiting for the user's go-ahead, keyed by the confirmation handed to the model. */
const pendingBulk = new Map<string, { userId: number; tenantId: string; key: string; turnId: string; expires: number }>();

async function coreRecords(tenantId: string, table: string, body: unknown) {
  const res = await fetch(`${CORE_API_URL}/${tenantId}/_admin/records/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as any };
}

/** The table argument, or a refusal naming the tables that do exist. */
function recordTable(args: Record<string, unknown>, user: User, tenantId: string): string | ToolOutcome {
  const table = typeof args.table === "string" ? args.table.trim() : "";
  const tables = parseResources(ownedProject(tenantId, user.id)!.resources);
  if (!NAME_RE.test(table) || !tables.includes(table))
    return { result: { error: `there is no table '${table}' in this project`, tables } };
  return table;
}

/** A core refusal, in words the model can act on. */
function recordRefusal(res: { status: number; data: any }, table: string, tables: string[]): ToolOutcome {
  if (res.status === 404) return { result: { error: `there is no table '${table}' in this project`, tables } };
  return { result: { error: String(res.data?.error ?? `the change was refused (status ${res.status})`) } };
}

/** Keeps a change's undo, when it is small enough to keep. Returns its id, or null. */
function keepUndo(user: User, tenantId: string, table: string, undo: unknown): string | null {
  const payload = JSON.stringify(undo ?? null);
  if (!undo || payload.length > AI_MAX_UNDO_CHARS) return null;
  db.query(`DELETE FROM ai_undo WHERE created_at < datetime('now', '-${AI_UNDO_TTL_HOURS} hours')`).run();
  const id = crypto.randomUUID();
  db.query("INSERT INTO ai_undo (id, user_id, tenant_id, table_name, payload) VALUES (?, ?, ?, ?, ?)").run(
    id,
    user.id,
    tenantId,
    table,
    payload,
  );
  return id;
}

/** create_records — adds records; answers with how many and their ids. */
async function toolCreateRecords(args: Record<string, unknown>, user: User, tenantId: string): Promise<ToolOutcome> {
  const table = recordTable(args, user, tenantId);
  if (typeof table !== "string") return table;
  const records = Array.isArray(args.records) ? args.records : [];
  if (records.length === 0) return { result: { error: "give the records to create, one object each" } };
  if (records.length > AI_MAX_CREATE)
    return { result: { error: `at most ${AI_MAX_CREATE} records per call; split the rest into further calls` } };
  for (const r of records) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return { result: { error: "every record must be an object" } };
    if (JSON.stringify(r).length > AI_MAX_RECORD_CHARS)
      return { result: { error: `a record is larger than ${AI_MAX_RECORD_CHARS} characters` } };
  }
  const res = await coreRecords(tenantId, table, { op: "create", records });
  if (!res.ok) return recordRefusal(res, table, parseResources(ownedProject(tenantId, user.id)!.resources));
  const undoId = keepUndo(user, tenantId, table, res.data?.undo);
  return {
    changed: true,
    result: {
      table,
      created: res.data.result.created,
      ids: (res.data.result.ids as string[]).slice(0, 10),
      ...(res.data.staged ? { staged: true, note: "The table is not deployed yet: these records go live with it." } : {}),
      undoId,
    },
  };
}

/** The `where` argument as the core takes it — values only as strings, numbers or booleans. */
function whereArg(args: Record<string, unknown>): Record<string, string | number | boolean> | string {
  if (args.where === undefined) return {};
  if (!args.where || typeof args.where !== "object" || Array.isArray(args.where))
    return "'where' must be an object of filters, e.g. { \"status\": \"pending\", \"price[gt]\": 20 }";
  const where: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args.where as Record<string, unknown>)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
      return `'where.${k}' must be a string, number or boolean`;
    Object.defineProperty(where, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return where;
}

/** update_records / delete_records — by filter, with the bulk guard and an undo. */
async function toolChangeRecords(
  kind: "update" | "delete",
  args: Record<string, unknown>,
  user: User,
  tenantId: string,
  turnId: string,
): Promise<ToolOutcome> {
  const table = recordTable(args, user, tenantId);
  if (typeof table !== "string") return table;
  const tables = parseResources(ownedProject(tenantId, user.id)!.resources);
  const where = whereArg(args);
  if (typeof where === "string") return { result: { error: where } };
  const all = args.all === true;
  if (Object.keys(where).length === 0 && !all)
    return { result: { error: "name the records with 'where', or set 'all': true to change every record" } };
  const change =
    kind === "update"
      ? { op: "update", where, all, set: args.set ?? {}, unset: args.unset ?? [] }
      : { op: "delete", where, all };

  // How many it would touch, before touching any.
  const counted = await coreRecords(tenantId, table, { op: "count", where });
  if (!counted.ok) return recordRefusal(counted, table, tables);
  const matched = counted.data.result.count as number;
  if (matched === 0) return { result: { table, matched: 0, note: "No records match, so nothing was changed." } };

  if (matched > AI_BULK_THRESHOLD) {
    const key = JSON.stringify([kind, table, change]);
    const given = typeof args.confirmation === "string" ? pendingBulk.get(args.confirmation) : undefined;
    const valid =
      given &&
      given.userId === user.id &&
      given.tenantId === tenantId &&
      given.key === key &&
      given.turnId !== turnId &&
      given.expires > Date.now();
    if (!valid) {
      for (const [id, p] of pendingBulk) if (p.expires <= Date.now()) pendingBulk.delete(id);
      const confirmation = crypto.randomUUID();
      pendingBulk.set(confirmation, { userId: user.id, tenantId, key, turnId, expires: Date.now() + AI_CONFIRM_TTL_MS });
      return {
        result: {
          table,
          matched,
          needsConfirmation: true,
          confirmation,
          note:
            `NOTHING HAS CHANGED. This would ${kind} ${matched} records. Tell the user that number and ` +
            `ask them to confirm. Only after they agree, in their next message, call again with exactly ` +
            `the same arguments plus this confirmation.`,
        },
      };
    }
    pendingBulk.delete(args.confirmation as string);
  }

  const res = await coreRecords(tenantId, table, change);
  if (!res.ok) return recordRefusal(res, table, tables);
  const undoId = keepUndo(user, tenantId, table, res.data?.undo);
  return {
    changed: true,
    result: {
      table,
      ...res.data.result,
      ...(res.data.staged ? { staged: true } : {}),
      undoId,
      ...(undoId ? {} : { note: "Too large to keep an undo for; the change stands." }),
    },
  };
}

/** count_records — how many records match; never the records. */
async function toolCountRecords(args: Record<string, unknown>, tenantId: string): Promise<ToolOutcome> {
  const table = typeof args.table === "string" ? args.table.trim() : "";
  if (!NAME_RE.test(table)) return { result: { error: "name one table, e.g. 'books'" } };
  const where = whereArg(args);
  if (typeof where === "string") return { result: { error: where } };
  const res = await coreRecords(tenantId, table, { op: "count", where });
  if (res.status === 404) return { result: { error: `there is no table '${table}' in this project` } };
  if (!res.ok) return { result: { error: String(res.data?.error ?? `the count was refused (status ${res.status})`) } };
  return { result: { table, count: res.data.result.count } };
}

/**
 * POST /projects/<id>/ai/undo/<undoId> — puts back what one Co-Pilot record
 * change altered. Spent on use. The core skips any record written since the
 * change, so an undo never erases a later write; the answer says how many.
 */
async function undoRecordChange(user: User, tenantId: string, undoId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const row = db
    .query(
      `SELECT table_name, payload FROM ai_undo
       WHERE id = ? AND user_id = ? AND tenant_id = ? AND created_at >= datetime('now', '-${AI_UNDO_TTL_HOURS} hours')`,
    )
    .get(undoId, user.id, tenantId) as { table_name: string; payload: string } | null;
  if (!row) return err(404, "nothing to undo — it was already undone, or has expired");
  // Spent before the call: a double click must not restore twice.
  db.query("DELETE FROM ai_undo WHERE id = ?").run(undoId);
  const res = await coreRecords(tenantId, row.table_name, { op: "restore", ...JSON.parse(row.payload) });
  if (!res.ok) return err(502, `core engine refused the undo (status ${res.status})`);
  return json({ ok: true, table: row.table_name, ...res.data.result });
}

// ── Data model ─────────────────────────────────────────────────────
// The shape of the project's tables, from the core's models/ folder: what the
// Co-Pilot designs against instead of being sent the records. Field names are
// the only user data in it, and a model never carries a value.

const REQUIRED_NOTE =
  "Required is recorded in the data model, not enforced yet: requests that leave the field out still succeed.";

/** get_data_model — every table's model, deployed and staged, never a record. */
async function toolGetDataModel(tenantId: string): Promise<ToolOutcome> {
  const res = await coreAdminModels(tenantId);
  if (!res.ok) return { result: { error: `could not read the data model (status ${res.status})` } };
  const all = ((res.data as any)?.models ?? {}) as Record<string, Record<string, unknown>>;
  const tables: Record<string, unknown> = {};
  const staged: Record<string, unknown> = {};
  for (const [name, { resource: _resource, ...model }] of Object.entries(all))
    if (name.startsWith(DRAFT_PREFIX)) staged[name.slice(DRAFT_PREFIX.length)] = model;
    else tables[name] = model;
  return {
    result: {
      tables,
      ...(Object.keys(staged).length > 0 ? { staged } : {}),
      note:
        "Per field: `count` is how many records carry it and `types` how many hold each type. " +
        "`staged` is what a waiting draft will make the table once deployed. " +
        REQUIRED_NOTE,
    },
  };
}

const AI_MAX_REQUIRED_FIELDS = 50;

/** set_required_fields — declares fields required or optional; recorded, not enforced. */
async function toolSetRequiredFields(args: Record<string, unknown>, tenantId: string): Promise<ToolOutcome> {
  const table = typeof args.table === "string" ? args.table.trim() : "";
  if (!NAME_RE.test(table) || table.startsWith(DRAFT_PREFIX))
    return { result: { error: "name one existing table, e.g. 'posts'" } };
  const raw = Array.isArray(args.fields) ? args.fields.slice(0, AI_MAX_REQUIRED_FIELDS) : [];
  const required: Record<string, boolean> = {};
  for (const entry of raw) {
    const name = (entry as any)?.name;
    const value = (entry as any)?.required;
    if (typeof name !== "string" || !name.trim() || name.length > 128 || typeof value !== "boolean") continue;
    Object.defineProperty(required, name.trim(), { value, enumerable: true, writable: true, configurable: true });
  }
  if (Object.keys(required).length === 0)
    return { result: { error: "name each field and whether it is required (true or false)" } };

  const res = await coreAdminModels(tenantId, { resource: table, required });
  if (res.status === 404) {
    const models = await coreAdminModels(tenantId);
    const tables = Object.keys(((models.data as any)?.models ?? {}) as object).filter(
      (n) => !n.startsWith(DRAFT_PREFIX),
    );
    return { result: { error: `there is no table '${table}' in this project`, tables } };
  }
  if (!res.ok)
    return { result: { error: String((res.data as any)?.error ?? `the data model refused it (status ${res.status})`) } };
  const fields = ((res.data as any)?.models?.[table]?.fields ?? {}) as Record<string, { required?: boolean }>;
  return {
    result: {
      table,
      required: Object.keys(fields).filter((f) => fields[f]?.required === true),
      note: REQUIRED_NOTE,
    },
  };
}

/** get_diagnostics — tables, settings, syntax health, server status and recent traffic. */
async function toolGetDiagnostics(user: User, tenantId: string): Promise<ToolOutcome> {
  const project = ownedProject(tenantId, user.id)!;
  const [{ syntaxErrors, checked }, status, logs, deployed, staged] = await Promise.all([
    collectSyntaxErrors(tenantId, project),
    projectStatus(tenantId),
    coreLogSnapshot(tenantId, AI_MAX_LOG_ENTRIES),
    readSettings(tenantId, "config"),
    readSettings(tenantId, `${DRAFT_PREFIX}config`),
  ]);

  const recent = logs.slice(-AI_MAX_LOG_ENTRIES).map((e) => {
    const rejected = Array.isArray(e.lifecycle) ? e.lifecycle.find((s) => !s.ok) : undefined;
    // No request or response bodies: they are text strangers sent to the public
    // API, and the agent that reads this can change records. The status and
    // the pipeline stage that refused the request are what a diagnosis needs.
    return {
      ts: e.ts,
      method: e.method,
      path: e.path,
      status: e.status,
      durationMs: e.durationMs,
      ...(rejected ? { rejectedAt: rejected.stage, reason: rejected.note ?? null } : {}),
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
      // What the live API runs on, and — when an edit is waiting for a deploy —
      // what it will run on after one. `alsoSet` names the settings whose
      // values are not shown (credentials, URLs).
      settings: {
        deployed: deployed ?? { values: {}, alsoSet: [] },
        ...(staged ? { staged } : {}),
      },
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

async function runTool(call: FunctionCall, user: User, tenantId: string, turnId: string): Promise<ToolOutcome> {
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
      case "change_settings":
        return toolChangeSettings(call.args);
      case "use_starter":
        return toolUseStarter(call.args, user, tenantId);
      case "get_diagnostics":
        return await toolGetDiagnostics(user, tenantId);
      case "get_data_model":
        return await toolGetDataModel(tenantId);
      case "create_records":
        return await toolCreateRecords(call.args, user, tenantId);
      case "update_records":
        return await toolChangeRecords("update", call.args, user, tenantId, turnId);
      case "delete_records":
        return await toolChangeRecords("delete", call.args, user, tenantId, turnId);
      case "count_records":
        return await toolCountRecords(call.args, tenantId);
      case "set_required_fields":
        return await toolSetRequiredFields(call.args, tenantId);
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
 * Accounts with a Co-Pilot turn in flight. One at a time per account: the
 * balance is checked before a turn and charged after it, so two turns in
 * parallel could each pass the check and together overrun it.
 */
const aiTurnsInFlight = new Set<number>();

/**
 * POST /projects/<tenantId>/ai/chat — one conversational turn, including any
 * tool calls it takes to answer.
 *
 * Loops: ask the model → it either replies with text (done) or asks for tools →
 * run them → feed the results back → ask again. Bounded by AI_MAX_TOOL_ROUNDS,
 * after which the model is asked once more with no tools available, so a
 * confused agent still ends the request with a sentence for the user instead of
 * spending provider calls in a circle.
 *
 * Every round's tokens are added up and the turn is charged once, when it ends
 * — however it ends, a provider failure included, since the provider billed
 * what it read. The reply carries `creditsCharged` and `creditsRemaining`.
 */
async function aiChat(req: Request, user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  // Credits before configuration: an account with none gets the same answer
  // whether or not this deployment happens to hold a provider credential, so
  // the refusal never doubles as a probe of the server's setup. 402 rather
  // than 403 — the request is well-formed and the caller is who they say they
  // are; what is missing is credit.
  if (creditBalance(user) < 1)
    return json(
      {
        error:
          planOf(user).monthlyAiCredits > 0
            ? "You have used this month's AI credits. They refill on the 1st, or add a credit pack."
            : "You have no AI credits left. Add a credit pack, or move to Pro for credits every month.",
        creditsRemaining: 0,
      },
      402,
    );
  if (!aiService)
    return err(503, `The AI Co-Pilot is not configured on this server (${aiDisabledReason})`);
  if (aiTurnsInFlight.has(user.id))
    return err(409, "The AI Co-Pilot is still answering your last message.");

  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const history = validateHistory((body as any)?.messages);
  if (typeof history === "string") return err(400, history);

  aiTurnsInFlight.add(user.id);
  // Identifies this request, so a bulk change's confirmation can be required to
  // come from a later one — the user's answer — and never from the same turn.
  const turnId = crypto.randomUUID();
  let usage = NO_USAGE;
  /** Charges the turn and reports it; every way out of the loop goes through here. */
  const settle = () => {
    const creditsCharged = Math.ceil(usage.totalTokens / TOKENS_PER_CREDIT);
    if (creditsCharged > 0) spendCredits(user, creditsCharged);
    console.log(
      `[ai] turn for account ${user.id}: ${usage.totalTokens} tokens ` +
        `(${usage.promptTokens} in, ${usage.outputTokens} out), ${creditsCharged} credits`,
    );
    return { creditsCharged, creditsRemaining: creditBalance(user) };
  };
  const failed = (status: number, error: string) => json({ error, ...settle() }, status);

  try {
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
          usage = addUsage(usage, e.usage);
          console.warn(`[ai] ${e.kind}: ${e.message}${e.detail ? ` — ${e.detail}` : ""}`);
          if (e.kind === "timeout")
            return failed(504, "The AI Co-Pilot took too long to respond, please try again.");
          return failed(502, "The AI Co-Pilot could not answer, please try again.");
        }
        console.error("[ai] unexpected failure:", e);
        return failed(502, "The AI Co-Pilot could not answer, please try again.");
      }

      usage = addUsage(usage, reply.usage);
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
          ...settle(),
        });

      const parts: ChatPart[] = [];
      for (const call of reply.calls) {
        const outcome = await runTool(call, user, tenantId, turnId);
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
    return failed(502, "The AI Co-Pilot could not finish its work, please try again.");
  } finally {
    aiTurnsInFlight.delete(user.id);
  }
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

/** An account's requests in the calendar month that holds `date`. */
function accountRequestsInMonthOf(userId: number, date: string): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(request_count), 0) AS n FROM api_usage
       WHERE user_id = ? AND date >= date(?, 'start of month')
         AND date < date(?, 'start of month', '+1 month')`,
    )
    .get(userId, date, date) as { n: number };
  return row.n;
}

/**
 * Records usage and draws request packs for whatever of it went past the plan's
 * monthly allowance, in one transaction. The draw is the part of each row that
 * crossed the allowance — measured against the month the row belongs to, so a
 * flush straddling midnight on the 1st charges each side to its own month.
 */
const applyUsage = db.transaction(
  (rows: { tenantId: string; date: string; requests: number; bytes: number }[]) => {
    for (const r of rows) {
      const account = usageAccount(r.tenantId);
      const owner =
        account === null
          ? null
          : (db.query("SELECT id, plan FROM users WHERE id = ?").get(account) as {
              id: number;
              plan: string;
            } | null);
      const plan = owner ? planOf(owner) : null;
      const before = plan?.requestPacks ? accountRequestsInMonthOf(account!, r.date) : 0;
      upsertUsage.run(r.tenantId, r.date, r.requests, r.bytes, account);
      if (plan?.requestPacks) {
        const over = (n: number) => Math.max(0, n - plan.monthlyRequests);
        const past = over(before + r.requests) - over(before);
        if (past > 0) drawPacks(account!, past);
      }
    }
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
  // without ever being taught what a plan or a user is — it gets a few numbers
  // per tenant and the opaque name of its rate-limit bucket, refreshed every flush. That also means a plan change takes effect
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
 *
 * The per-second limit follows the same rule. `rps` and `burst` are the
 * owner's plan's, and `bucket` names the account, so every project of it draws
 * from one bucket in the core — a second project never buys a second rate. An
 * orphan gets the smallest plan's rate in a bucket of its own.
 */
function quotaFor(tenantId: string): {
  tenantId: string;
  limit: number;
  used: number;
  rps: number;
  burst: number;
  bucket: string;
} {
  const owner = db
    .query(
      `SELECT u.id AS id, u.plan AS plan FROM projects p JOIN users u ON u.id = p.user_id
       WHERE p.tenant_id = ?`,
    )
    .get(tenantId) as { id: number; plan: string } | null;
  if (owner) {
    const allowance = allowanceOf(owner);
    const used = accountMonthRequests(owner.id);
    return {
      tenantId,
      limit: limitOf(allowance, used),
      used,
      rps: allowance.requestsPerSecond,
      burst: allowance.burst,
      bucket: rateBucket(`account:${owner.id}`),
    };
  }

  const orphan = db
    .query(
      `SELECT COALESCE(SUM(request_count), 0) AS n FROM api_usage
       WHERE tenant_id = ? AND date >= date('now', 'start of month')`,
    )
    .get(tenantId) as { n: number };
  const smallest = planOf({ plan: DEFAULT_PLAN });
  return {
    tenantId,
    limit: smallest.monthlyRequests,
    used: orphan.n,
    rps: smallest.requestsPerSecond,
    burst: smallest.burst,
    bucket: rateBucket(`tenant:${tenantId}`),
  };
}

/**
 * A rate-limit bucket's name as the core is told it. Opaque on purpose: the
 * core needs to know which tenants share a bucket, never whose account it is.
 */
const rateBucket = (owner: string) => `rb-${sha256hex(`rate-bucket:${owner}`).slice(0, 32)}`;

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
    limit: limitOf(allowanceOf(user), accountMonthRequests(user.id)),
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
): Promise<{ promoted: string[]; removed?: string[] } | { error: string }> {
  // Removals first, each unmarked as soon as it is done, so a deploy that fails
  // part-way leaves exactly the tables still to remove marked.
  const removed: string[] = [];
  const pending = db.query("SELECT removing FROM projects WHERE tenant_id = ?").get(tenantId) as {
    removing: string;
  } | null;
  for (const name of parseResources(pending?.removing ?? "[]")) {
    await coreAdmin("DELETE", tenantId, `${DRAFT_PREFIX}${name}`);
    const gone = await coreAdmin("DELETE", tenantId, name);
    if (!gone.ok && gone.status !== 404)
      return { error: `core engine failed to remove '${name}' (status ${gone.status})` };
    removeResource(tenantId, name);
    setRemoving(tenantId, name, false);
    removed.push(name);
  }

  const res = await coreAdminAction(tenantId, "deploy");
  // A project with nothing written yet has no tenant folder on the core, which
  // answers 404. Ownership is already verified by the caller, so that is not an
  // error: this service owns "the project exists", and there is simply nothing
  // staged to promote. Without this, Deploy fails on every brand-new project.
  if (res.status === 404) return { promoted: [], ...(removed.length > 0 ? { removed } : {}) };
  if (!res.ok) return { error: `core engine refused the deploy (status ${res.status})` };
  // Cleared here rather than in deployProject so the Deploy button and the
  // Co-Pilot's deploy_project tool cannot disagree about what a deploy means.
  // Only on success: a refused deploy returns above with the flag standing,
  // which is the safe direction — a project that over-reports staged changes
  // costs a redundant redeploy, one that under-reports serves stale data
  // silently. The core promotes every draft it finds, including any staged
  // before this column existed, so clearing the whole set is right.
  clearDirty(tenantId);
  return {
    promoted: ((res.data as any)?.promoted ?? []) as string[],
    ...(removed.length > 0 ? { removed } : {}),
  };
}

async function deployProject(user: User, tenantId: string): Promise<Response> {
  if (!ownedProject(tenantId, user.id)) return err(404, "project not found");
  const out = await promoteDrafts(tenantId);
  if ("error" in out) return err(502, out.error);
  return json({ ok: true, tenant: tenantId, promoted: out.promoted, removed: out.removed ?? [] });
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
  // The file revision an editor sends back with its save (If-Match).
  res.headers.set("access-control-expose-headers", "x-revision");
  return res;
}

function preflight(req: Request): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.headers.set("access-control-allow-headers", "authorization, content-type, if-match");
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
    if (req.method === "POST" && segments[1] === "signup" && segments.length === 3) {
      if (segments[2] === "verify") return verifySignup(req);
      if (segments[2] === "resend") return resendSignupCode(req);
    }
    if (req.method === "POST" && segments[1] === "login" && segments.length === 2)
      return login(req);
    if (req.method === "POST" && segments[1] === "forgot-password" && segments.length === 2)
      return forgotPassword(req);
    if (req.method === "POST" && segments[1] === "reset-password" && segments.length === 2)
      return resetPassword(req);

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
    if (req.method === "PATCH" && segments[1] === "me" && segments.length === 2)
      return updateAccount(req, user);
    if (req.method === "GET" && segments[1] === "account" && segments.length === 2)
      return accountSummary(user);
    if (req.method === "POST" && segments[1] === "delete-account" && segments.length === 2)
      return deleteAccount(req, user);
    if (segments[1] === "sessions") {
      if (req.method === "GET" && segments.length === 2) return listSessions(req, user);
      // Session ids are 32 hex characters, so "others" can never be one.
      if (req.method === "DELETE" && segments.length === 3)
        return segments[2] === "others" ? endOtherSessions(req, user) : endSession(user, segments[2]);
    }
    if (req.method === "POST" && segments[1] === "change-password" && segments.length === 2)
      return changePassword(req, user);
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
            "SELECT tenant_id, name, resources, dirty, removing, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC",
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
      if (segments[2] === "duplicate") return duplicateProject(req, user, segments[1]);
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
    if (segments.length === 5 && req.method === "POST" && segments[2] === "ai" && segments[3] === "undo")
      return undoRecordChange(user, segments[1], segments[4]);

    if (segments.length === 5 && segments[2] === "files" && segments[4] === "restore" && req.method === "POST")
      return restoreFile(user, segments[1], segments[3]);

    if (segments.length === 4 && segments[2] === "files") {
      if (req.method === "GET")
        return getFile(user, segments[1], segments[3], url.searchParams.get("source") === "live");
      if (req.method === "PUT") return putFile(req, user, segments[1], segments[3]);
      if (req.method === "DELETE") return deleteFile(user, segments[1], segments[3]);
    }
  }

  return err(404, "not found");
}

// Before the first request, so no sign-up can race an empty table.
await loadBlockedEmailDomains();

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
