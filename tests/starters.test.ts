/**
 * The dashboard's starter examples, checked against a real Core Engine.
 *
 * Each starter card advertises a query (`?_expand=…&status=…&_limit=…`). This
 * suite seeds that starter's data into a live core and runs exactly that query,
 * so a card can never promise something its seed data cannot answer — a wrong
 * foreign-key name, a filter no record matches, or an `_expand` target that
 * isn't there.
 *
 * The starter data is plain TS (sites/dashboard/src/lib/starters.ts) precisely
 * so it can be imported here rather than duplicated.
 *
 *   bun test tests/starters.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLANNED_STARTERS, STARTERS, countRecords } from "../sites/dashboard/src/lib/starters.ts";
import { RAW_KEY, maskValue, mergeEnv, parseEnvText, socialLoginConfigured } from "../sites/dashboard/src/lib/env.ts";
import { emailVerificationEnabled, groupEndpoints } from "../sites/dashboard/src/lib/endpoints.ts";
import { adminAuth, seedTenant, startCore, stopServices, type Service } from "./helpers.ts";

let ROOT = "";
let core: Service;

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "stubbase-starters-test-"));
  core = await startCore(ROOT, "core");
  // One tenant per starter, seeded exactly as the dashboard would write it —
  // including the config an `auth` starter stages. The `-w` twin exists so the
  // write tests can POST without changing the row counts the read tests assert.
  for (const starter of STARTERS) {
    const files = {
      ...starter.resources,
      ...(starter.config ? { config: starter.config } : {}),
      ...(starter.rbac ? { rbac: starter.rbac } : {}),
    };
    await seedTenant(core, starter.id, files);
    await seedTenant(core, `${starter.id}-w`, files);
  }
}, 30_000);

afterAll(async () => {
  await stopServices([core]);
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
});

/** The one-time code a request left in its project's log — where it goes with no Resend key, as in every starter. */
async function loggedCode(tenant: string, correlationId: string | null): Promise<string> {
  const { entries } = await fetch(`${core.base}/${tenant}/_admin/logs`, { headers: adminAuth }).then((r) => r.json());
  const note = entries.find((e: { correlationId: string }) => e.correlationId === correlationId)?.note ?? "";
  const code = /: (\d{6}) —/.exec(note)?.[1];
  if (!code) throw new Error(`no code in ${tenant}'s log for ${correlationId}`);
  return code;
}

/**
 * Signs up on a starter's tenant and answers with the account's tokens (201),
 * finishing email verification the way the project's owner would when the
 * starter has it on: with the code from the Logs tab.
 */
async function signUp(tenant: string, email: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const post = (route: string, body: unknown) =>
    fetch(`${core.base}/${tenant}/auth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const res = await post("signup", { email, password: "password123", ...extra });
  if (res.status !== 202) return res;
  const { verificationId } = (await res.json()) as { verificationId: string };
  return post("signup/verify", { verificationId, code: await loggedCode(tenant, res.headers.get("x-correlation-id")) });
}

/**
 * A starter's config lands in a project whose .env is the commented-out
 * template. The keys are what the core acts on and the raw text is what the
 * editor re-compiles on Save, so the two must still agree after the merge.
 */
describe("a starter's config merged into a templated .env", () => {
  const TEMPLATE = [
    "# ── Auth ──",
    "# Who emails come from — already set by the owner, and it must survive.",
    "RESEND_FROM=Owner <owner@example.com>",
    "",
    "# The switch.",
    "# AUTH_ENABLED=true",
    "",
    "# Resources anyone may read without a token, comma-separated.",
    "# AUTH_PUBLIC_ROUTES=posts,comments",
    "",
  ].join("\n");

  test("uncomments the template's lines, so what Save compiles is what the core acts on", () => {
    const configured = STARTERS.filter((s) => s.config);
    expect(configured.length).toBeGreaterThan(0);
    for (const starter of configured) {
      const { [RAW_KEY]: raw, ...keys } = mergeEnv(
        { RESEND_FROM: "Owner <owner@example.com>", [RAW_KEY]: TEMPLATE },
        starter.config!,
      );
      expect(parseEnvText(raw).env).toEqual(keys);
      expect(keys.RESEND_FROM).toBe("Owner <owner@example.com>");
      for (const [key, value] of Object.entries(starter.config!)) {
        // Set once, where the template documents it — not appended as a second copy.
        expect(raw.match(new RegExp(`^#?\\s*${key}=.*$`, "gm"))).toEqual([`${key}=${value}`]);
      }
    }
  });

  /** The template's social login lines, as envTemplate writes them. */
  const SOCIAL = [
    "# 1.5.1 Google — fill in both values to turn on /auth/google.",
    "# Register this callback URL in your Google OAuth app:",
    "#   https://api.example/acme/auth/google/callback",
    "# AUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com",
    "# AUTH_GOOGLE_SECRET=GOCSPX-your-secret",
    "",
    "# 1.5.2 GitHub — fill in both values to turn on /auth/github.",
    "# AUTH_GITHUB_CLIENT_ID=Iv1.a1b2c3d4e5f6",
    "# AUTH_GITHUB_SECRET=your-github-secret",
    "",
  ].join("\n");
  const SOCIAL_KEYS = ["AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_SECRET", "AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_SECRET"];
  /** The template above has the owner's RESEND_FROM live, so the stored keys have it too. */
  const OWNER = { RESEND_FROM: "Owner <owner@example.com>" };
  const linesFor = (raw: string, key: string) => raw.match(new RegExp(`^#?\\s*${key}=.*$`, "gm"));

  test("turning auth on uncomments the Google and GitHub lines in place, empty, and the core leaves them off", async () => {
    const { [RAW_KEY]: raw, ...keys } = mergeEnv({ ...OWNER, [RAW_KEY]: TEMPLATE + SOCIAL }, { AUTH_ENABLED: "true" });
    for (const key of SOCIAL_KEYS) expect(linesFor(raw, key)).toEqual([`${key}=`]);
    // Under the template's own comments, not moved to the end.
    expect(raw).toContain("#   https://api.example/acme/auth/google/callback\nAUTH_GOOGLE_CLIENT_ID=\nAUTH_GOOGLE_SECRET=");
    expect(parseEnvText(raw).env).toEqual(keys);
    expect(socialLoginConfigured(keys)).toBe(false);
    // …and the .env view shows an empty secret as empty, not as a masked value that looks filled in.
    expect(maskValue("AUTH_GOOGLE_SECRET", "")).toBe("");

    // Empty is off on the core too, so exposing the lines switches nothing on.
    await seedTenant(core, "oauth-exposed", { config: keys });
    expect((await fetch(`${core.base}/oauth-exposed/auth/google`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${core.base}/oauth-exposed/auth/github`, { redirect: "manual" })).status).toBe(404);
  });

  test("a line with a value is never touched, and a provider already set up leaves the rest commented", () => {
    const half = TEMPLATE + SOCIAL.replace("# AUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com", "AUTH_GOOGLE_CLIENT_ID=real-client-id");
    const partly = mergeEnv({ ...OWNER, AUTH_GOOGLE_CLIENT_ID: "real-client-id", [RAW_KEY]: half }, { AUTH_ENABLED: "true" });
    expect(linesFor(partly[RAW_KEY], "AUTH_GOOGLE_CLIENT_ID")).toEqual(["AUTH_GOOGLE_CLIENT_ID=real-client-id"]);
    expect(partly.AUTH_GOOGLE_CLIENT_ID).toBe("real-client-id");
    expect(linesFor(partly[RAW_KEY], "AUTH_GOOGLE_SECRET")).toEqual(["AUTH_GOOGLE_SECRET="]);

    const whole = half.replace("# AUTH_GOOGLE_SECRET=GOCSPX-your-secret", "AUTH_GOOGLE_SECRET=real-secret");
    const setUp = mergeEnv(
      { ...OWNER, AUTH_GOOGLE_CLIENT_ID: "real-client-id", AUTH_GOOGLE_SECRET: "real-secret", [RAW_KEY]: whole },
      { AUTH_ENABLED: "true" },
    );
    expect(linesFor(setUp[RAW_KEY], "AUTH_GITHUB_CLIENT_ID")).toEqual(["# AUTH_GITHUB_CLIENT_ID=Iv1.a1b2c3d4e5f6"]);
    expect("AUTH_GITHUB_CLIENT_ID" in setUp).toBe(false);
  });

  test("a .env without the lines gets them, with this project's callback URLs and the guide", () => {
    const { [RAW_KEY]: raw, ...keys } = mergeEnv({ ...OWNER, [RAW_KEY]: TEMPLATE }, { AUTH_ENABLED: "true" }, { tenantBase: "https://api.example/acme" });
    for (const key of SOCIAL_KEYS) expect(linesFor(raw, key)).toEqual([`${key}=`]);
    expect(raw).toContain("#   https://api.example/acme/auth/google/callback");
    expect(raw).toContain("#   https://api.example/acme/auth/github/callback");
    expect(raw).toContain("# How to get the keys: https://stubbase.dev/guides/google-github-oauth-keys");
    expect(parseEnvText(raw).env).toEqual(keys);
  });

  test("the lines stay commented unless the patch switches auth on", () => {
    const { [RAW_KEY]: raw } = mergeEnv({ ...OWNER, [RAW_KEY]: TEMPLATE + SOCIAL }, { QA_MODE: "true" });
    for (const key of SOCIAL_KEYS) expect(linesFor(raw, key)?.[0].startsWith("# ")).toBe(true);
  });

  test("a key the template does not offer is appended, and a config with no text only merges keys", () => {
    const appended = mergeEnv({ [RAW_KEY]: TEMPLATE }, { SCHEMA_POSTS: "{}" })[RAW_KEY];
    expect(appended.trimEnd().endsWith("SCHEMA_POSTS={}")).toBe(true);
    expect(mergeEnv({ QA_MODE: "true" }, { AUTH_ENABLED: "true" })).toEqual({
      QA_MODE: "true",
      AUTH_ENABLED: "true",
    });
  });
});

/**
 * Turning auth on uncomments the Google and GitHub lines until a provider has
 * both keys. That has to be the core's own rule, or the lines would stop being
 * offered while the route still 404s.
 */
describe("social login counts as set up exactly when the core routes it", () => {
  test("a provider counts as set up only with both its keys, exactly as the core routes it", async () => {
    const half = { AUTH_ENABLED: "true", AUTH_GOOGLE_CLIENT_ID: "client-id-only" };
    const whole = { ...half, AUTH_GOOGLE_SECRET: "a-secret" };
    await seedTenant(core, "oauth-half", { config: half });
    await seedTenant(core, "oauth-whole", { config: whole });

    expect(socialLoginConfigured(half)).toBe(false);
    expect((await fetch(`${core.base}/oauth-half/auth/google`, { redirect: "manual" })).status).toBe(404);

    expect(socialLoginConfigured(whole)).toBe(true);
    expect((await fetch(`${core.base}/oauth-whole/auth/google`, { redirect: "manual" })).status).toBe(302);

    // Forkful ships no keys, so applying it offers the key lines.
    const forkful = STARTERS.find((s) => s.id === "recipes")!;
    expect(socialLoginConfigured(forkful.config)).toBe(false);
  });
});

/** `?_expand=authors` → the core nests the match under `author`. */
const singularize = (n: string) =>
  n.endsWith("ies") ? `${n.slice(0, -3)}y` : n.endsWith("ss") || !n.endsWith("s") ? n : n.slice(0, -1);

describe("starter examples", () => {
  test("the list really does escalate: plain, then auth alone, then relations, then both, then roles", () => {
    // The order is the pitch — a card claiming `relations` must have foreign
    // keys, and one without it must be a single flat resource.
    expect(STARTERS.map((s) => s.id)).toEqual(["tracker", "signin", "blog", "storefront", "recipes", "helpdesk", "accounts"]);
    expect(STARTERS.map((s) => s.features)).toEqual([
      [],
      ["auth"],
      ["relations"],
      ["relations", "auth"],
      ["relations", "auth"],
      ["relations", "auth", "rbac"],
      ["relations", "auth", "rbac"],
    ]);

    for (const starter of STARTERS) {
      const names = Object.keys(starter.resources);
      const rows = starter.resources[names[0]];
      expect(rows.length).toBeGreaterThan(0);
      const hasForeignKey = Object.keys(rows[0]).some((k) => k.endsWith("Id"));

      if (starter.features.includes("relations")) {
        expect(names.length).toBeGreaterThan(1);
        expect(hasForeignKey).toBe(true);
      } else {
        expect(names).toHaveLength(1);
        expect(hasForeignKey).toBe(false);
      }

      // Only an `auth` starter ships config, and it must actually enable auth.
      if (starter.features.includes("auth")) expect(starter.config?.AUTH_ENABLED).toBe("true");
      else expect(starter.config).toBeUndefined();
      // Only an `rbac` starter ships rules, and it must switch them on.
      if (starter.features.includes("rbac")) {
        expect(starter.config?.RBAC_ENABLED).toBe("true");
        expect(starter.rbac).toBeDefined();
      } else {
        expect(starter.rbac).toBeUndefined();
      }
    }
  });

  test("the placeholders stay placeholders, and stay distinguishable", () => {
    // Nine cards on the empty state: the real starters, then as many placeholders
    // as still fit (StarterGrid slices the list). The grid renders both, so a
    // placeholder that drifted into looking real — duplicate id, empty resource
    // list — would be a card promising an example that cannot be seeded.
    // Moving one into STARTERS is what makes the rest of this suite cover it.
    expect(STARTERS.length).toBeLessThanOrEqual(9);
    expect(STARTERS.length + PLANNED_STARTERS.length).toBeGreaterThanOrEqual(9);

    const ids = new Set(STARTERS.map((s) => s.id));
    for (const planned of PLANNED_STARTERS) {
      expect(ids.has(planned.id as never), `${planned.id} is in both lists`).toBe(false);
      ids.add(planned.id as never);
      // Names only — a placeholder has no records, and must not pretend to.
      expect(planned.resources.length).toBeGreaterThan(0);
      for (const name of planned.resources) expect(typeof name).toBe("string");
      expect(planned.title.length).toBeGreaterThan(0);
      expect(planned.blurb.length).toBeGreaterThan(0);
      // A `relations` claim needs somewhere for the relation to point.
      if (planned.features.includes("relations")) expect(planned.resources.length).toBeGreaterThan(1);
    }
    expect(ids.size).toBe(STARTERS.length + PLANNED_STARTERS.length);
  });

  test("every foreign key resolves to a record that exists", () => {
    for (const starter of STARTERS) {
      for (const [name, rows] of Object.entries(starter.resources)) {
        for (const row of rows) {
          for (const [field, value] of Object.entries(row)) {
            if (!field.endsWith("Id") || value === null) continue;
            const target = `${field.slice(0, -2)}s`;
            const targets = starter.resources[target];
            expect(targets, `${starter.id}: ${name}.${field} has no ${target} resource`).toBeDefined();
            expect(
              targets!.some((t) => String(t.id) === String(value)),
              `${starter.id}: ${name}.${field}=${value} matches no ${target} record`,
            ).toBe(true);
          }
        }
      }
    }
  });

  for (const starter of STARTERS) {
    test(`${starter.id}: the advertised query works on a real core`, async () => {
      const [path, rawQuery = ""] = starter.example.split("?");
      const resource = path.replace(/^\//, "");
      expect(Object.keys(starter.resources)).toContain(resource);

      const res = await fetch(`${core.base}/${starter.id}${starter.example}`);
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Record<string, any>[];
      expect(Array.isArray(rows)).toBe(true);
      // A query that returns nothing showcases nothing.
      expect(rows.length).toBeGreaterThan(0);

      const params = new URLSearchParams(rawQuery);

      // _expand: every requested relation is nested, and is a real object.
      const expanded = params
        .getAll("_expand")
        .flatMap((v) => v.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      for (const name of expanded) {
        const key = singularize(name);
        for (const row of rows) {
          expect(row[key], `${starter.id}: ${key} was not nested`).toBeTruthy();
          expect(typeof row[key]).toBe("object");
          expect(row[key].id).toBeDefined();
        }
      }

      // Plain field filters actually hold for every row returned.
      for (const [key, value] of params.entries()) {
        if (key.startsWith("_")) continue;
        for (const row of rows) expect(String(row[key])).toBe(value);
      }

      // _limit is respected, and X-Total-Count reports the unpaged total.
      const limit = params.get("_limit");
      if (limit) {
        expect(rows.length).toBeLessThanOrEqual(Number(limit));
        expect(Number(res.headers.get("x-total-count"))).toBeGreaterThanOrEqual(rows.length);
      }

      // _sort/_direction really ordered the result.
      const sort = params.get("_sort");
      if (sort) {
        const values = rows.map((r) => r[sort]).filter((v) => v !== null && v !== undefined);
        const sorted = [...values].sort((a, b) => String(a).localeCompare(String(b)));
        if (params.get("_direction") === "desc") sorted.reverse();
        expect(values).toEqual(sorted);
      }
    }, 15_000);
  }

  test("each auth starter reads publicly but refuses an unauthenticated write", async () => {
    const authOnly = STARTERS.filter((s) => s.features.includes("auth") && !s.features.includes("rbac"));
    expect(authOnly.map((s) => s.id)).toEqual(["signin", "storefront", "recipes"]);
    for (const starter of authOnly) {
      const resource = Object.keys(starter.resources)[0];

      // AUTH_PUBLIC_ROUTES keeps reads open, so the example query still works…
      expect((await fetch(`${core.base}/${starter.id}-w/${resource}`)).status).toBe(200);

      // …but a write with no token is rejected, which is the point of the example.
      const anonymous = await fetch(`${core.base}/${starter.id}-w/${resource}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
      expect(anonymous.status).toBe(401);

      // And the auth plane is live, so a caller can get themselves a token.
      const signup = await signUp(`${starter.id}-w`, `someone@${starter.id}.example`);
      expect(signup.status).toBe(201);
      const { token } = (await signup.json()) as { token: string };

      const authorised = await fetch(`${core.base}/${starter.id}-w/${resource}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "pending" }),
      });
      expect(authorised.status).toBe(201);
    }
  }, 30_000);

  test("each auth starter's sessions last what its .env says, and a refresh keeps one going", async () => {
    const withAuth = STARTERS.filter((s) => s.config?.AUTH_ENABLED === "true");
    expect(withAuth.map((s) => s.id)).toEqual(["signin", "storefront", "recipes", "helpdesk", "accounts"]);
    for (const starter of withAuth) {
      const base = `${core.base}/${starter.id}-w`;
      const json = { "content-type": "application/json" };
      // The core's defaults stand in for a key the starter leaves out.
      const tokenTtl = Number(starter.config!.AUTH_JWT_TTL_SECONDS ?? 86_400);
      const sessionTtl = Number(starter.config!.AUTH_REFRESH_TTL_SECONDS ?? 2_592_000);

      const signup = await signUp(`${starter.id}-w`, `sessions@${starter.id}.example`);
      expect(signup.status).toBe(201);
      const issued = (await signup.json()) as { expiresIn: number; refreshToken: string; user: { id: string } };
      expect({ starter: starter.id, expiresIn: issued.expiresIn }).toEqual({ starter: starter.id, expiresIn: tokenTtl });

      const refreshed = await fetch(`${base}/auth/refresh`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ refreshToken: issued.refreshToken }),
      });
      expect(refreshed.status).toBe(200);

      // The session now ends what the starter promises after that refresh.
      const sessions = (await fetch(`${base}/_admin/system/sessions`, { headers: adminAuth }).then((r) => r.json())) as {
        userId: string;
        expiresAt: string;
      }[];
      const mine = sessions.find((s) => s.userId === String(issued.user.id))!;
      const lasts = (Date.parse(mine.expiresAt) - Date.now()) / 1000;
      expect({ starter: starter.id, offBySeconds: Math.abs(lasts - sessionTtl) < 60 }).toEqual({
        starter: starter.id,
        offBySeconds: true,
      });
    }
  }, 30_000);

  test("each auth starter says in its .env whether signup needs a code, and the core and the APIs rail agree", async () => {
    const withAuth = STARTERS.filter((s) => s.config?.AUTH_ENABLED === "true");
    for (const starter of withAuth) {
      // Said out loud in every auth starter, so its .env shows the choice either way.
      expect({ starter: starter.id, set: starter.config!.AUTH_EMAIL_VERIFICATION !== undefined }).toEqual({
        starter: starter.id,
        set: true,
      });
      const verifying = emailVerificationEnabled(starter.config);
      const res = await fetch(`${core.base}/${starter.id}-w/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `rail@${starter.id}.example`, password: "password123" }),
      });
      expect({ starter: starter.id, status: res.status }).toEqual({ starter: starter.id, status: verifying ? 202 : 201 });
      const listed = groupEndpoints([], starter.config)
        .flatMap((g) => g.endpoints)
        .some((e) => e.path === "/auth/signup/verify");
      expect({ starter: starter.id, listed }).toEqual({ starter: starter.id, listed: verifying });
    }
    // The simplest auth starter turns it off; the rest keep the default.
    expect(withAuth.filter((s) => !emailVerificationEnabled(s.config)).map((s) => s.id)).toEqual(["storefront"]);
  }, 30_000);

  test("Sign-in basics: signup with verification, login, and forgot and reset password all work before email is set up", async () => {
    const starter = STARTERS.find((s) => s.id === "signin")!;
    const base = `${core.base}/signin-w`;
    const [resource] = Object.keys(starter.resources);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const email = "sam@signin.example";

    // Signup makes no account yet; with no Resend key the code is in the Logs tab.
    const started = await post("/auth/signup", { email, password: "password123" });
    expect(started.status).toBe(202);
    const { verificationId, delivery } = (await started.json()) as { verificationId: string; delivery: string };
    expect(delivery).toBe("logs");
    expect((await post("/auth/login", { email, password: "password123" })).status).toBe(403);
    // A resent code is the one that works.
    const resent = await post("/auth/signup/resend", { verificationId });
    expect(resent.status).toBe(202);
    const code = await loggedCode("signin-w", resent.headers.get("x-correlation-id"));
    expect((await post("/auth/signup/verify", { verificationId, code })).status).toBe(201);

    // Login hands out a token that can post where an anonymous caller cannot.
    const login = await post("/auth/login", { email, password: "password123" });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const asSam = { authorization: `Bearer ${token}` };
    expect((await post(`/${resource}`, { title: "Hello" })).status).toBe(401);
    expect((await post(`/${resource}`, { title: "Hello" }, asSam)).status).toBe(201);

    // Forgot and reset: the code, from the log again, sets a new password and ends the old session.
    const forgot = await post("/auth/forgot-password", { email });
    expect(forgot.status).toBe(202);
    const resetCode = await loggedCode("signin-w", forgot.headers.get("x-correlation-id"));
    expect((await post("/auth/reset-password", { email, code: resetCode, password: "a-new-password" })).status).toBe(200);
    expect((await post(`/${resource}`, { title: "Again" }, asSam)).status).toBe(401);
    expect((await post("/auth/login", { email, password: "password123" })).status).toBe(401);
    expect((await post("/auth/login", { email, password: "a-new-password" })).status).toBe(200);

    // Auth and nothing else: no roles, no social login.
    expect(starter.rbac).toBeUndefined();
    expect(socialLoginConfigured(starter.config)).toBe(false);
  }, 30_000);

  test("Forkful keeps its non-public resources behind sign-in", async () => {
    const starter = STARTERS.find((s) => s.id === "recipes")!;
    // Everything but collections is on AUTH_PUBLIC_ROUTES — and every one of those names a real resource.
    const publicRoutes = starter.config!.AUTH_PUBLIC_ROUTES.split(",");
    for (const name of publicRoutes) expect(Object.keys(starter.resources)).toContain(name);
    expect((await fetch(`${core.base}/recipes-w/collections`)).status).toBe(401);
  });

  test("Deskline's rules pass the core, and customers and agents see different queues", async () => {
    const starter = STARTERS.find((s) => s.id === "helpdesk")!;
    const base = `${core.base}/${starter.id}-w`;
    const admin = { ...adminAuth, "content-type": "application/json" };

    // The rules are accepted by the core's own validation, not merely written to disk.
    const valid = await fetch(`${base}/_admin/files/draft_rbac`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify(starter.rbac),
    });
    expect(valid.status).toBe(201);

    // Visitors get the help centre and nothing else.
    expect((await fetch(`${base}/articles`)).status).toBe(200);
    expect((await fetch(`${base}/tickets`)).status).toBe(401);

    // A new account is a customer, and sees only the tickets it opens.
    const signup = await signUp("helpdesk-w", "customer@deskline.example").then((r) => r.json());
    expect(signup.user.role).toBe(starter.rbac!.defaultRole);
    const as = { authorization: `Bearer ${signup.token}`, "content-type": "application/json" };
    expect(await fetch(`${base}/tickets`, { headers: as }).then((r) => r.json())).toEqual([]);
    const opened = await fetch(`${base}/tickets`, {
      method: "POST",
      headers: as,
      body: JSON.stringify({ subject: "Cannot log in", topicId: "2", status: "open" }),
    });
    expect(opened.status).toBe(201);
    expect(await fetch(`${base}/tickets`, { headers: as }).then((r) => r.json())).toHaveLength(1);
    expect((await fetch(`${base}/macros`, { headers: as })).status).toBe(403);

    // Made an agent from the admin plane, the same token sees the whole queue.
    const promoted = await fetch(`${base}/_admin/users/${signup.user.id}/role`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ role: "agent" }),
    });
    expect(promoted.status).toBe(200);
    const queue = await fetch(`${base}/tickets`, { headers: as }).then((r) => r.json());
    expect(queue).toHaveLength(starter.resources.tickets.length + 1);
    expect((await fetch(`${base}/macros`, { headers: as })).status).toBe(200);
  }, 30_000);

  test("Signet: every sign-in path it advertises is live, and roles decide who manages accounts", async () => {
    const starter = STARTERS.find((s) => s.id === "accounts")!;
    const base = `${core.base}/accounts-w`;
    const admin = { ...adminAuth, "content-type": "application/json" };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const promote = (id: unknown, role: string) =>
      fetch(`${base}/_admin/users/${id}/role`, { method: "POST", headers: admin, body: JSON.stringify({ role }) });

    // The rules are accepted by the core's own validation, not merely written to disk.
    expect((await post("/_admin/files/draft_rbac", starter.rbac, adminAuth)).status).toBe(201);

    // Visitors get the org directory and the plans, and nothing about people.
    expect((await fetch(`${base}/plans`)).status).toBe(200);
    for (const name of ["memberships", "invitations", "profiles"])
      expect((await fetch(`${base}/${name}`)).status, `${name} is open to visitors`).toBe(401);

    // Sign up with a password. The account exists once the code comes back — from
    // the Logs tab, since no Resend key is set — and until then login says so.
    const started = await post("/auth/signup", { email: "ada@signet.example", password: "password123", name: "Ada" });
    expect(started.status).toBe(202);
    const { verificationId } = (await started.json()) as { verificationId: string };
    const early = await post("/auth/login", { email: "ada@signet.example", password: "password123" });
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ verificationRequired: true, verificationId });
    const code = await loggedCode("accounts-w", started.headers.get("x-correlation-id"));
    const signup = await post("/auth/signup/verify", { verificationId, code });
    expect(signup.status).toBe(201);
    const ada = (await signup.json()) as { token: string; user: { id: unknown; role: string } };
    // A new account is a member.
    expect(ada.user.role).toBe(starter.rbac!.defaultRole);
    expect((await post("/auth/login", { email: "ada@signet.example", password: "password123" })).status).toBe(200);
    const bo = (await signUp("accounts-w", "bo@signet.example").then((r) => r.json())) as {
      token: string;
      user: { id: unknown };
    };
    const asAda = { authorization: `Bearer ${ada.token}` };

    // A profile is its owner's alone, whatever the body claims.
    expect(await fetch(`${base}/profiles`, { headers: asAda }).then((r) => r.json())).toEqual([]);
    expect((await post("/profiles", { displayName: "Ada", userId: "someone-else" }, asAda)).status).toBe(201);
    const mine = (await fetch(`${base}/profiles`, { headers: asAda }).then((r) => r.json())) as { userId: unknown }[];
    expect(mine).toHaveLength(1);
    expect(String(mine[0].userId)).toBe(String(ada.user.id));
    expect(await fetch(`${base}/profiles`, { headers: { authorization: `Bearer ${bo.token}` } }).then((r) => r.json())).toEqual([]);

    // Members can't list accounts; support can, but can't change a role; an admin can.
    expect((await fetch(`${base}/auth/users`, { headers: asAda })).status).toBe(403);
    expect((await promote(ada.user.id, "support")).status).toBe(200);
    expect((await fetch(`${base}/auth/users`, { headers: asAda })).status).toBe(200);
    const makeBoSupport = () =>
      fetch(`${base}/auth/users/${bo.user.id}/role`, {
        method: "PUT",
        headers: { ...asAda, "content-type": "application/json" },
        body: JSON.stringify({ role: "support" }),
      });
    expect((await makeBoSupport()).status).toBe(403);
    expect((await promote(ada.user.id, "admin")).status).toBe(200);
    expect((await makeBoSupport()).status).toBe(200);
    expect((await fetch(`${base}/auth/users`, { headers: { authorization: `Bearer ${bo.token}` } })).status).toBe(200);

    // Changing the password signs the old token out and hands back a new one.
    const changed = await post("/auth/change-password", { currentPassword: "password123", password: "password456" }, asAda);
    expect(changed.status).toBe(200);
    expect((await fetch(`${base}/profiles`, { headers: asAda })).status).toBe(401);
    const { token, refreshToken } = (await changed.json()) as { token: string; refreshToken: string };
    expect((await fetch(`${base}/profiles`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

    // Its short token is kept going by the refresh token, and logout ends the session at once.
    const refreshed = await post("/auth/refresh", { refreshToken });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { token: string };
    const asNext = { authorization: `Bearer ${next.token}` };
    expect((await fetch(`${base}/profiles`, { headers: asNext })).status).toBe(200);
    expect((await post("/auth/logout", {}, asNext)).status).toBe(204);
    expect((await fetch(`${base}/profiles`, { headers: asNext })).status).toBe(401);
    expect((await post("/auth/refresh", { refreshToken })).status).toBe(401);

    // Password reset works already, its code in the Logs tab until a Resend key is added.
    const forgot = await post("/auth/forgot-password", { email: "ada@signet.example" });
    expect(forgot.status).toBe(202);
    const resetCode = await loggedCode("accounts-w", forgot.headers.get("x-correlation-id"));
    const reset = await post("/auth/reset-password", { email: "ada@signet.example", code: resetCode, password: "password789" });
    expect(reset.status).toBe(200);
    expect((await post("/auth/login", { email: "ada@signet.example", password: "password789" })).status).toBe(200);

    // Social sign-in waits on the OAuth app only the owner can register.
    expect((await fetch(`${base}/auth/google`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${base}/auth/github`, { redirect: "manual" })).status).toBe(404);
    expect(socialLoginConfigured(starter.config)).toBe(false);
  }, 30_000);

  test("a starter without the auth feature needs no token at all", async () => {
    for (const starter of STARTERS.filter((s) => !s.features.includes("auth"))) {
      const resource = Object.keys(starter.resources)[0];
      const res = await fetch(`${core.base}/${starter.id}-w/${resource}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "anonymous write" }),
      });
      expect(res.status).toBe(201);
    }
  }, 20_000);

  test("each starter seeds enough rows for pagination to be meaningful", async () => {
    for (const starter of STARTERS) {
      expect(countRecords(starter)).toBeGreaterThanOrEqual(10);
      const first = Object.keys(starter.resources)[0];
      const res = await fetch(`${core.base}/${starter.id}/${first}?_page=1&_limit=3`);
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown[]).toHaveLength(3);
      expect(Number(res.headers.get("x-total-count"))).toBe(starter.resources[first].length);
    }
  }, 20_000);
});
