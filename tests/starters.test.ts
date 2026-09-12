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
import { RAW_KEY, mergeEnv, parseEnvText } from "../sites/dashboard/src/lib/env.ts";
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

  test("a key the template does not offer is appended, and a config with no text only merges keys", () => {
    const appended = mergeEnv({ [RAW_KEY]: TEMPLATE }, { SCHEMA_POSTS: "{}" })[RAW_KEY];
    expect(appended.trimEnd().endsWith("SCHEMA_POSTS={}")).toBe(true);
    expect(mergeEnv({ QA_MODE: "true" }, { AUTH_ENABLED: "true" })).toEqual({
      QA_MODE: "true",
      AUTH_ENABLED: "true",
    });
  });
});

/** `?_expand=authors` → the core nests the match under `author`. */
const singularize = (n: string) =>
  n.endsWith("ies") ? `${n.slice(0, -3)}y` : n.endsWith("ss") || !n.endsWith("s") ? n : n.slice(0, -1);

describe("starter examples", () => {
  test("the list really does escalate: plain, then relations, then auth, then roles", () => {
    // The order is the pitch — a card claiming `relations` must have foreign
    // keys, and one claiming neither must be a single flat resource.
    expect(STARTERS.map((s) => s.id)).toEqual(["tracker", "blog", "storefront", "recipes", "helpdesk"]);
    expect(STARTERS.map((s) => s.features)).toEqual([
      [],
      ["relations"],
      ["relations", "auth"],
      ["relations", "auth"],
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
    // Nine cards on the empty state: five real, four not written yet. The grid
    // renders both lists, so a placeholder that drifted into looking real —
    // duplicate id, empty resource list — would be a card promising an example
    // that cannot be seeded. Moving one into STARTERS is what makes the rest of
    // this suite start covering it.
    expect(STARTERS.length + PLANNED_STARTERS.length).toBe(9);

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
    expect(ids.size).toBe(9);
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
    expect(authOnly.map((s) => s.id)).toEqual(["storefront", "recipes"]);
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
      const signup = await fetch(`${core.base}/${starter.id}-w/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `someone@${starter.id}.example`, password: "password123" }),
      });
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

  test("Forkful keeps its non-public resources behind sign-in", async () => {
    const starter = STARTERS.find((s) => s.id === "recipes")!;
    // Everything but collections is on AUTH_PUBLIC_ROUTES — and every one of those names a real resource.
    const publicRoutes = starter.config!.AUTH_PUBLIC_ROUTES.split(",");
    for (const name of publicRoutes) expect(Object.keys(starter.resources)).toContain(name);
    expect((await fetch(`${core.base}/recipes-w/collections`)).status).toBe(401);
  });

  test("the rbac starter's rules pass the core, and customers and agents see different queues", async () => {
    const starter = STARTERS.find((s) => s.features.includes("rbac"))!;
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
    const signup = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "customer@deskline.example", password: "password123" }),
    }).then((r) => r.json());
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
