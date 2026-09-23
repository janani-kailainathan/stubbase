# Plans, AI credits and request add-ons: build plan

Status: draft for review, 2026-09-24. Nothing here is built yet.

Stubbase moves to two self-serve plans, Free and Pro. The Co-Pilot is metered
in AI credits, which you buy in packs, instead of being unlocked by a plan. The
work is split into phases that ship one at a time. Each phase stands on its own,
passes `scripts/build.ts`, and leaves the product working.

Sources: `docs/plan.txt` and `docs/request package plan.txt`, both reviewed on
2026-09-23. This file replaces them wherever the two disagree.

---

## 1. Decisions

| Topic | Decision |
| --- | --- |
| Plans | Free and Pro. Enterprise is a "Let's talk" card on the pricing page, with no code behind it. |
| Request add-ons | Pro only, on purpose, so a cheap pack does not take the place of a subscription. A pack is a **one-time pool** of requests, drawn on once the month's plan allowance is spent, and valid for 12 months. (Decided 2026-09-24.) |
| AI | Metered in credits (1 credit = 1,000 tokens). Pro gets a monthly grant, Free gets a one-time welcome gift, and credit packs are open to any plan. |
| AI model | Gemini 3.1 Flash-Lite on Vertex AI. |
| Project features | **Not gated.** Webhooks, QA mode, auth and RBAC stay on every plan. |
| Sign-up | Unchanged. Email and password (with code verification) stays, OAuth stays, and there is no GitHub account-age check. |
| Rate limits | Unchanged mechanism: one per-account token bucket in the core, not per IP and not in Caddy. Only the numbers move. |
| Registration cap | 1,000 **active** Free accounts. Deleted accounts do not count. |
| Hosting | The target box is a 4GB Hetzner CX23, up from the 1GB box CLAUDE.md sizes for. |
| Payment gateway | **Undecided, and out of this plan.** Plans, packs and credits stay granted by hand (SQL or a script), as plans and add-ons are today. |
| Warning emails, grace period, auto-recharge | Later (section 4). |

---

## 2. Target model

### 2.1 Plans

| | Free | Pro | Today |
| --- | --- | --- | --- |
| Plan id | `free` | `pro` | `free`, `pro` ("Pro QA"), `pro_ai` |
| Price | $0 | $29/mo | $0 / $15 / $29 |
| Requests/month | 10,000 | 250,000 | 5,000 / 50,000 / 250,000 |
| Rate (per account) | 5/s, burst 20 | 50/s, burst 150 | 5 / 20 / 50 per second |
| AI credits | 100 gift credits, expire 3 months after sign-up, never refresh | 1,000 per calendar month, no rollover | Co-Pilot on Pro + AI only |
| Request add-ons | Not available | Available | Any plan |
| AI credit packs | Available | Available | n/a |
| Project features | All | All | All |

Enterprise has no plan id.

### 2.2 Request add-ons (Pro only)

| Pack | Price (one-time) | Today |
| --- | --- | --- |
| +250,000 requests | $9.99 | $10/mo |
| +1,000,000 requests | $24.99 | $19/mo |

- The +100,000 pack ($5 today) is retired.
- A pack is a pool of requests bought once and valid for 12 months from its
  grant. It is not a monthly amount: requests come out of the plan's monthly
  allowance first, and only once that is spent does traffic draw the pool down.
  What is left in the pool carries from month to month until the 12 months end.
- A pack held by a Free account is not drawn on. It still expires on schedule.
- Packs stack. Pools are drawn soonest-expiring first.
- This changes how the core is quoted: today `limit` is the plan plus add-ons
  for the month. With pools, `limit` becomes the plan's monthly allowance plus
  what is left in the account's pools, and the Dashboard API has to count
  overflow traffic against the pools as it ingests usage.

### 2.3 AI credits

**1 credit = 1,000 tokens**, counting input, output and thinking tokens as
reported in the provider's `usageMetadata.totalTokenCount`. A Co-Pilot turn is
charged once, when it ends: all its rounds' tokens are added up, divided by
1,000 and rounded up.

| Source | Credits | Expires | Who |
| --- | --- | --- | --- |
| Welcome gift | 100 | 3 months after sign-up | New Free accounts, once per account. A revived account (deleted, then signed up again) does not get another. |
| Pro monthly grant | 1,000 | End of the calendar month (UTC) | Pro |
| Starter pack | 5,000 | 365 days after grant | Any plan, $4.99 |
| Builder pack | 20,000 | 365 days after grant | Any plan, $14.99 |
| Scale pack | 60,000 | 365 days after grant | Any plan, $39.99 |

- Credits are spent **soonest-expiring first**, so the monthly grant and the
  welcome gift go before any pack.
- The Co-Pilot is gated by the balance, not the plan. With no credits left, a
  turn is refused with 402.
- **Cost warning.** A turn is up to 5 model rounds (`AI_MAX_TOOL_ROUNDS = 4`
  plus a final round without tools), and each round resends the persona, the
  tool catalogue and the history. A turn may cost 5 to 20 credits, not 1. The
  credit amounts above are provisional until Phase 4 measures real turns.

---

## 3. Build phases

The order holds the wallet safe. The Co-Pilot stays Pro-only until credits
exist (Phase 4), so no phase opens AI to Free accounts without metering.

Every phase that adds or changes an invariant adds the test that breaks it, and
updates CLAUDE.md, ENVIRONMENT.md and FEATURES.md where they describe it.

### Phase 1: Two plans instead of three

**Scope**
- `PLANS` in `apps/dashboard-api/server-app.ts` becomes `free` and `pro` with
  the numbers in 2.1. `pro` keeps `features: ["ai"]` for now, so the Co-Pilot
  gate becomes "Pro" until Phase 4 replaces it.
- No migration for `pro_ai` rows: nothing is deployed, so the local dev
  accounts were deleted and seeded again instead (done 2026-09-24).
- `cheapestPlanWith`, the 402 message and `PlanNotice` in the SPA name "Pro".
- `scripts/seed-dev-users.ts` seeds one account per plan (two, not three).

**Tests** (`tests/dashboard-api.test.ts`)
- `/auth/me` and `/auth/account` report the new numbers.
- `quotaFor` quotes 10,000 / 250,000 and the new rates.

### Phase 2: Request add-ons, Pro only, 12 months

**Scope**
- Schema: `account_addons` is keyed `(user_id, addon)` with a `quantity`, which
  cannot hold two grants with different expiries. Replace it with one row per
  grant: `id, user_id, addon, granted_at, expires_at`. The migration turns each
  existing row into `quantity` grants dated from its `created_at`, or the rows
  are simply dropped: nothing is deployed, so local data can be reset.
- `ADDONS`: drop `requests_100k`. Keep `requests_250k` and `requests_1m`. An
  id missing from `ADDONS` still adds nothing.
- Each grant records `requests` and `remaining`. At usage ingest, requests over
  the month's plan allowance are taken from the account's unexpired pools,
  soonest-expiring first, in one synchronous turn.
- `allowanceOf` adds the pools' `remaining` only when the account is on Pro. It
  stays the single place a plan and its add-ons combine.
- The SPA's usage and account views show each pack's expiry.
- Deleting an account still removes its grants.

**Tests**
- A Free account holding a pack gets the Free allowance.
- An expired pack adds nothing, and a pack in force adds what is left in it.
- Traffic within the plan allowance leaves the pool untouched. Traffic over it
  draws the pool down, and what is left carries into next month.
- Two grants stack and are drawn soonest-expiring first.

### Phase 3: Vertex AI provider (Gemini 3.1 Flash-Lite)

**Scope**
- New `apps/dashboard-api/ai/vertex-ai.service.ts` implementing `IAIService`.
  Endpoint:
  `https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/publishers/google/models/{MODEL}:generateContent`.
  The body is the same `contents`/`tools` shape the Google AI provider already
  sends.
- Auth with no npm dependencies: read a service-account key file, sign an RS256
  JWT with `crypto.subtle`, exchange it at `oauth2.googleapis.com/token` for an
  access token, and cache that until shortly before it expires (~1 hour).
- `IAIService.chat()` returns `usage` (`promptTokens`, `outputTokens`,
  `totalTokens`) from `usageMetadata`. Both providers fill it in, so Phase 4
  does not depend on which one is in use.
- `ai/index.ts` picks the provider with `AI_PROVIDER=vertex|google`. New env
  vars: `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_CREDENTIALS_FILE`. The
  key file lives in `/etc/stubbase/`, never in git, and is readable under
  `ProtectSystem=strict` with no new `ReadWritePaths`.
- The Dockerfile `COPY` and the Ansible copy task gain the new file.
- The key stays server-side, like `GOOGLE_AI_API_KEY`.

**Check before building**
- The exact model id, and that it supports function calling (the Gemma family
  does not).
- That it still needs `thoughtSignature` parts echoed back verbatim.
- Which region serves it.

**Tests**
- Point a mock server at the provider with an env-overridable base URL, as the
  existing OAuth and Resend mocks do. Check the token exchange, token caching,
  and that `usage` is parsed.

### Phase 4: AI credits

**Scope**
- Schema: `ai_credit_grants` (`id, user_id, source, credits, remaining,
  granted_at, expires_at`), where `source` is `welcome`, `monthly` or a pack
  id. `AI_PACKS` sits next to `ADDONS` as the single source of pack sizes.
- **Welcome gift**: granted in `createOrReviveUser`, only when a new row is
  inserted. A revived row gets none, because the id lineage already had its
  gift.
- **Pro monthly grant**: created lazily on the account's first Co-Pilot use in
  a calendar month, so no cron job is needed.
- **Charging**: `aiChat` adds up `usage.totalTokens` over every round of the
  turn, including rounds that failed partway. It charges
  `ceil(tokens / 1000)`, drawing from grants soonest-expiring first, in one
  synchronous turn so two turns cannot each spend the same credits.
- **Gate**: a turn needs a balance of at least 1. The 402 for no credits still
  comes after the ownership check (a stranger gets 404) and before the provider
  check, so the refusal does not reveal whether the server has a key. The
  `features: ["ai"]` plan gate is removed.
- **One turn at a time per account** (an in-memory Set), so parallel turns
  cannot each pass the balance check and overrun it together.
- Response: `creditsCharged` and `creditsRemaining`. The SPA shows a toast
  ("Used 7 credits") and a balance in place of the Pro-only `PlanNotice`.
- `/auth/me` or `/auth/account` reports the balance and the grants with their
  expiries.
- **Measure first**: log tokens per turn in dev across typical prompts (a
  3-table schema, "seed 50 rows", a diagnostics question) and set the final
  pack sizes and prices from that.

**Tests**
- A new Free account has 100 credits, and has none 3 months later.
- A revived account gets no second gift.
- Pro gets 1,000 a month, and last month's leftover is gone.
- Spending order is soonest-expiring first.
- The charge equals the sum of tokens across rounds, rounded up.
- Zero balance: 402, before the provider check, for Free and Pro alike.
- A second turn while one is running is refused.
- Deleting an account removes its grants.

### Phase 5: Cap of 1,000 active Free accounts

**Scope**
- The count is
  `SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND plan = 'free'`.
- It is checked only where an account would be created: at `POST /auth/signup`
  (before any code is emailed, so a waitlisted address costs no send), again at
  `POST /auth/signup/verify` (the count may have moved), and in
  `signInWithIdentity` for a new OAuth account. A revived account counts as a
  new one. An existing account always signs in.
- Count and insert happen in one synchronous turn, so two sign-ups cannot both
  take the last place.
- Pro accounts do not count toward the cap and are never refused.
- `DASHBOARD_FREE_ACCOUNT_CAP` (default 1000, `0` = no cap), so the cap can move
  without a redeploy.
- Refusal: the password path answers a dedicated error, and OAuth goes through
  `oauthFailed` with a new `waitlist` code and a matching `OAUTH_MESSAGES`
  entry. The SPA shows a waitlist screen.

**Tests**
- At the cap, a new sign-up is refused on every path.
- A deleted account frees a place.
- An existing account still signs in.
- A Pro account is not counted.

### Phase 6: Pricing page and docs

**Scope**
- `sites/landing/src/pages/pricing.astro`: tiers Free / Pro / Enterprise.
  Remove the copy that describes feature gating ("Unlocks ChaosGuard",
  "Ephemeral instances" versus "Always-on"), since every project feature is on
  every plan. Request add-ons are listed as Pro only. A new AI credit packs
  block is added. Paid items keep `comingSoon: true` and `PreOrder` until a
  gateway exists.
- FEATURES.md (plans, add-ons, credits), a changelog entry, and the CLAUDE.md
  plan invariants rewritten for credits.

### Phase 7: Retarget from 1GB to 4GB

**Scope**
- Update CLAUDE.md's "1GB VPS" constraint and README to the CX23.
- Review each cap sized for 1GB (tenant RAM cache, `LOG_CAP`, the rate
  limits' "box's fuse" note, argon2 params). Raise a cap only after measuring
  it, one knob at a time.
- This does not block Phases 1 to 6, which are sized for either box.

---

## 4. Later (not in this plan)

- **Payment gateway**: undecided. When chosen, it grants plans, request packs
  and credit packs by writing the same rows the manual process writes now, and
  the pricing page's `comingSoon` flips.
- **Usage warning email at 80%** of the monthly request allowance.
- **Grace period / soft cap**: keep serving about 10,000 requests past the
  limit and email before pausing. Today the core stops hard at
  `used >= limit`.
- **Auto-recharge**: buy a request pack automatically when the limit is hit.
  Needs the gateway.
- **Enterprise**: custom isolated nodes, sold by conversation.

---

## 5. Open questions

1. ~~When does a request pack count within a month?~~ Settled 2026-09-24:
   a pack is a one-time pool valid 12 months, so there is no monthly share.
2. **Pro downgraded to Free, holding packs**: recommended that they go dormant
   (add nothing, still expire on schedule) and count again on returning to Pro.
3. **Existing accounts when credits launch**: give existing Free accounts the
   100-credit gift, expiring 3 months after launch? Recommended yes. Otherwise
   they are the only accounts that never had one.
4. **A turn that costs more than the balance left**: absorb the overrun (the
   balance stops at zero; the loss is bounded by the round limit) or record it
   as a negative balance? Recommended: absorb it.
5. **Waitlist**: just a message, or store the address to email later? Storing
   one means keeping personal data with a purpose.
6. **Existing `requests_100k` rows**: convert them to `requests_250k`, or
   honour them until they expire?
7. **Vertex details**: exact model id, region, and GCP project. Needed before
   Phase 3.
