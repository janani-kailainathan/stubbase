/**
 * Stubbase Core Tenant Engine
 *
 * Scale-to-zero JSON-to-CRUD:
 *   - Tenant data lazy-loads from /tenants/<id>/*.json into RAM on first request.
 *   - Mutations update RAM and write-through to disk immediately.
 *   - After 5 idle minutes a tenant is evicted from RAM (disk stays authoritative).
 *
 * Routes:
 *   GET|POST         /<tenant>/<resource>
 *   GET|PUT|DELETE   /<tenant>/<resource>/<id>
 *   POST             /<tenant>/auth/signup | /<tenant>/auth/login   (when AUTH_ENABLED)
 *   GET              /<tenant>/auth/google|github[/callback]        (OAuth, when configured)
 *   GET              /<tenant>/openapi.json
 *   POST             /<tenant>/_notify/email | sms                  (JWT-protected proxy)
 *   GET|POST|DELETE  /<tenant>/_admin/files/<resource>   (Bearer ADMIN_SECRET)
 *   POST             /<tenant>/_admin/flush | deploy     (Bearer ADMIN_SECRET)
 *   GET              /<tenant>/_admin/sse-logs           (Bearer ADMIN_SECRET, SSE)
 *   GET              /<tenant>/_admin/logs               (Bearer ADMIN_SECRET, snapshot)
 *   GET              /<tenant>/_admin/mcp/sse            (Bearer ADMIN_SECRET, MCP SSE)
 *   POST             /<tenant>/_admin/mcp/message        (Bearer ADMIN_SECRET, JSON-RPC 2.0)
 *
 * AI agents reach the tenant's data over MCP, which queries a read-only
 * in-memory SQLite projection of the JSON files (see "In-memory SQLite
 * projection" below). The JSON arrays remain the store; SQL only reads.
 *
 * Per-tenant behavior is configured by an optional config.json in the tenant
 * folder (flat object of env-style keys, compiled from the dashboard's
 * simulated .env editor). CRUD requests flow through a middleware PIPELINE:
 * statusGuard → authGuard → chaosGuard → validationGuard →
 * beforeWebhookGuard → coreOperation → afterWebhookGuard.
 */
import { readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Database } from "bun:sqlite"; // built into Bun — not an npm dependency

const PORT = Number(process.env.PORT ?? 3000);
const TENANTS_DIR = process.env.TENANTS_DIR ?? "./tenants";
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const IDLE_TTL_MS = Number(process.env.IDLE_TTL_MS ?? 5 * 60_000);
const MAX_ACTIVE_TENANTS = Number(process.env.MAX_ACTIVE_TENANTS ?? 500);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 1_048_576); // 1 MiB
const HOOK_TIMEOUT_MS = Number(process.env.HOOK_TIMEOUT_MS ?? 5_000);
// Ceiling on x-stubbase-delay: held-open requests cost memory on the 1GB box.
const MAX_CHAOS_DELAY_MS = Number(process.env.MAX_CHAOS_DELAY_MS ?? 10_000);
// Usage metering: counts aggregate in RAM and flush to the Dashboard API,
// which owns the SQLite file (this service's sandbox can't write it).
// Unset URL = metering off.
const USAGE_SINK_URL = process.env.USAGE_SINK_URL ?? "";
const USAGE_FLUSH_MS = Number(process.env.USAGE_FLUSH_MS ?? 60_000);
// SQL projection + MCP. The projection is derived from the in-RAM arrays and
// has its own idle life, independent of IDLE_TTL_MS: an MCP client may hold an
// SSE stream open for hours while querying rarely, and a sleeping projection
// must not keep costing RAM on the 1GB box.
const SQL_IDLE_MS = Number(process.env.SQL_IDLE_MS ?? 5 * 60_000);
const SQL_MAX_ROWS = Number(process.env.SQL_MAX_ROWS ?? 500);
const SQL_MAX_COLUMNS = Number(process.env.SQL_MAX_COLUMNS ?? 200);
const SQL_MAX_QUERY_CHARS = Number(process.env.SQL_MAX_QUERY_CHARS ?? 4_000);
const MCP_MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS ?? 50);
// Local dev/tests only: lets tenant webhooks target private addresses. NEVER set in production.
const HOOK_ALLOW_PRIVATE = process.env.HOOK_ALLOW_PRIVATE === "true";
// Upstream bases are env-overridable so the local stack can point them at mocks.
const RESEND_API_URL = process.env.RESEND_API_URL ?? "https://api.resend.com/emails";
const TWILIO_API_BASE = process.env.TWILIO_API_BASE ?? "https://api.twilio.com";

if (!ADMIN_SECRET) {
  console.error("[core] ADMIN_SECRET is required");
  process.exit(1);
}

// tenant ids / resource names: path-traversal-safe by construction
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
// The tenant config is an object, not a record array — as is its staged draft.
const isConfigFile = (resource: string) => resource === "config" || resource === "draft_config";

// Files the public plane must never mount as a CRUD resource: tenant settings
// (current and legacy names) and anything staged but undeployed.
const isPrivateFile = (name: string) =>
  name === "config" || name === "stubbase" || name === "env" || name.startsWith("draft_");

// Router blacklist — names that can never address a public resource. Underscore
// and dot prefixes are reserved for internal planes (_admin, _notify) and
// dotfiles; NAME_RE already rejects them, this answers 403 instead of 400.
// (`auth` needs no entry: it is dispatched as a route before this check.)
const isProtectedResource = (name: string) =>
  isPrivateFile(name) || name.startsWith("_") || name.startsWith(".");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;
// Same OWASP argon2id baseline as the dashboard API — 19 MiB transient per
// hash keeps concurrent signups affordable on the 1GB box.
const ARGON = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
// Verified against when a login email is unknown, so response time can't enumerate users.
const DUMMY_HASH = await Bun.password.hash("stubbase.invalid", ARGON);

// ── Tenant config (config.json) ───────────────────────────────────
// The dashboard UI edits a simulated .env; it lands on disk as config.json,
// a flat object of env-style string keys. Every tenant feature toggle lives here.

interface TenantConfig {
  projectStatus: "active" | "stopped" | "maintenance";
  qaMode: boolean; // gates every x-stubbase-* simulation header
  schemas: Record<string, unknown>; // resource → JSON Schema for POST/PUT bodies
  authEnabled: boolean;
  publicRoutes: Set<string>; // resources that allow anonymous GET despite auth
  jwtTtlSec: number;
  oauthRedirect: string; // frontend URL that receives #token=... after OAuth
  google?: { clientId: string; secret: string };
  github?: { clientId: string; secret: string };
  hooks: Record<string, string>; // HOOK_BEFORE_INSERT_POSTS etc → webhook URL
  resendKey: string;
  resendFrom: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
}

const DEFAULT_CONFIG: TenantConfig = {
  projectStatus: "active",
  qaMode: false,
  schemas: {},
  authEnabled: false,
  publicRoutes: new Set(),
  jwtTtlSec: 86_400,
  oauthRedirect: "",
  hooks: {},
  resendKey: "",
  resendFrom: "",
  twilioSid: "",
  twilioToken: "",
  twilioFrom: "",
};

function parseConfig(raw: unknown): TenantConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_CONFIG;
  const env = raw as Record<string, unknown>;
  const str = (k: string) => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
  const publicRoutes = new Set(
    str("AUTH_PUBLIC_ROUTES")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => NAME_RE.test(s)),
  );
  const hooks: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (k.startsWith("HOOK_") && typeof v === "string" && v.trim()) hooks[k] = v.trim();
  const pair = (idKey: string, secretKey: string) =>
    str(idKey) && str(secretKey) ? { clientId: str(idKey), secret: str(secretKey) } : undefined;
  const statusRaw = str("PROJECT_STATUS").toLowerCase();

  // Schemas come either as SCHEMA_<RESOURCE>=<json> (the flat .env form) or as
  // a nested `resources: { <name>: { schema } }` object for API-written configs.
  const schemas: Record<string, unknown> = {};
  const nested = env.resources;
  if (nested && typeof nested === "object" && !Array.isArray(nested))
    for (const [name, entry] of Object.entries(nested as Record<string, any>))
      if (NAME_RE.test(name) && entry?.schema && typeof entry.schema === "object")
        schemas[name] = entry.schema;
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("SCHEMA_") || typeof v !== "string" || !v.trim()) continue;
    const name = k.slice("SCHEMA_".length).toLowerCase();
    if (!NAME_RE.test(name)) continue;
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object") schemas[name] = parsed;
    } catch {
      console.warn(`[core] ${k}: not valid JSON, schema ignored`);
    }
  }

  return {
    projectStatus: statusRaw === "stopped" || statusRaw === "maintenance" ? statusRaw : "active",
    qaMode: str("QA_MODE").toLowerCase() === "true",
    schemas,
    authEnabled: str("AUTH_ENABLED").toLowerCase() === "true",
    publicRoutes,
    jwtTtlSec: Math.max(60, Number(str("AUTH_JWT_TTL_SECONDS")) || DEFAULT_CONFIG.jwtTtlSec),
    oauthRedirect: str("AUTH_OAUTH_REDIRECT"),
    google: pair("AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_SECRET"),
    github: pair("AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_SECRET"),
    hooks,
    resendKey: str("RESEND_API_KEY"),
    resendFrom: str("RESEND_FROM"),
    twilioSid: str("TWILIO_ACCOUNT_SID"),
    twilioToken: str("TWILIO_AUTH_TOKEN"),
    twilioFrom: str("TWILIO_FROM"),
  };
}

interface TenantState {
  db: Record<string, any[]>;
  config: TenantConfig;
  timer: ReturnType<typeof setTimeout>;
  lastSeen: number;
  writeChain: Promise<unknown>; // serializes disk writes per tenant
}

const activeTenants = new Map<string, TenantState>();

// Already-serialized body text, keyed by the Response that carries it. Lets the
// live logger record a response body without `res.clone().text()` buffering a
// second copy — same reason `json()` sets content-length for usage metering.
// Weak, so entries vanish with the Response itself.
const serializedBody = new WeakMap<Response, string>();

// Serializes once and declares content-length, so usage metering can read the
// response size from the header instead of cloning every body.
const json = (data: unknown, status = 200) => {
  const body = JSON.stringify(data) ?? "null";
  const res = new Response(body, {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
  serializedBody.set(res, body);
  return res;
};
const err = (status: number, message: string) => json({ error: message }, status);

const tenantDir = (t: string) => join(TENANTS_DIR, t);
const resourceFile = (t: string, r: string) => join(tenantDir(t), `${r}.json`);

// ── Usage metering ────────────────────────────────────────────────
// Every public-plane request bumps an in-RAM counter; a timer (and tenant
// eviction, and shutdown) flushes the aggregate to the Dashboard API, which
// upserts one api_usage row per tenant per UTC day. Counters live outside
// activeTenants on purpose: eviction can't drop unflushed usage.

interface UsageBucket {
  requests: number;
  bytes: number;
}
const usage = new Map<string, UsageBucket>(); // `${tenantId} ${YYYY-MM-DD}`
const usageEnabled = USAGE_SINK_URL !== "";
const utcDay = () => new Date().toISOString().slice(0, 10);

function meter(tenantId: string, res: Response): Response {
  if (!usageEnabled) return res;
  const bytes = Number(res.headers.get("content-length") ?? 0) || 0;
  const key = `${tenantId} ${utcDay()}`;
  const bucket = usage.get(key);
  if (bucket) {
    bucket.requests += 1;
    bucket.bytes += bytes;
  } else {
    usage.set(key, { requests: 1, bytes });
  }
  return res;
}

let flushInFlight: Promise<void> | null = null;

async function doFlushUsage(): Promise<void> {
  if (usage.size === 0) return;
  const snapshot = [...usage.entries()];
  usage.clear(); // new requests accumulate into a fresh map while we ship
  const rows = snapshot.map(([key, b]) => {
    const [tenantId, date] = key.split(" ");
    return { tenantId, date, requests: b.requests, bytes: b.bytes };
  });
  try {
    const res = await fetch(USAGE_SINK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    // Sink unreachable: fold the counts back in so a transient outage
    // defers usage rather than losing it.
    for (const [key, b] of snapshot) {
      const cur = usage.get(key);
      if (cur) {
        cur.requests += b.requests;
        cur.bytes += b.bytes;
      } else {
        usage.set(key, b);
      }
    }
    console.warn(`[core] usage flush failed, ${rows.length} bucket(s) retained (${e})`);
  }
}

/** Coalesces concurrent callers so eviction storms can't stampede the sink. */
function flushUsage(): Promise<void> {
  if (!usageEnabled) return Promise.resolve();
  if (flushInFlight) return flushInFlight;
  flushInFlight = doFlushUsage().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

if (usageEnabled) {
  const timer = setInterval(() => void flushUsage(), USAGE_FLUSH_MS);
  timer.unref?.(); // never hold the process open just to flush
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      void flushUsage().finally(() => process.exit(0));
    });
}

// ── Live request log ──────────────────────────────────────────────
// A capped ring of recent public-plane requests per tenant, held in RAM and
// never written to disk (the 1GB box has no budget for request logging, and
// journald is capped separately). Each entry carries the middleware lifecycle
// so the dashboard can show *where* a request was rejected, not just that it
// was. Like the usage counters, this lives OUTSIDE activeTenants on purpose:
// an idle eviction must not blank the log a developer is currently watching,
// and an open SSE stream does not count as tenant activity.

const LOG_CAP = Number(process.env.LOG_CAP ?? 50);
const LOG_BODY_CHARS = Number(process.env.LOG_BODY_CHARS ?? 500);

interface LifecycleStep {
  stage: string;
  /** false marks the stage that rejected the request — the UI paints it red. */
  ok: boolean;
  ms: number;
  note?: string;
}

interface LogEntry {
  correlationId: string;
  ts: string;
  tenantId: string;
  method: string;
  path: string;
  query: string;
  status: number;
  durationMs: number;
  requestBody: string | null;
  responseBody: string | null;
  lifecycle: LifecycleStep[];
}

const tenantLogs = new Map<string, LogEntry[]>();
/** Per-tenant SSE subscribers, notified as entries are appended. */
const logSubscribers = new Map<string, Set<(e: LogEntry) => void>>();

/** Bodies are capped so one fat payload can't pin megabytes in the ring. */
function truncate(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text.length <= LOG_BODY_CHARS ? text : `${text.slice(0, LOG_BODY_CHARS)}…[truncated]`;
}

function recordLog(entry: LogEntry) {
  let ring = tenantLogs.get(entry.tenantId);
  if (!ring) {
    ring = [];
    tenantLogs.set(entry.tenantId, ring);
  }
  ring.push(entry);
  while (ring.length > LOG_CAP) ring.shift(); // drop oldest
  const subs = logSubscribers.get(entry.tenantId);
  if (subs) for (const send of subs) send(entry);
}

/** Per-request log scratchpad, threaded through the pipeline by handleCrud. */
interface LogDraft {
  correlationId: string;
  startedAt: number;
  lifecycle: LifecycleStep[];
  requestBody?: string | null;
}

const newLogDraft = (): LogDraft => ({
  correlationId: crypto.randomUUID(),
  startedAt: performance.now(),
  lifecycle: [],
});

/**
 * Closes out a request: stamps x-correlation-id on the response and appends the
 * entry to the tenant's ring. Never throws — logging must not be able to fail a
 * request that already succeeded.
 */
function finishLog(
  tenantId: string,
  req: Request,
  url: URL,
  draft: LogDraft,
  res: Response,
): Response {
  try {
    res.headers.set("x-correlation-id", draft.correlationId);
    recordLog({
      correlationId: draft.correlationId,
      ts: new Date().toISOString(),
      tenantId,
      method: req.method,
      path: url.pathname,
      query: url.search,
      status: res.status,
      durationMs: Math.round(performance.now() - draft.startedAt),
      requestBody: truncate(draft.requestBody),
      responseBody: truncate(serializedBody.get(res) ?? null),
      lifecycle: draft.lifecycle,
    });
  } catch (e) {
    console.warn(`[core] log record failed for ${tenantId} (${e})`);
  }
  return res;
}

// ── State management ──────────────────────────────────────────────

async function loadTenant(tenantId: string): Promise<TenantState | null> {
  let entries: string[];
  try {
    entries = await readdir(tenantDir(tenantId));
  } catch {
    return null; // tenant does not exist on disk
  }
  const db: Record<string, any[]> = {};
  let config = DEFAULT_CONFIG;
  let configFromCanonical = false; // config.json wins over the legacy stubbase.json
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -5);
    if (!NAME_RE.test(name)) continue;
    // config/stubbase are settings, draft_* are staged: none may become a
    // servable resource. Everything else in isPrivateFile is skipped outright.
    const isSettings = name === "config" || name === "stubbase";
    if (isPrivateFile(name) && !isSettings) continue;
    try {
      const data = await Bun.file(join(tenantDir(tenantId), f)).json();
      if (isSettings) {
        if (name === "config" || !configFromCanonical) config = parseConfig(data);
        configFromCanonical ||= name === "config";
      } else if (Array.isArray(data)) db[name] = data;
      else console.warn(`[core] ${tenantId}/${f}: root is not an array, skipped`);
    } catch (e) {
      console.warn(`[core] ${tenantId}/${f}: unreadable JSON, skipped (${e})`);
    }
  }
  const state: TenantState = {
    db,
    config,
    timer: setTimeout(() => evict(tenantId), IDLE_TTL_MS),
    lastSeen: Date.now(),
    writeChain: Promise.resolve(),
  };
  activeTenants.set(tenantId, state);
  enforceCap(tenantId);
  return state;
}

function evict(tenantId: string) {
  const state = activeTenants.get(tenantId);
  if (!state) return;
  clearTimeout(state.timer);
  activeTenants.delete(tenantId); // writes are already flushed (write-through)
  // The SQL projection was derived from the arrays we are dropping, and every
  // admin route that rewrites files behind the cache lands here — so this is
  // also what keeps the projection honest after deploy/flush/file writes.
  dropSqlMount(tenantId);
  // Keep the log ring only while someone is watching it; otherwise a sleeping
  // tenant would hold 50 entries in RAM forever on a 1GB box.
  if (!logSubscribers.has(tenantId)) tenantLogs.delete(tenantId);
  void flushUsage(); // tenant went to sleep — ship its counters (coalesced)
}

function touch(tenantId: string, state: TenantState) {
  state.lastSeen = Date.now();
  clearTimeout(state.timer);
  state.timer = setTimeout(() => evict(tenantId), IDLE_TTL_MS);
}

// RAM guard for the 1GB box: past the cap, drop the least-recently-seen tenant early
function enforceCap(justLoaded: string) {
  if (activeTenants.size <= MAX_ACTIVE_TENANTS) return;
  let oldest: string | null = null;
  let oldestSeen = Infinity;
  for (const [id, s] of activeTenants) {
    if (id !== justLoaded && s.lastSeen < oldestSeen) {
      oldestSeen = s.lastSeen;
      oldest = id;
    }
  }
  if (oldest) evict(oldest);
}

async function getTenant(tenantId: string): Promise<TenantState | null> {
  const state = activeTenants.get(tenantId) ?? (await loadTenant(tenantId));
  if (state) touch(tenantId, state);
  return state;
}

// Write-through, serialized per tenant so concurrent mutations can't interleave a file
function persist(state: TenantState, tenantId: string, resource: string) {
  dropSqlMount(tenantId); // the SQL projection is now stale — rebuilt on next query
  const snapshot = JSON.stringify(state.db[resource] ?? [], null, 2);
  state.writeChain = state.writeChain.then(() =>
    Bun.write(resourceFile(tenantId, resource), snapshot).catch((e) =>
      console.error(`[core] persist failed ${tenantId}/${resource}: ${e}`),
    ),
  );
  return state.writeChain;
}

// ── In-memory SQLite projection ───────────────────────────────────
// A read-only `:memory:` database built lazily from the tenant's in-RAM arrays
// the first time something asks a SQL question, so MCP clients get a real query
// engine over JSON files.
//
// It is a PROJECTION, never the store. The arrays stay authoritative and every
// mutation still goes through the write-through path above; this DB is dropped
// whenever the data underneath it changes (`persist`, and `evict` for the admin
// routes that rewrite files behind the cache) and rebuilt on the next query.
// Routing CRUD through SQL instead would mean a SELECT + array rebuild on every
// write, two copies of every row in RAM, and — because JSON records are
// heterogeneous — silently dropping any key absent from the row that defined
// the schema, the first time a table was dumped back to disk.
//
// Like the log ring and the usage counters this lives OUTSIDE activeTenants,
// with its own idle timer: an MCP session can sit open far longer than
// IDLE_TTL_MS, and a projection nobody is querying must not pin RAM.

interface SqlMount {
  db: Database;
  timer: ReturnType<typeof setTimeout>;
  /** Tables that were skipped entirely, surfaced to the client rather than hidden. */
  skipped: string[];
}

const sqlMounts = new Map<string, SqlMount>();

/** SQLite identifier quoting — tenant JSON keys are arbitrary text. */
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Column type hint from *every* row, not just the first: JSON records are
 * heterogeneous, and `PRAGMA table_info` output is what gets injected into the
 * model's tool description, so the hint should describe the real data.
 * SQLite's typing is dynamic, so this only ever affects readability.
 */
function inferColumnType(rows: any[], key: string): "INTEGER" | "REAL" | "TEXT" {
  let sawNumeric = false;
  let allIntegral = true;
  for (const row of rows) {
    const v = row?.[key];
    if (v === null || v === undefined) continue;
    if (typeof v === "boolean") {
      sawNumeric = true;
      continue;
    }
    if (typeof v === "number") {
      sawNumeric = true;
      if (!Number.isInteger(v)) allIntegral = false;
      continue;
    }
    return "TEXT"; // strings, objects and arrays all land as text
  }
  if (!sawNumeric) return "TEXT";
  return allIntegral ? "INTEGER" : "REAL";
}

/** Records are JSON, columns are scalar: nested values ride as JSON text. */
function sqlValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null; // circular structures can't reach here from parsed JSON, but be safe
  }
}

/**
 * Union of keys across the whole table, capped. `passwordHash` is excluded at
 * mount time rather than filtered at read time: `SELECT *` is a response path
 * like any other, and a column that was never created cannot leak.
 */
function projectColumns(rows: any[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      if (key === "passwordHash" || key === "" || key.length > 128) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= SQL_MAX_COLUMNS) return keys;
    }
  }
  return keys;
}

function buildSqlMount(tenantId: string, state: TenantState): SqlMount {
  const db = new Database(":memory:");
  const skipped: string[] = [];

  for (const [resource, rows] of Object.entries(state.db)) {
    if (!Array.isArray(rows)) continue;
    const columns = projectColumns(rows);
    if (columns.length === 0) {
      skipped.push(resource); // no object rows to derive a shape from
      continue;
    }
    const decls = columns.map((c) => `${quoteIdent(c)} ${inferColumnType(rows, c)}`);
    db.run(`CREATE TABLE ${quoteIdent(resource)} (${decls.join(", ")})`);

    const insert = db.prepare(
      `INSERT INTO ${quoteIdent(resource)} (${columns.map(quoteIdent).join(", ")})` +
        ` VALUES (${columns.map(() => "?").join(", ")})`,
    );
    const insertAll = db.transaction((batch: any[]) => {
      for (const row of batch) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        insert.run(...columns.map((c) => sqlValue(row[c])));
      }
    });
    insertAll(rows);
    insert.finalize();
  }

  // Engine-level read-only. The prefix check in runSqlQuery is the friendly
  // error; this is the guarantee — INSERT/UPDATE/DELETE/DROP all fail here even
  // if a query somehow slipped past it.
  db.run("PRAGMA query_only = ON");

  return {
    db,
    skipped,
    timer: setTimeout(() => dropSqlMount(tenantId), SQL_IDLE_MS),
  };
}

function dropSqlMount(tenantId: string) {
  const mount = sqlMounts.get(tenantId);
  if (!mount) return;
  clearTimeout(mount.timer);
  sqlMounts.delete(tenantId);
  try {
    mount.db.close();
  } catch (e) {
    console.warn(`[core] closing sql projection for ${tenantId} failed (${e})`);
  }
}

/**
 * Lazy mount + idle-timer reset. Rebuilding is ~1ms for a typical tenant, so a
 * query arriving over a long-idle MCP session pays a rebuild rather than the
 * session having to hold RAM the whole time.
 */
async function getSqlMount(tenantId: string): Promise<SqlMount | null> {
  const existing = sqlMounts.get(tenantId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dropSqlMount(tenantId), SQL_IDLE_MS);
    return existing;
  }
  const state = await getTenant(tenantId);
  if (!state) return null;
  const mount = buildSqlMount(tenantId, state);
  sqlMounts.set(tenantId, mount);
  return mount;
}

// ── Helpers ───────────────────────────────────────────────────────

function isAdminAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  // hash both sides → equal length → constant-time compare
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(ADMIN_SECRET!).digest();
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: Request): Promise<unknown | Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return err(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return err(413, "body too large");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return err(400, "invalid JSON body");
  }
}

// Public origin as the browser sees it (Caddy terminates TLS and forwards Host)
function requestOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

// ── SSRF guard for tenant-supplied webhook URLs ───────────────────
// Tenant configs are untrusted: a hook URL pointing at 127.0.0.1 or the LAN
// would let a tenant probe this box (dashboard API, systemd services). Resolve
// the hostname and refuse private/reserved addresses before fetching.

function isPrivateIp(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // v4-mapped v6
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    return (
      low === "::" ||
      low === "::1" ||
      low.startsWith("fc") ||
      low.startsWith("fd") ||
      low.startsWith("fe8") ||
      low.startsWith("fe9") ||
      low.startsWith("fea") ||
      low.startsWith("feb")
    );
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 0) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
    p[0] >= 224
  );
}

// Returns a rejection reason, or null when the URL is safe to fetch.
async function hookUrlBlocked(target: string): Promise<string | null> {
  if (HOOK_ALLOW_PRIVATE) return null;
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "protocol must be http(s)";
  try {
    const addrs = await lookup(u.hostname, { all: true });
    if (addrs.length === 0) return "hostname does not resolve";
    if (addrs.some((a) => isPrivateIp(a.address))) return "resolves to a private address";
  } catch {
    return "hostname does not resolve";
  }
  return null;
}

// ── JSON Schema validation (zero-dependency subset) ───────────────
// ajv/zod would break the "no npm dependencies" rule for the backends, so
// this covers the draft-07 keywords that matter for record shapes:
// type, required, properties, additionalProperties, enum, const,
// minimum/maximum, minLength/maxLength, pattern, items, min/maxItems.

interface SchemaError {
  path: string;
  message: string;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function validateSchema(value: unknown, schema: any, path = ""): SchemaError[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: SchemaError[] = [];
  const at = path || "(root)";

  if (schema.type !== undefined) {
    const allowed: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsonType(value);
    // an integer satisfies "number"; a whole float satisfies "integer"
    const ok = allowed.some(
      (t) => t === actual || (t === "number" && actual === "integer") || (t === "integer" && actual === "number" && Number.isInteger(value)),
    );
    if (!ok) {
      errors.push({ path: at, message: `expected ${allowed.join(" or ")}, got ${actual}` });
      return errors; // further keywords would be noise once the type is wrong
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => deepEqual(e, value)))
    errors.push({ path: at, message: `must be one of ${JSON.stringify(schema.enum)}` });
  if (schema.const !== undefined && !deepEqual(schema.const, value))
    errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push({ path: at, message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push({ path: at, message: `must be <= ${schema.maximum}` });
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push({ path: at, message: `must be at least ${schema.minLength} characters` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    if (typeof schema.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        /* an unparseable pattern in tenant config must not 500 the request */
      }
      if (re && !re.test(value)) errors.push({ path: at, message: `must match ${schema.pattern}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push({ path: at, message: `must have at least ${schema.minItems} items` });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push({ path: at, message: `must have at most ${schema.maxItems} items` });
    if (schema.items)
      value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? schema.required : [])
      if (!(key in obj)) errors.push({ path: path ? `${path}.${key}` : key, message: "is required" });
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, sub] of Object.entries(props))
      if (key in obj) errors.push(...validateSchema(obj[key], sub, path ? `${path}.${key}` : key));
    if (schema.additionalProperties === false)
      for (const key of Object.keys(obj))
        if (!(key in props))
          errors.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
  }

  return errors;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) => deepEqual((a as any)[k], (b as any)[k]))
    );
  }
  return false;
}

// ── JWT (HS256, zero-dependency) ──────────────────────────────────
// Per-tenant signing keys are derived from ADMIN_SECRET, so they survive
// restarts and evictions without ever being stored on disk.

function jwtKey(tenantId: string): Buffer {
  return createHmac("sha256", ADMIN_SECRET!).update(`jwt:${tenantId}`).digest();
}

interface JwtClaims {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

function signJwt(tenantId: string, user: Record<string, any>, ttlSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({
    sub: String(user.id),
    email: String(user.email),
    role: String(user.role ?? "user"),
    iat: now,
    exp: now + ttlSec,
  } satisfies JwtClaims);
  const sig = createHmac("sha256", jwtKey(tenantId)).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function verifyJwt(tenantId: string, token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", jwtKey(tenantId)).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as JwtClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── OAuth (Google / GitHub) ───────────────────────────────────────
// Tenants bring their own OAuth app (client id/secret in config.json) and
// register `<origin>/<tenant>/auth/<provider>/callback` with the provider
// themselves. Endpoint bases are env-overridable so the local stack can
// point them at mocks.

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
type Provider = keyof typeof OAUTH_PROVIDERS;

// CSRF state: HMAC-signed timestamp, verified on callback, valid 10 minutes
function oauthState(tenantId: string): string {
  const ts = Date.now().toString();
  const sig = createHmac("sha256", jwtKey(tenantId)).update(`state:${ts}`).digest("base64url");
  return `${ts}.${sig}`;
}

function oauthStateValid(tenantId: string, s: string): boolean {
  const [ts, sig] = s.split(".");
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Date.now() - Number(ts) > 10 * 60_000) return false;
  const expected = createHmac("sha256", jwtKey(tenantId)).update(`state:${ts}`).digest();
  const given = Buffer.from(sig, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handleOauth(
  req: Request,
  tenantId: string,
  state: TenantState,
  provider: Provider,
  isCallback: boolean,
): Promise<Response> {
  const cfg = state.config;
  const creds = provider === "google" ? cfg.google : cfg.github;
  if (!creds) return err(404, `${provider} oauth is not configured`);
  const p = OAUTH_PROVIDERS[provider];
  const redirectUri = `${requestOrigin(req)}/${tenantId}/auth/${provider}/callback`;

  if (!isCallback) {
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: p.scope,
      state: oauthState(tenantId),
    });
    return new Response(null, { status: 302, headers: { location: `${p.authUrl}?${q}` } });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const st = url.searchParams.get("state") ?? "";
  if (!code || !oauthStateValid(tenantId, st)) return err(400, "missing or invalid oauth code/state");

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

  const users = (state.db.users ??= []);
  let user = users.find((u) => typeof u?.email === "string" && u.email.toLowerCase() === (email as string).toLowerCase());
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      email,
      ...(typeof profile.name === "string" && profile.name ? { name: profile.name } : {}),
      role: "user",
      provider,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    await persist(state, tenantId, "users");
  }
  const token = signJwt(tenantId, user, cfg.jwtTtlSec);
  if (cfg.oauthRedirect)
    return new Response(null, { status: 302, headers: { location: `${cfg.oauthRedirect}#token=${token}` } });
  return json({ token, user: safeUser(user) });
}

// ── Tenant auth: POST /<tenant>/auth/signup | login ───────────────
// When AUTH_ENABLED, users.json is the tenant's identity table. Password
// hashes live in its records but must never leave the server — every
// response path goes through safeUser().

const safeUser = (u: Record<string, any>) => {
  const { passwordHash: _ph, ...rest } = u;
  return rest;
};

async function handleAuth(req: Request, tenantId: string, segments: string[]): Promise<Response> {
  const state = await getTenant(tenantId);
  if (!state) return err(404, "tenant not found");
  const blocked = statusBlocked(state);
  if (blocked) return blocked;
  if (!state.config.authEnabled) return err(404, "auth is not enabled for this tenant");

  const [action, sub] = segments;
  if (req.method === "GET" && (action === "google" || action === "github") && segments.length <= 2) {
    if (sub !== undefined && sub !== "callback") return err(404, "unknown auth route");
    return handleOauth(req, tenantId, state, action, sub === "callback");
  }
  if (req.method !== "POST" || segments.length !== 1 || (action !== "signup" && action !== "login"))
    return err(404, "unknown auth route");

  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const { email, password, name } = ((body ?? {}) as Record<string, unknown>) || {};
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return err(400, "valid email required");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN)
    return err(400, `password must be at least ${MIN_PASSWORD_LEN} characters`);

  const users = (state.db.users ??= []);
  const findByEmail = () =>
    users.find((u) => typeof u?.email === "string" && u.email.toLowerCase() === email.toLowerCase());

  if (action === "signup") {
    if (findByEmail()) return err(409, "email already registered");
    const passwordHash = await Bun.password.hash(password, ARGON);
    if (findByEmail()) return err(409, "email already registered"); // re-check: hashing yielded
    const user = {
      id: crypto.randomUUID(),
      email,
      ...(typeof name === "string" && name ? { name } : {}),
      role: "user",
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    await persist(state, tenantId, "users");
    return json({ token: signJwt(tenantId, user, state.config.jwtTtlSec), user: safeUser(user) }, 201);
  }

  // login — always verify against some hash so unknown emails take the same time
  const existing = findByEmail();
  const hash = typeof existing?.passwordHash === "string" ? existing.passwordHash : DUMMY_HASH;
  const ok = await Bun.password.verify(password, hash).catch(() => false);
  if (!ok || !existing) return err(401, "invalid email or password");
  return json({ token: signJwt(tenantId, existing, state.config.jwtTtlSec), user: safeUser(existing) });
}

// ── OpenAPI: GET /<tenant>/openapi.json ───────────────────────────
// Schema is inferred from the keys of up to 20 in-RAM records per resource,
// so LLMs / MCP clients can ingest the tenant API as a tool.

function inferItemSchema(rows: any[]): object {
  const seen: Record<string, Set<string>> = {};
  for (const row of rows.slice(0, 20)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const [k, v] of Object.entries(row)) {
      if (k === "passwordHash") continue; // sanitized out of responses, keep it out of the spec
      const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      (seen[k] ??= new Set()).add(t);
    }
  }
  const properties: Record<string, object> = {};
  for (const [k, types] of Object.entries(seen)) {
    types.delete("null");
    const t = types.size === 1 ? [...types][0] : "string";
    properties[k] =
      t === "array"
        ? { type: "array", items: {} }
        : t === "object"
          ? { type: "object" }
          : t === "number" || t === "boolean"
            ? { type: t }
            : { type: "string" };
  }
  return { type: "object", properties };
}

async function handleOpenApi(req: Request, tenantId: string): Promise<Response> {
  if (req.method !== "GET") return err(405, "method not allowed");
  const state = await getTenant(tenantId);
  if (!state) return err(404, "tenant not found");
  const blocked = statusBlocked(state);
  if (blocked) return blocked;
  const cfg = state.config;
  const secured = (resource: string, method: string) =>
    cfg.authEnabled && !(method === "get" && cfg.publicRoutes.has(resource))
      ? [{ bearerAuth: [] }]
      : [];
  const jsonOf = (schema: object) => ({ "application/json": { schema } });
  const paths: Record<string, object> = {};
  const schemas: Record<string, object> = {};
  for (const [resource, rows] of Object.entries(state.db)) {
    schemas[resource] = inferItemSchema(rows);
    const ref = { $ref: `#/components/schemas/${resource}` };
    const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
    paths[`/${tenantId}/${resource}`] = {
      get: {
        summary: `List ${resource}`,
        description:
          "Filter with ?<field>=<value>; sort with _sort/_order; paginate with _page/_limit (or _offset/_limit); expand relations with _expand. Total row count is returned in the X-Total-Count header.",
        security: secured(resource, "get"),
        parameters: [
          { name: "_page", in: "query", description: "1-based page number", schema: { type: "integer" } },
          { name: "_limit", in: "query", schema: { type: "integer" } },
          { name: "_offset", in: "query", schema: { type: "integer" } },
          { name: "_sort", in: "query", description: "field(s), comma-separated", schema: { type: "string" } },
          { name: "_order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
          { name: "_expand", in: "query", description: "related resource(s) to nest", schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK", content: jsonOf({ type: "array", items: ref }) } },
      },
      post: {
        summary: `Create a ${resource} record`,
        security: secured(resource, "post"),
        requestBody: { required: true, content: jsonOf(ref) },
        responses: { "201": { description: "Created", content: jsonOf(ref) } },
      },
    };
    paths[`/${tenantId}/${resource}/{id}`] = {
      get: {
        summary: `Get one ${resource} record`,
        security: secured(resource, "get"),
        parameters: [idParam],
        responses: { "200": { description: "OK", content: jsonOf(ref) }, "404": { description: "Not found" } },
      },
      put: {
        summary: `Replace a ${resource} record`,
        security: secured(resource, "put"),
        parameters: [idParam],
        requestBody: { required: true, content: jsonOf(ref) },
        responses: { "200": { description: "OK", content: jsonOf(ref) } },
      },
      delete: {
        summary: `Delete a ${resource} record`,
        security: secured(resource, "delete"),
        parameters: [idParam],
        responses: { "200": { description: "Deleted", content: jsonOf(ref) } },
      },
    };
  }
  return json({
    openapi: "3.0.3",
    info: { title: `${tenantId} API`, description: "Auto-generated by Stubbase", version: "1.0.0" },
    servers: [{ url: requestOrigin(req) }],
    paths,
    components: {
      schemas,
      ...(cfg.authEnabled
        ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } }
        : {}),
    },
  });
}

// ── Notifications proxy: POST /<tenant>/_notify/email | sms ───────
// The tenant's frontend calls these with a user JWT; provider API keys stay
// in config.json server-side and are never exposed to the browser.

async function handleNotify(req: Request, tenantId: string, segments: string[]): Promise<Response> {
  const kind = segments[0];
  if (req.method !== "POST" || segments.length !== 1 || (kind !== "email" && kind !== "sms"))
    return err(404, "unknown notify route");
  const state = await getTenant(tenantId);
  if (!state) return err(404, "tenant not found");
  const blocked = statusBlocked(state);
  if (blocked) return blocked;
  const cfg = state.config;
  if (!cfg.authEnabled) return err(404, "notifications require AUTH_ENABLED");
  const header = req.headers.get("authorization") ?? "";
  const claims = header.startsWith("Bearer ") ? verifyJwt(tenantId, header.slice(7)) : null;
  if (!claims) return err(401, "valid bearer token required");
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const b = (body ?? {}) as Record<string, unknown>;

  if (kind === "email") {
    if (!cfg.resendKey) return err(404, "email notifications not configured");
    if (typeof b.to !== "string" || typeof b.subject !== "string")
      return err(400, "`to` and `subject` are required");
    const upstream = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.resendKey}` },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: cfg.resendFrom || "Stubbase <onboarding@resend.dev>",
        to: b.to,
        subject: b.subject,
        ...(typeof b.html === "string" ? { html: b.html } : {}),
        ...(typeof b.text === "string" ? { text: b.text } : {}),
      }),
    }).catch(() => null);
    if (!upstream?.ok)
      return err(502, `email provider rejected the request (${upstream?.status ?? "unreachable"})`);
    const out = (await upstream.json().catch(() => ({}))) as any;
    return json({ ok: true, id: out?.id ?? null });
  }

  // sms
  if (!cfg.twilioSid || !cfg.twilioToken || !cfg.twilioFrom)
    return err(404, "sms notifications not configured");
  if (typeof b.to !== "string" || typeof b.body !== "string") return err(400, "`to` and `body` are required");
  const creds = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString("base64");
  const upstream = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${cfg.twilioSid}/Messages.json`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${creds}` },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ To: b.to, From: cfg.twilioFrom, Body: b.body }).toString(),
  }).catch(() => null);
  if (!upstream || upstream.status >= 300)
    return err(502, `sms provider rejected the request (${upstream?.status ?? "unreachable"})`);
  const out = (await upstream.json().catch(() => ({}))) as any;
  return json({ ok: true, sid: out?.sid ?? null });
}

// ── Admin plane ───────────────────────────────────────────────────

/**
 * GET /<tenant>/_admin/sse-logs — Server-Sent Events stream of the live request
 * log. Replays the buffered ring immediately so a fresh connection is never
 * blank, then pushes each new entry as it is recorded. Admin-authenticated by
 * handleAdmin, and deliberately CORS-free like the rest of the admin plane:
 * the browser reaches it only through the Dashboard API's proxy.
 */
function streamLogs(req: Request, tenantId: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: LogEntry) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          unsubscribe(); // client vanished mid-write
        }
      };

      for (const e of tenantLogs.get(tenantId) ?? []) send(e); // replay
      controller.enqueue(encoder.encode(": connected\n\n"));

      let subs = logSubscribers.get(tenantId);
      if (!subs) {
        subs = new Set();
        logSubscribers.set(tenantId, subs);
      }
      subs.add(send);

      // Proxies and load balancers drop idle streams; a comment frame keeps it warm.
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          unsubscribe();
        }
      }, 25_000);
      keepAlive.unref?.();

      unsubscribe = () => {
        clearInterval(keepAlive);
        const set = logSubscribers.get(tenantId);
        set?.delete(send);
        if (set && set.size === 0) logSubscribers.delete(tenantId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", unsubscribe);
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no", // Caddy/proxies must not buffer the stream
    },
  });
}

// ── MCP: Model Context Protocol over HTTP+SSE ─────────────────────
// Exposes the tenant's data to AI agents as a SQL tool, using the MCP HTTP+SSE
// transport (protocol revision 2024-11-05):
//
//   GET  /<tenant>/_admin/mcp/sse       → opens the stream; first event is
//                                         `endpoint`, naming the POST URL
//   POST /<tenant>/_admin/mcp/message   → JSON-RPC 2.0 in, 202 out; the reply
//                                         is pushed down that session's stream
//
// It lives on the _admin plane because ADMIN_SECRET is what authorizes it:
// handleAdmin has already checked the bearer token by the time anything here
// runs, and the plane is CORS-free and unmetered, so a browser can only reach
// it through the Dashboard API's proxy. That also means an MCP endpoint can
// never be shadowed by (or shadow) a tenant resource literally named `mcp`.
//
// The tenant is taken from the URL path and pinned to the session at connect
// time. Nothing in a JSON-RPC message can select a tenant, so multiplexing many
// sessions through one process cannot cross-contaminate their data.

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SQL_TOOL = "execute_sql_query";

interface McpSession {
  tenantId: string;
  send: (message: unknown) => void;
}

const mcpSessions = new Map<string, McpSession>();

const rpcResult = (id: string | number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: string | number, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
/** MCP convention: a tool that failed reports it *in* the result, not as a
 *  transport error, so the model can read the reason and try something else. */
const toolText = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

// ── SQL tool ──────────────────────────────────────────────────────

/** Leading whitespace and comments, so the read-only prefix check can't be
 *  slipped past by hiding the real verb behind a block or `--` comment. */
function stripLeadingNoise(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.trimStart();
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    }
    if (s === before) return s;
  }
}

/**
 * Returns a rejection reason, or null when the statement may run.
 *
 * BOTH read-only layers are load-bearing; neither is decoration.
 *  - `PRAGMA query_only = ON` (set in buildSqlMount) is what actually stops
 *    writes, including ones this check can't see — `WITH x AS (…) DELETE FROM …`
 *    starts with WITH and passes right through here.
 *  - This check is what stops ATTACH, which query_only does NOT block. Without
 *    it an agent could `ATTACH` the Dashboard API's app.sqlite — same box — and
 *    read its users and sessions tables. Verified, not assumed.
 * Requiring SELECT/WITH is therefore a security control, not just a nicer error.
 */
function sqlRejection(sql: string): string | null {
  const head = stripLeadingNoise(sql);
  if (!head) return "The query was empty.";
  if (!/^(select|with)\b/i.test(head))
    return (
      "Only read-only queries are allowed: the statement must start with SELECT or WITH. " +
      "This database is a read-only projection — data is changed through the project's REST API, not here."
    );
  return null;
}

/** Bounded by SQL_MAX_ROWS via lazy iteration, so even a cartesian join stops early. */
function runSqlQuery(mount: SqlMount, sql: string): { rows: unknown[]; truncated: boolean } {
  // prepare(), not query(): query() caches by SQL string, and agent-authored
  // SQL is unbounded in variety — the cache would grow without limit.
  const stmt = mount.db.prepare(sql);
  try {
    const rows: unknown[] = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= SQL_MAX_ROWS) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    return { rows, truncated };
  } finally {
    stmt.finalize();
  }
}

/**
 * Dense one-line description of the mounted database, read back out of SQLite
 * itself (`sqlite_master` + `PRAGMA table_info`) so it describes what is
 * actually queryable rather than what we believe we mounted.
 */
function describeSchema(mount: SqlMount): string {
  const tables = mount.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  const parts = tables.map(({ name }) => {
    const columns = mount.db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as {
      name: string;
      type: string;
    }[];
    return `${name}(${columns.map((c) => `${c.name} ${c.type}`).join(", ")})`;
  });
  if (parts.length === 0)
    return "This project currently has no queryable tables — it has no resource files holding JSON objects.";
  const skipped =
    mount.skipped.length > 0
      ? ` Not mounted (no object records to derive columns from): ${mount.skipped.join(", ")}.`
      : "";
  return `Tables available: ${parts.join(", ")}.${skipped}`;
}

async function mcpListTools(tenantId: string) {
  const mount = await getSqlMount(tenantId);
  const schema = mount
    ? describeSchema(mount)
    : "This project could not be loaded, so no tables are available.";
  return {
    tools: [
      {
        name: SQL_TOOL,
        description:
          "Run a single read-only SQL query against this project's data. The project's JSON " +
          "resources are mounted as tables in an in-memory SQLite database, so ordinary SQLite " +
          "syntax works: joins, aggregates, GROUP BY, ORDER BY, CTEs. The statement must start " +
          "with SELECT or WITH; writes are rejected. Nested objects and arrays are stored as " +
          "JSON text, so use SQLite's json_extract() to read inside them. Password hashes are " +
          `never mounted. At most ${SQL_MAX_ROWS} rows are returned per call.\n\n${schema}`,
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "A single read-only SQL statement, e.g. SELECT * FROM posts LIMIT 10",
            },
          },
          required: ["sql"],
        },
      },
    ],
  };
}

async function mcpCallTool(tenantId: string, params: any) {
  const name = params?.name;
  if (name !== SQL_TOOL)
    return toolText(
      `There is no tool named ${JSON.stringify(name ?? null)}. The only available tool is ${SQL_TOOL}.`,
      true,
    );
  const sql = params?.arguments?.sql;
  if (typeof sql !== "string" || !sql.trim())
    return toolText("`sql` must be a non-empty string containing one SQL statement.", true);
  if (sql.length > SQL_MAX_QUERY_CHARS)
    return toolText(`The query is too long (limit ${SQL_MAX_QUERY_CHARS} characters).`, true);

  const rejection = sqlRejection(sql);
  if (rejection) return toolText(rejection, true);

  // Lazy mount: the projection may have been dropped by the idle timer, by a
  // write, or by tenant eviction — rebuilding it is what makes that safe.
  const mount = await getSqlMount(tenantId);
  if (!mount) return toolText("This project no longer exists.", true);

  try {
    const { rows, truncated } = runSqlQuery(mount, sql);
    return toolText(JSON.stringify({ rowCount: rows.length, truncated, rows }, null, 2));
  } catch (e) {
    // SQLite's own message ("no such table: postz") is the most useful thing we
    // can hand a model — it is about the query, and leaks nothing else.
    return toolText(`SQL error: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────

/** Returns the reply to push, or null for notifications (which get none). */
async function handleRpc(tenantId: string, message: unknown): Promise<object | null> {
  const msg = message as any;
  const shaped = msg !== null && typeof msg === "object" && !Array.isArray(msg);
  const id = shaped && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
  if (!shaped || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return id === null ? null : rpcError(id, -32600, "invalid JSON-RPC request");

  const method: string = msg.method;
  if (method.startsWith("notifications/")) return null;
  if (id === null) return null; // a request without an id is a notification

  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `stubbase/${tenantId}`, version: "1.0.0" },
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, await mcpListTools(tenantId));
      case "tools/call":
        return rpcResult(id, await mcpCallTool(tenantId, msg.params));
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    console.error(`[core] mcp ${method} failed for ${tenantId}:`, e);
    return rpcError(id, -32603, "internal error");
  }
}

// ── Transport ─────────────────────────────────────────────────────

function openMcpStream(req: Request, tenantId: string): Response {
  // RAM guard for the 1GB box, same spirit as MAX_ACTIVE_TENANTS: MCP streams
  // are held open indefinitely by design, so they need a ceiling.
  if (mcpSessions.size >= MCP_MAX_SESSIONS) return err(503, "too many MCP sessions");

  const sessionId = crypto.randomUUID();
  const encoder = new TextEncoder();
  let teardown = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const frame = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          teardown(); // client vanished mid-write
        }
      };

      // MCP HTTP+SSE requires this to be the first event on the stream: it tells
      // the client where to POST its JSON-RPC messages for *this* session.
      frame(`event: endpoint\ndata: /${tenantId}/_admin/mcp/message?sessionId=${sessionId}\n\n`);

      mcpSessions.set(sessionId, {
        tenantId, // pinned here, from the path — never read from a message
        send: (message) => frame(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
      });

      // Proxies drop idle streams; a comment frame keeps it warm.
      const keepAlive = setInterval(() => frame(": ping\n\n"), 25_000);
      keepAlive.unref?.();

      teardown = () => {
        clearInterval(keepAlive);
        mcpSessions.delete(sessionId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", teardown);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no", // Caddy/proxies must not buffer the stream
    },
  });
}

async function handleMcp(req: Request, tenantId: string, segments: string[]): Promise<Response> {
  if (segments.length !== 1) return err(404, "unknown mcp route");

  if (segments[0] === "sse") {
    if (req.method !== "GET") return err(405, "method not allowed");
    return openMcpStream(req, tenantId);
  }

  if (segments[0] !== "message") return err(404, "unknown mcp route");
  if (req.method !== "POST") return err(405, "method not allowed");

  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  const session = mcpSessions.get(sessionId);
  // Tenant isolation: a session id only works under the tenant it was opened
  // for, so one project's id can never be replayed against another's data.
  if (!session || session.tenantId !== tenantId) return err(404, "unknown mcp session");

  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const batch = Array.isArray(body) ? body : [body];
  if (batch.length === 0 || batch.length > 20)
    return err(400, "a JSON-RPC batch must hold between 1 and 20 messages");

  for (const message of batch) {
    // session.tenantId, not the path variable: the binding made at connect time
    // is the one thing that decides whose data gets queried.
    const reply = await handleRpc(session.tenantId, message);
    if (reply) session.send(reply);
  }
  // MCP HTTP+SSE: the POST is only an inbox; replies travel on the stream.
  return json({ ok: true }, 202);
}

// ── Admin plane: POST|DELETE /<tenant>/_admin/files/<resource> ────

async function handleAdmin(
  req: Request,
  tenantId: string,
  segments: string[],
): Promise<Response> {
  if (!isAdminAuthorized(req)) return err(401, "unauthorized");

  // /<tenant>/_admin/mcp/{sse,message} — Model Context Protocol transport
  if (segments[0] === "mcp") return handleMcp(req, tenantId, segments.slice(1));

  // GET /<tenant>/_admin/sse-logs — live request-log stream
  if (segments[0] === "sse-logs" && segments.length === 1) {
    if (req.method !== "GET") return err(405, "method not allowed");
    return streamLogs(req, tenantId);
  }

  // GET /<tenant>/_admin/logs — one-shot snapshot of the same ring, newest
  // last. The AI Co-Pilot's diagnostics tool needs to *read* recent traffic
  // inside a single request; holding an SSE stream open just to collect the
  // replay frames would leak a subscriber on every tool call.
  if (segments[0] === "logs" && segments.length === 1) {
    if (req.method !== "GET") return err(405, "method not allowed");
    const ring = tenantLogs.get(tenantId) ?? [];
    const limit = Math.min(
      Math.max(Number(new URL(req.url).searchParams.get("_limit")) || LOG_CAP, 1),
      LOG_CAP,
    );
    return json({ tenant: tenantId, entries: ring.slice(-limit) });
  }

  // POST /<tenant>/_admin/flush — drop the RAM cache; next request lazy-loads disk
  if (segments[0] === "flush" && segments.length === 1) {
    if (req.method !== "POST") return err(405, "method not allowed");
    evict(tenantId);
    return json({ ok: true, tenant: tenantId, flushed: true });
  }

  // POST /<tenant>/_admin/deploy — promote every draft_<name>.json over <name>.json.
  // Lives here (not the dashboard) because only the core may write TENANTS_DIR.
  if (segments[0] === "deploy" && segments.length === 1) {
    if (req.method !== "POST") return err(405, "method not allowed");
    let entries: string[];
    try {
      entries = await readdir(tenantDir(tenantId));
    } catch {
      return err(404, "tenant not found");
    }
    const promoted: string[] = [];
    for (const f of entries) {
      if (!f.startsWith("draft_") || !f.endsWith(".json")) continue;
      const target = f.slice("draft_".length, -".json".length);
      if (!NAME_RE.test(target)) continue;
      await Bun.write(resourceFile(tenantId, target), Bun.file(join(tenantDir(tenantId), f)));
      promoted.push(target);
    }
    evict(tenantId); // CRITICAL: flush cache so the promoted files go live now
    return json({ ok: true, tenant: tenantId, promoted });
  }

  if (segments[0] !== "files" || !segments[1] || segments.length > 2)
    return err(404, "unknown admin route");
  const resource = segments[1];
  if (!NAME_RE.test(resource)) return err(400, "invalid resource name");
  const file = resourceFile(tenantId, resource);

  // Read-only, disk is authoritative (write-through) — no evict needed.
  // Exists so the dashboard can read files the public plane hides (config).
  if (req.method === "GET") {
    const f = Bun.file(file);
    if (!(await f.exists())) return err(404, "resource file not found");
    try {
      return json(await f.json());
    } catch {
      return err(500, "file is not valid JSON");
    }
  }

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    // `config` holds the tenant's env-style settings object; everything else is a record array
    const initial = body ?? (isConfigFile(resource) ? {} : []);
    if (isConfigFile(resource)) {
      if (initial === null || typeof initial !== "object" || Array.isArray(initial))
        return err(400, "config must be a JSON object");
    } else if (!Array.isArray(initial)) {
      return err(400, "initial data must be a JSON array");
    }
    await mkdir(tenantDir(tenantId), { recursive: true });
    await Bun.write(file, JSON.stringify(initial, null, 2));
    evict(tenantId); // CRITICAL: flush cache; next request lazy-loads fresh disk state
    const records = Array.isArray(initial) ? initial.length : Object.keys(initial).length;
    return json({ ok: true, tenant: tenantId, resource, records }, 201);
  }

  if (req.method === "DELETE") {
    if (!(await Bun.file(file).exists())) return err(404, "resource file not found");
    await rm(file);
    evict(tenantId); // CRITICAL: flush cache
    return json({ ok: true, tenant: tenantId, resource, deleted: true });
  }

  return err(405, "method not allowed");
}

// ── Query processing (GET collections) ────────────────────────────
// Filtering (?field=value), sorting (?_sort=&_order=), pagination
// (?_page=&_limit= or ?_offset=&_limit=) and relation expansion (?_expand=).
// Everything runs in memory over the tenant's arrays.

/** Missing values sort last (ascending); numbers numerically, strings naturally. */
function compareValues(a: unknown, b: unknown): number {
  const aEmpty = a === undefined || a === null;
  const bEmpty = b === undefined || b === null;
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const singularize = (n: string) =>
  n.endsWith("ies") ? `${n.slice(0, -3)}y` : n.endsWith("ss") || !n.endsWith("s") ? n : n.slice(0, -1);

interface Expansion {
  resource: string; // the array to look in (users)
  key: string; // where the record is nested (user)
  fk: string; // the field holding the id (userId)
}

/** `?_expand=users` (or `user`) → nest users.json[userId] under `user`. */
function parseExpansions(params: URLSearchParams, state: TenantState): Expansion[] {
  const names = params
    .getAll("_expand")
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Expansion[] = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const singular = singularize(name);
    const resource = state.db[name] ? name : state.db[`${singular}s`] ? `${singular}s` : null;
    if (!resource || isPrivateFile(resource)) continue;
    if (!out.some((e) => e.resource === resource))
      out.push({ resource, key: singular, fk: `${singular}Id` });
  }
  return out;
}

function expandRow(row: any, expansions: Expansion[], state: TenantState): any {
  if (!row || typeof row !== "object" || Array.isArray(row) || expansions.length === 0) return row;
  let out = row;
  for (const { resource, key, fk } of expansions) {
    const fkValue = row[fk];
    if (fkValue === undefined || fkValue === null) continue;
    const match = state.db[resource]?.find((r) => String(r?.id) === String(fkValue));
    if (out === row) out = { ...row }; // copy-on-write: never mutate the cached record
    // an expanded users record still carries passwordHash — strip it here too
    out[key] =
      match && resource === "users" && state.config.authEnabled ? safeUser(match) : (match ?? null);
  }
  return out;
}

// ── Middleware pipeline ───────────────────────────────────────────
// Every CRUD request flows through PIPELINE in order. A middleware that
// returns a Response aborts the chain (guard rejected the request);
// coreOperation instead stores its result in ctx.response so stages after
// it (after-hooks) still run before the response is sent.

interface Ctx {
  req: Request;
  url: URL;
  tenantId: string;
  resource: string;
  id: string | undefined;
  state: TenantState;
  body?: unknown; // parsed once in handleCrud — webhooks and coreOperation both need it
  user?: JwtClaims;
  result?: unknown; // record produced by coreOperation, for after-hooks
  response?: Response;
  log?: LogDraft; // lifecycle scratchpad; stages may push notes onto log.lifecycle
}
/** Returned by a middleware that has already set ctx.response and wants the
 *  remaining stages skipped (vs. returning a Response, which aborts outright). */
const SKIP_REST = Symbol("skip-rest");
type MwResult = Response | typeof SKIP_REST | void;
type Middleware = (ctx: Ctx) => Promise<MwResult> | MwResult;

// 503 for stopped/maintenance tenants. Used by statusGuard (first pipeline
// stage) and by every non-CRUD tenant surface (auth, notify, openapi) — the
// whole public plane goes dark together; only _admin stays reachable.
function statusBlocked(state: TenantState): Response | null {
  const s = state.config.projectStatus;
  if (s === "active") return null;
  return json({ error: "service unavailable", projectStatus: s }, 503);
}

const statusGuard: Middleware = (ctx) => statusBlocked(ctx.state) ?? undefined;

const authGuard: Middleware = (ctx) => {
  const cfg = ctx.state.config;
  if (!cfg.authEnabled) return;
  if (ctx.req.method === "GET" && cfg.publicRoutes.has(ctx.resource)) return;
  const header = ctx.req.headers.get("authorization") ?? "";
  const claims = header.startsWith("Bearer ") ? verifyJwt(ctx.tenantId, header.slice(7)) : null;
  if (!claims) return err(401, "valid bearer token required");
  ctx.user = claims; // claims.role === "admin" lets later middleware bypass ownership checks
};

// QA Chaos Engine: simulate latency, forced statuses, flakiness and empty
// states from the client. Strictly gated on QA_MODE=true — without it every
// x-stubbase-* header is ignored, so a production tenant can't be knocked
// over by anyone who guesses the header names.
const chaosGuard: Middleware = async (ctx) => {
  if (!ctx.state.config.qaMode) return;
  const h = (name: string) => ctx.req.headers.get(`x-stubbase-${name}`);

  const delay = Number(h("delay"));
  if (Number.isFinite(delay) && delay > 0) await Bun.sleep(Math.min(delay, MAX_CHAOS_DELAY_MS));

  const status = Number(h("status"));
  if (Number.isInteger(status) && status >= 100 && status <= 599)
    return new Response(null, { status });

  const rate = Number(h("error-rate"));
  if (Number.isFinite(rate) && rate > 0 && Math.random() < rate)
    return json({ error: "Simulated Flakiness" }, 503);

  if (h("empty")?.toLowerCase() === "true" && ctx.req.method === "GET") {
    ctx.response = json(ctx.id === undefined ? [] : null);
    return SKIP_REST; // bypass the RAM cache entirely
  }
};

// Body validation against the resource's JSON Schema (config.resources.<name>
// .schema, or SCHEMA_<RESOURCE>). Runs before webhooks so a malformed payload
// never reaches an external hook.
const validationGuard: Middleware = (ctx) => {
  if (ctx.req.method !== "POST" && ctx.req.method !== "PUT") return;
  const schema = ctx.state.config.schemas[ctx.resource];
  if (!schema) return;
  if (ctx.body === null || ctx.body === undefined || typeof ctx.body !== "object" || Array.isArray(ctx.body))
    return err(400, "body must be a JSON object");
  const errors = validateSchema(ctx.body, schema);
  if (errors.length > 0) return json({ error: "validation failed", errors }, 400);
};

// Webhooks: HOOK_<BEFORE|AFTER>_<INSERT|UPDATE|DELETE>_<RESOURCE> config keys
// (resource uppercased, non-alphanumerics → "_"). Before-hooks are synchronous
// gates — non-200 aborts the mutation; after-hooks fire and forget.

const HOOK_ACTION: Record<string, string> = { POST: "INSERT", PUT: "UPDATE", DELETE: "DELETE" };

function hookTarget(ctx: Ctx, phase: "BEFORE" | "AFTER"): string | undefined {
  const action = HOOK_ACTION[ctx.req.method];
  if (!action) return undefined;
  const key = `HOOK_${phase}_${action}_${ctx.resource.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  return ctx.state.config.hooks[key];
}

const hookPayload = (ctx: Ctx, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tenant: ctx.tenantId,
    resource: ctx.resource,
    action: HOOK_ACTION[ctx.req.method],
    id: ctx.id ?? null,
    payload: ctx.body ?? null,
    ...extra,
  });

const beforeWebhookGuard: Middleware = async (ctx) => {
  const target = hookTarget(ctx, "BEFORE");
  if (!target) return;
  const blocked = await hookUrlBlocked(target);
  if (blocked) return err(502, `before-hook URL not allowed: ${blocked}`);
  try {
    const res = await fetch(target, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: hookPayload(ctx),
    });
    if (res.status !== 200) return err(422, `before-hook rejected the request (status ${res.status})`);
  } catch {
    return err(502, "before-hook unreachable");
  }
};

// Runs only after a successful coreOperation (failures abort the chain earlier)
const afterWebhookGuard: Middleware = (ctx) => {
  const target = hookTarget(ctx, "AFTER");
  if (!target) return;
  const body = hookPayload(ctx, { result: ctx.result ?? null });
  void (async () => {
    const blocked = await hookUrlBlocked(target);
    if (blocked) return console.warn(`[core] after-hook skipped for ${ctx.tenantId}: ${blocked}`);
    await fetch(target, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body,
    }).catch((e) => console.warn(`[core] after-hook failed for ${ctx.tenantId}: ${e}`));
  })();
};

const coreOperation: Middleware = async (ctx) => {
  const { req, url, state, tenantId, resource, id } = ctx;
  const rows = state.db[resource];
  if (!rows) return err(404, "resource not found");
  // identity-table records carry passwordHash — it must never leave the server
  const sanitize =
    resource === "users" && state.config.authEnabled
      ? (r: any) => (r && typeof r === "object" ? safeUser(r) : r)
      : (r: any) => r;

  // Ownership (RBAC): a record with a userId belongs to that user. Admins
  // bypass; records without userId (uploaded datasets) stay open to any
  // authenticated user. On `users`, your own row is the one you may mutate.
  const isAdmin = ctx.user?.role === "admin";
  const mayMutate = (row: any) => {
    const u = ctx.user;
    if (!state.config.authEnabled || !u || isAdmin) return true;
    if (resource === "users") return String(row?.id) === u.sub;
    const owner = row && typeof row === "object" && "userId" in row ? String(row.userId) : null;
    return owner === null || owner === u.sub;
  };

  if (req.method === "GET") {
    const params = url.searchParams;
    const expansions = parseExpansions(params, state);

    if (id === undefined) {
      // 1. filter — every non-underscore param is an exact-match field filter
      let out = rows;
      for (const [k, v] of params) {
        if (k.startsWith("_")) continue;
        out = out.filter((row) => String(row?.[k]) === v);
      }

      // 2. sort — on a copy, so the cached array keeps its insertion order
      const sortKeys = (params.get("_sort") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (sortKeys.length > 0) {
        const orders = (params.get("_order") ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase());
        out = out.slice().sort((a, b) => {
          for (let i = 0; i < sortKeys.length; i++) {
            const dir = (orders[i] ?? orders[0] ?? "asc") === "desc" ? -1 : 1;
            const c = compareValues(a?.[sortKeys[i]], b?.[sortKeys[i]]);
            if (c !== 0) return c * dir;
          }
          return 0;
        });
      }

      // 3. paginate — _page is 1-based (defaults to 10 per page); _offset is
      //    the raw-index alternative. Total goes out as X-Total-Count.
      const total = out.length;
      const rawLimit = Number(params.get("_limit"));
      const hasLimit = Number.isFinite(rawLimit) && rawLimit > 0;
      const rawPage = Number(params.get("_page"));
      let start = Math.max(0, Number(params.get("_offset") ?? 0) || 0);
      let count = hasLimit ? Math.floor(rawLimit) : total;
      if (Number.isFinite(rawPage) && rawPage >= 1) {
        count = hasLimit ? Math.floor(rawLimit) : 10;
        start = (Math.floor(rawPage) - 1) * count;
      }
      out = out.slice(start, start + count);

      // 4. expand relations, then sanitize
      const body = out.map((row) => sanitize(expandRow(row, expansions, state)));
      const res = json(body);
      res.headers.set("x-total-count", String(total));
      ctx.response = res;
      return;
    }

    const row = rows.find((r) => String(r?.id) === id);
    if (!row) return err(404, "record not found");
    ctx.response = json(sanitize(expandRow(row, expansions, state)));
    return;
  }

  if (req.method === "POST" && id === undefined) {
    const body = ctx.body;
    if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body))
      return err(400, "body must be a JSON object");
    const record: Record<string, any> = { id: crypto.randomUUID(), ...(body as object) };
    if (state.config.authEnabled && ctx.user && resource !== "users" && !("userId" in record))
      record.userId = ctx.user.sub; // stamp ownership
    if (rows.some((r) => String(r?.id) === String(record.id)))
      return err(409, "record with this id already exists");
    rows.push(record);
    await persist(state, tenantId, resource);
    ctx.result = record;
    ctx.response = json(sanitize(record), 201);
    return;
  }

  if (req.method === "PUT" && id !== undefined) {
    const body = ctx.body;
    if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body))
      return err(400, "body must be a JSON object");
    const idx = rows.findIndex((r) => String(r?.id) === id);
    if (idx === -1) return err(404, "record not found");
    const prev = rows[idx];
    if (!mayMutate(prev)) return err(403, "forbidden: not the record owner");
    const record: Record<string, any> = { ...(body as object), id: prev.id };
    const prevObj = prev && typeof prev === "object" ? (prev as Record<string, any>) : null;
    if (prevObj && !isAdmin && state.config.authEnabled) {
      if (resource === "users") {
        record.role = prevObj.role; // non-admins cannot grant themselves roles
        if (!("passwordHash" in record) && "passwordHash" in prevObj)
          record.passwordHash = prevObj.passwordHash;
      } else if ("userId" in prevObj) {
        record.userId = prevObj.userId; // ownership cannot be reassigned
      }
    }
    rows[idx] = record;
    await persist(state, tenantId, resource);
    ctx.result = record;
    ctx.response = json(sanitize(record));
    return;
  }

  if (req.method === "DELETE" && id !== undefined) {
    const idx = rows.findIndex((r) => String(r?.id) === id);
    if (idx === -1) return err(404, "record not found");
    if (!mayMutate(rows[idx])) return err(403, "forbidden: not the record owner");
    const [removed] = rows.splice(idx, 1);
    await persist(state, tenantId, resource);
    ctx.result = removed;
    ctx.response = json(sanitize(removed));
    return;
  }

  return err(405, "method not allowed");
};

const PIPELINE: Middleware[] = [
  statusGuard,
  authGuard,
  chaosGuard,
  validationGuard,
  beforeWebhookGuard,
  coreOperation,
  afterWebhookGuard,
];

async function handleCrud(
  req: Request,
  url: URL,
  tenantId: string,
  resource: string,
  id: string | undefined,
  log?: LogDraft,
): Promise<Response> {
  const state = await getTenant(tenantId);
  if (!state) return err(404, "tenant not found");
  const ctx: Ctx = { req, url, tenantId, resource, id, state, log };
  if (req.method === "POST" || req.method === "PUT") {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    ctx.body = body;
    if (log) log.requestBody = JSON.stringify(body) ?? null;
  }
  // Each stage is timed and recorded. A stage that returns a Response rejected
  // the request, so its step is marked failed — that is what the Lifecycle view
  // highlights in red.
  for (const mw of PIPELINE) {
    const startedAt = performance.now();
    const outcome = await mw(ctx);
    if (log) {
      const step: LifecycleStep = {
        stage: mw.name || "stage",
        ok: !(outcome instanceof Response),
        ms: Math.round(performance.now() - startedAt),
      };
      if (outcome instanceof Response) step.note = `rejected with ${outcome.status}`;
      else if (outcome === SKIP_REST) step.note = "short-circuited remaining stages";
      log.lifecycle.push(step);
    }
    if (outcome === SKIP_REST) break;
    if (outcome) return outcome;
  }
  return ctx.response ?? err(500, "pipeline produced no response");
}

// ── CORS ──────────────────────────────────────────────────────────
// The public CRUD surface is meant to be fetched from any browser frontend,
// so it answers with permissive CORS; its preflight allows `authorization`
// because tenant-auth JWTs ride that header. The admin plane is
// server-to-server (dashboard backend only) and deliberately gets no CORS
// headers — and its preflight's allow-headers still omits `authorization`,
// so browsers won't send admin credentials cross-origin.

function cors(res: Response): Response {
  res.headers.set("access-control-allow-origin", "*");
  // pagination total and the log correlation id must be readable cross-origin
  res.headers.set("access-control-expose-headers", "X-Total-Count, X-Correlation-Id");
  return res;
}

function preflight(isAdmin: boolean): Response {
  const res = new Response(null, { status: 204 });
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  // Public preflight allows tenant JWTs and the QA simulation headers; the
  // admin plane deliberately allows neither.
  res.headers.set(
    "access-control-allow-headers",
    isAdmin
      ? "content-type"
      : "content-type, authorization, x-stubbase-delay, x-stubbase-status, x-stubbase-error-rate, x-stubbase-empty",
  );
  res.headers.set("access-control-max-age", "86400");
  return res;
}

// ── Server ────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (req.method === "OPTIONS") return preflight(segments[1] === "_admin");

    if (segments.length === 0)
      return cors(json({ service: "stubbase-core", activeTenants: activeTenants.size }));

    const [tenantId, second, ...rest] = segments;
    if (!NAME_RE.test(tenantId)) return cors(err(400, "invalid tenant id"));

    if (second === "_admin") return handleAdmin(req, tenantId, rest); // no CORS, not metered: internal

    // Everything below is public-plane traffic, so it is metered for usage and
    // recorded in the tenant's live log ring.
    const draft = newLogDraft();
    const done = (res: Response) => finishLog(tenantId, req, url, draft, meter(tenantId, cors(res)));
    /** Non-CRUD surfaces have no middleware chain — record the handler itself. */
    const single = (stage: string, res: Response) => {
      draft.lifecycle.push({
        stage,
        ok: res.status < 400,
        ms: Math.round(performance.now() - draft.startedAt),
      });
      return done(res);
    };

    if (second === "auth") return single("auth", await handleAuth(req, tenantId, rest));
    if (second === "_notify") return single("notify", await handleNotify(req, tenantId, rest));
    if (second === "openapi.json" && rest.length === 0)
      return single("openapi", await handleOpenApi(req, tenantId));

    // Blacklist runs before NAME_RE so protected names answer 403, not 400.
    // Internal planes (_admin, _notify, auth, openapi.json) are dispatched above.
    if (second && isProtectedResource(second))
      return single("blacklist", err(403, "forbidden: protected resource"));
    if (!second || !NAME_RE.test(second)) return single("route", err(400, "invalid resource name"));
    if (rest.length > 1) return single("route", err(404, "not found"));
    return done(await handleCrud(req, url, tenantId, second, rest[0], draft));
  },
  error(e) {
    console.error("[core] unhandled:", e);
    return cors(err(500, "internal error"));
  },
});

console.log(
  `[core] listening on :${server.port} — tenants dir: ${TENANTS_DIR}, idle TTL: ${IDLE_TTL_MS}ms`,
);
