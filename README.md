# Stubbase

Hyper-dense, multi-tenant, scale-to-zero JSON-to-CRUD hosting, sized for a $4/month VPS (1GB RAM).

Drop JSON files in, get a REST API out. A single Bun process serves every tenant: data lazy-loads from disk into RAM on the first request, mutations write through to disk immediately, and idle tenants are evicted from memory after 5 minutes. No containers per tenant, no cold-start processes — just a `Map` and the filesystem.

## Architecture

Four routing zones, all fronted by Caddy (auto-TLS):

| Zone | Host | Served by |
|---|---|---|
| Landing page (SSG) | `stubbase.dev` | Caddy `file_server` only |
| Dashboard SPA | `app.stubbase.dev` | Caddy `try_files` + `file_server` only |
| Dashboard backend | `api.app.stubbase.dev` | Bun + SQLite on `:3001` |
| Core Tenant API | `api.stubbase.dev` | Bun engine on `:3000` |

The dashboard backend (`apps/dashboard-api/server-app.ts`) owns users, sessions, and projects in SQLite. Passwords are argon2id (`Bun.password`); sessions are opaque bearer tokens stored hashed. When a project is created it provisions the tenant's JSON files by calling the Core Engine's admin plane with `ADMIN_SECRET` — file writes from the dashboard SPA also go through this service, so the secret never reaches a browser.

**Dashboard API** (`api.app.stubbase.dev`; auth = `Authorization: Bearer <session token>`):

```
POST   /auth/signup                        { email, password, name? } → { token, user }
POST   /auth/login                         { email, password } → { token, user }
POST   /auth/logout                        (auth) revoke session
GET    /auth/me                            (auth)
GET    /auth/providers                     → { google, github } — which buttons the SPA shows
GET    /auth/google | /auth/github         start OAuth sign-in (302 to the provider)
GET    /auth/<provider>/callback           finish it → 302 to the SPA with #token=…
GET    /projects                           (auth) list own projects
POST   /projects                           (auth) { name, resources? } → provision tenant
PATCH  /projects/<tenantId>                (auth) { name } rename
DELETE /projects/<tenantId>                (auth) deprovision tenant + remove row
PUT    /projects/<tenantId>/files/<res>    (auth) body = JSON array → create/replace file
DELETE /projects/<tenantId>/files/<res>    (auth) delete file
GET    /projects/<tenantId>/live-logs      (auth) SSE proxy of the request log
GET    /projects/<tenantId>/diagnostics    (auth) JSON syntax health check
```

The Core Engine (`apps/core/server-core.ts`) is the product: per-tenant CRUD over JSON files with lazy loading, write-through persistence, and idle eviction.

## Tenant API

```
GET    /<tenant>/<resource>          list  (see query params below)
GET    /<tenant>/<resource>/<id>     read  (supports _expand)
POST   /<tenant>/<resource>          create (id auto-generated if omitted)
PUT    /<tenant>/<resource>/<id>     replace (id preserved)
DELETE /<tenant>/<resource>/<id>     delete
GET    /<tenant>/openapi.json        auto-generated OpenAPI 3.0 spec
```

Each resource is one file: `/tenants/<tenant>/<resource>.json`, a JSON array of objects.

**List query params** (all optional, composable in this order — filter → sort → paginate → expand):

| Param | Example | Effect |
|---|---|---|
| `<field>` | `?category=shoes&status=active` | exact-match filter on any record field |
| `_sort` / `_order` | `?_sort=price&_order=desc` | sort by field(s), comma-separated; `asc` (default) or `desc` |
| `_page` / `_limit` | `?_page=2&_limit=10` | 1-based pagination (default 10 per page) |
| `_offset` / `_limit` | `?_offset=20&_limit=10` | raw-index alternative to `_page` |
| `_expand` | `?_expand=users` | nest the record referenced by `<name>Id` under `<name>` |

The unpaginated total is returned in the `X-Total-Count` response header.

**Admin plane** (used by the dashboard backend; requires `Authorization: Bearer <ADMIN_SECRET>`):

```
GET    /<tenant>/_admin/files/<resource>   read file (drafts included)
POST   /<tenant>/_admin/files/<resource>   create/overwrite file (body = seed array)
DELETE /<tenant>/_admin/files/<resource>   delete file
POST   /<tenant>/_admin/flush              drop the RAM cache
POST   /<tenant>/_admin/deploy             promote draft_* files to production
GET    /<tenant>/_admin/sse-logs           SSE stream of the live request log
GET    /<tenant>/_admin/logs               one-shot snapshot of the same log ring
GET    /<tenant>/_admin/mcp/sse            MCP (Model Context Protocol) stream
POST   /<tenant>/_admin/mcp/message        MCP JSON-RPC 2.0 inbox
```

Admin writes immediately evict the tenant from the RAM cache, so the next request lazy-loads fresh disk state.

### MCP: querying a project with SQL

AI agents can talk to a project over the **Model Context Protocol**, using the
HTTP+SSE transport (protocol revision `2024-11-05`). Connect to
`/<tenant>/_admin/mcp/sse`; the first event on the stream is `endpoint`, naming
the URL to POST JSON-RPC messages to for that session.

The server offers one tool, `execute_sql_query`. The tenant's JSON resources are
mounted into a **read-only in-memory SQLite database**, so agents get real
joins, aggregates and CTEs instead of paging the REST API — and `tools/list`
injects the live table/column list straight into the tool's description, so the
model sees the schema without having to guess it:

```
Tables available: posts(id TEXT, title TEXT, views INTEGER, userId TEXT),
                  users(id TEXT, email TEXT, role TEXT).
```

Worth knowing:

- **The JSON files remain the store.** The SQLite database is a *projection*
  built from the in-RAM arrays, never the other way round. It is dropped
  whenever the data changes and rebuilt (~1ms) on the next query, so SQL always
  reads current data while every write keeps going through the REST pipeline
  with its validation, ownership and webhook rules intact.
- **Reads only.** Statements must start with `SELECT` or `WITH`, and the
  connection runs under `PRAGMA query_only`.
- **Columns are the union of keys across every record**, so fields that appear
  on only some records are still queryable. Nested objects and arrays are stored
  as JSON text — use `json_extract()`.
- **`passwordHash` is never mounted**, so no query can reach it.
- Projections are dropped after `SQL_IDLE_MS` of no queries even while the
  session stays open, and results are capped at `SQL_MAX_ROWS` rows per call.

### Connecting an external agent (Claude Desktop, IDEs)

The core's MCP routes sit behind `ADMIN_SECRET`, which never leaves the server.
External agents instead connect through the Dashboard API with a **developer API
key**, created per project in the dashboard's *API keys* tab (or over the API):

```
POST   /projects/<tenantId>/keys       → { key: "sk_stub_…" }   returned once
GET    /projects/<tenantId>/keys       → metadata only, never the key
DELETE /projects/<tenantId>/keys/<id>  → revoke

GET    /projects/<tenantId>/mcp/sse        Authorization: Bearer sk_stub_…
POST   /projects/<tenantId>/mcp/message
```

Keys are stored sha256-hashed and shown exactly once. Revoking a key — or
deleting the project — invalidates it immediately.

Claude Desktop speaks stdio, so it reaches a remote SSE server through the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge. The dashboard
generates this for you with the key filled in:

```json
{
  "mcpServers": {
    "stubbase_my_project": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://api.app.stubbase.dev/projects/my-project/mcp/sse",
        "--transport", "sse-only",
        "--header", "Authorization: Bearer ${STUBBASE_API_KEY}"
      ],
      "env": { "STUBBASE_API_KEY": "sk_stub_…" }
    }
  }
}
```

`--transport sse-only` matters: this server implements the HTTP+SSE transport,
and without the flag the bridge probes for Streamable HTTP first.

## Local development

**See [BUILD.md](BUILD.md)** for the full local build & test guide — dev mode with hot reload, and the production-style stack below.

Dev mode, everything in one command (both backends + both frontend dev servers, hot reload, one Ctrl-C to stop) — then open http://localhost:5173:

```bash
bun run scripts/dev.ts
```

Production-shaped stack behind Caddy (build both sites with `build:docker` first — see BUILD.md):

```bash
docker compose up --build
```

Then (no `/etc/hosts` edits needed — `*.localhost` resolves to 127.0.0.1):

```bash
curl http://api.stubbase.localhost/demo/todos
TOKEN=$(curl -s -X POST http://api.app.stubbase.localhost/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-password"}' | jq -r .token)
curl -X POST http://api.app.stubbase.localhost/projects \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"My API"}'
```

Tenant JSON lives in `./tenants/` on the host, bind-mounted into the core container, so writes are visible live.

To run one backend on its own (`scripts/dev.ts` is just a supervisor around these):

```bash
ADMIN_SECRET=dev PORT=3000 bun run apps/core/server-core.ts
ADMIN_SECRET=dev PORT=3001 CORE_API_URL=http://127.0.0.1:3000 bun run apps/dashboard-api/server-app.ts
```

## Production deployment

Prereqs: a fresh Ubuntu VPS, DNS records for `stubbase.dev`, `app.`, `api.`, `api.app.` (A records) and `www.` (CNAME to the apex, redirected by Caddy) pointing at it, and freshly built frontends (`sites/*/dist/` is gitignored — see [BUILD.md](BUILD.md#production-builds--deploy)).

```bash
cd deploy
cp inventory.ini.example inventory.ini    # set your VPS IP
STUBBASE_ADMIN_SECRET="$(openssl rand -hex 32)" ansible-playbook -i inventory.ini deploy.yml
```

The playbook installs Caddy (official apt repo) and Bun (native, `/usr/local/bin/bun`), creates the `stubbase` user and directory layout, deploys code and static sites, writes `/etc/stubbase/stubbase.env` (0600) with the admin secret, installs/starts the two sandboxed systemd units, and validates the Caddyfile before reloading Caddy. Re-run the same command to deploy updates — it's idempotent.

Production layout:

```
/opt/stubbase/{core,app}/          app code (systemd units run from here)
/var/www/stubbase/tenants/         tenant JSON (only path core can write)
/var/lib/stubbase/app.sqlite       dashboard DB (only path app can write)
/var/www/stubbase-landing/dist     landing SSG
/var/www/stubbase-dashboard/dist   dashboard SPA
/etc/stubbase/stubbase.env         ADMIN_SECRET (0600)
/etc/caddy/Caddyfile               4-zone routing
```

### Dry-running a deploy locally (Multipass)

No VPS yet, but want to see the real `deploy.yml` run — real `apt`-installed Caddy, native Bun, sandboxed systemd units, the actual folder layout — before it matters? Run it against a disposable local VM instead. This exercises everything except DNS/Let's Encrypt (a local VM has no public IP, so TLS is skipped by design — see below).

**1. Install Multipass and create the VM** (sized to the same 1GB-RAM class as the real target, so memory behavior is representative):

```bash
brew install --cask multipass
multipass launch 22.04 --name stubbase-test --cpus 1 --memory 1G --disk 6G
```

On macOS, the first time you reach the VM's IP you may need to approve **System Settings → Privacy & Security → Local Network** for Terminal — without it, `ping`/`ssh` to the VM fail with `No route to host` even though the VM itself is running fine.

**2. Trust your SSH key on the VM** (Ansible needs real key auth, not Multipass's internal one):

```bash
multipass exec stubbase-test -- cloud-init status --wait   # wait for boot to finish
cat ~/.ssh/id_ed25519.pub | multipass exec stubbase-test -- bash -c \
  'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys'
```

**3. Point Ansible at it.** `deploy/inventory.local.ini` (gitignored) mirrors `inventory.ini.example`, just aimed at the VM's IP (`multipass list` to confirm it):

```ini
[stubbase]
192.168.252.2 ansible_user=ubuntu ansible_ssh_private_key_file=~/.ssh/id_ed25519
```

**4. Build the frontends in docker mode** (bakes in `*.stubbase.localhost` URLs instead of production ones), then deploy with `caddyfile_src` overridden to the local-VM Caddyfile variant:

```bash
bun run scripts/build.ts --docker
cd deploy
STUBBASE_ADMIN_SECRET="$(openssl rand -hex 32)" ansible-playbook -i inventory.local.ini deploy.yml -e caddyfile_src=Caddyfile.local
```

`caddyfile_src` defaults to `Caddyfile` (production), so a real VPS deploy is unaffected unless you pass this override. `caddy/Caddyfile.local` routes the same four zones on `*.stubbase.localhost` with an explicit `http://` scheme — since auto-HTTPS only ever activates for bare (schemeless) hostnames, Caddy never attempts an ACME cert here at all. (It's a separate file from `Caddyfile.dev` because that one targets docker-compose's bind-mount paths, `/srv/...` — this one matches the real VPS layout deploy.yml creates, `/var/www/...`.)

**5. Browse it** — no `/etc/hosts` edits needed, `*.localhost` always resolves to loopback:

```bash
ssh -f -N -L 8080:127.0.0.1:80 ubuntu@192.168.252.2   # background tunnel, leave running
open http://stubbase.localhost:8080                    # landing
open http://app.stubbase.localhost:8080                # dashboard
curl http://api.stubbase.localhost:8080/demo/todos     # core API
```

**Start / stop / tear down:**

```bash
multipass stop stubbase-test      # pause — disk kept, resume later
multipass start stubbase-test     # resume where you left off
multipass delete stubbase-test && multipass purge   # full teardown, reclaims disk
```

`stop`/`start` is enough between test sessions. Use `delete && purge` (then `launch` again) when you want to verify the playbook against a genuinely fresh box — that's what actually exercises its idempotency guards (e.g. `creates: /usr/local/bin/bun`) the same way a brand-new VPS would.

## Configuration

**See [ENVIRONMENT.md](ENVIRONMENT.md)** for the complete reference — every
process env var (including webhook/SSRF, notification, and OAuth knobs), the
per-tenant `config.json` keys (`AUTH_*`, `HOOK_*`, `RESEND_*`, `TWILIO_*`),
frontend build variables, and how each is wired in dev / Docker / production.
The most common ones:

| Env var | Default | Used by |
|---|---|---|
| `ADMIN_SECRET` | *(required)* | both |
| `PORT` | 3000 / 3001 | both |
| `TENANTS_DIR` | `./tenants` | core |
| `IDLE_TTL_MS` | `300000` (5 min) | core |
| `MAX_ACTIVE_TENANTS` | `500` | core |
| `MAX_BODY_BYTES` | `1048576` (1 MiB) | both |
| `CORE_API_URL` | `http://127.0.0.1:3000` | app |
| `DB_PATH` | `./app.sqlite` | app |
| `ALLOWED_ORIGINS` | `https://app.stubbase.dev` | app (CORS, comma-separated) |
| `SESSION_TTL_DAYS` | `30` | app |
