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
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite"; // only to build a decoy DB the MCP tool must not reach
import {
  ADMIN_SECRET,
  adminAuth,
  seedTenant,
  startCore,
  stopServices,
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
  await seed(core, "stopped", { posts: [], config: { PROJECT_STATUS: "stopped" } });
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

    // ...and the hash really is on disk, so stripping is what hid it.
    const onDisk = await readFile(core, "secure", "users");
    expect(onDisk.find((u: any) => u.email === "leak@test.co").passwordHash).toBeString();
  }, 15_000);

  test("every users response path strips passwordHash", async () => {
    const { token, user } = await fetch(`${core.base}/secure/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "paths@test.co", password: "password123" }),
    }).then((r) => r.json());
    const auth = { authorization: `Bearer ${token}` };

    const collection = await fetch(`${core.base}/secure/users`, { headers: auth }).then((r) => r.json());
    expect(collection.length).toBeGreaterThan(0);
    for (const row of collection) expect(row).not.toHaveProperty("passwordHash");

    const single = await fetch(`${core.base}/secure/users/${user.id}`, { headers: auth }).then((r) => r.json());
    expect(single).not.toHaveProperty("passwordHash");

    // _expand nests a users record into another resource — it must be stripped there too.
    await fetch(`${core.base}/secure/posts`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "mine" }),
    });
    const expanded = await fetch(`${core.base}/secure/posts?_expand=users`, { headers: auth }).then((r) =>
      r.json(),
    );
    expect(expanded[0].user).toBeTruthy();
    expect(expanded[0].user).not.toHaveProperty("passwordHash");
  }, 20_000);

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
    await seed(core, "rbac", {
      posts: [],
      users: [
        {
          id: "admin-1",
          email: "admin@test.co",
          role: "admin",
          passwordHash: adminHash,
          createdAt: new Date().toISOString(),
        },
      ],
      config: { AUTH_ENABLED: "true" },
    });

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

  test("a non-admin cannot grant themselves a role, and keeps their passwordHash", async () => {
    const update = await fetch(`${core.base}/rbac/users/${alice.id}`, {
      method: "PUT",
      headers: { ...as(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@test.co", role: "admin" }),
    });
    expect(update.status).toBe(200);
    expect((await update.json()).role).toBe("user");

    // Dropping passwordHash from the body must not lock the account out.
    const relogin = await fetch(`${core.base}/rbac/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@test.co", password }),
    });
    expect(relogin.status).toBe(200);
  }, 15_000);

  test("a non-admin cannot mutate another user's row", async () => {
    const res = await fetch(`${core.base}/rbac/users/${bob.id}`, {
      method: "PUT",
      headers: { ...as(alice.token), "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@test.co" }),
    });
    expect(res.status).toBe(403);
  });

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

// ── Virtual start / stop ───────────────────────────────────────────

describe("virtual start/stop", () => {
  test("every public surface answers 503 when the project is stopped", async () => {
    const surfaces: Array<[string, RequestInit]> = [
      ["/stopped/posts", {}],
      ["/stopped/posts/1", {}],
      ["/stopped/openapi.json", {}],
      ["/stopped/auth/login", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
      ["/stopped/_notify/email", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
    ];
    for (const [path, init] of surfaces) {
      const res = await fetch(`${core.base}${path}`, init);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ projectStatus: "stopped" });
    }
  });

  test("_admin stays reachable, or a stopped project could never restart", async () => {
    const read = await fetch(`${core.base}/stopped/_admin/files/config`, { headers: adminAuth });
    expect(read.status).toBe(200);

    // Restart it through the same plane the dashboard uses.
    const write = await fetch(`${core.base}/stopped/_admin/files/config`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({ PROJECT_STATUS: "active" }),
    });
    expect(write.status).toBe(201);

    const revived = await fetch(`${core.base}/stopped/posts`);
    expect(revived.status).toBe(200);
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

    await stream.waitFor(1);
    const entry = stream.entries.find((e) => e.correlationId === cid);
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({ tenantId: "plain", method: "GET", path: "/plain/posts", status: 200 });
    stream.close();
  });

  test("the lifecycle records each pipeline stage in order", async () => {
    const stream = await openLogStream(core, "plain");
    const res = await fetch(`${core.base}/plain/posts`);
    const cid = res.headers.get("x-correlation-id");

    await stream.waitFor(1);
    const entry = stream.entries.find((e) => e.correlationId === cid);
    const stages = entry.lifecycle.map((s: any) => s.stage);
    expect(stages).toEqual([
      "statusGuard",
      "authGuard",
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

    await stream.waitFor(1);
    const entry = stream.entries.at(-1);
    const failed = entry.lifecycle.filter((s: any) => !s.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].stage).toBe("authGuard");
    expect(failed[0].note).toBe("rejected with 401");
    // Stages after the rejection never ran.
    expect(entry.lifecycle.map((s: any) => s.stage)).toEqual(["statusGuard", "authGuard"]);
    stream.close();
  });

  test("a fresh connection replays the buffered ring before streaming", async () => {
    await fetch(`${core.base}/plain/posts?replay=1`);
    const stream = await openLogStream(core, "plain");
    await stream.waitFor(1);
    // The request happened before the stream opened, so it can only be a replay.
    expect(stream.entries.some((e) => e.query === "?replay=1")).toBe(true);
    stream.close();
  });

  test("the admin plane is never logged", async () => {
    const stream = await openLogStream(core, "plain");
    await fetch(`${core.base}/plain/_admin/files/posts`, { headers: adminAuth });
    await fetch(`${core.base}/plain/posts?marker=after`); // ordering fence
    await stream.waitFor(1);
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
        { id: "u1", email: "a@x.com", passwordHash: "SECRET-HASH", role: "admin" },
        { id: "u2", email: "b@x.com", passwordHash: "SECRET-HASH-2" },
      ],
      draft_posts: [{ id: "99", title: "staged" }],
      config: { QA_MODE: "false" },
      empties: [],
    });
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

  test("passwordHash is never mounted, so SELECT * cannot leak it", async () => {
    const mcp = await openMcp(core, "mcp");
    const all = await mcp.query("SELECT * FROM users");
    expect(all.rows).toHaveLength(2);
    for (const row of all.rows) expect(row).not.toHaveProperty("passwordHash");
    // Not filtered on the way out — the column does not exist at all.
    const explicit = await mcp.call("SELECT passwordHash FROM users");
    expect(explicit.isError).toBe(true);
    expect(explicit.content[0].text).toContain("no such column");
    mcp.close();
  });

  test("staged drafts and tenant config are not mounted", async () => {
    const mcp = await openMcp(core, "mcp");
    for (const table of ["draft_posts", "config"]) {
      const result = await mcp.call(`SELECT * FROM ${table}`);
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
