/**
 * Core Tenant Engine — regression suite for the invariants in CLAUDE.md.
 *
 * Black-box on purpose: every test spawns the real `server-core.ts` against a
 * scratch TENANTS_DIR and talks to it over HTTP. Nothing imports the server's
 * internals, so refactoring the pipeline, the dispatcher or the storage layer
 * keeps these passing — they only fail when observable behaviour changes,
 * which is the point.
 *
 *   bun test tests/core.test.ts        (or: bun run scripts/build.ts -pl core)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite"; // only to build a decoy DB the MCP tool must not reach
import {
  ADMIN_SECRET,
  adminAuth,
  seedStatus,
  seedSystemFile,
  seedTenant,
  startCore,
  stopServices,
  systemFile,
  tenantFile,
  waitFor,
  type Service,
} from "./helpers.ts";

let ROOT = "";

const running: Service[] = [];

/** Boots a core into this suite's scratch root and tracks it for teardown. */
async function boot(name: string, env: Record<string, string> = {}): Promise<Service> {
  const core = await startCore(ROOT, name, env);
  running.push(core);
  return core;
}

const seed = seedTenant;
const readFile = tenantFile;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Signs a new account up on a tenant with AUTH_ENABLED, failing the test if it can't. */
async function signupAs(tenant: string, email: string, password = "password123", on?: Service) {
  const res = await fetch(`${(on ?? core).base}/${tenant}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; user: { id: string; email: string } };
}

// ── Shared server ──────────────────────────────────────────────────
// One core covers everything that doesn't need process-level env; tenants are
// isolated per concern because behaviour is driven by each tenant's config.json.

let core: Service;

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "stubbase-core-test-"));
  core = await boot("main", { MAX_CHAOS_DELAY_MS: "200" });

  await seed(core, "plain", {
    posts: [
      { id: "1", title: "first", views: 10 },
      { id: "2", title: "second", views: 5 },
    ],
    // Staged but undeployed: must never be servable.
    draft_posts: [{ id: "99", title: "staged" }],
  });
  await seed(core, "qa", { posts: [{ id: "1", title: "first" }], config: { QA_MODE: "true" } });
  await seed(core, "qaauth", {
    posts: [],
    config: { QA_MODE: "true", AUTH_ENABLED: "true" },
  });
  await seed(core, "secure", { posts: [], config: { AUTH_ENABLED: "true" } });
  await seed(core, "pubroute", {
    posts: [{ id: "1", title: "readable" }],
    config: { AUTH_ENABLED: "true", AUTH_PUBLIC_ROUTES: "posts" },
  });
  await seed(core, "stopped", { posts: [] });
  await seedStatus(core, "stopped", "stopped");
  await seed(core, "validated", {
    posts: [],
    config: {
      SCHEMA_POSTS: JSON.stringify({
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLength: 3 } },
      }),
    },
  });
  await seed(core, "hooked", {
    posts: [],
    config: { HOOK_BEFORE_INSERT_POSTS: "http://127.0.0.1:9/hook" },
  });
  await seed(core, "deployable", {
    posts: [{ id: "1", title: "live" }],
    draft_posts: [{ id: "1", title: "promoted" }],
  });
}, 30_000);

afterAll(async () => {
  await stopServices(running);
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
});

// ── Sorting and server-owned timestamps ────────────────────────────

describe("sorting with _sort and _direction", () => {
  const ids = (tenant: string, query: string) =>
    fetch(`${core.base}/${tenant}/items?${query}`)
      .then((r) => r.json())
      .then((rows: any[]) => rows.map((r) => r.id));

  beforeAll(async () => {
    await seed(core, "sorting", {
      items: [
        { id: "a", price: 20, name: "b", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" },
        { id: "b", price: 5, name: "a", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
        { id: "c", name: "c" }, // imported: no price, no timestamps
        { id: "d", price: 20, name: "a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
  });

  test("an ordinary field sorts ascending unless _direction says desc", async () => {
    expect(await ids("sorting", "_sort=price")).toEqual(["b", "a", "d", "c"]);
    expect(await ids("sorting", "_sort=price&_direction=desc")).toEqual(["a", "d", "b", "c"]);
  });

  test("records missing the sort field go last in either direction", async () => {
    expect((await ids("sorting", "_sort=price&_direction=asc")).at(-1)).toBe("c");
    expect((await ids("sorting", "_sort=price&_direction=desc")).at(-1)).toBe("c");
  });

  test("created and updated sort by the timestamps, newest first by default", async () => {
    expect(await ids("sorting", "_sort=created")).toEqual(["b", "a", "d", "c"]);
    expect(await ids("sorting", "_sort=createdAt")).toEqual(["b", "a", "d", "c"]);
    expect(await ids("sorting", "_sort=updated&_direction=asc")).toEqual(["d", "b", "a", "c"]);
  });

  test("one _direction per key, and a single one applies to every key", async () => {
    expect(await ids("sorting", "_sort=price,name&_direction=desc,asc")).toEqual(["d", "a", "b", "c"]);
    expect(await ids("sorting", "_sort=price,name&_direction=desc")).toEqual(["a", "d", "b", "c"]);
  });

  test("_order is no longer read", async () => {
    expect(await ids("sorting", "_sort=price&_order=desc")).toEqual(["b", "a", "d", "c"]);
  });
});

describe("server-owned timestamps", () => {
  const send = (method: string, url: string, body: unknown) =>
    fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ANCIENT = "1999-01-01T00:00:00.000Z";

  test("POST stamps createdAt and updatedAt, overwriting what the client sent", async () => {
    await seed(core, "stamped", { posts: [] });
    const before = Date.now();
    const res = await send("POST", `${core.base}/stamped/posts`, {
      title: "new",
      createdAt: ANCIENT,
      updatedAt: ANCIENT,
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.createdAt).not.toBe(ANCIENT);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before - 1000);

    const onDisk = await readFile(core, "stamped", "posts");
    expect(onDisk[0]).toMatchObject({ createdAt: created.createdAt, updatedAt: created.updatedAt });
  });

  test("PUT keeps createdAt and stamps updatedAt, ignoring what the client sent", async () => {
    await seed(core, "restamped", { posts: [] });
    const created = await send("POST", `${core.base}/restamped/posts`, { title: "v1" }).then((r) => r.json());
    await Bun.sleep(10); // a later write must carry a later timestamp

    const res = await send("PUT", `${core.base}/restamped/posts/${created.id}`, {
      ...created,
      title: "v2",
      createdAt: ANCIENT,
      updatedAt: ANCIENT,
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  test("PUT never invents a createdAt for a record that had none", async () => {
    await seed(core, "imported", { posts: [{ id: "1", title: "from a file" }] });
    const updated = await send("PUT", `${core.base}/imported/posts/1`, {
      title: "edited",
      createdAt: ANCIENT,
    }).then((r) => r.json());
    expect("createdAt" in updated).toBe(false);
    expect(typeof updated.updatedAt).toBe("string");
  });

  test("a signup stamps the new user", async () => {
    const res = await send("POST", `${core.base}/secure/auth/signup`, {
      email: `stamped-${Date.now()}@example.com`,
      password: "long-enough-password",
    });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(typeof user.createdAt).toBe("string");
    expect(user.updatedAt).toBe(user.createdAt);
  });

  test("the _admin plane never stamps — a file keeps exactly what was written", async () => {
    await seed(core, "unstamped", { posts: [] });
    const write = await fetch(`${core.base}/unstamped/_admin/files/posts`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify([{ id: "1", title: "as written" }]),
    });
    expect(write.status).toBe(201);
    expect(await fetch(`${core.base}/unstamped/posts`).then((r) => r.json())).toEqual([
      { id: "1", title: "as written" },
    ]);
  });
});

describe("filters: plain is exact, brackets are operators", () => {
  const ids = (tenant: string, query: string) =>
    fetch(`${core.base}/${tenant}/products?${query}`)
      .then((r) => r.json())
      .then((rows: any[]) => rows.map((r) => r.id));

  beforeAll(async () => {
    await seed(core, "filtering", {
      products: [
        { id: "1", brand: "Samsung", category: "phone", price: 799, tags: ["android", "5G"], releasedAt: "2026-02-01T00:00:00.000Z" },
        { id: "2", brand: "Sam's Club", category: "grocery", price: 12, releasedAt: "2025-11-15T00:00:00.000Z" },
        { id: "3", brand: "Škoda", category: "car", price: "90", releasedAt: "2026-06-30T00:00:00.000Z" },
        { id: "4", brand: "Apple", category: "headphones", price: 249, tags: ["wireless"] },
        { id: "5", brand: "Sony", category: "phone", price: null },
      ],
    });
  });

  test("a plain field=value stays exact and case-sensitive", async () => {
    expect(await ids("filtering", "category=phone")).toEqual(["1", "5"]); // not headphones
    expect(await ids("filtering", "brand=samsung")).toEqual([]);
  });

  test("contains ignores case and accents", async () => {
    expect(await ids("filtering", "brand[contains]=SAM")).toEqual(["1", "2"]);
    expect(await ids("filtering", "brand[contains]=skod")).toEqual(["3"]);
  });

  test("contains on a list matches when any item does", async () => {
    expect(await ids("filtering", "tags[contains]=wire")).toEqual(["4"]);
    expect(await ids("filtering", "tags[contains]=5g")).toEqual(["1"]);
  });

  test("gt / gte / lt / lte compare numbers, and skip values that are missing", async () => {
    expect(await ids("filtering", "price[gt]=12&price[lt]=800")).toEqual(["1", "3", "4"]);
    expect(await ids("filtering", "price[lte]=12")).toEqual(["2"]);
    // Text holding a number orders naturally: "90" is below 100. Compared
    // letter by letter it would not be, since "9" sorts after "1".
    expect(await ids("filtering", "price[gte]=100")).toEqual(["1", "4"]);
  });

  test("comparisons order ISO dates by time", async () => {
    expect(await ids("filtering", "releasedAt[gte]=2026-01-01")).toEqual(["1", "3"]);
    expect(await ids("filtering", "releasedAt[lt]=2026-01-01")).toEqual(["2"]);
  });

  test("filters combine with each other, sorting and paging — and the total counts matches", async () => {
    const res = await fetch(
      `${core.base}/filtering/products?category=phone&brand[contains]=s&_sort=price&_direction=desc&_limit=1`,
    );
    expect((await res.json()).map((r: any) => r.id)).toEqual(["1"]);
    expect(res.headers.get("x-total-count")).toBe("2");
  });

  test("an unknown or empty operator is a 400 that names it, never ignored", async () => {
    const typo = await fetch(`${core.base}/filtering/products?price[gtee]=10`);
    expect(typo.status).toBe(400);
    expect((await typo.json()).error).toContain("'gtee'");
    expect((await fetch(`${core.base}/filtering/products?price[]=10`)).status).toBe(400);
  });

});

// ── CORS split ─────────────────────────────────────────────────────

describe("CORS split", () => {
  test("public CRUD sends wildcard CORS and exposes the pagination total", async () => {
    const res = await fetch(`${core.base}/plain/posts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "X-Total-Count, X-Correlation-Id",
    );
    expect(res.headers.get("x-total-count")).toBe("2");
  });

  test("public error responses also carry CORS", async () => {
    // A frontend must be able to read the error, not just a network failure.
    for (const path of ["/nope/posts", "/plain/missing", "/plain/config"]) {
      const res = await fetch(`${core.base}${path}`);
      expect(res.ok).toBe(false);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  test("the _admin plane sends no CORS headers at all", async () => {
    const res = await fetch(`${core.base}/plain/_admin/files/posts`, { headers: adminAuth });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("_admin sends no CORS even when it rejects the request", async () => {
    const res = await fetch(`${core.base}/plain/_admin/files/posts`);
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("public preflight allows authorization and the QA headers", async () => {
    const res = await fetch(`${core.base}/plain/posts`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toContain("authorization"); // tenant JWTs ride this header
    expect(allowed).toContain("x-stubbase-delay");
    expect(allowed).toContain("x-stubbase-status");
  });

  test("admin preflight must NOT allow the authorization header", async () => {
    // Browsers would otherwise be permitted to send ADMIN_SECRET cross-origin.
    const res = await fetch(`${core.base}/plain/_admin/files/posts`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toBe("content-type");
    expect(allowed).not.toContain("authorization");
  });
});

// ── Name validation / protected names ──────────────────────────────

describe("name validation and the protected-name blacklist", () => {
  test("tenant ids that fail NAME_RE are rejected before any path is built", async () => {
    // Plain `../` and `%2e%2e` never get this far — URL parsing collapses dot
    // segments before dispatch. What survives as a single path segment is the
    // encoded-slash form, and NAME_RE is the only thing standing between it
    // and a join() into TENANTS_DIR.
    for (const tenant of ["..%2f..%2fetc", "a%2fb", "bad!id", "with%20space", "foo%00bar", "a".repeat(65)]) {
      const res = await fetch(`${core.base}/${tenant}/posts`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid tenant id" });
    }
  });

  test("an encoded slash cannot smuggle an extra path segment", async () => {
    // `/plain/posts%2f..%2fconfig` must stay one resource segment, not two.
    const res = await fetch(`${core.base}/plain/posts%2f..%2fconfig`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid resource name" });
  });

  test("resource names that fail NAME_RE are rejected", async () => {
    const res = await fetch(`${core.base}/plain/bad!resource`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid resource name" });
  });

  test("protected names answer 403 on the public plane", async () => {
    for (const name of ["config", "stubbase", "env", "draft_posts", "_secret", ".hidden"]) {
      const res = await fetch(`${core.base}/plain/${name}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden: protected resource" });
    }
  });

  test("internal planes are dispatched BEFORE the blacklist swallows them", async () => {
    // Each of these shares a prefix with the blacklist; a dispatch-order
    // regression turns them into 403s.
    const openapi = await fetch(`${core.base}/plain/openapi.json`);
    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toMatchObject({ openapi: "3.0.3" });

    const admin = await fetch(`${core.base}/plain/_admin/files/posts`, { headers: adminAuth });
    expect(admin.status).toBe(200);

    // Reaches the notify handler (which reports auth is off) rather than 403.
    const notify = await fetch(`${core.base}/plain/_notify/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(notify.status).toBe(404);
    expect(await notify.json()).toMatchObject({ error: "notifications require AUTH_ENABLED" });

    // Reaches the auth handler, not the blacklist.
    const auth = await fetch(`${core.base}/plain/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "password123" }),
    });
    expect(auth.status).toBe(404);
    expect(await auth.json()).toMatchObject({ error: "auth is not enabled for this tenant" });
  });

  test("draft_* files are never mounted as resources", async () => {
    const spec = await fetch(`${core.base}/plain/openapi.json`).then((r) => r.json());
    expect(Object.keys(spec.components.schemas)).toContain("posts");
    expect(Object.keys(spec.components.schemas)).not.toContain("draft_posts");
  });
});

// ── Admin auth ─────────────────────────────────────────────────────

describe("admin authentication", () => {
  test("rejects a missing, malformed or wrong bearer token", async () => {
    const cases = [
      undefined,
      { authorization: "Bearer wrong-secret" },
      { authorization: ADMIN_SECRET }, // no "Bearer " prefix
      { authorization: `Bearer ${ADMIN_SECRET}x` },
    ];
    for (const headers of cases) {
      const res = await fetch(`${core.base}/plain/_admin/files/posts`, {
        headers: headers as HeadersInit | undefined,
      });
      expect(res.status).toBe(401);
    }
  });

  test("admin can read a file the public plane hides", async () => {
    const res = await fetch(`${core.base}/qa/_admin/files/config`, { headers: adminAuth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ QA_MODE: "true" });
  });
});

// ── Write-through, eviction and admin invalidation ─────────────────

describe("write-through persistence", () => {
  test("a mutation is on disk by the time the response returns", async () => {
    await seed(core, "wt", { posts: [] });
    const res = await fetch(`${core.base}/wt/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "durable" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();

    const onDisk = await readFile(core, "wt", "posts");
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ id: created.id, title: "durable" });
  });

  test("concurrent mutations all survive — the write chain can't interleave files", async () => {
    await seed(core, "concurrent", { posts: [] });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        fetch(`${core.base}/concurrent/posts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ n: i }),
        }),
      ),
    );
    const onDisk = await readFile(core, "concurrent", "posts");
    expect(onDisk).toHaveLength(25);
    expect(new Set(onDisk.map((r: any) => r.n)).size).toBe(25);
  });

  test("eviction only drops RAM — data reloads from disk intact", async () => {
    await seed(core, "evictable", { posts: [] });
    await fetch(`${core.base}/evictable/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "survives eviction" }),
    });

    const flushed = await fetch(`${core.base}/evictable/_admin/flush`, {
      method: "POST",
      headers: adminAuth,
    });
    expect(flushed.status).toBe(200);
    expect(await flushed.json()).toMatchObject({ flushed: true });

    const after = await fetch(`${core.base}/evictable/posts`).then((r) => r.json());
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ title: "survives eviction" });
  });

  test("idle timer eviction is equally lossless", async () => {
    const shortLived = await boot("ttl", { IDLE_TTL_MS: "300" });
    await seed(shortLived, "t", { posts: [] });

    await fetch(`${shortLived.base}/t/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "before idle" }),
    });
    await Bun.sleep(700); // let the idle timer fire

    const after = await fetch(`${shortLived.base}/t/posts`).then((r) => r.json());
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ title: "before idle" });
  }, 15_000);

  test("admin file writes invalidate the cache, so the next read is fresh", async () => {
    await seed(core, "invalidate", { posts: [{ id: "1", title: "old" }] });
    // Warm the cache first — without evict() this read would be stale.
    expect(await fetch(`${core.base}/invalidate/posts`).then((r) => r.json())).toHaveLength(1);

    const write = await fetch(`${core.base}/invalidate/_admin/files/posts`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify([{ id: "1", title: "new" }, { id: "2", title: "also new" }]),
    });
    expect(write.status).toBe(201);

    const after = await fetch(`${core.base}/invalidate/posts`).then((r) => r.json());
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ title: "new" });
  });

  test("admin delete invalidates too", async () => {
    await seed(core, "deletable", { posts: [{ id: "1" }] });
    expect((await fetch(`${core.base}/deletable/posts`)).status).toBe(200);

    const del = await fetch(`${core.base}/deletable/_admin/files/posts`, {
      method: "DELETE",
      headers: adminAuth,
    });
    expect(del.status).toBe(200);

    const after = await fetch(`${core.base}/deletable/posts`);
    expect(after.status).toBe(404);
  });

  test("deploy promotes every draft over its live file and evicts", async () => {
    // Cache the pre-deploy state so a missing evict() would be visible.
    const before = await fetch(`${core.base}/deployable/posts`).then((r) => r.json());
    expect(before[0]).toMatchObject({ title: "live" });

    const deploy = await fetch(`${core.base}/deployable/_admin/deploy`, {
      method: "POST",
      headers: adminAuth,
    });
    expect(deploy.status).toBe(200);
    expect(await deploy.json()).toMatchObject({ promoted: ["posts"] });

    const after = await fetch(`${core.base}/deployable/posts`).then((r) => r.json());
    expect(after[0]).toMatchObject({ title: "promoted" });
  });

  /**
   * A promoted draft has to be consumed, or it becomes a frozen second copy of
   * the resource that nothing updates again — and drafts are read in preference
   * to live files. Left behind, it hides every record the public API creates
   * from the dashboard editor, and the next deploy re-promotes it over the live
   * file, destroying those records even for a resource nobody edited.
   */
  test("a promoted draft is consumed, so a second deploy promotes nothing", async () => {
    const files = await readdir(join(core.dir, "deployable", "data"));
    expect(files).toContain("posts.json");
    expect(files).not.toContain("draft_posts.json");

    // The live data now belongs to whoever writes it, including the public API.
    const created = await fetch(`${core.base}/deployable/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "written through the API" }),
    });
    expect(created.status).toBe(201);

    const redeploy = await fetch(`${core.base}/deployable/_admin/deploy`, {
      method: "POST",
      headers: adminAuth,
    });
    expect(await redeploy.json()).toMatchObject({ promoted: [] });

    // The API-created record is still there — the stale draft did not come back.
    const posts = await fetch(`${core.base}/deployable/posts`).then((r) => r.json());
    expect(posts.map((p: any) => p.title)).toEqual(["promoted", "written through the API"]);
  });
});

// ── QA chaos engine ────────────────────────────────────────────────

describe("QA chaos headers", () => {
  test("are inert unless the tenant sets QA_MODE=true", async () => {
    const res = await fetch(`${core.base}/plain/posts`, {
      headers: { "x-stubbase-status": "500", "x-stubbase-error-rate": "1" },
    });
    expect(res.status).toBe(200);
  });

  test("force a status when QA_MODE is on", async () => {
    const res = await fetch(`${core.base}/qa/posts`, { headers: { "x-stubbase-status": "503" } });
    expect(res.status).toBe(503);
  });

  test("error-rate 1 always trips the simulated failure", async () => {
    const res = await fetch(`${core.base}/qa/posts`, { headers: { "x-stubbase-error-rate": "1" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "Simulated Flakiness" });
  });

  test("empty=true returns an empty collection and a null record", async () => {
    const collection = await fetch(`${core.base}/qa/posts`, { headers: { "x-stubbase-empty": "true" } });
    expect(await collection.json()).toEqual([]);

    const single = await fetch(`${core.base}/qa/posts/1`, { headers: { "x-stubbase-empty": "true" } });
    expect(await single.json()).toBeNull();
  });

  test("delay is capped by MAX_CHAOS_DELAY_MS", async () => {
    // The server runs with a 200ms cap; a 5s request must not be held 5s.
    const started = Date.now();
    const res = await fetch(`${core.base}/qa/posts`, { headers: { "x-stubbase-delay": "5000" } });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("chaos runs AFTER authGuard, so it can never bypass auth", async () => {
    // The most dangerous ordering regression: an unauthenticated caller
    // forcing a 200 out of a protected tenant.
    const forced = await fetch(`${core.base}/qaauth/posts`, { headers: { "x-stubbase-status": "200" } });
    expect(forced.status).toBe(401);

    const emptied = await fetch(`${core.base}/qaauth/posts`, { headers: { "x-stubbase-empty": "true" } });
    expect(emptied.status).toBe(401);
  });
});

// ── Tenant auth ────────────────────────────────────────────────────

describe("tenant auth", () => {
  test("signup and login never leak passwordHash", async () => {
    const signup = await fetch(`${core.base}/secure/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "leak@test.co", password: "password123" }),
    });
    expect(signup.status).toBe(201);
    const created = await signup.json();
    expect(created.token).toBeString();
    expect(created.user).not.toHaveProperty("passwordHash");

    const login = await fetch(`${core.base}/secure/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "leak@test.co", password: "password123" }),
    });
    expect(login.status).toBe(200);
    expect((await login.json()).user).not.toHaveProperty("passwordHash");

    // ...and the hash really is on disk, in system/, so stripping is what hid it.
    const onDisk = await systemFile(core, "secure", "users");
    expect(onDisk.find((u: any) => u.email === "leak@test.co").passwordHash).toBeString();
  }, 15_000);

  test("the identity table is not a resource: no route, no spec entry, nothing to expand", async () => {
    await seed(core, "ident", { posts: [], config: { AUTH_ENABLED: "true" } });
    const { token, user } = await signupAs("ident", "ident@test.co");
    const auth = bearer(token);

    expect(await Bun.file(join(core.dir, "ident", "data", "users.json")).exists()).toBe(false);
    expect((await fetch(`${core.base}/ident/users`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${core.base}/ident/users/${user.id}`, { headers: auth })).status).toBe(404);

    const spec = await fetch(`${core.base}/ident/openapi.json`).then((r) => r.json());
    expect(Object.keys(spec.components.schemas)).not.toContain("users");

    // Ownership is still stamped from the token, but there is no users resource to nest.
    await fetch(`${core.base}/ident/posts`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "mine" }),
    });
    const [post] = await fetch(`${core.base}/ident/posts?_expand=users`, { headers: auth }).then((r) => r.json());
    expect(post.userId).toBe(user.id);
    expect(post).not.toHaveProperty("user");
  }, 15_000);

  test("a data/users.json is an ordinary resource beside it", async () => {
    // Plain CRUD in every respect: served exactly as stored, filterable on any
    // field, writable under the ordinary ownership rules — and never the table
    // anyone signs in against.
    const plain = [{ id: "u1", name: "Ada", passwordHash: "just-a-field-here", role: "user" }];
    await seed(core, "twousers", { users: plain, config: { AUTH_ENABLED: "true" } });
    const { token } = await signupAs("twousers", "real@test.co");
    const auth = bearer(token);

    expect(await fetch(`${core.base}/twousers/users`, { headers: auth }).then((r) => r.json())).toEqual(plain);
    expect((await fetch(`${core.base}/twousers/users?passwordHash[contains]=field`, { headers: auth })).status).toBe(200);

    const put = await fetch(`${core.base}/twousers/users/u1`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada L", role: "admin" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ name: "Ada L", role: "admin" });

    // Writing to it touched no account: the real one still signs in, as a plain user.
    const login = await fetch(`${core.base}/twousers/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "real@test.co", password: "password123" }),
    });
    expect(login.status).toBe(200);
    expect((await login.json()).user.role).toBe("user");
  }, 15_000);

  test("an unknown email fails login the same way a wrong password does", async () => {
    const unknown = await fetch(`${core.base}/secure/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ghost@test.co", password: "password123" }),
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "invalid email or password" });
  }, 15_000);

  test("CRUD requires a bearer token when AUTH_ENABLED", async () => {
    const anon = await fetch(`${core.base}/secure/posts`);
    expect(anon.status).toBe(401);

    const garbage = await fetch(`${core.base}/secure/posts`, {
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(garbage.status).toBe(401);
  });

  test("a JWT signed for another tenant is rejected", async () => {
    // Per-tenant keys are derived from ADMIN_SECRET, so tokens must not travel.
    const { token } = await fetch(`${core.base}/secure/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "crosstenant@test.co", password: "password123" }),
    }).then((r) => r.json());

    const res = await fetch(`${core.base}/qaauth/posts`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  }, 15_000);

  test("AUTH_PUBLIC_ROUTES opens GET only", async () => {
    const read = await fetch(`${core.base}/pubroute/posts`);
    expect(read.status).toBe(200);

    const write = await fetch(`${core.base}/pubroute/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "anonymous" }),
    });
    expect(write.status).toBe(401);
  });
});

// ── Ownership / RBAC ───────────────────────────────────────────────

describe("ownership (RBAC)", () => {
  const password = "password123";
  let alice: { token: string; id: string };
  let bob: { token: string; id: string };
  let adminToken = "";

  beforeAll(async () => {
    const adminHash = await Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 19_456,
      timeCost: 2,
    });
    await seed(core, "rbac", { posts: [], config: { AUTH_ENABLED: "true" } });
    // There is no API that makes an admin yet, so one is written into the identity table directly.
    await seedSystemFile(core, "rbac", "users", [
      {
        id: "admin-1",
        email: "admin@test.co",
        role: "admin",
        passwordHash: adminHash,
        createdAt: new Date().toISOString(),
      },
    ]);

    const signup = async (email: string) => {
      const r = await fetch(`${core.base}/rbac/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }).then((x) => x.json());
      return { token: r.token as string, id: r.user.id as string };
    };
    alice = await signup("alice@test.co");
    bob = await signup("bob@test.co");

    const login = await fetch(`${core.base}/rbac/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@test.co", password }),
    }).then((r) => r.json());
    adminToken = login.token;
  }, 30_000);

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createPost(token: string, title: string) {
    const res = await fetch(`${core.base}/rbac/posts`, {
      method: "POST",
      headers: { ...as(token), "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return { status: res.status, record: await res.json() };
  }

  test("an authenticated POST stamps userId", async () => {
    const { status, record } = await createPost(alice.token, "alice's post");
    expect(status).toBe(201);
    expect(record.userId).toBe(alice.id);
  });

  test("a non-owner cannot update or delete someone else's record", async () => {
    const { record } = await createPost(alice.token, "hands off");

    const update = await fetch(`${core.base}/rbac/posts/${record.id}`, {
      method: "PUT",
      headers: { ...as(bob.token), "content-type": "application/json" },
      body: JSON.stringify({ title: "hijacked" }),
    });
    expect(update.status).toBe(403);

    const remove = await fetch(`${core.base}/rbac/posts/${record.id}`, {
      method: "DELETE",
      headers: as(bob.token),
    });
    expect(remove.status).toBe(403);

    // Untouched.
    const still = await fetch(`${core.base}/rbac/posts/${record.id}`, { headers: as(alice.token) }).then((r) =>
      r.json(),
    );
    expect(still.title).toBe("hands off");
  });

  test("an owner can update their own record", async () => {
    const { record } = await createPost(alice.token, "mine");
    const update = await fetch(`${core.base}/rbac/posts/${record.id}`, {
      method: "PUT",
      headers: { ...as(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ title: "edited" }),
    });
    expect(update.status).toBe(200);
    expect((await update.json()).title).toBe("edited");
  });

  test("ownership cannot be reassigned by a non-admin", async () => {
    const { record } = await createPost(alice.token, "stays mine");
    const update = await fetch(`${core.base}/rbac/posts/${record.id}`, {
      method: "PUT",
      headers: { ...as(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ title: "stays mine", userId: bob.id }),
    });
    expect(update.status).toBe(200);
    expect((await update.json()).userId).toBe(alice.id);
  });

  test("no public route can grant a role: the identity table is out of CRUD's reach", async () => {
    // Alice's own account row is not addressable at all, so there is nothing to PUT a role into.
    const update = await fetch(`${core.base}/rbac/users/${alice.id}`, {
      method: "PUT",
      headers: { ...as(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@test.co", role: "admin" }),
    });
    expect(update.status).toBe(404);
    const me = await fetch(`${core.base}/rbac/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@test.co", password }),
    }).then((r) => r.json());
    expect(me.user.role).toBe("user");
    expect(bob.id).not.toBe(alice.id);
  }, 15_000);

  test("an admin bypasses the ownership checks", async () => {
    const { record } = await createPost(alice.token, "admin will edit this");
    const update = await fetch(`${core.base}/rbac/posts/${record.id}`, {
      method: "PUT",
      headers: { ...as(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ title: "edited by admin" }),
    });
    expect(update.status).toBe(200);
    expect((await update.json()).title).toBe("edited by admin");
  });
});

// ── Roles and permissions (rbac.json) ──────────────────────────────

describe("roles and permissions (rbac.json)", () => {
  const RULES = {
    defaultRole: "customer",
    roles: {
      guest: { products: ["read"] },
      customer: {
        products: ["read"],
        orders: { create: "own", read: "own", update: "own" },
        reviews: { read: "all", create: "own", delete: "own" },
      },
      staff: {
        products: ["read", "create", "update"],
        orders: { read: "all", update: "all" },
        _users: ["read"],
      },
      admin: "*",
    },
  };
  type Account = { token: string; user: { id: string; role?: string } };
  let ada: Account, bea: Account, staff: Account, admin: Account;

  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(`${core.base}/store${path}`, {
      method,
      headers: {
        ...(token ? bearer(token) : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const assign = (id: string, role: string) =>
    fetch(`${core.base}/store/_admin/users/${id}/role`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });

  beforeAll(async () => {
    await seed(core, "store", {
      products: [{ id: "p1", title: "A book" }],
      orders: [],
      reviews: [],
      ledger: [{ id: "l1" }],
      config: { AUTH_ENABLED: "true", RBAC_ENABLED: "true", AUTH_PUBLIC_ROUTES: "ledger" },
      rbac: RULES,
    });
    ada = await signupAs("store", "ada@shop.co");
    bea = await signupAs("store", "bea@shop.co");
    staff = await signupAs("store", "sam@shop.co");
    admin = await signupAs("store", "root@shop.co");
    expect((await assign(staff.user.id, "staff")).status).toBe(200);
    expect((await assign(admin.user.id, "admin")).status).toBe(200);
  }, 30_000);

  test("a signup gets the default role", () => {
    expect(ada.user.role).toBe("customer");
  });

  test("the owner assigns roles on the admin plane, and only roles the rules define", async () => {
    expect((await assign(bea.user.id, "superuser")).status).toBe(400);
    expect((await assign("no-such-user", "staff")).status).toBe(404);
    const anon = await fetch(`${core.base}/store/_admin/users/${bea.user.id}/role`, {
      method: "POST",
      body: JSON.stringify({ role: "staff" }),
    });
    expect(anon.status).toBe(401);
    const accounts = await systemFile(core, "store", "users");
    expect(accounts.find((u: any) => u.id === staff.user.id).role).toBe("staff");
  });

  test("a visitor gets the guest role's permissions, and AUTH_PUBLIC_ROUTES no longer applies", async () => {
    expect((await call("GET", "/products")).status).toBe(200);
    expect((await call("POST", "/products", undefined, { title: "free" })).status).toBe(401);
    expect((await call("GET", "/orders")).status).toBe(401);
    expect((await call("GET", "/ledger")).status).toBe(401); // public route, but guest isn't granted it
  });

  test("a bad token is refused outright, never downgraded to guest", async () => {
    expect((await call("GET", "/products", "not.a.token")).status).toBe(401);
  });

  test("a resource or action a role doesn't list is refused, naming the role", async () => {
    const res = await call("GET", "/ledger", ada.token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden: role 'customer' may not read ledger" });
    expect((await call("POST", "/products", ada.token, { title: "mine now" })).status).toBe(403);
  });

  test("read own lists only the caller's records, and create own stamps the caller", async () => {
    // The body names someone else as the owner: "own" creates it for the caller regardless.
    const mine = await call("POST", "/orders", ada.token, { item: "p1", userId: bea.user.id }).then((r) => r.json());
    expect(mine.userId).toBe(ada.user.id);
    const theirs = await call("POST", "/orders", bea.token, { item: "p1" }).then((r) => r.json());

    const list = await call("GET", "/orders", ada.token);
    expect((await list.json()).map((o: any) => o.id)).toEqual([mine.id]);
    expect(list.headers.get("x-total-count")).toBe("1");
    expect((await call("GET", `/orders/${theirs.id}`, ada.token)).status).toBe(404);

    const all = await call("GET", "/orders", staff.token).then((r) => r.json());
    expect(all.map((o: any) => o.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  test("update own hides other people's records, and ownership stays put", async () => {
    const mine = await call("POST", "/orders", ada.token, { item: "p1" }).then((r) => r.json());
    const theirs = await call("POST", "/orders", bea.token, { item: "p1" }).then((r) => r.json());
    expect((await call("PUT", `/orders/${theirs.id}`, ada.token, { item: "p2" })).status).toBe(404);
    const edited = await call("PUT", `/orders/${mine.id}`, ada.token, { item: "p2", userId: bea.user.id });
    expect(await edited.json()).toMatchObject({ item: "p2", userId: ada.user.id });
    // "update all" reaches every record, and may hand one to someone else.
    const moved = await call("PUT", `/orders/${mine.id}`, staff.token, { item: "p3", userId: bea.user.id });
    expect((await moved.json()).userId).toBe(bea.user.id);
  });

  test("delete own: 403 on a record the caller can see, and nothing without the action", async () => {
    const mine = await call("POST", "/reviews", ada.token, { stars: 5 }).then((r) => r.json());
    const theirs = await call("POST", "/reviews", bea.token, { stars: 1 }).then((r) => r.json());
    expect((await call("DELETE", `/reviews/${theirs.id}`, ada.token)).status).toBe(403); // reviews are read-all
    expect((await call("DELETE", `/reviews/${mine.id}`, ada.token)).status).toBe(200);
    const order = await call("POST", "/orders", ada.token, { item: "p1" }).then((r) => r.json());
    expect((await call("DELETE", `/orders/${order.id}`, ada.token)).status).toBe(403);
    expect((await call("DELETE", `/orders/${order.id}`, admin.token)).status).toBe(200); // "*"
  });

  test("_expand nests only what the caller could read directly", async () => {
    const theirs = await call("POST", "/orders", bea.token, { item: "p1" }).then((r) => r.json());
    const review = await call("POST", "/reviews", ada.token, { stars: 4, orderId: theirs.id, ledgerId: "l1" }).then(
      (r) => r.json(),
    );
    // Reviews are read-all for customers, orders read-own, and the ledger not readable at all.
    const asAda = await call("GET", `/reviews/${review.id}?_expand=orders,ledger`, ada.token).then((r) => r.json());
    expect(asAda.order).toBeNull();
    expect(asAda).not.toHaveProperty("ledger");
    const listed = await call("GET", "/reviews?_expand=orders", ada.token).then((r) => r.json());
    expect(listed.find((r: any) => r.id === review.id).order).toBeNull();
    // The owner of that order sees it nested.
    const asBea = await call("GET", `/reviews/${review.id}?_expand=orders`, bea.token).then((r) => r.json());
    expect(asBea.order).toMatchObject({ id: theirs.id });
  });

  test("a role change applies from the next request, on the same token", async () => {
    expect((await call("GET", "/ledger", bea.token)).status).toBe(403);
    await assign(bea.user.id, "admin");
    expect((await call("GET", "/ledger", bea.token)).status).toBe(200);
    await assign(bea.user.id, "customer");
    expect((await call("GET", "/ledger", bea.token)).status).toBe(403);
  });

  test("managing accounts through the API takes the _users permission", async () => {
    expect((await call("GET", "/auth/users")).status).toBe(401);
    expect((await call("GET", "/auth/users", ada.token)).status).toBe(403);
    const listed = await call("GET", "/auth/users", staff.token);
    expect(listed.status).toBe(200);
    const accounts = await listed.json();
    expect(accounts.length).toBe(4);
    for (const account of accounts) expect(account).not.toHaveProperty("passwordHash");

    // staff may list but not change; admin ("*") may, and only to a role the rules define.
    const role = (token: string, body: unknown) => call("PUT", `/auth/users/${ada.user.id}/role`, token, body);
    expect((await role(staff.token, { role: "staff" })).status).toBe(403);
    expect((await role(admin.token, { role: "wizard" })).status).toBe(400);
    const promoted = await role(admin.token, { role: "staff" });
    expect(await promoted.json()).toMatchObject({ id: ada.user.id, role: "staff" });
    await assign(ada.user.id, "customer");
  });

  test("the refusing stage in the request log is rbacGuard", async () => {
    const res = await call("GET", "/ledger", ada.token);
    const cid = res.headers.get("x-correlation-id");
    const { entries } = await fetch(`${core.base}/store/_admin/logs`, { headers: adminAuth }).then((r) => r.json());
    const entry = entries.find((e: any) => e.correlationId === cid);
    expect(entry.lifecycle.filter((s: any) => !s.ok).map((s: any) => s.stage)).toEqual(["rbacGuard"]);
  });

  test("rules are checked where they are written, and deploy promotes them", async () => {
    await seed(core, "rulewrites", { posts: [], config: { AUTH_ENABLED: "true", RBAC_ENABLED: "true" } });
    const write = (body: unknown) =>
      fetch(`${core.base}/rulewrites/_admin/files/draft_rbac`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const bad = await write({
      defaultRole: "nobody",
      roles: { guest: { posts: { read: "own" } }, member: { posts: ["reed"] } },
    });
    expect(bad.status).toBe(400);
    const problems = ((await bad.json()).problems as string[]).join(" | ");
    expect(problems).toContain("defaultRole");
    expect(problems).toContain('"own"');
    expect(problems).toContain('"reed"');
    expect(await Bun.file(join(core.dir, "rulewrites", "system", "draft_rbac.json")).exists()).toBe(false);

    expect((await write({ defaultRole: "member", roles: { member: { posts: ["read"] } } })).status).toBe(201);
    const deploy = await fetch(`${core.base}/rulewrites/_admin/deploy`, { method: "POST", headers: adminAuth });
    expect((await deploy.json()).promoted).toEqual(["rbac"]);
    const { token } = await signupAs("rulewrites", "m@x.co");
    expect((await fetch(`${core.base}/rulewrites/posts`, { headers: bearer(token) })).status).toBe(200);
    const create = await fetch(`${core.base}/rulewrites/posts`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(create.status).toBe(403);
  }, 20_000);

  test("rules that are invalid on disk refuse everything rather than open up", async () => {
    await seed(core, "badrules", {
      posts: [{ id: "1" }],
      config: { AUTH_ENABLED: "true", RBAC_ENABLED: "true" },
      rbac: { roles: "everyone" },
    });
    const { token } = await signupAs("badrules", "b@x.co");
    expect((await fetch(`${core.base}/badrules/posts`, { headers: bearer(token) })).status).toBe(403);
    expect((await fetch(`${core.base}/badrules/posts`)).status).toBe(401);
  }, 15_000);

  test("rbac.json is never served, and does nothing unless both switches are on", async () => {
    expect((await call("GET", "/rbac", admin.token)).status).toBe(403);
    // Rules that would lock every account out, if they applied.
    const locked = { defaultRole: "member", roles: { member: {} } };

    // No AUTH_ENABLED: no sign-in, so no roles, whatever RBAC_ENABLED says.
    await seed(core, "rulesnoauth", { posts: [{ id: "1" }], config: { RBAC_ENABLED: "true" }, rbac: locked });
    expect((await fetch(`${core.base}/rulesnoauth/posts`)).status).toBe(200);

    // No RBAC_ENABLED: the plain ownership rules, AUTH_PUBLIC_ROUTES honoured, signups are "user".
    await seed(core, "rulesoff", {
      posts: [{ id: "1" }],
      config: { AUTH_ENABLED: "true", AUTH_PUBLIC_ROUTES: "posts" },
      rbac: locked,
    });
    expect((await fetch(`${core.base}/rulesoff/posts`)).status).toBe(200);
    const { token, user } = await signupAs("rulesoff", "o@x.co");
    expect((user as { role?: string }).role).toBe("user");
    const created = await fetch(`${core.base}/rulesoff/posts`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
  }, 15_000);
});

// ── Tenant layout: data/ and system/ ───────────────────────────────

describe("tenant layout", () => {
  const write = (tenant: string, name: string, body: unknown) =>
    fetch(`${core.base}/${tenant}/_admin/files/${name}`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("resources and their drafts land in data/, settings in system/", async () => {
    expect((await write("layout", "posts", [{ id: "1" }])).status).toBe(201);
    expect((await write("layout", "draft_posts", [{ id: "2" }])).status).toBe(201);
    expect((await write("layout", "config", { QA_MODE: "true" })).status).toBe(201);
    expect((await write("layout", "draft_config", { QA_MODE: "false" })).status).toBe(201);

    expect((await readdir(join(core.dir, "layout"))).sort()).toEqual(["data", "system"]);
    expect((await readdir(join(core.dir, "layout", "data"))).sort()).toEqual(["draft_posts.json", "posts.json"]);
    expect((await readdir(join(core.dir, "layout", "system"))).sort()).toEqual(["config.json", "draft_config.json"]);
  });

  test("deploy promotes each draft within its own folder, and never a feature's file", async () => {
    await seed(core, "promote", {
      posts: [{ id: "1", title: "live" }],
      draft_posts: [{ id: "1", title: "staged" }],
      config: { QA_MODE: "false" },
      draft_config: { QA_MODE: "true" },
    });
    // A feature's file is written by its feature alone, and settings never stage in data/.
    await Bun.write(join(core.dir, "promote", "system", "draft_users.json"), JSON.stringify([{ id: "x", email: "x@y.co" }]));
    await Bun.write(join(core.dir, "promote", "data", "draft_config.json"), JSON.stringify({ QA_MODE: "false" }));

    const deploy = await fetch(`${core.base}/promote/_admin/deploy`, { method: "POST", headers: adminAuth });
    expect(((await deploy.json()).promoted as string[]).sort()).toEqual(["config", "posts"]);

    expect(await readFile(core, "promote", "posts")).toEqual([{ id: "1", title: "staged" }]);
    expect(await readFile(core, "promote", "config")).toEqual({ QA_MODE: "true" });
    expect(await Bun.file(join(core.dir, "promote", "system", "users.json")).exists()).toBe(false);
    // Served, so the stray data/draft_config did not stop it; QA on, so system/'s draft did go live.
    const teapot = await fetch(`${core.base}/promote/posts`, { headers: { "x-stubbase-status": "418" } });
    expect(teapot.status).toBe(418);
  });

  test("files in the tenant root are not read — only the two folders are", async () => {
    await mkdir(join(core.dir, "rootfiles"), { recursive: true });
    await Bun.write(join(core.dir, "rootfiles", "posts.json"), JSON.stringify([{ id: "1" }]));
    // Read, this would answer 503 rather than 404.
    await Bun.write(join(core.dir, "rootfiles", "status.json"), JSON.stringify({ status: "stopped" }));
    const res = await fetch(`${core.base}/rootfiles/posts`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "resource not found" });
  });
});

describe("the admin system plane", () => {
  beforeAll(async () => {
    await seed(core, "sysview", { config: { AUTH_ENABLED: "true" } });
    await seedSystemFile(core, "sysview", "users", [{ id: "1", email: "a@b.co", passwordHash: "HASH", role: "user" }]);
    await seedSystemFile(core, "sysview", "reset-password", [
      { userId: "1", codeHash: "CODEHASH", expiresAt: "2099-01-01T00:00:00.000Z", attempts: 2, issuedAt: [] },
    ]);
  });

  test("lists a tenant's feature files and shows each without its credentials", async () => {
    const list = await fetch(`${core.base}/sysview/_admin/system`, { headers: adminAuth });
    expect(await list.json()).toEqual({ tenant: "sysview", files: ["users", "reset-password"] });

    const users = await fetch(`${core.base}/sysview/_admin/system/users`, { headers: adminAuth });
    expect(await users.json()).toEqual([{ id: "1", email: "a@b.co", role: "user" }]);

    const resets = await fetch(`${core.base}/sysview/_admin/system/reset-password`, { headers: adminAuth });
    expect(await resets.json()).toEqual([
      { userId: "1", expiresAt: "2099-01-01T00:00:00.000Z", attempts: 2, issuedAt: [] },
    ]);

    const empty = await fetch(`${core.base}/plain/_admin/system`, { headers: adminAuth });
    expect(await empty.json()).toEqual({ tenant: "plain", files: [] });
  });

  test("is read-only, admin-only, and names only feature files", async () => {
    const url = `${core.base}/sysview/_admin/system/users`;
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await fetch(url, { method, headers: adminAuth })).status).toBe(405);
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url)).headers.get("access-control-allow-origin")).toBeNull();
    // config has its own door (files/config); it is not a feature file.
    expect((await fetch(`${core.base}/sysview/_admin/system/config`, { headers: adminAuth })).status).toBe(404);
    // …and the files plane cannot reach a feature file: `users` there is data/users.json.
    expect((await fetch(`${core.base}/sysview/_admin/files/users`, { headers: adminAuth })).status).toBe(404);
  });
});

// ── Password: change, forgot, reset ────────────────────────────────

describe("change password", () => {
  const change = (token: string | undefined, body: unknown) =>
    fetch(`${core.base}/chpw/auth/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? bearer(token) : {}) },
      body: JSON.stringify(body),
    });
  const login = (password: string) =>
    fetch(`${core.base}/chpw/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "hal@test.co", password }),
    });
  const read = (token: string) => fetch(`${core.base}/chpw/posts`, { headers: bearer(token) });

  test("takes the token and the current password, and signs every other session out", async () => {
    await seed(core, "chpw", { posts: [], config: { AUTH_ENABLED: "true" } });
    const first = await signupAs("chpw", "hal@test.co");
    const second = (await (await login("password123")).json()).token as string;

    expect((await change(undefined, { currentPassword: "password123", password: "new-password-1" })).status).toBe(401);
    const wrong = await change(first.token, { currentPassword: "not-my-password", password: "new-password-1" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "current password is incorrect" });
    expect((await read(second)).status).toBe(200); // a refused change revokes nothing

    const ok = await change(first.token, { currentPassword: "password123", password: "new-password-1" });
    expect(ok.status).toBe(200);
    const { token: fresh, user } = await ok.json();
    expect(user).not.toHaveProperty("passwordHash");

    for (const stale of [first.token, second]) expect((await read(stale)).status).toBe(401);
    expect((await read(fresh)).status).toBe(200);
    expect((await login("password123")).status).toBe(401);
    expect((await login("new-password-1")).status).toBe(200);
  }, 30_000);
});

describe("forgot and reset password", () => {
  const PASSWORD = "password123";
  const mail: { from: string; to: string; subject: string; text: string; html: string; authorization: string | null }[] = [];
  let mailStatus = 200;
  let mailer: ReturnType<typeof Bun.serve>;
  let svc: Service;

  beforeAll(async () => {
    // Stands in for Resend, so every code the core sends can be read back.
    mailer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as any;
        if (mailStatus !== 200) return new Response("{}", { status: mailStatus });
        mail.push({ ...body, authorization: req.headers.get("authorization") });
        return Response.json({ id: `email_${mail.length}` });
      },
    });
    svc = await boot("reset", { RESEND_API_URL: `http://127.0.0.1:${mailer.port}/emails` });
  }, 30_000);

  afterAll(() => mailer.stop(true));

  const post = (tenant: string, route: string, body: unknown, on = svc) =>
    fetch(`${on.base}/${tenant}/auth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const codeIn = (text: string) => /\b(\d{6})\b/.exec(text)?.[1] ?? "";
  const mailTo = (to: string) => mail.filter((m) => m.to === to);
  const project = (tenant: string, extra: Record<string, string> = {}) =>
    seed(svc, tenant, {
      posts: [],
      config: { AUTH_ENABLED: "true", RESEND_API_KEY: "re_test_key", RESEND_FROM: "App <hi@app.test>", ...extra },
    });
  const INVALID = { error: "invalid or expired reset code" };

  test("answers the same for an unknown email, and mails a code only to a real account", async () => {
    await project("fp", { AUTH_RESET_URL: "https://app.test/reset" });
    await signupAs("fp", "ada@test.co", PASSWORD, svc);

    const ghost = await post("fp", "forgot-password", { email: "ghost@test.co" });
    const real = await post("fp", "forgot-password", { email: "ADA@test.co" });
    expect([ghost.status, real.status]).toEqual([202, 202]);
    expect(await ghost.json()).toEqual(await real.json());

    expect(mailTo("ghost@test.co")).toHaveLength(0);
    const [sent, ...more] = mailTo("ada@test.co");
    expect(more).toHaveLength(0);
    expect(sent).toMatchObject({ from: "App <hi@app.test>", authorization: "Bearer re_test_key" });
    const code = codeIn(sent.text);
    expect(code).toMatch(/^\d{6}$/);
    // The link carries email and code in the fragment, which never reaches a server log.
    expect(sent.text).toContain(`https://app.test/reset#email=ada%40test.co&code=${code}`);
    expect(sent.html).toContain(code);
  }, 20_000);

  test("a code resets the password once, and every earlier token stops working", async () => {
    await project("rp");
    const { token: before } = await signupAs("rp", "bo@test.co", PASSWORD, svc);
    expect((await fetch(`${svc.base}/rp/posts`, { headers: bearer(before) })).status).toBe(200);

    expect((await post("rp", "forgot-password", { email: "bo@test.co" })).status).toBe(202);
    const code = codeIn(mailTo("bo@test.co").at(-1)!.text);
    // No link without AUTH_RESET_URL: the code alone.
    expect(mailTo("bo@test.co").at(-1)!.text).not.toContain("http");

    const reset = await post("rp", "reset-password", { email: "bo@test.co", code, password: "a-brand-new-password" });
    expect(reset.status).toBe(200);
    const { token: after, user } = await reset.json();
    expect(user).not.toHaveProperty("passwordHash");

    expect((await fetch(`${svc.base}/rp/posts`, { headers: bearer(before) })).status).toBe(401);
    expect((await fetch(`${svc.base}/rp/posts`, { headers: bearer(after) })).status).toBe(200);
    expect((await post("rp", "login", { email: "bo@test.co", password: PASSWORD })).status).toBe(401);
    expect((await post("rp", "login", { email: "bo@test.co", password: "a-brand-new-password" })).status).toBe(200);

    const again = await post("rp", "reset-password", { email: "bo@test.co", code, password: "yet-another-password" });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual(INVALID);
  }, 30_000);

  test("every way a code is wrong reads alike, and five wrong guesses spend it", async () => {
    await project("guess");
    await signupAs("guess", "cy@test.co", PASSWORD, svc);
    const attempt = (email: string, code: string) =>
      post("guess", "reset-password", { email, code, password: "whatever-password" });

    // Nothing issued yet, and an address with no account: the same answer.
    expect(await (await attempt("cy@test.co", "123456")).json()).toEqual(INVALID);
    expect(await (await attempt("ghost@test.co", "123456")).json()).toEqual(INVALID);

    await post("guess", "forgot-password", { email: "cy@test.co" });
    const code = codeIn(mailTo("cy@test.co").at(-1)!.text);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) expect(await (await attempt("cy@test.co", wrong)).json()).toEqual(INVALID);

    // The right code, too late: the guesses spent it.
    expect((await attempt("cy@test.co", code)).status).toBe(400);
    expect((await post("guess", "login", { email: "cy@test.co", password: PASSWORD })).status).toBe(200);
  }, 30_000);

  test("codes are throttled per account, quietly, and eviction does not reset the count", async () => {
    await project("throttle");
    await signupAs("throttle", "di@test.co", PASSWORD, svc);
    for (let i = 0; i < 6; i++)
      expect((await post("throttle", "forgot-password", { email: "di@test.co" })).status).toBe(202);
    expect(mailTo("di@test.co")).toHaveLength(5);

    await fetch(`${svc.base}/throttle/_admin/flush`, { method: "POST", headers: adminAuth });
    expect((await post("throttle", "forgot-password", { email: "di@test.co" })).status).toBe(202);
    expect(mailTo("di@test.co")).toHaveLength(5);

    // Each request replaced the code before it: only the newest one works.
    const codes = mailTo("di@test.co").map((m) => codeIn(m.text));
    const newest = codes.at(-1)!;
    if (codes[0] !== newest)
      expect((await post("throttle", "reset-password", { email: "di@test.co", code: codes[0], password: "new-password-2" })).status).toBe(400);
    expect((await post("throttle", "reset-password", { email: "di@test.co", code: newest, password: "new-password-2" })).status).toBe(200);
  }, 30_000);

  test("a code is stored only as a keyed hash, and the system view shows neither hash", async () => {
    await project("stored");
    await signupAs("stored", "ed@test.co", PASSWORD, svc);
    await post("stored", "forgot-password", { email: "ed@test.co" });
    const code = codeIn(mailTo("ed@test.co").at(-1)!.text);

    const [row] = await systemFile(svc, "stored", "reset-password");
    expect(Object.values(row)).not.toContain(code);
    expect(row.codeHash).toBeString();
    expect(row.codeHash).not.toBe(new Bun.CryptoHasher("sha256").update(code).digest("base64url"));

    const [shown] = await fetch(`${svc.base}/stored/_admin/system/reset-password`, { headers: adminAuth }).then((r) => r.json());
    expect(shown).not.toHaveProperty("codeHash");
    expect(shown).toMatchObject({ userId: row.userId, attempts: 0 });
  }, 20_000);

  test("a provider that refuses the email is reported, not swallowed", async () => {
    await project("bounce");
    await signupAs("bounce", "fay@test.co", PASSWORD, svc);
    mailStatus = 500;
    try {
      const res = await post("bounce", "forgot-password", { email: "fay@test.co" });
      expect(res.status).toBe(502);
    } finally {
      mailStatus = 200;
    }
  }, 20_000);

  test("an account that signed up with OAuth can use a code to set its first password", async () => {
    await project("oauthonly");
    await seedSystemFile(svc, "oauthonly", "users", [{ id: "gh-1", email: "gus@test.co", role: "user", provider: "github" }]);
    await post("oauthonly", "forgot-password", { email: "gus@test.co" });
    const code = codeIn(mailTo("gus@test.co").at(-1)!.text);
    expect((await post("oauthonly", "reset-password", { email: "gus@test.co", code, password: "first-password" })).status).toBe(200);
    expect((await post("oauthonly", "login", { email: "gus@test.co", password: "first-password" })).status).toBe(200);
  }, 20_000);

  test("with no email provider it is not configured — unless the dev log flag is on", async () => {
    await seed(svc, "nomail", { posts: [], config: { AUTH_ENABLED: "true" } });
    await signupAs("nomail", "hana@test.co", PASSWORD, svc);
    for (const email of ["hana@test.co", "ghost@test.co"]) {
      const res = await post("nomail", "forgot-password", { email });
      expect(res.status).toBe(404); // the same for every address
      expect((await res.json()).error).toContain("RESEND_API_KEY");
    }

    const dev = await boot("reset-log", { AUTH_RESET_LOG_CODES: "true" });
    await seed(dev, "t", { config: { AUTH_ENABLED: "true" } });
    await signupAs("t", "ivy@test.co", PASSWORD, dev);
    expect((await post("t", "forgot-password", { email: "ivy@test.co" }, dev)).status).toBe(202);
    const pattern = /password reset code for ivy@test\.co is (\d{6})/;
    await waitFor(() => pattern.test(dev.output.join("")));
    const code = pattern.exec(dev.output.join(""))![1];
    expect((await post("t", "reset-password", { email: "ivy@test.co", code, password: "logged-password" }, dev)).status).toBe(200);
  }, 30_000);
});

// ── Virtual start / stop ───────────────────────────────────────────

describe("virtual start/stop", () => {
  test("every public surface answers 503 when the project is stopped", async () => {
    const surfaces: Array<[string, RequestInit]> = [
      ["/stopped/posts", {}],
      ["/stopped/posts/1", {}],
      ["/stopped/openapi.json", {}],
      ["/stopped/auth/login", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
      ["/stopped/auth/forgot-password", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
      ["/stopped/_notify/email", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
    ];
    for (const [path, init] of surfaces) {
      const res = await fetch(`${core.base}${path}`, init);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ projectStatus: "stopped" });
    }
  });

  test("_admin stays reachable, or a stopped project could never restart", async () => {
    const read = await fetch(`${core.base}/stopped/_admin/status`, { headers: adminAuth });
    expect(await read.json()).toEqual({ tenant: "stopped", status: "stopped" });

    // Restart it through the same plane the dashboard uses.
    const write = await fetch(`${core.base}/stopped/_admin/status`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(write.status).toBe(200);

    const revived = await fetch(`${core.base}/stopped/posts`);
    expect(revived.status).toBe(200);
  });

  test("status is its own file: neither config nor a deploy can start or stop an API", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${core.base}/own-status/_admin/${path}`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // A PROJECT_STATUS key in config is only an unknown key now.
    await seed(core, "own-status", { posts: [{ id: "1" }], config: { PROJECT_STATUS: "stopped" } });
    expect((await fetch(`${core.base}/own-status/posts`)).status).toBe(200);

    expect((await post("status", { status: "stopped" })).status).toBe(200);
    expect(await Bun.file(join(core.dir, "own-status", "system", "status.json")).json()).toEqual({ status: "stopped" });
    expect((await fetch(`${core.base}/own-status/posts`)).status).toBe(503);

    // A staged config that says otherwise, and a stray status draft, both deployed: still stopped.
    await post("files/draft_config", { PROJECT_STATUS: "active" });
    await Bun.write(join(core.dir, "own-status", "system", "draft_status.json"), JSON.stringify({ status: "active" }));
    const deploy = await post("deploy", {});
    expect((await deploy.json()).promoted).toEqual(["config"]);
    expect((await fetch(`${core.base}/own-status/posts`)).status).toBe(503);
  });

  test("the status plane validates, reads a missing file as active, and is admin-only", async () => {
    await seed(core, "no-status", { posts: [] });
    const url = `${core.base}/no-status/_admin/status`;
    expect(await (await fetch(url, { headers: adminAuth })).json()).toEqual({ tenant: "no-status", status: "active" });

    const bad = await fetch(url, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(bad.status).toBe(400);
    expect(await Bun.file(join(core.dir, "no-status", "system", "status.json")).exists()).toBe(false);

    const anon = await fetch(url);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(url, { method: "DELETE", headers: adminAuth })).status).toBe(405);
  });
});

// ── Schema validation ──────────────────────────────────────────────

describe("built-in schema validation", () => {
  test("rejects a body that violates the resource schema", async () => {
    const res = await fetch(`${core.base}/validated/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no" }), // minLength 3
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
    expect(body.errors[0]).toMatchObject({ path: "title" });
  });

  test("reports missing required fields", async () => {
    const res = await fetch(`${core.base}/validated/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "no title" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toContainEqual({ path: "title", message: "is required" });
  });

  test("accepts a valid body", async () => {
    const res = await fetch(`${core.base}/validated/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "long enough" }),
    });
    expect(res.status).toBe(201);
  });
});

// ── Webhook SSRF guard ─────────────────────────────────────────────

describe("webhook SSRF guard", () => {
  test("a hook pointing at a private address is refused, and the mutation is aborted", async () => {
    const res = await fetch(`${core.base}/hooked/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "should not persist" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("before-hook URL not allowed");

    // The before-hook is a gate: nothing may have been written.
    expect(await readFile(core, "hooked", "posts")).toHaveLength(0);
  });
});

// ── Usage metering ─────────────────────────────────────────────────

describe("usage metering", () => {
  test("counts the public plane, ignores _admin, and survives eviction", async () => {
    const rows: any[] = [];
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { rows?: any[] };
        rows.push(...(body.rows ?? []));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });

    try {
      const metered = await boot("usage", {
        USAGE_SINK_URL: `http://127.0.0.1:${sink.port}/_internal/usage`,
        USAGE_FLUSH_MS: "600000", // only our explicit flush should fire
      });
      await seed(metered, "m", { posts: [{ id: "1" }] });

      const PUBLIC_REQUESTS = 4;
      for (let i = 0; i < PUBLIC_REQUESTS; i++) await fetch(`${metered.base}/m/posts`);
      // Admin traffic must not be billed to the tenant.
      for (let i = 0; i < 3; i++)
        await fetch(`${metered.base}/m/_admin/files/posts`, { headers: adminAuth });

      // Eviction ships the counters rather than dropping them.
      await fetch(`${metered.base}/m/_admin/flush`, { method: "POST", headers: adminAuth });
      await waitFor(() => rows.length > 0);

      const total = rows
        .filter((r) => r.tenantId === "m")
        .reduce((sum, r) => sum + r.requests, 0);
      expect(total).toBe(PUBLIC_REQUESTS);
      expect(rows[0].bytes).toBeGreaterThan(0);
    } finally {
      sink.stop(true);
    }
  }, 30_000);

  test("a project that doesn't exist is answered 404 before anything is metered or logged", async () => {
    // Metering and logging both key on the id in the URL. Counting a made-up id
    // would mint a usage row, a quota entry and a log ring for nobody — and the
    // two in RAM are never freed, because only a tenant that loaded is evicted.
    const rows: { tenantId: string }[] = [];
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { rows?: { tenantId: string }[] };
        rows.push(...(body.rows ?? []));
        return Response.json({ ok: true });
      },
    });

    try {
      const metered = await boot("usage-ghosts", {
        USAGE_SINK_URL: `http://127.0.0.1:${sink.port}/_internal/usage`,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "real", { posts: [{ id: "1" }] });

      // Every public surface, including paths whose route checks used to answer first.
      const probes: [string, RequestInit?][] = [
        ["/ghost-crud/posts"],
        ["/ghost-protected/_secret"],
        ["/ghost-badname/a.b"],
        ["/ghost-deep/posts/1/extra"],
        ["/ghost-openapi/openapi.json"],
        [
          "/ghost-auth/auth/login",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "a@b.co", password: "password123" }),
          },
        ],
      ];
      for (const [path, init] of probes) {
        const res = await fetch(`${metered.base}${path}`, init);
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("tenant not found");
        expect(res.headers.get("x-correlation-id")).toBeNull(); // never reached the log
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }

      await fetch(`${metered.base}/real/posts`);
      await fetch(`${metered.base}/real/_admin/flush`, { method: "POST", headers: adminAuth });
      await waitFor(() => rows.length > 0);
      expect(rows.map((r) => r.tenantId)).toEqual(["real"]);

      const log = await fetch(`${metered.base}/ghost-crud/_admin/logs`, { headers: adminAuth }).then((r) =>
        r.json(),
      );
      expect(log.entries).toEqual([]);

      // The admin plane still brings a tenant into being, and from then on it is served.
      const created = await fetch(`${metered.base}/brand-new/_admin/files/posts`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify([{ id: "1" }]),
      });
      expect(created.status).toBe(201);
      expect((await fetch(`${metered.base}/brand-new/posts`)).status).toBe(200);
    } finally {
      sink.stop(true);
    }
  }, 30_000);
});

// ── Request quota ──────────────────────────────────────────────────

/**
 * The monthly request allowance, enforced here because the core is the only
 * thing in the traffic path.
 *
 * The core stays plan-blind: it learns one number per tenant from the reply to
 * its own usage flush, which is what this stub sink plays back. Everything
 * below is driven through that channel, so the test exercises exactly the
 * contract the Dashboard API implements — and nothing here knows what a plan is
 * either.
 */
describe("request quota", () => {
  /** A usage sink that accumulates, then quotes each tenant a fixed limit. */
  function quotaSink(limit: number) {
    const used = new Map<string, number>();
    let flushes = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { rows?: { tenantId: string; requests: number }[] };
        for (const row of body.rows ?? [])
          used.set(row.tenantId, (used.get(row.tenantId) ?? 0) + row.requests);
        flushes += 1;
        return Response.json({
          ok: true,
          quotas: [...used].map(([tenantId, n]) => ({ tenantId, limit, used: n })),
        });
      },
    });
    return {
      server,
      url: `http://127.0.0.1:${server.port}/_internal/usage`,
      /** Requests the core has reported, by tenant. */
      used,
      get flushes() {
        return flushes;
      },
    };
  }

  const flush = (core: Service, tenant: string) =>
    fetch(`${core.base}/${tenant}/_admin/flush`, { method: "POST", headers: adminAuth });

  test("serves up to the allowance, then answers 429", async () => {
    const sink = quotaSink(3);
    try {
      const metered = await boot("quota", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000", // only our explicit flushes fire
      });
      await seed(metered, "q", { posts: [{ id: "1" }] });

      for (let i = 0; i < 3; i++) expect((await fetch(`${metered.base}/q/posts`)).status).toBe(200);

      // Nothing has been reconciled yet, so the tenant is still unknown and
      // still served — the fail-open half of the contract.
      const before = sink.flushes;
      await flush(metered, "q");
      await waitFor(() => sink.flushes > before);

      const blocked = await fetch(`${metered.base}/q/posts`);
      expect(blocked.status).toBe(429);
      const body = await blocked.json();
      expect(body).toMatchObject({ error: "monthly request quota exceeded", limit: 3 });
      // Public-plane errors keep the wildcard, or a browser could not read why.
      expect(blocked.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);

  test("a tenant nobody has reconciled is served — metering must not gate traffic", async () => {
    const sink = quotaSink(1);
    try {
      const metered = await boot("quota-open", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "known", { posts: [{ id: "1" }] });
      await seed(metered, "unseen", { posts: [{ id: "1" }] });

      await fetch(`${metered.base}/known/posts`);
      const before = sink.flushes;
      await flush(metered, "known");
      await waitFor(() => sink.flushes > before);

      // `known` is over its allowance of 1…
      expect((await fetch(`${metered.base}/known/posts`)).status).toBe(429);
      // …but `unseen` has never been quoted a limit, and is served anyway. A
      // sink outage or a fresh boot must not take customers down.
      expect((await fetch(`${metered.base}/unseen/posts`)).status).toBe(200);
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);

  test("the whole public plane runs out together, but _admin stays reachable", async () => {
    const sink = quotaSink(1);
    try {
      const metered = await boot("quota-plane", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "p", {
        posts: [{ id: "1" }],
        config: { AUTH_ENABLED: "true" },
      });

      await fetch(`${metered.base}/p/posts`);
      const before = sink.flushes;
      await flush(metered, "p");
      await waitFor(() => sink.flushes > before);

      // Every public surface, the same way statusBlocked takes them all down.
      expect((await fetch(`${metered.base}/p/posts`)).status).toBe(429);
      expect((await fetch(`${metered.base}/p/openapi.json`)).status).toBe(429);
      const signup = await fetch(`${metered.base}/p/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.co", password: "password123" }),
      });
      expect(signup.status).toBe(429);

      // The owner has to be able to see why their API stopped, so the plane
      // the dashboard uses is never quota-checked.
      const admin = await fetch(`${metered.base}/p/_admin/files/posts`, { headers: adminAuth });
      expect(admin.status).toBe(200);
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);

  test("an over-quota tenant is refused before its token is checked", async () => {
    // quotaGuard sits ahead of authGuard: an exhausted project should stop
    // costing the box work, and a 429 that demanded credentials would be
    // unreadable to the client being throttled.
    const sink = quotaSink(1);
    try {
      const metered = await boot("quota-auth", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "a", { posts: [{ id: "1" }], config: { AUTH_ENABLED: "true" } });

      await fetch(`${metered.base}/a/posts`);
      const before = sink.flushes;
      await flush(metered, "a");
      await waitFor(() => sink.flushes > before);

      // With auth on and no token this would be 401; the quota answers first.
      const res = await fetch(`${metered.base}/a/posts`);
      expect(res.status).toBe(429);
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);

  test("a malformed quota reply is ignored rather than fatal", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.json();
        return Response.json({ ok: true, quotas: [{ tenantId: "bad name!", limit: "x", used: -1 }] });
      },
    });
    try {
      const metered = await boot("quota-junk", {
        USAGE_SINK_URL: `http://127.0.0.1:${server.port}/_internal/usage`,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "j", { posts: [{ id: "1" }] });

      await fetch(`${metered.base}/j/posts`);
      await flush(metered, "j");
      await Bun.sleep(300);
      // Nothing valid was quoted, so nothing is enforced — and the core is
      // still alive, which is the point.
      expect((await fetch(`${metered.base}/j/posts`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a spent allowance's 429s are logged but not counted", async () => {
    const sink = quotaSink(2);
    try {
      const metered = await boot("quota-refusals", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "spent", { posts: [{ id: "1" }] });
      await seed(metered, "side", { posts: [{ id: "1" }] });

      for (let i = 0; i < 2; i++) expect((await fetch(`${metered.base}/spent/posts`)).status).toBe(200);
      let before = sink.flushes;
      await flush(metered, "spent");
      await waitFor(() => sink.flushes > before);

      for (let i = 0; i < 5; i++) expect((await fetch(`${metered.base}/spent/posts`)).status).toBe(429);
      expect((await fetch(`${metered.base}/spent/openapi.json`)).status).toBe(429);

      // Refusals alone would leave nothing to ship, so give the flush real traffic.
      await fetch(`${metered.base}/side/posts`);
      before = sink.flushes;
      await flush(metered, "side");
      await waitFor(() => sink.flushes > before);

      // Two served, six refused: `used` stays at the limit rather than climbing past it.
      expect(sink.used.get("spent")).toBe(2);
      expect(sink.used.get("side")).toBe(1);

      // Still in the owner's log — a refusal is exactly what they need to see.
      const log = await fetch(`${metered.base}/spent/_admin/logs`, { headers: adminAuth }).then((r) => r.json());
      expect(log.entries.filter((e: { status: number }) => e.status === 429)).toHaveLength(6);
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);

  test("a stopped project's 503s are logged but not counted", async () => {
    const sink = quotaSink(1_000);
    try {
      const metered = await boot("stopped-refusals", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "off", { posts: [{ id: "1" }] });
      await seedStatus(metered, "off", "stopped");
      await seed(metered, "side", { posts: [{ id: "1" }] });

      for (let i = 0; i < 3; i++) expect((await fetch(`${metered.base}/off/posts`)).status).toBe(503);
      expect((await fetch(`${metered.base}/off/openapi.json`)).status).toBe(503);

      await fetch(`${metered.base}/side/posts`);
      const before = sink.flushes;
      await flush(metered, "side");
      await waitFor(() => sink.flushes > before);

      expect(sink.used.has("off")).toBe(false);
      expect(sink.used.get("side")).toBe(1);

      const log = await fetch(`${metered.base}/off/_admin/logs`, { headers: adminAuth }).then((r) => r.json());
      expect(log.entries.filter((e: { status: number }) => e.status === 503)).toHaveLength(4);
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);

  test("a 503 or 429 a QA project asked for is real traffic, and still counted", async () => {
    // What is exempt is the platform refusing, not a status code: x-stubbase-status
    // makes the project itself answer 503 or 429, and it did serve those.
    const sink = quotaSink(1_000);
    try {
      const metered = await boot("chaos-counted", {
        USAGE_SINK_URL: sink.url,
        USAGE_FLUSH_MS: "600000",
      });
      await seed(metered, "qa", { posts: [{ id: "1" }], config: { QA_MODE: "true" } });

      const unavailable = await fetch(`${metered.base}/qa/posts`, { headers: { "x-stubbase-status": "503" } });
      const throttled = await fetch(`${metered.base}/qa/posts`, { headers: { "x-stubbase-status": "429" } });
      expect([unavailable.status, throttled.status]).toEqual([503, 429]);

      const before = sink.flushes;
      await flush(metered, "qa");
      await waitFor(() => sink.flushes > before);
      expect(sink.used.get("qa")).toBe(2);
    } finally {
      sink.server.stop(true);
    }
  }, 30_000);
});

// ── Live request log + SSE ─────────────────────────────────────────

/**
 * Opens the admin SSE stream and collects entries until `want` have arrived (or
 * the deadline passes). Returns a `close()` so the test can drop the connection
 * — the stream itself never ends.
 */
async function openLogStream(svc: Service, tenant: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${svc.base}/${tenant}/_admin/sse-logs`, {
    headers: adminAuth,
    signal: ctrl.signal,
  });
  const entries: any[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) entries.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      /* aborted by close() */
    }
  })();

  return {
    res,
    entries,
    waitFor: (want: number) => waitFor(() => entries.length >= want),
    /**
     * Waits for the entry a test is actually about. Prefer this to waitFor(n)
     * whenever the assertion names one entry: the ring replays first, so a
     * count can be satisfied by an entry from an earlier test in this file.
     */
    waitForEntry: (match: (entry: any) => boolean) => waitFor(() => entries.some(match)),
    close: () => ctrl.abort(),
  };
}

describe("live request log", () => {
  test("public responses carry a correlation id that matches the logged entry", async () => {
    const stream = await openLogStream(core, "plain");
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toBe("text/event-stream");

    const res = await fetch(`${core.base}/plain/posts`);
    const cid = res.headers.get("x-correlation-id");
    expect(cid).toBeTruthy();

    await stream.waitForEntry((e) => e.correlationId === cid);
    const entry = stream.entries.find((e) => e.correlationId === cid);
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({ tenantId: "plain", method: "GET", path: "/plain/posts", status: 200 });
    stream.close();
  });

  test("the lifecycle records each pipeline stage in order", async () => {
    const stream = await openLogStream(core, "plain");
    const res = await fetch(`${core.base}/plain/posts`);
    const cid = res.headers.get("x-correlation-id");

    await stream.waitForEntry((e) => e.correlationId === cid);
    const entry = stream.entries.find((e) => e.correlationId === cid);
    const stages = entry.lifecycle.map((s: any) => s.stage);
    expect(stages).toEqual([
      "statusGuard",
      "quotaGuard",
      "authGuard",
      "rbacGuard",
      "chaosGuard",
      "validationGuard",
      "beforeWebhookGuard",
      "coreOperation",
      "afterWebhookGuard",
    ]);
    expect(entry.lifecycle.every((s: any) => s.ok)).toBe(true);
    stream.close();
  });

  test("the rejecting stage is the one marked failed", async () => {
    const stream = await openLogStream(core, "secure");
    const res = await fetch(`${core.base}/secure/posts`); // AUTH_ENABLED, no token
    expect(res.status).toBe(401);
    const cid = res.headers.get("x-correlation-id");

    await stream.waitForEntry((e) => e.correlationId === cid);
    const entry = stream.entries.find((e) => e.correlationId === cid);
    const failed = entry.lifecycle.filter((s: any) => !s.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].stage).toBe("authGuard");
    expect(failed[0].note).toBe("rejected with 401");
    // Stages after the rejection never ran.
    expect(entry.lifecycle.map((s: any) => s.stage)).toEqual([
      "statusGuard",
      "quotaGuard",
      "authGuard",
    ]);
    stream.close();
  });

  test("a fresh connection replays the buffered ring before streaming", async () => {
    await fetch(`${core.base}/plain/posts?replay=1`);
    const stream = await openLogStream(core, "plain");
    // The request happened before the stream opened, so it can only be a replay.
    await stream.waitForEntry((e) => e.query === "?replay=1");
    expect(stream.entries.some((e) => e.query === "?replay=1")).toBe(true);
    stream.close();
  });

  test("the admin plane is never logged", async () => {
    const stream = await openLogStream(core, "plain");
    await fetch(`${core.base}/plain/_admin/files/posts`, { headers: adminAuth });
    await fetch(`${core.base}/plain/posts?marker=after`); // ordering fence
    await stream.waitForEntry((e) => e.query === "?marker=after");
    expect(stream.entries.some((e) => e.path.includes("_admin"))).toBe(false);
    stream.close();
  });

  test("sse-logs refuses an unauthenticated reader", async () => {
    const res = await fetch(`${core.base}/plain/_admin/sse-logs`);
    expect(res.status).toBe(401);
    // ...and carries no CORS, like the rest of the admin plane.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the snapshot route returns the same ring without holding a stream open", async () => {
    const snap = await boot("logsnap");
    await seed(snap, "t", { posts: [] });
    await fetch(`${snap.base}/t/posts?n=1`);
    await fetch(`${snap.base}/t/posts?n=2`);

    const res = await fetch(`${snap.base}/t/_admin/logs`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant).toBe("t");
    // Newest last, same shape the SSE stream emits.
    expect(body.entries.map((e: any) => e.query)).toEqual(["?n=1", "?n=2"]);
    expect(body.entries[0].correlationId).toBeString();

    // _limit takes the newest N.
    const capped = await fetch(`${snap.base}/t/_admin/logs?_limit=1`, { headers: adminAuth });
    expect((await capped.json()).entries.map((e: any) => e.query)).toEqual(["?n=2"]);

    // Admin-authenticated and CORS-free, like the rest of the plane.
    const anon = await fetch(`${snap.base}/t/_admin/logs`);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("access-control-allow-origin")).toBeNull();

    // Reading the snapshot must not leave a subscriber behind, or every AI
    // diagnosis would leak one: an unread tenant with no subscribers evicts.
    expect((await (await fetch(`${snap.base}/t/_admin/logs`, { headers: adminAuth })).json()).entries.length).toBe(2);
  }, 30_000);

  test("the ring drops the oldest entry past LOG_CAP, and bodies are truncated", async () => {
    const small = await boot("logcap", { LOG_CAP: "3", LOG_BODY_CHARS: "20" });
    await seed(small, "t", { posts: [] });

    for (let i = 0; i < 5; i++) await fetch(`${small.base}/t/posts?n=${i}`);
    await fetch(`${small.base}/t/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(200) }),
    });

    const stream = await openLogStream(small, "t");
    await stream.waitFor(3);
    await Bun.sleep(100); // let any extra replay frames land

    expect(stream.entries).toHaveLength(3); // capped
    expect(stream.entries.some((e) => e.query === "?n=0")).toBe(false); // oldest dropped

    const post = stream.entries.find((e) => e.method === "POST");
    expect(post.requestBody).toEndWith("…[truncated]");
    expect(post.requestBody.length).toBeLessThan(60);
    stream.close();
  });
});

// ── MCP + the in-memory SQLite projection ──────────────────────────

/**
 * Speaks the MCP HTTP+SSE transport the way a real client does: open the
 * stream, read the POST URL out of the mandatory first `endpoint` event, then
 * POST JSON-RPC and wait for the reply to arrive back down the stream.
 */
async function openMcp(svc: Service, tenant: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${svc.base}/${tenant}/_admin/mcp/sse`, {
    headers: adminAuth,
    signal: ctrl.signal,
  });
  const frames: string[] = [];
  const messages: any[] = [];
  let endpoint = "";

  if (res.ok) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const parts = buffered.split("\n\n");
          buffered = parts.pop() ?? "";
          for (const frame of parts) {
            frames.push(frame);
            const data = frame.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
            if (!data) continue;
            if (frame.startsWith("event: endpoint")) endpoint = data;
            else messages.push(JSON.parse(data));
          }
        }
      } catch {
        /* aborted by close() */
      }
    })();
    await waitFor(() => endpoint !== "");
  }

  let nextId = 0;
  async function rpc(method: string, params?: unknown) {
    const id = ++nextId;
    const post = await fetch(`${svc.base}${endpoint}`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    });
    expect(post.status).toBe(202); // the POST is an inbox; the reply rides the stream
    await waitFor(() => messages.some((m) => m.id === id));
    return messages.find((m) => m.id === id);
  }

  /** Runs SQL and returns the tool result (text unparsed — errors carry prose). */
  const call = async (sql: string) =>
    (await rpc("tools/call", { name: "execute_sql_query", arguments: { sql } })).result;
  /** Runs SQL that is expected to succeed, and returns the decoded payload. */
  const query = async (sql: string) => {
    const result = await call(sql);
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0].text);
  };

  return { res, frames, messages, endpoint, rpc, call, query, close: () => ctrl.abort() };
}

describe("MCP transport", () => {
  beforeAll(async () => {
    await seed(core, "mcp", {
      // Deliberately heterogeneous: `views`/`meta`/`score` each appear on one
      // row only. Inferring columns from the first record would lose them.
      posts: [
        { id: "1", title: "first", views: 10, tags: ["a", "b"], userId: "u1" },
        { id: "2", title: "second", userId: "u2", meta: { pinned: true }, score: 1.5 },
      ],
      users: [
        { id: "u1", email: "a@x.com", role: "admin" },
        { id: "u2", email: "b@x.com" },
      ],
      draft_posts: [{ id: "99", title: "staged" }],
      config: { QA_MODE: "false", AUTH_ENABLED: "true" },
      empties: [],
    });
    // The sign-in accounts: a different table that happens to share the name.
    await seedSystemFile(core, "mcp", "users", [
      { id: "acct-1", email: "secret-account@x.com", passwordHash: "SECRET-HASH" },
    ]);
  });

  test("the stream's first event is `endpoint`, naming this session's POST URL", async () => {
    const mcp = await openMcp(core, "mcp");
    expect(mcp.res.status).toBe(200);
    expect(mcp.res.headers.get("content-type")).toBe("text/event-stream");
    // MCP spec: `endpoint` must be the first event on the stream.
    expect(mcp.frames[0]).toStartWith("event: endpoint\ndata: ");
    expect(mcp.endpoint).toStartWith("/mcp/_admin/mcp/message?sessionId=");
    mcp.close();
  });

  test("it is admin-authenticated and CORS-free, like the rest of the plane", async () => {
    const anon = await fetch(`${core.base}/mcp/_admin/mcp/sse`);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("access-control-allow-origin")).toBeNull();

    const authed = await openMcp(core, "mcp");
    expect(authed.res.headers.get("access-control-allow-origin")).toBeNull();
    authed.close();
  });

  test("initialize advertises the tools capability", async () => {
    const mcp = await openMcp(core, "mcp");
    const reply = await mcp.rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(reply.result.protocolVersion).toBe("2024-11-05");
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(reply.result.serverInfo.name).toBe("stubbase/mcp");
    mcp.close();
  });

  test("tools/list injects the live schema, unioning keys across every row", async () => {
    const mcp = await openMcp(core, "mcp");
    const { tools } = (await mcp.rpc("tools/list")).result;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("execute_sql_query");
    expect(tools[0].inputSchema.required).toEqual(["sql"]);

    const description: string = tools[0].description;
    // Columns present on only one record still have to be queryable.
    expect(description).toContain(
      "posts(id TEXT, title TEXT, views INTEGER, tags TEXT, userId TEXT, meta TEXT, score REAL)",
    );
    expect(description).toContain("users(id TEXT, email TEXT, role TEXT)");
    // A table with no object records can't have a shape — say so, don't hide it.
    expect(description).toContain("Not mounted");
    expect(description).toContain("empties");
    mcp.close();
  });

  test("SQL runs against the mounted data, joins included", async () => {
    const mcp = await openMcp(core, "mcp");
    const joined = await mcp.query(
      "SELECT p.title, u.email FROM posts p JOIN users u ON u.id = p.userId ORDER BY p.id",
    );
    expect(joined.rows).toEqual([
      { title: "first", email: "a@x.com" },
      { title: "second", email: "b@x.com" },
    ]);

    // Nested JSON rides as text, so json_extract() reaches into it.
    const nested = await mcp.query("SELECT json_extract(meta, '$.pinned') AS pinned FROM posts WHERE id = '2'");
    expect(nested.rows).toEqual([{ pinned: 1 }]);
    mcp.close();
  });

  test("the identity table is never mounted, so SELECT * cannot reach an account", async () => {
    const mcp = await openMcp(core, "mcp");
    // `users` is data/users.json: the two rows the project wrote, and nothing from system/.
    const all = await mcp.query("SELECT * FROM users ORDER BY id");
    expect(all.rows.map((r: any) => r.email)).toEqual(["a@x.com", "b@x.com"]);
    const explicit = await mcp.call("SELECT passwordHash FROM users");
    expect(explicit.isError).toBe(true);
    expect(explicit.content[0].text).toContain("no such column");
    mcp.close();
  });

  test("staged drafts, tenant config and feature files are not mounted", async () => {
    const mcp = await openMcp(core, "mcp");
    for (const table of ["draft_posts", "config", "reset-password"]) {
      const result = await mcp.call(`SELECT * FROM "${table}"`);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no such table");
    }
    mcp.close();
  });

  test("the projection is read-only — writes are refused and change nothing", async () => {
    const mcp = await openMcp(core, "mcp");
    for (const sql of [
      "DROP TABLE posts",
      "DELETE FROM posts",
      "UPDATE posts SET title = 'hacked'",
      "INSERT INTO posts (id) VALUES ('x')",
      "/* comment */ -- line\n DROP TABLE posts",
      "ATTACH DATABASE '/etc/passwd' AS leak",
      "WITH x AS (SELECT 1) DELETE FROM posts", // caught by PRAGMA query_only
    ]) {
      const result = await mcp.call(sql);
      expect(result.isError).toBe(true);
    }
    // Both the projection and the file behind it are untouched.
    expect((await mcp.query("SELECT COUNT(*) AS n FROM posts")).rows).toEqual([{ n: 2 }]);
    expect(await readFile(core, "mcp", "posts")).toHaveLength(2);
    mcp.close();
  });

  test("ATTACH cannot reach another SQLite database on the box", async () => {
    // This is why the SELECT/WITH check exists as well as PRAGMA query_only:
    // query_only stops writes but permits ATTACH, and the Dashboard API's
    // app.sqlite — platform users and session tokens — lives on the same host.
    const secretPath = join(ROOT, "not-a-tenant.sqlite");
    const secrets = new Database(secretPath);
    secrets.run("CREATE TABLE sessions (token TEXT)");
    secrets.run("INSERT INTO sessions VALUES ('super-secret-token')");
    secrets.close();

    const mcp = await openMcp(core, "mcp");
    const attached = await mcp.call(`ATTACH DATABASE '${secretPath}' AS leak`);
    expect(attached.isError).toBe(true);
    expect(attached.content[0].text).toContain("must start with SELECT or WITH");

    // ...and the alias never came into being, so nothing can be read through it.
    const read = await mcp.call("SELECT token FROM leak.sessions");
    expect(read.isError).toBe(true);
    expect(read.content[0].text).toContain("no such table");
    mcp.close();
  });

  test("the projection follows REST writes and admin deploys", async () => {
    const svc = await boot("mcpfresh");
    await seed(svc, "t", { posts: [{ id: "1", title: "live" }] });
    const mcp = await openMcp(svc, "t");

    expect((await mcp.query("SELECT COUNT(*) AS n FROM posts")).rows).toEqual([{ n: 1 }]);

    // A write through the REST plane invalidates it.
    const created = await fetch(`${svc.base}/t/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "second" }),
    });
    expect(created.status).toBe(201);
    expect((await mcp.query("SELECT COUNT(*) AS n FROM posts")).rows).toEqual([{ n: 2 }]);

    // So does an admin file write promoted by deploy.
    await fetch(`${svc.base}/t/_admin/files/draft_posts`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify([{ id: "1", title: "promoted" }]),
    });
    await fetch(`${svc.base}/t/_admin/deploy`, { method: "POST", headers: adminAuth });
    expect((await mcp.query("SELECT title FROM posts")).rows).toEqual([{ title: "promoted" }]);
    mcp.close();
  }, 30_000);

  test("a dropped projection is remounted transparently on the next query", async () => {
    const svc = await boot("mcpidle", { SQL_IDLE_MS: "150" });
    await seed(svc, "t", { posts: [{ id: "1", title: "still here" }] });
    const mcp = await openMcp(svc, "t");

    expect((await mcp.query("SELECT title FROM posts")).rows).toEqual([{ title: "still here" }]);
    await Bun.sleep(400); // projection times out and frees its RAM
    // The SSE session outlives the projection: the next call just re-mounts.
    expect((await mcp.query("SELECT title FROM posts")).rows).toEqual([{ title: "still here" }]);
    mcp.close();
  }, 30_000);

  test("results are capped, and the cap is reported rather than hidden", async () => {
    const svc = await boot("mcpcap", { SQL_MAX_ROWS: "2" });
    await seed(svc, "t", {
      posts: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
    });
    const mcp = await openMcp(svc, "t");
    const out = await mcp.query("SELECT id FROM posts");
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.rowCount).toBe(2);
    mcp.close();
  }, 30_000);

  test("a session id only works under the tenant it was opened for", async () => {
    const svc = await boot("mcpisolate");
    await seed(svc, "mine", { posts: [{ id: "1", title: "mine" }] });
    await seed(svc, "yours", { posts: [{ id: "1", title: "yours" }] });
    const mcp = await openMcp(svc, "mine");
    const sessionId = new URL(mcp.endpoint, svc.base).searchParams.get("sessionId");

    // Same valid session id, replayed against another tenant's path.
    const replay = await fetch(`${svc.base}/yours/_admin/mcp/message?sessionId=${sessionId}`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(replay.status).toBe(404);

    // Nothing was pushed onto the victim session, and it still sees only its own data.
    expect(mcp.messages).toHaveLength(0);
    expect((await mcp.query("SELECT title FROM posts")).rows).toEqual([{ title: "mine" }]);
    mcp.close();
  }, 30_000);

  test("an unknown session is refused outright", async () => {
    const res = await fetch(`${core.base}/mcp/_admin/mcp/message?sessionId=${crypto.randomUUID()}`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  test("notifications get no reply; unknown methods and tools report cleanly", async () => {
    const mcp = await openMcp(core, "mcp");
    const notified = await fetch(`${core.base}${mcp.endpoint}`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notified.status).toBe(202);
    await Bun.sleep(150);
    expect(mcp.messages).toHaveLength(0); // a notification is not a request

    expect((await mcp.rpc("resources/list")).error.code).toBe(-32601);

    // An unusable tool call is a capability answer, not a transport error.
    const unknown = (await mcp.rpc("tools/call", { name: "rm_rf", arguments: {} })).result;
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("execute_sql_query");
    mcp.close();
  });

  test("concurrent MCP streams are capped", async () => {
    const svc = await boot("mcpsess", { MCP_MAX_SESSIONS: "1" });
    await seed(svc, "t", { posts: [] });
    const first = await openMcp(svc, "t");
    expect(first.res.status).toBe(200);

    const second = await fetch(`${svc.base}/t/_admin/mcp/sse`, { headers: adminAuth });
    expect(second.status).toBe(503);

    // A disconnect must free its slot, or the cap turns into a slow denial of
    // service: every dropped client would permanently consume one.
    first.close();
    let status = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && status !== 200) {
      const retry = await openMcp(svc, "t"); // the abort takes a moment to land
      status = retry.res.status;
      retry.close();
      if (status !== 200) await Bun.sleep(50);
    }
    expect(status).toBe(200);
  }, 30_000);
});

// ── Service surface ────────────────────────────────────────────────

describe("service root", () => {
  test("reports liveness with CORS", async () => {
    const res = await fetch(`${core.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ service: "stubbase-core" });
  });

  test("the scratch tenants dir is the only thing touched", async () => {
    // Guards the path-traversal defence from the outside: nothing escaped.
    const entries = await readdir(core.dir);
    expect(entries.every((e) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(e))).toBe(true);
  });
});
