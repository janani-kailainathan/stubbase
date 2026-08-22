# Backlog

## Go-live checklist (when ready to host)

1. **Namecheap DNS** (Domain List → stubbase.dev → Manage → Advanced DNS) — replace `YOUR_VPS_IP`:

   | Type | Host | Value | TTL |
   |---|---|---|---|
   | A | `@` | YOUR_VPS_IP | Automatic |
   | A | `app` | YOUR_VPS_IP | Automatic |
   | A | `api` | YOUR_VPS_IP | Automatic |
   | A | `api.app` | YOUR_VPS_IP | Automatic |
   | CNAME | `www` | `stubbase.dev.` | Automatic |

   - Delete Namecheap's parking defaults first (CNAME `www → parkingpage.namecheap.com`, any "URL Redirect Record" on `@`).
   - Don't use Namecheap's URL-redirect for `www` — Caddy handles the redirect and its cert.
   - Wait until the names resolve (`dig +short stubbase.dev`) **before** deploying: Caddy needs live DNS to obtain Let's Encrypt certs.

2. **Deploy** (see [BUILD.md](BUILD.md#production-builds--deploy)): build both frontends, set the VPS IP in `deploy/inventory.ini`, run the playbook with a generated `STUBBASE_ADMIN_SECRET` — and keep reusing that same secret for every future deploy.

3. **Post-deploy smoke test**: `https://stubbase.dev` (landing), `https://www.stubbase.dev` (redirects to apex), sign up on `https://app.stubbase.dev`, create a project, curl `https://api.stubbase.dev/<tenant>/<resource>`.

## Pending features / content

- **`public` demo tenant** on the core with the six resources the landing page advertises (`posts`, `comments`, `albums`, `photos`, `todos`, `users`) — until then the Home "Try it live" demo uses its fallback sample and the Free Resources links 404.
- **OAuth login** (GitHub/Google) — deliberately postponed; buttons removed from the UI.
- **Forgot password** — link exists on the login page but there's no reset flow/endpoint.
- **Contact form backend** — the landing `/contact` form is markup-only (no endpoint or form service).
- **Delete project / delete resource UI** — API + hooks exist (`useDeleteProject`, `useDeleteResource`); no affordance in the dashboard yet.
- **Landing `?delay` / `?status` simulation params** — marketed on the landing page (Quick Start, FAQs) but not implemented in the core engine.
- **Cloudflare CDN** (from the original brief) — if enabled later, set the five records to DNS-only during first cert issuance or switch TLS mode to "Full (strict)".
- **Billing** — plans are displayed (Free / Pro QA $15 / Pro+AI $29) but there's no payment integration; `users.plan` is always `free`.
- **AI Co-Pilot gating** — the conversational agent ships (schema staging, deploy, start/stop, log-reading diagnostics via function calling), but it is available to every account: nothing ties it to the Pro+AI plan, and there is no per-account usage cap on provider calls.
