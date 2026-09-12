# Environment variables

Every knob in Stubbase, what it does, and where it gets set. There are three
distinct layers — don't confuse them:

1. **Process env** — read by the two Bun backends at startup (`process.env`).
   Set in your shell for dev, in `docker-compose.yml` for the local stack, and
   in the systemd units / `/etc/stubbase/stubbase.env` in production.
2. **Tenant config** — env-*style* keys inside each tenant's `system/config.json`
   (edited as a simulated `.env` in the dashboard UI). These are **not**
   process env; the Core Engine reads them per-tenant, per-request.
3. **Frontend build env** — Vite/Astro variables baked into the static `dist/`
   at build time (`.env.docker` files, or built-in production defaults).

---

## 1a. Core Engine (`apps/core/server-core.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_SECRET` | — **(required, exits if unset)** | Bearer token for the `_admin` plane; also the root key from which per-tenant JWT signing keys are derived (`HMAC(ADMIN_SECRET, "jwt:" + tenantId)`). Rotating it invalidates every tenant's JWTs. Must match the Dashboard API's value. **Never reaches a browser.** |
| `PORT` | `3000` | Listen port. |
| `TENANTS_DIR` | `./tenants` | Root of tenant folders: `<tenant>/data/<resource>.json` (and drafts) for resources, `<tenant>/system/` for `config.json`, `status.json` and feature-owned files (`users.json`, `reset-password.json`). The only writable path in the sandboxed systemd unit. |
| `IDLE_TTL_MS` | `300000` (5 min) | Idle time before a tenant is evicted from RAM (scale-to-zero). Set low to test eviction. |
| `MAX_ACTIVE_TENANTS` | `500` | RAM cap; past it, the least-recently-seen tenant is evicted early. |
| `MAX_BODY_BYTES` | `1048576` (1 MiB) | Request-body size limit. |
| `HOOK_TIMEOUT_MS` | `5000` | Timeout for tenant webhook fetches (before- and after-hooks). |
| `MAX_CHAOS_DELAY_MS` | `10000` | Ceiling on the QA `x-stubbase-delay` header — held-open requests cost memory on the 1GB box. |
| `USAGE_SINK_URL` | *(unset = metering off)* | Where aggregated usage counters are POSTed, i.e. the Dashboard API's `/_internal/usage`. The core cannot write the SQLite file itself (sandbox), so that service is the only writer to `api_usage`. |
| `USAGE_FLUSH_MS` | `60000` | How often counters flush. They also flush on tenant eviction and on SIGTERM/SIGINT; a failed flush retains its counters for the next attempt. |
| `LOG_CAP` | `50` | Live request-log ring size per tenant (in RAM, never written to disk). Past it the oldest entry is dropped. |
| `LOG_BODY_CHARS` | `500` | Request/response bodies in the log are truncated to this many characters, so one fat payload can't pin memory in the ring. |
| `SQL_IDLE_MS` | `300000` (5 min) | Idle time before a tenant's in-memory SQLite projection (the MCP query surface) is destroyed and its RAM freed. Independent of `IDLE_TTL_MS`: an MCP session can stay open for hours while querying rarely, and the next query transparently re-mounts. |
| `SQL_MAX_ROWS` | `500` | Row ceiling per `execute_sql_query` call. Rows are pulled lazily, so a runaway join stops early rather than materialising. The result reports `truncated: true`. |
| `SQL_MAX_COLUMNS` | `200` | Column ceiling per mounted table, so one pathological record shape can't blow up the projection. |
| `SQL_MAX_QUERY_CHARS` | `4000` | Longest SQL statement an MCP client may submit. |
| `MCP_MAX_SESSIONS` | `50` | Concurrent MCP SSE streams across all tenants. They are held open indefinitely by design, so they need a ceiling on the 1GB box; past it, new streams get 503. |
| `HOOK_ALLOW_PRIVATE` | unset (off) | `true` disables the webhook SSRF guard so hooks may target private addresses. **Local dev/tests only — never set in production.** |
| `AUTH_RESET_LOG_CODES` | unset (off) | `true` writes every tenant password reset code (and its link) to the core's log, so reset can be tried with no email provider configured — `forgot-password` then works without `RESEND_API_KEY`. The core warns at boot while it is on. **Local dev/tests only — never set in production**: the log would hold working account-recovery codes for every project's users. |
| `RESEND_API_URL` | `https://api.resend.com/emails` | Upstream for the `_notify/email` proxy and password reset emails. Override only to point at a mock. |
| `TWILIO_API_BASE` | `https://api.twilio.com` | Upstream base for the `_notify/sms` proxy. Override only to point at a mock. |
| `OAUTH_GOOGLE_AUTH_URL` | Google's real endpoint | OAuth consent-screen URL. Override only for mocks. |
| `OAUTH_GOOGLE_TOKEN_URL` | Google's real endpoint | OAuth code-exchange URL. |
| `OAUTH_GOOGLE_USERINFO_URL` | Google's real endpoint | OpenID userinfo URL. |
| `OAUTH_GITHUB_AUTH_URL` | GitHub's real endpoint | OAuth authorize URL. |
| `OAUTH_GITHUB_TOKEN_URL` | GitHub's real endpoint | OAuth code-exchange URL. |
| `OAUTH_GITHUB_USER_URL` | GitHub's real endpoint | Profile URL. |
| `OAUTH_GITHUB_EMAILS_URL` | GitHub's real endpoint | Fallback when the profile has no public email. |

Where it's set: dev shell (`ADMIN_SECRET=dev PORT=3000 bun run …`) ·
docker-compose service `core` · systemd `deploy/files/stubbase-core.service`
(`PORT`, `TENANTS_DIR` inline; `ADMIN_SECRET` via
`EnvironmentFile=/etc/stubbase/stubbase.env`).

## 1b. Dashboard API (`apps/dashboard-api/server-app.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_SECRET` | — **(required, exits if unset)** | Bearer it presents to the Core `_admin` plane. Must equal the Core's value. |
| `PORT` | `3001` | Listen port. |
| `DB_PATH` | `./app.sqlite` | SQLite file (users, sessions, projects, `api_usage`). Its directory is the unit's only writable path. |
| `CORE_API_URL` | `http://127.0.0.1:3000` | Where to reach the Core Engine (server-to-server; trailing slash stripped). |
| `ALLOWED_ORIGINS` | `https://app.stubbase.dev` | Comma-separated browser origins allowed by CORS. Never `*` on this service. |
| `PUBLIC_API_BASE` | `https://api.stubbase.dev` | Where a tenant's API is reachable *from the outside* — distinct from `CORE_API_URL`, which is this service's private route to the Core. Used for the `apiBase` shown on a new project and told to the AI Co-Pilot so it quotes URLs that resolve. |
| `MAX_BODY_BYTES` | `1048576` (1 MiB) | Request-body size limit. |
| `SESSION_TTL_DAYS` | `30` | Lifetime of opaque session tokens (stored sha256-hashed). |
| `DASHBOARD_GOOGLE_CLIENT_ID` / `DASHBOARD_GOOGLE_SECRET` | *(unset = button hidden)* | **Stubbase's own** Google OAuth app, for signing in to the dashboard. Both halves present ⇒ `GET /auth/google` (+ `/callback`) and `POST /auth/google/one-tap` go live and the SPA renders the button. Not to be confused with a *tenant's* `AUTH_GOOGLE_*` (§2), which lives in that project's `config.json` and logs in that project's end users. |
| `DASHBOARD_GITHUB_CLIENT_ID` / `DASHBOARD_GITHUB_SECRET` | *(unset = button hidden)* | Same for GitHub. |
| `DASHBOARD_URL` | first `ALLOWED_ORIGINS` entry, else `https://app.stubbase.dev` | Where a finished OAuth sign-in bounces the browser: `<DASHBOARD_URL>/auth/callback#token=…`, and `/login#error=…` on failure. A constant on purpose — taking it from the request would be an open redirect that hands out session tokens. |
| `OAUTH_CALLBACK_BASE` | *(derived from the request)* | Origin the provider calls back on, i.e. the `redirect_uri` registered in the provider console. Defaults to `x-forwarded-proto`/`x-forwarded-host` (correct behind Caddy). Set it where the browser reaches this service through a path prefix — `scripts/dev.ts` points it at the Vite proxy (`http://localhost:5173/api/app`) so the dev flow stays on one origin. |
| `OAUTH_GOOGLE_AUTH_URL` / `OAUTH_GOOGLE_TOKEN_URL` / `OAUTH_GOOGLE_USERINFO_URL` | Google's real endpoints | Override only to point at a mock (same names, same purpose as the Core's). |
| `OAUTH_GOOGLE_CERTS_URL` | `https://www.googleapis.com/oauth2/v3/certs` | JWKS used to verify a One Tap ID token's signature. Override only to point at a mock. |
| `OAUTH_GITHUB_AUTH_URL` / `OAUTH_GITHUB_TOKEN_URL` / `OAUTH_GITHUB_USER_URL` / `OAUTH_GITHUB_EMAILS_URL` | GitHub's real endpoints | Same. The emails endpoint is **not** a fallback here: it is the only address source this service will trust, because a GitHub profile email need not be verified. |
| `GOOGLE_AI_API_KEY` | *(unset = AI disabled)* | Google AI Studio key for `POST /projects/<id>/ai/chat`. Server-side only — it must never reach a browser. Without it the route answers `503`; the service still boots. |
| `AI_MODEL_NAME` | `models/gemini-3.5-flash-lite` | Model string, with or without the `models/` prefix. **Must support function calling** — the Co-Pilot is an agent, and a model without tools (the Gemma family) can only talk about acting. Validated at boot; a malformed value **exits**, since it becomes a URL path segment. |
| `AI_TIMEOUT_MS` | `60000` | Per-call timeout (1s–300s). One chat turn can make several calls when tools run. |
| `AI_BASE_URL` | Google's v1beta endpoint | Override only to point at a mock in dev/tests. |
| `PLATFORM_TENANTS` | `public` | Comma-separated tenants the platform serves itself. Counted for usage but never given a request allowance — see §2b. |

Where it's set: dev shell · docker-compose service `dashboard-api` (adds
`ALLOWED_ORIGINS=http://app.stubbase.localhost`) · systemd
`deploy/files/stubbase-app.service` (`PORT`, `CORE_API_URL`, `DB_PATH` inline;
`ADMIN_SECRET` via the same `EnvironmentFile`).

### The production secret flow

`STUBBASE_ADMIN_SECRET` (shell var when running `ansible-playbook`) →
`deploy/deploy.yml` templates `deploy/templates/stubbase.env.j2` →
`/etc/stubbase/stubbase.env` (root-only) → `EnvironmentFile=` in **both**
service units. Secrets never live in unit files or git.

The dashboard's OAuth secrets travel the same road, and are optional:
`STUBBASE_GOOGLE_CLIENT_ID` / `STUBBASE_GOOGLE_SECRET` /
`STUBBASE_GITHUB_CLIENT_ID` / `STUBBASE_GITHUB_SECRET` in the deploying
shell → the same template → the same `EnvironmentFile`. A pair with either
half missing is simply not written, and that provider's button never appears.

---

## 2. Tenant config (`<tenant>/system/config.json`)

Env-style keys stored as a flat JSON object of strings, written through the
dashboard's files proxy (`PUT /projects/<id>/files/…` → core
`_admin/files/config`; reads go through the same proxy since `config` is
hidden from the public CRUD plane). Parsed by `parseConfig()` on tenant load;
any `_admin` write evicts the tenant, so changes apply on the next request.
All keys are optional; an absent `config.json` means "everything off" (plain
open CRUD).

The dashboard's `.env` editor is the intended writer: it compiles `KEY=value`
text into this object and keeps the raw text (comments, ordering) under the
`__raw` key, which `parseConfig()` ignores. Don't repurpose `__raw`.

**A new project's `.env` starts as a template.** `envTemplate` in
`apps/dashboard-api/server-app.ts` writes every key in this section into
`__raw`, grouped by feature with a comment on each, and every line commented
out — so a new project is still plain, open CRUD, and switching a feature on is
uncommenting its lines. Anything that sets a key from code (a starter)
uncomments the template's line in place
rather than appending, so `__raw` and the parsed keys never disagree. Adding a
key here means adding it to the template as well.

**Drafts:** dashboard saves land in `draft_<name>.json` beside the file they
stage — `data/draft_<resource>.json`, or `system/draft_config.json` — and only
reach the live files on deploy
(`POST /projects/<id>/deploy` → core `_admin/deploy`). The core skips
`draft_*` when loading a tenant, so staged data is never served. Editor reads
prefer the draft; the Live tab and the public API always show deployed state.

### Server state — not a config key

Whether a project is serving lives in its own file,
`<tenant>/system/status.json` (`{ "status": "active" | "stopped" | "maintenance" }`),
not in `config.json`. `stopped` or `maintenance` makes the whole public plane
(CRUD, auth, notify, openapi) answer `503` with `{"error":…,"projectStatus":…}`;
`active`, or no file at all, serves normally. It is set only by the dashboard's
Start/Stop toggle and the Co-Pilot (`POST /projects/<id>/status` → core
`POST _admin/status`), and applies immediately. It is never staged, never
deployed and has no `.env` line, so neither a Save nor a Deploy can start or
stop an API — a `PROJECT_STATUS` key in config is ignored. The `_admin` plane
stays reachable so the dashboard can always start it again.

### QA Chaos Engine

| Key | Example | Purpose |
|---|---|---|
| `QA_MODE` | `"true"` | Master gate for request simulation. **Without it every `x-stubbase-*` header is ignored**, so a production tenant can't be disrupted by anyone who guesses the header names. |

With `QA_MODE=true`, clients may send (per request):

| Header | Example | Effect |
|---|---|---|
| `x-stubbase-delay` | `1500` | Sleep this many ms before handling (capped by `MAX_CHAOS_DELAY_MS`). |
| `x-stubbase-status` | `500` | Return an empty response with this status (100–599); the operation never runs. |
| `x-stubbase-error-rate` | `0.3` | 30% of requests return `503 {"error":"Simulated Flakiness"}`. |
| `x-stubbase-empty` | `true` | GET returns `[]` (collection) or `null` (by id) without touching the cache. |

The guard runs after auth, so simulation never bypasses authentication. These
headers are allow-listed in the public CORS preflight (never the admin one).

### Request validation

| Key | Example | Purpose |
|---|---|---|
| `SCHEMA_<RESOURCE>` | `SCHEMA_POSTS={"type":"object","required":["title"]}` | JSON Schema (as a one-line JSON string) validating POST/PUT bodies for that resource. Failures return `400` with `{"error":"validation failed","errors":[{path,message}]}`. |

Equivalently, an API-written config may nest `resources: { posts: { schema: {…} } }` —
`resources` is the one config key allowed to hold an object rather than a string.
Supported keywords: `type`, `required`, `properties`, `additionalProperties`,
`enum`, `const`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`,
`items`, `minItems`/`maxItems` (validated by a small built-in checker — the
backends take no npm dependencies).

### Auth

| Key | Example | Purpose |
|---|---|---|
| `AUTH_ENABLED` | `"true"` | Master switch. Enables `POST /auth/signup`, `/login`, `/change-password`, `/forgot-password` and `/reset-password`, keeps accounts in `system/users.json` (never a CRUD resource — a `data/users.json` is unaffected), and makes all CRUD require a `Bearer` JWT. Everything else in this section is inert without it. |
| `AUTH_PUBLIC_ROUTES` | `"posts,comments"` | Comma-separated resources that allow **anonymous GET** despite auth (writes still need a JWT). Ignored while the project has a `system/rbac.json` — its `guest` role decides what visitors may do. |
| `AUTH_JWT_TTL_SECONDS` | `"3600"` | JWT lifetime (default 86400 = 24 h, min 60). |
| `AUTH_OAUTH_REDIRECT` | `"https://myapp.com/login"` | After OAuth, 302 the browser here with `#token=<jwt>` instead of returning JSON. |
| `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_SECRET` | — | Tenant's own Google OAuth app. Both present ⇒ `GET /<tenant>/auth/google` (+ `/callback`) go live. The tenant registers `<origin>/<tenant>/auth/google/callback` in their Google console. |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_SECRET` | — | Same for GitHub (`/auth/github`). |
| `AUTH_RESET_URL` | `"https://myapp.com/reset"` | Page a reset email links to, as `<url>#email=…&code=…`, below the code. Must be http(s); anything else is ignored with a boot warning and the email carries the code alone. Password reset itself needs `RESEND_API_KEY` (§ Notifications) — or the core's `AUTH_RESET_LOG_CODES` locally — and answers `404` without either. |

Roles: an account's `role` lives on its `system/users.json` record and is
re-read on every request, so a change applies from the next one. Without an
`rbac.json`, `"admin"` bypasses the ownership rules and every signup is `user`.
With one, signups get its `defaultRole`, and a role is changed from the
dashboard or by a role holding `_users: update`. JWTs carry
`sub`/`email`/`role`/`pwdAt` claims signed with the derived per-tenant key
(nothing stored on disk).

**Password reset and revocation** (not keys — fixed behaviour): a reset code is
six digits, lives 15 minutes, works once, is spent by five wrong guesses, and is
replaced by the next request; each account gets at most five codes an hour. Codes
are stored in `system/reset-password.json` as an HMAC keyed off `ADMIN_SECRET`.
Changing or resetting a password stamps `passwordChangedAt`, and every token
signed before it stops verifying.

### Roles and permissions (`<tenant>/system/rbac.json`)

Not env keys: a JSON file, edited in the dashboard beside the `.env`, staged as
`draft_rbac.json` and promoted on deploy. It takes effect only with
`AUTH_ENABLED=true`; without the file, the ownership rules above apply.

```json
{
  "defaultRole": "customer",
  "roles": {
    "guest":    { "products": ["read"] },
    "customer": { "orders": { "create": "own", "read": "own", "update": "own" } },
    "staff":    { "products": "*", "orders": { "read": "all" }, "_users": ["read"] },
    "admin":    "*"
  }
}
```

| Part | Meaning |
|---|---|
| `defaultRole` | Required. The role every new account gets; must be one of `roles`, and not `guest`. |
| `roles.<name>` | `"*"` (everything, managing accounts included), or an object keyed by resource name — `"*"` as a key covers any resource the role doesn't name. |
| a resource's value | `"*"`, a list of actions (each on every record), or `{ "<action>": "own" \| "all" }`. Actions are `read` (GET), `create` (POST), `update` (PUT) and `delete` (DELETE). |
| `own` / `all` | `own` reaches records whose `userId` is the caller's: lists are filtered, anyone else's record reads as `404`, a create is stamped with the caller whatever the body says, and an update can't move `userId`. `all` reaches every record. |
| `_users` | `["read"]` lists accounts (`GET /auth/users`); `["read", "update"]` or `"*"` also changes roles (`PUT /auth/users/<id>/role`). |
| `guest` | The role for requests without a token: `all` scopes only, no `_users`. While the file exists, `AUTH_PUBLIC_ROUTES` is ignored. |

Anything a role doesn't list is refused — `401` for a visitor, `403` naming the
role for an account. A write is validated and refused with every problem listed;
a file broken on disk refuses everything rather than falling back to open access.

### Webhooks

| Key pattern | Example | Purpose |
|---|---|---|
| `HOOK_BEFORE_<ACTION>_<RESOURCE>` | `HOOK_BEFORE_INSERT_POSTS` | Synchronous gate: the payload is POSTed to the URL; any status ≠ 200 aborts the mutation (422). |
| `HOOK_AFTER_<ACTION>_<RESOURCE>` | `HOOK_AFTER_UPDATE_ORDERS` | Fire-and-forget notification after a successful mutation, includes the resulting record. |

`<ACTION>` ∈ `INSERT` (POST) / `UPDATE` (PUT) / `DELETE`. `<RESOURCE>` is the
resource name uppercased with non-alphanumerics → `_`. URLs are SSRF-checked
(DNS-resolved; private/reserved addresses refused) unless the process runs
with `HOOK_ALLOW_PRIVATE=true`.

### Notifications (`POST /<tenant>/_notify/…`, requires a user JWT)

| Key | Purpose |
|---|---|
| `RESEND_API_KEY` | Enables `_notify/email` and password reset emails (`/auth/forgot-password`); the key stays server-side, the tenant's frontend never sees it. |
| `RESEND_FROM` | From address for both (default `Stubbase <onboarding@resend.dev>`). |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` | All three enable `_notify/sms`. |

⚠️ These provider credentials are stored **plaintext** in `system/config.json` on
disk (encryption-at-rest is a known backlog item).

---

## 2b. Plans and entitlements

Not an env var: a plan is a column on the `users` row, and the table that gives
it meaning is `PLANS` in `apps/dashboard-api/server-app.ts`. There is no payment
gateway yet, so a plan is set by hand:

```sql
UPDATE users SET plan = 'pro_ai' WHERE email = 'someone@example.com';
```

Locally, `scripts/seed-dev-users.ts` (run automatically by `scripts/dev.ts`)
creates one account per plan — `free@`, `pro@` and `ai@stubbase.dev`, password
`devpassword123` — so all three sides can be exercised without touching SQL.

| Plan id | Name | Requests/month | Unlocks |
|---|---|---|---|
| `free` | Free | 5,000 | — |
| `pro` | Pro QA | 50,000 | — |
| `pro_ai` | Pro + AI | 250,000 | `ai` |

An unknown or absent plan string reads as **Free**, never as unlimited.

**Plans differ by request allowance.** Every project feature — auth and roles,
webhooks, QA mode — is on every plan, so nothing a project's `.env` or
`rbac.json` switches on is refused. The one gated feature is the AI Co-Pilot
(`ai`): `POST /projects/<id>/ai/chat` answers `402` below Pro + AI, because every
turn is a paid provider call.

`PLATFORM_TENANTS` (Dashboard API env, default `public`) lists tenants the
platform itself serves. They belong to no account, so they are counted but
never quoted an allowance — the landing site's demo tenant would otherwise be
capped at the Free plan across all its visitors. They are simply left out of
the flush reply, so the core's fail-open path serves them with no special case.

**The request allowance is enforced at request time, in the core.** The core
never learns what a plan is: the Dashboard API answers each usage flush with
one number per tenant (`quotas: [{ tenantId, limit, used }]`), and the core
serves until `used >= limit`, then answers `429` on the whole public plane —
CRUD, auth, notify and openapi together, with `_admin` still reachable so the
owner can see why. Between flushes the count advances locally, so overshoot is
bounded by `USAGE_FLUSH_MS` per project.

**The allowance is one pool per account, not per project.** `limit` is the
owner's plan and `used` is the account's month-to-date total across all its
projects — including projects deleted this month, since each usage row records
the account it was charged to — so creating more projects never raises how many
requests an account can make. A flush reply quotes every project of each account
that reported, so an account's idle projects stop as soon as a busy one spends
the pool.

A tenant the core has never been quoted a limit for is **served** (fresh boot,
sink unreachable, first request of the month). Metering failing must not take
customer traffic down. That also means quotas are unenforced entirely when
`USAGE_SINK_URL` is unset.

## 3. Frontend build env

Three build modes per site (see BUILD.md): `dev` (dev servers + proxy, loads
`.env.development`), `docker` (`bun run build:docker`, loads `.env.docker`,
`*.localhost` hosts), `prod` (`bun run build`, no env file — hard-coded
`*.stubbase.dev` defaults in code). All values are baked in at build time;
changing them means rebuilding.

### `sites/dashboard` (Vite — must be prefixed `VITE_` to reach the client)

| Variable | Dev default | Prod default | Purpose |
|---|---|---|---|
| `VITE_APP_API_URL` | `/api/app` (proxied) | `https://api.app.stubbase.dev` | Dashboard API base for all TanStack Query fetches (`src/lib/api.ts`). |
| `VITE_CORE_API_URL` | `/api/core` (proxied) | `https://api.stubbase.dev` | Core Engine base (public CRUD calls from the SPA). |
| `VITE_CORE_PUBLIC_URL` | `http://127.0.0.1:3000` | falls back sensibly | Display-only base for endpoint docs / curl samples; defaults to `VITE_CORE_API_URL` when that's absolute. |
| `VITE_APP_PUBLIC_URL` | falls back sensibly | `https://api.app.stubbase.dev` | Display-only base for the MCP endpoint and the generated Claude Desktop config, which an external agent must be able to resolve — so it can never be the relative dev-proxy path. Defaults to `VITE_APP_API_URL` when that's absolute. |
| `VITE_LANDING_URL` | `http://localhost:4321` | `https://stubbase.dev` | Marketing-site links from auth pages. |

The two dev values are pinned in `sites/dashboard/.env.development` (loaded only
by `vite` in development mode) so the local cross-links and displayed URLs point
at the dev servers `scripts/dev.ts` starts.

Dev-server proxy targets (read by `vite.config.ts` from the *shell*, not
`VITE_`-prefixed, never baked into the bundle):

| Variable | Default | Purpose |
|---|---|---|
| `APP_API_TARGET` | `http://127.0.0.1:3001` | Where `/api/app` proxies to. |
| `CORE_API_TARGET` | `http://127.0.0.1:3000` | Where `/api/core` proxies to. |

### `sites/landing` (Astro — must be prefixed `PUBLIC_` to reach the client)

| Variable | Dev default | Prod default | Purpose |
|---|---|---|---|
| `PUBLIC_APP_URL` | `http://localhost:5173` | `https://app.stubbase.dev` | Dashboard links (`src/lib/urls.ts`). |
| `PUBLIC_CORE_URL` | `http://127.0.0.1:3000` | `https://api.stubbase.dev` | Core API base for the Home "Try it live" runner. |
| `PUBLIC_GOOGLE_CLIENT_ID` | *(unset = no prompt)* | *(must be set at build time)* | Google OAuth client id for the One Tap prompt on Home. Public by design — it is the `aud` the Dashboard API checks a returned ID token against, not a secret. Unset ships no prompt and no request to Google. Must be the **same client** as `DASHBOARD_GOOGLE_CLIENT_ID`, with each origin registered as an **authorized JavaScript origin** — without that Google refuses the prompt with `no registered origin` / `invalid_client`. No redirect URI is needed for One Tap: the page posts the credential to `/auth/google/one-tap` itself. |

`.env.docker` in each site pins these to the `*.localhost` hosts for the
Docker stack; `.env.development` pins the dev-server values above. Ports in the
`.env.development` files must match the constants in `scripts/dev.ts`.

---

## Cross-links

- Same knob, three places: any process-env change usually needs matching edits
  in `docker-compose.yml`, `deploy/files/*.service`, and the dev commands in
  CLAUDE.md/BUILD.md.
- `ADMIN_SECRET` couples the two backends — set it identically in both, from
  one source (`/etc/stubbase/stubbase.env` in prod).
- The mock-upstream overrides (`RESEND_API_URL`, `TWILIO_API_BASE`,
  `OAUTH_*_URL`) and `HOOK_ALLOW_PRIVATE` exist for the local stack and test
  suites; production sets none of them.
