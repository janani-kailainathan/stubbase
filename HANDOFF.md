# Stubbase — where the work stands

**Date:** 31 Aug 2026
**Branch:** `master`, in sync with `origin/master` (0 unpushed commits)
**HEAD:** `0d6d217` — Sign in from the landing page with Google One Tap

Multi-tenant, scale-to-zero JSON-to-CRUD hosting on a 1GB VPS. Two zero-dependency
Bun backends, a static landing site and a React SPA. The product is feature-complete
for a first release; what is left is money, DNS and a box.

---

## Verified today

| Check | Result |
|---|---|
| `bun test` | **187 pass, 0 fail**, 875 assertions, 3 files (5.40s) |
| `bun run scripts/build.ts` | **BUILD SUCCESS** — all 4 reactor modules (9.7s) |
| `sites/*/dist/` | Present and current for both sites |
| Unpushed commits | 0 |
| Uncommitted files | 4 |

The `google-one-tap` branch is identical to `master` — fully merged, safe to delete.

```
$ bun test
187 pass · 0 fail · 875 expect() calls · 3 files [5.40s]

$ bun run scripts/build.ts
stubbase-core ............ SUCCESS [3.483 s]
stubbase-dashboard-api ... SUCCESS [1.623 s]
stubbase-landing ......... SUCCESS [2.055 s]
stubbase-dashboard ....... SUCCESS [2.581 s]
BUILD SUCCESS
```

---

## Working tree: one uncommitted change

**Sign-out leaves for the marketing site.** Three source files that belong together,
plus roadmap notes in `plan.txt`. The change is coherent and the suite is green over
it — finished work waiting for a commit message, not work in progress.

| File | Diff | What it does |
|---|---|---|
| `sites/dashboard/src/components/shell/TopBar.tsx` | +15 / −2 | Clicking log out calls `logout()` then navigates to the landing site. An *involuntary* 401 still falls through to `/login`, which is why the redirect lives at the click and not in the auth store. |
| `sites/dashboard/src/lib/api.ts` | +4 | `keepalive: true` on the logout POST, so navigating away doesn't cancel it and leave the session live server-side. |
| `sites/landing/src/components/Nav.astro` | +6 / −6 | Signed-in nav drops the duplicate "Dashboard" text link; the CTA already points at the same URL. |
| `plan.txt` | +14 / −1 | New roadmap lines: one-click backend, email-code registration, subscriptions, full auth with RBAC, three worked examples. |

---

## Shipped

### Core engine — `apps/core/server-core.ts` (2,318 lines, 0 npm deps)
- JSON-to-CRUD with relations, filtering, sorting, pagination, OpenAPI
- Middleware pipeline: status → quota → auth → chaos → validation → webhooks
- Tenant JWT auth, OAuth, ownership/RBAC, email + SMS notify proxy
- Read-only in-memory SQLite projection behind MCP, tenancy pinned at connect time
- Usage metering, request quotas (plan-blind, fail-open), capped live log ring

### Dashboard API — `apps/dashboard-api/server-app.ts` (2,264 lines, 0 npm deps)
- argon2id auth, sha256-hashed opaque sessions, developer API keys
- Google + GitHub sign-in, and Google One Tap on the landing origin
- Plan enforcement: features at write time, request allowance at request time
- AI Co-Pilot agent loop with a tool catalogue that can stage but never delete
- Files proxy, draft/deploy model, diagnostics, SSE log + MCP proxies

### Dashboard SPA — `sites/dashboard/`
- Light + dark; theme and session hint carried across the origin boundary
- Nine starter cards — three seedable and under test, six placeholders
- Plan shown with off-plan controls disabled and explained, never hidden
- Project delete wired; resource delete has a hook but no affordance yet

### Landing site — `sites/landing/`
- 8 hardcoded pages + 13 content spokes (3 features, 5 roles, 2 use-cases, 2 compare, 1 guide)
- Changelog as data; one unreleased entry dated `null` until go-live
- `/pricing` leads with a donation; both paid tiers marked coming soon
- One conditional third-party script (Google One Tap), nothing else

---

## Open — what stands between here and a live service

| Item | State | Notes |
|---|---|---|
| **Billing** | Blocker | No payment gateway. Plans are set with `UPDATE users SET plan = …`. `TODO.md` names Lemon Squeezy as merchant of record. Flipping `comingSoon` per tier on `/pricing` is the only page change needed. |
| **DNS + deploy** | Blocker | Five records at Namecheap, then the Ansible playbook with a generated `STUBBASE_ADMIN_SECRET` reused forever after. Certs need live DNS first. Checklist in `BACKLOG.md`. |
| **Public demo tenant** | Local only | Seeded here with all six resources; needs seeding on the box or the home page falls back to its sample and the Free Resources links 404. |
| **Forgot password** | Dead link | The link is at `sites/dashboard/src/pages/Login.tsx:67`; there is no reset flow or endpoint behind it. |
| **Contact form** | Markup only | No endpoint or form service behind `/contact`. |
| **Delete resource UI** | Hook only | `useDeleteResource` exists and is unused; project delete is wired in `TopBar`. |
| **Stress test** | Not started | On `plan.txt`; nothing has run against the 1GB sizing yet. |

---

## Found while surveying — three things worth knowing first

**1. Plain `grep` goes blind on `server-core.ts`.**
The usage map keys tenants by `` `${tenantId}\0${day}` ``, and those three literal NUL
bytes make `grep` treat the file as binary — it silently returns nothing for terms
that are plainly there (`PIPELINE`, `chaosGuard`, `QA_MODE`). Use `grep -a` or `rg`.
The bytes are deliberate and safe: `NAME_RE` forbids NUL in tenant ids, so the
composite key can't be forged.

**2. `BACKLOG.md` is stale in four places.**
It still says OAuth is postponed and its buttons removed, that `users.plan` is always
free, that billing plans are display-only, and that the Co-Pilot is ungated. All four
shipped: sign-in in `b0c0bed` and `0d6d217`, plans in `53c5f15`, per-plan dev seeds in
`ba70c8b`, and `aiChat` now answers 402 before it ever checks whether a provider key
exists. Trust `CLAUDE.md`, which is current.

**3. `.env.example` is missing `PUBLIC_GOOGLE_CLIENT_ID`.**
The local `.env` has it, so One Tap works here. A fresh clone builds a landing site
that never prompts — and, by design, never calls Google at all — with nothing to
explain why.

---

## Next — where to pick this up

1. **Commit the sign-out change.** Three files, tests green, one message. Then delete
   the merged `google-one-tap` branch.
2. **Refresh `BACKLOG.md` and `.env.example`.** Cross off the four shipped items, add
   the missing client-id key. Five minutes, and it stops the next session re-deriving
   all of this.
3. **Decide the launch order: billing or box first.** Deploying without billing is
   viable — Free is genuinely live and the paid tiers already read as pre-order.
   Wiring Lemon Squeezy first means launching with a working checkout but a longer
   wait. The DNS and smoke-test steps in `BACKLOG.md` are ready either way.
4. **Close the dead ends before traffic arrives.** Forgot-password and the contact
   form are both visible promises with nothing behind them — cheaper to fix than to
   explain.
5. **Stress test against the 1GB sizing.** Every memory decision in the engine is a
   bet that has never been measured under load.

---

*Compiled from the working tree at `0d6d217` on 31 Aug 2026, with `bun test` and
`scripts/build.ts` run to confirm the status above rather than inferred from the log.*
