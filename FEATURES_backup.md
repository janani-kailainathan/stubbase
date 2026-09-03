# Features

Two groups, split by who the feature belongs to.

- **[User-level features](#1-user-level-features--the-api-you-create)** — what a
  *project's* API can do. These are per-tenant behaviours, configured through
  `config.json` and served by the Core Engine (`apps/core/server-core.ts`) to
  whoever calls the tenant's endpoints.
- **[App-level features](#2-app-level-features--the-stubbase-platform)** — what
  *Stubbase itself* does: accounts, the dashboard, the Co-Pilot, metering,
  keys, and the site around them.

Reference docs: [README.md](README.md) (architecture + API),
[ENVIRONMENT.md](ENVIRONMENT.md) (every knob), [PRODUCT.md](PRODUCT.md)
(positioning and what is deliberately not built yet).

---

## 1. User-level features — the API you create

Everything here is scoped to one tenant (`/<tenant>/…`) and is off by default:
an absent `config.json` means plain, open CRUD.

### 1.1 JSON-to-CRUD

One JSON array per file (`/tenants/<tenant>/<resource>.json`) becomes a REST
resource. Data lazy-loads into RAM on first request, every mutation writes
through to disk immediately, and idle tenants are evicted after 5 minutes.

```
GET    /<tenant>/<resource>          list
GET    /<tenant>/<resource>/<id>     read
POST   /<tenant>/<resource>          create (id auto-generated if omitted)
PUT    /<tenant>/<resource>/<id>     replace (id preserved)
DELETE /<tenant>/<resource>/<id>     delete
```

### 1.2 Query surface

Composable in a fixed order — filter → sort → paginate → expand.

| Feature | Example | Notes |
|---|---|---|
| Exact-match filter | `?category=shoes&status=active` | any record field |
| Sort | `?_sort=price&_order=desc` | comma-separated fields; `asc` default |
| Page pagination | `?_page=2&_limit=10` | 1-based, 10 per page by default |
| Offset pagination | `?_offset=20&_limit=10` | raw-index alternative |
| Relational expand | `?_expand=users` | nests the record referenced by `<name>Id` |
| Total count | — | unpaginated total in the `X-Total-Count` header |

Records are heterogeneous — there is no schema to migrate, and fields that
exist on only some records still filter and sort.

### 1.3 Auto-generated OpenAPI

`GET /<tenant>/openapi.json` returns an OpenAPI 3.0 spec inferred from the
project's live resources. Not plan-gated — every project gets it.

### 1.4 End-user auth (`AUTH_*`)

Turns `users.json` into the project's identity table.

- `AUTH_ENABLED` — master switch; all CRUD then requires a `Bearer` JWT.
- `POST /<tenant>/auth/signup` and `/auth/login`.
- `AUTH_PUBLIC_ROUTES` — resources that still allow anonymous `GET`.
- `AUTH_JWT_TTL_SECONDS` — token lifetime (default 24 h).
- Social sign-in per project: `AUTH_GOOGLE_*` / `AUTH_GITHUB_*` light up
  `GET /<tenant>/auth/google|github[/callback]`; `AUTH_OAUTH_REDIRECT` sends the
  browser back to the tenant's own app with `#token=<jwt>`.

Signing keys are *derived* from `ADMIN_SECRET` per tenant — never stored on
disk — and `passwordHash` is stripped from every response path.

### 1.5 Ownership and roles (RBAC)

Authenticated `POST`s stamp `userId` on the record. A non-admin may mutate only
records they own (plus their own `users` row) and cannot change `role`, drop
their `passwordHash`, or reassign `userId`. A `"role": "admin"` user bypasses
the ownership check.

### 1.6 Request validation

`SCHEMA_<RESOURCE>` holds a JSON Schema (as a one-line string) validating
`POST`/`PUT` bodies; failures return `400` with a per-field error list.
Supported: `type`, `required`, `properties`, `additionalProperties`, `enum`,
`const`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `items`,
`minItems`/`maxItems` — a small built-in checker, since the backends carry zero
npm dependencies.

### 1.7 QA Chaos Engine

Deterministic failure on demand, gated behind `QA_MODE=true` so nobody who
guesses the header names can disrupt a production tenant.

| Header | Example | Effect |
|---|---|---|
| `x-stubbase-delay` | `1500` | sleep N ms before handling (capped) |
| `x-stubbase-status` | `500` | return that status; the operation never runs |
| `x-stubbase-error-rate` | `0.3` | 30% of requests return `503` |
| `x-stubbase-empty` | `true` | `GET` returns `[]` / `null` |

Chaos runs *after* auth, so simulation can never bypass authentication.

### 1.8 Webhooks

- `HOOK_BEFORE_<ACTION>_<RESOURCE>` — synchronous gate; any non-200 aborts the
  mutation with `422`.
- `HOOK_AFTER_<ACTION>_<RESOURCE>` — fire-and-forget, includes the resulting
  record.

`<ACTION>` is `INSERT` / `UPDATE` / `DELETE`. URLs are DNS-resolved and refused
if they point at private or reserved addresses (SSRF guard).

### 1.9 Notification proxy

`POST /<tenant>/_notify/email` (Resend) and `/_notify/sms` (Twilio), both
requiring a valid end-user JWT. The provider credentials live in the tenant's
`config.json` and stay server-side, so the tenant's frontend never holds them.

### 1.10 Virtual start / stop

`PROJECT_STATUS=stopped|maintenance` makes the entire public surface — CRUD,
auth, notify and `openapi.json` — answer `503` with a machine-readable body.
Admin access stays open, so a stopped project can always be started again.

### 1.11 SQL over MCP (agent access)

The tenant's JSON resources are mounted into a **read-only in-memory SQLite
projection**, exposed to AI agents over the Model Context Protocol (HTTP+SSE)
as a single `execute_sql_query` tool. Real joins, aggregates and CTEs instead of
paging the REST API; `tools/list` injects the live table/column list into the
tool description so the model does not have to guess the schema.

- The JSON files stay authoritative — the projection is rebuilt (~1ms) whenever
  data changes, so SQL always reads current data and every write still goes
  through the CRUD pipeline.
- Reads only: statements must start with `SELECT` or `WITH`, and the connection
  runs under `PRAGMA query_only`.
- Columns are the union of keys across *all* records; nested values are JSON
  text (`json_extract()`).
- `passwordHash`, `config` and `draft_*` are never mounted.

### 1.12 Request pipeline and observability

Every CRUD request flows through one middleware pipeline —
`statusGuard → authGuard → chaosGuard → validationGuard → beforeWebhookGuard →
coreOperation → afterWebhookGuard` — so the stub behaves like the backend it
stands in for. Every public response carries an `x-correlation-id` and lands in
a capped in-RAM request log (nothing written to disk) that the owner watches
live from the dashboard.

Public CRUD is CORS-open (`Access-Control-Allow-Origin: *`) so a browser app can
call it directly; the admin plane sends no CORS headers at all.

---

## 2. App-level features — the Stubbase platform

Everything here belongs to Stubbase itself: the dashboard, its API, and the
marketing site.

### 2.1 Accounts and sign-in

- Email/password signup and login — argon2id via `Bun.password`, opaque bearer
  session tokens stored sha256-hashed with a TTL.
- Social sign-in with **Google** and **GitHub** (`DASHBOARD_GOOGLE_*` /
  `DASHBOARD_GITHUB_*`); `GET /auth/providers` tells the SPA which buttons to
  render, so an unconfigured provider simply does not appear.
- **Google One Tap** on the landing page — the one non-static path on the apex,
  because `g_csrf_token` is host-only. The Google script is fetched only when
  there is a prompt to show.
- Identities link to an existing account by **verified** email; an unverified
  address is refused on every path.
- Sessions never cross origins as a credential: only a theme cookie and a
  no-authority `stubbase_session` *hint* are shared between `stubbase.dev` and
  `app.stubbase.dev`.

### 2.2 Projects

Create, rename and delete projects; each provisions a tenant on the Core Engine.
`ADMIN_SECRET` never reaches a browser — every file write is proxied through the
authenticated Dashboard API, which keeps the project's resource list in sync
with what it creates and deletes.

### 2.3 JSON resource editor

A CodeMirror editor over each resource file, plus starter examples that seed a
real, queryable dataset in one click (each shipped starter has its advertised
query verified by the regression suite).

### 2.4 Draft-then-deploy

Dashboard writes land in `draft_<name>.json` and are never served. `Deploy`
promotes every draft over its live file and evicts the tenant, so an edit goes
live atomically with no downtime — and a half-finished schema never reaches
callers.

### 2.5 Environment / config editor

A simulated `.env` editor that compiles `KEY=value` text into the tenant's
`config.json` (keeping comments and ordering under `__raw`). This is where every
user-level feature in section 1 is turned on.

### 2.6 Live request logs

`GET /projects/<id>/live-logs` proxies the core's admin SSE stream after an
ownership check, streaming unbuffered and tearing the upstream subscriber down
when the tab closes. The SPA consumes it with `fetch` + `ReadableStream`, so the
session token rides an `Authorization` header instead of the query string.

### 2.7 Diagnostics

`GET /projects/<id>/diagnostics` reports JSON files that fail to parse — live
resources, their drafts, and `config` — read over the core's admin files plane.

### 2.8 Usage metering and quotas

The core counts public-plane responses in RAM and flushes them to the Dashboard
API. The Dashboard API answers with one allowance per tenant, and the core
serves until `used >= limit`, then `429`s the whole public plane with the admin
plane still reachable so the owner can see why.

- The core is **plan-blind** — it only ever sees a number.
- Deliberately **fail-open**: a tenant that has never been quoted a limit is
  served, because breaking a customer's CI over a metering hiccup is worse than
  over-serving for a minute.
- Counters survive tenant eviction, and a failed flush folds its counts back in.

### 2.9 Plans and entitlements

`PLANS` in the Dashboard API is the single source of truth; an unknown plan
string reads as Free, never as unlimited.

| Plan | Requests/month | Unlocks |
|---|---|---|
| Free | 5,000 | — |
| Pro QA | 50,000 | chaos, auth |
| Pro + AI | 250,000 | chaos, auth, webhooks, AI Co-Pilot |

Features are gated at **write time** (turning one on means writing
`config.json`, and this service is its only reachable writer) and re-checked at
**deploy time**; the request allowance is gated at request time in the core.
Turning a key *off* is always allowed, so an account can always remove what it
is no longer entitled to — and config a tenant already has live is never
silently ignored, because un-protecting a live API is not a safe way to enforce
a downgrade. Off-plan controls in the SPA are disabled with an explanation, not
hidden.

> **Not shipped:** there is no payment gateway. Plans are set with SQL
> (`UPDATE users SET plan = …`), and the pricing page marks the two paid tiers
> as not yet purchasable. See [PRODUCT.md](PRODUCT.md).

### 2.10 AI Co-Pilot

An agent loop owned by the Dashboard API (`POST /projects/<id>/ai/chat`): the
provider returns prose or a tool request, this service executes the tool, feeds
the result back and re-asks, bounded by a round limit with a final tool-less
round so a turn always ends in a sentence.

Tools: `stage_schema_drafts`, `deploy_project`, `set_server_status`,
`get_diagnostics`, `delete_resources`.

- The tenant always comes from the authenticated path, never a tool argument.
- Tools run only from a *live* model reply, never from history the browser sent.
- **The agent may not destroy data** — `delete_resources` only returns a pending
  confirmation naming resources that actually exist; the deletion is carried out
  by the user's click.
- Generated table names are validated like any other resource, and results are
  staged as `draft_*` only, so a prompt injection cannot overwrite settings or
  go live unreviewed.
- Provider-agnostic: `apps/dashboard-api/ai/` is pure transport, still with zero
  npm dependencies.

### 2.11 Developer API keys and external agents

Per-project keys (`sk_stub_…`) shown exactly once and stored sha256-hashed, with
list and revoke. They authenticate `GET|POST /projects/<id>/mcp/*`, which proxies
the core's MCP stream — so Claude Desktop, IDEs and other agents reach a project
without `ADMIN_SECRET` ever leaving the server. The dashboard generates the
`mcp-remote` config with the key filled in. Revoking a key, or deleting the
project, invalidates it immediately.

### 2.12 Marketing site

A static Astro site (`stubbase.dev`) built hub-and-spoke: hardcoded hubs (`/`,
`/pricing`) plus Markdown spokes for solutions, roles, use cases, features and
comparisons, all reading one nav source of truth — a new page is one content
file plus one nav entry. Also `/guides` (evergreen how-tos, with committed
out-of-band AI Summary panels) and `/changelog`. Client JS is limited to six
small blocks, every one of which degrades to a working page with JS off, and
the only third-party script is loaded conditionally.

### 2.13 Theming

Both frontends ship light and dark, sharing one token vocabulary so the site and
the app read as one system. The theme is resolved before first paint (no flash),
and the choice follows you across origins via the `stubbase_theme` cookie.

### 2.14 Operations

- Scale-to-zero multi-tenancy: one Bun process serves every tenant, sized for a
  1GB VPS — no container or process per tenant.
- Zero npm dependencies on both backends; Caddy for TLS and static files;
  systemd units sandboxed with `ProtectSystem=strict` and exactly one writable
  path each.
- One-command Ansible deploy (`deploy/deploy.yml`), idempotent and re-runnable.
- A reactor-style build (`scripts/build.ts`) that verifies and tests the
  backends before either site is built, and a black-box regression suite over
  the invariants above.
