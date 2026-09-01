# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Stubbase has no single primary user. It serves several developer segments who
arrive with different jobs, and the site architecture is built around that fact
rather than around one hero persona (see Operating Context).

- **Frontend developers** blocked waiting on a backend, who need a persistent,
  relational REST API to build a real UI against today.
- **QA and test-automation engineers** who need deterministic failure —
  latency, error rates, intercepted status codes — wired into CI.
- **Indie hackers and students** shipping an MVP who want a real backend without
  standing up or paying for a database.
- **AI agent builders** wiring Claude, ChatGPT or an IDE to a live datastore
  over MCP, and querying it with read-only SQL.

Each segment gets its own page; the home page is the combination. No segment
outranks the others, so design work must not quietly re-center the product on
one of them.

## Product Purpose

Stubbase turns JSON files into a hosted, persistent REST API. A user drops in a
JSON file — or describes a schema in plain English and lets the AI Co-Pilot
generate it — and gets CRUD endpoints with relations, filtering, sorting,
pagination and an auto-generated OpenAPI spec, with no database to configure.

Success is a developer going from nothing to a working endpoint they can point
real client code at, in seconds, without a signup wall for the public data.

## Positioning

Three claims are all true, and each page leads with whichever fits its segment.
The home page combines them:

1. **JSON files in, a real REST API out.** Drop a flat JSON file; Stubbase
   infers relationships, mounts CRUD, and serves nested routing. Zero database
   configuration.
2. **A full API pipeline, not a mock.** Requests run through real middleware —
   auth and ownership, schema validation, chaos injection, webhook proxying — so
   the stub behaves like the backend it stands in for. Mocking tools have no
   middleware pipeline.
3. **An agent-native datastore.** An LLM can join and aggregate across a
   project's resources over MCP with read-only SQL, while the JSON files stay
   authoritative.

Explicitly *not* positioning: the engineering density (scale-to-zero
multi-tenancy on a 1GB / $4-per-month VPS). That is a deployment fact and an
enabler of the free tier, not a claim to sell on.

## Operating Context

**Hub-and-spoke content, segmented by role and use case.** The landing site is
deliberately structured as one combined home page plus a growing set of
segment-specific pages, modeled on xmind.com's `/roles/<role>` and
`/use-cases/<case>` architecture. Each page speaks to one segment in its own
vocabulary and leads with the positioning claim that fits it.

- Shipped spokes today: `solutions/`, `features/`, `compare/` — Markdown in
  `sites/landing/src/content/`, rendered through a shared layout, with the nav
  reading a single source of truth (`src/lib/nav.ts`).
- Planned: `roles/` and `use-cases/` collections in the same shape.
- **This set grows continuously.** Adding a page must stay a cheap, repeatable
  act — one content file plus one nav entry — and the design system must hold up
  across dozens of these pages, not just the handful that exist now.

**How the product is actually used:** a developer signs up on the dashboard,
creates a project, edits JSON resources in a browser editor (or has the AI
Co-Pilot stage them), deploys drafts live, then calls the resulting endpoints
from their own client code, from `curl`, or from an AI agent over MCP. Live
request logs stream back into the dashboard while they work.

**Four routing zones:** marketing site, dashboard SPA, dashboard API, and the
core tenant API — each on its own subdomain of `stubbase.dev`.

## Capabilities and Constraints

Shipped and working:

- Multi-tenant JSON-to-CRUD core: list/read/create/replace/delete, exact-match
  filtering, `_sort`/`_order`, `_page`/`_limit`/`_offset`, `_expand` relational
  nesting, `X-Total-Count`, auto-generated `openapi.json`.
- Dashboard: email/password accounts, projects, a JSON resource editor with a
  draft-then-deploy model, live streaming request logs, usage metering, JSON
  diagnostics, per-tenant environment/config editing, developer API keys.
- AI Co-Pilot: a real agent loop that stages schema drafts, deploys, starts and
  stops a project, and reads logs to diagnose. It may never destroy data on its
  own — deletions are confirmed by a user click.
- Per-tenant auth (JWT), record ownership/RBAC, schema validation, webhook
  proxying with an SSRF guard, notification proxy, virtual start/stop.
- MCP over HTTP+SSE with one `execute_sql_query` tool against a read-only
  in-memory SQLite projection; developer API keys for external agents.

**Not built yet — the user is building these one at a time. Do not present them
as shipped, and do not invent new claims in the same family:**

- `?delay` / `?status` URL simulation params (currently advertised on the
  landing page; the header-driven chaos controls do exist).
- Billing and payment. Plans (Free / Pro QA $15 / Pro+AI $29) are displayed but
  no checkout exists; every account is `free`. Lemon Squeezy is the intended
  merchant of record, after MVP.
- The `public` demo tenant with the six advertised resources — so the home
  "Try it live" runner falls back to a sample, and the Free Resources links 404.
- OAuth login (Google/GitHub), password reset, contact-form backend.
- Delete-project and delete-resource UI (the API and hooks exist).
- AI Co-Pilot plan gating and per-account usage caps.
- Not yet deployed: there is no live `stubbase.dev` production instance.

Hard constraints that shape the product:

- The whole platform is sized for a single 1GB VPS. Both frontends must build to
  static files; neither may acquire a server-side runtime.
- Zero npm dependencies on both backends.
- The core admin secret must never reach a browser.

## Brand Commitments

- **Name:** Stubbase. **Canonical domain:** `stubbase.dev` — the `.com` is not
  owned and must never be used in copy, links or schema markup.
- **Assets:** the wordmark ships as SVG with text converted to outlines, so it
  is resolution-independent and carries no font dependency — both sites hold the
  identical set in `public/`: `stubbase-logo-text-dark.svg`,
  `stubbase-logo-text-light.svg` (theme-paired; every call site sizes them by
  height with `w-auto`), `stubbase-logo.svg` (icon only, no theme variant — the
  mark is emerald in both), plus `favicon-32.png` and an opaque
  `apple-touch-icon.png`. `dashboard-ui.png` (landing) is the og:image.
- **Voice:** technical, exact, developer-direct. Concrete mechanisms and real
  endpoint names over adjectives.
- **Copy on the landing pages is SEO/RAG-tuned.** H2 wording, code blocks and
  vocabulary are deliberate exact-match targets — they are not to be reworded
  casually as part of a visual pass.
- **Both frontends ship light and dark themes**, always, sharing one token
  vocabulary so the marketing site and the app read as one system.

## Evidence on Hand

Real:

- A complete, working implementation of everything listed as shipped above,
  runnable locally (`bun run scripts/dev.ts`) and as a production-shaped Docker
  stack — so live demos and real screenshots are available on demand.
- `sites/landing/public/dashboard-ui.png` — product screenshot in use on the
  home page.
- Documented, verifiable API surface (README.md, ENVIRONMENT.md, BUILD.md) and a
  black-box regression suite.
- Starter examples with real advertised queries (`sites/dashboard/src/lib/starters.ts`).

Absent — future work must not fabricate these:

- No customers, users, testimonials, case studies, logos, press or reviews.
- No benchmarks, uptime figures, latency numbers or request-volume statistics.
- No revenue, funding, team-size or "trusted by" claims.
- No live production deployment to point at.

## Product Principles

1. **Segment pages are the growth surface.** One page per role or use case,
   combined on the home page. Adding another must stay cheap and must not
   degrade the system — design for dozens, not for the current handful.
2. **Claim only what ships.** The gap between the marketing copy and the built
   product is a known debt being paid down one feature at a time; design work
   closes that gap and never widens it.
3. **The endpoint is the product.** Every surface is judged by how fast it gets
   someone to a working URL they can call. The dashboard is a means to that, not
   the destination.
4. **A stub that behaves like a backend.** Real auth, real validation, real
   failure modes. Fidelity to production behavior is the differentiator against
   every mocking tool.
5. **Agents are a first-class client**, alongside browsers and `curl`. Anything
   a person can do to a project, an agent should be able to do too — except
   destroy data unasked.

## Accessibility & Inclusion

No external standard has been committed to. One practice is already binding: the
light and dark themes are contrast-engineered per theme rather than mechanically
inverted — status, syntax and brand colors are re-picked so text keeps legible
contrast on both grounds. Any color work must preserve that.
