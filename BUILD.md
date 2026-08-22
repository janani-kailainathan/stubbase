# Building & testing locally

Prereqs: [Bun](https://bun.sh) (runs the backends and both frontend builds). Docker is only needed for Option 2. Install frontend deps once with `bun install` in `sites/landing` and `sites/dashboard`.

## Option 1 — dev mode (fastest feedback)

One command from the repo root starts all four processes — both backends (hot-reloading via `bun --watch`) and both frontend dev servers — with prefixed output and a single Ctrl-C teardown:

```bash
bun run scripts/dev.ts          # --reseed to regenerate the demo tenant
```

| URL | What |
|---|---|
| http://localhost:5173 | dashboard SPA — **start here** |
| http://localhost:4321 | landing site |
| http://127.0.0.1:3000 | Core Engine |
| http://127.0.0.1:3001 | Dashboard API |

Sign up (any email, password ≥ 8 chars) → create a project → edit JSON, add resources, fire requests from the Live tab. Your project's API is directly curl-able at `http://127.0.0.1:3000/<tenant-id>/<resource>` (the tenant id is visible in the Request tab's URL).

- The Vite dev server proxies `/api/app` → `:3001` and `/api/core` → `:3000`, so everything is same-origin and no CORS setup is needed.
- Data lands in `./tenants/` and `./app.sqlite` (both gitignored) — inspect the JSON files as you save from the UI.
- `ADMIN_SECRET` defaults to `dev` and reaches both backends from one place (`ADMIN_SECRET=… bun run scripts/dev.ts` to override). Setting it differently per backend silently breaks admin auth and the per-tenant JWT keys derived from it — the script makes that impossible.
- The repo-root `.env` is loaded automatically, so `GOOGLE_AI_API_KEY` reaches the Dashboard API and the AI route works in dev (see `.env.example`).
- **Cross-links line up**: the landing's "Log in" / "Go to Dashboard" reach the local :5173 dashboard, the dashboard's auth pages link back to :4321, and the endpoint docs / curl samples show `http://127.0.0.1:3000` instead of the production domain. Those URLs come from the committed `sites/dashboard/.env.development` and `sites/landing/.env.development`, which Vite and Astro load only in development mode — production and `build:docker` builds never see them.
- **First run seeds the `public` demo tenant** — the six free resources the landing advertises (100 posts, 500 comments, 100 albums, 5000 photos, 200 todos, 10 users), so the Home "Try it live" runner hits real local data instead of its built-in fallback. Generated from a fixed seed by `scripts/seed-public-tenant.ts`; existing files are left alone unless you pass `--reseed`.
- `scripts/dev.ts` owns the four dev ports, and the `.env.development` cross-links assume exactly those. A port already in use aborts startup with a clear message rather than letting a dev server drift to the next port and break the links.

To run a single piece by hand (the script is only a supervisor — nothing depends on it):

```bash
ADMIN_SECRET=dev PORT=3000 bun run apps/core/server-core.ts
ADMIN_SECRET=dev PORT=3001 CORE_API_URL=http://127.0.0.1:3000 bun run apps/dashboard-api/server-app.ts
cd sites/dashboard && bunx vite            # :5173
cd sites/landing   && bun run dev          # :4321
```

What dev mode still doesn't exercise: cross-origin calls (the SPA is same-origin through the Vite proxy), the `ALLOWED_ORIGINS` allow-list, Caddy routing, and the static `dist/` output. Run Option 2 before deploying.

## Option 2 — full stack behind Caddy (closest to production)

Builds are per-environment via Vite modes: plain `build` bakes in the production `*.stubbase.dev` URLs, while `build:docker` loads the committed `.env.docker` files and targets the `.localhost` hosts (API calls, displayed base URLs, and the landing↔dashboard cross-links all line up):

```bash
bun run scripts/build.ts --docker
docker compose up --build
```

Everything runs on port 80 with production-style routing (`*.localhost` resolves to 127.0.0.1 automatically — no `/etc/hosts` edits):

| URL | What |
|---|---|
| http://stubbase.localhost | landing site |
| http://app.stubbase.localhost | dashboard SPA (cross-origin API calls, like production) |
| http://api.app.stubbase.localhost | Dashboard API |
| http://api.stubbase.localhost/\<tenant\>/\<resource\> | generated tenant APIs |

The compose file already allow-lists `http://app.stubbase.localhost` in the Dashboard API's CORS config. Because of the `build:docker` mode, the base URLs shown in the dashboard's Request tab / curl samples are copy-paste-able against the local stack, and the landing's "Log in" / "Go to Dashboard" buttons reach the local dashboard.

## Production builds & deploy

`sites/*/dist/` is gitignored and Ansible copies it from your local checkout, so **always build before deploying**. One command from the repo root builds every module in order:

```bash
bun run scripts/build.ts                            # defaults to https://api.*.stubbase.dev
cd deploy && STUBBASE_ADMIN_SECRET=... ansible-playbook -i inventory.ini deploy.yml
```

The build is a Maven-style reactor over four modules — `stubbase-core`, `stubbase-dashboard-api`, `stubbase-landing`, `stubbase-dashboard` — with a summary table at the end:

```
[INFO] ---------------------< dev.stubbase:stubbase-core >---------------------
[INFO] Building stubbase-core 0.1.0                                       [1/4]
[INFO] --------------------------------[ bun ]---------------------------------
[INFO]
[INFO] --- deps:verify (zero-dependency-check) @ stubbase-core ---
[INFO] no npm dependencies declared — OK
...
[INFO] Reactor Summary for stubbase 0.1.0:
[INFO]
[INFO] stubbase-core ................. SUCCESS [  0.014 s]
[INFO] stubbase-dashboard-api ........ SUCCESS [  0.011 s]
[INFO] stubbase-landing .............. SUCCESS [  1.446 s]
[INFO] stubbase-dashboard ............ SUCCESS [  1.743 s]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
```

The backends have no build step; their modules run the checks that nothing else would — the zero-npm-dependency constraint and the `tests/` regression suite. It's fail-fast: a failed module marks everything after it `SKIPPED` and exits non-zero.

| Flag | What |
|---|---|
| `--docker` | build the frontends in `docker` mode (`*.localhost` URLs) instead of production |
| `-pl <modules>` | build only these, comma-separated (`core`, `dashboard-api`, `landing`, `dashboard`) |
| `--skip-tests` | skip the test goals — they still appear as `SKIPPED` in the log |

A failed build leaves any previously built `dist/` in place, so **don't deploy on red** — Ansible will happily copy whatever is on disk. Individual modules still build by hand (`cd sites/landing && bun run build`); the script is only a reactor, nothing in the deploy path depends on it.

Frontend URLs are supplied per build mode: production values are the in-code defaults, and the Docker stack's come from the committed `.env.docker` files (dashboard: `VITE_APP_API_URL`, `VITE_CORE_API_URL`, `VITE_LANDING_URL`, optional `VITE_CORE_PUBLIC_URL` display override; landing: `PUBLIC_APP_URL`, `PUBLIC_CORE_URL`). Any of them can also be overridden inline for a one-off build. Backend env vars are documented in the [README configuration table](README.md#configuration).
