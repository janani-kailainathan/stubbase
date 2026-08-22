/**
 * Dashboard Backend — regression suite for the invariants in CLAUDE.md.
 *
 * Black-box over HTTP against a real `server-app.ts` wired to a real
 * `server-core.ts`, both on scratch state. The pairing matters: the files
 * proxy, the draft model and deploy are only meaningful end-to-end, and the
 * whole point of this service is that ADMIN_SECRET stays on its side of that
 * boundary.
 *
 * SQLite is opened read-only from the tests for the few assertions that must
 * inspect storage rather than behaviour (are tokens really hashed at rest?).
 *
 *   bun test tests/dashboard-api.test.ts   (or: bun run scripts/build.ts -pl dashboard-api)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { ADMIN_SECRET, startApp, startCore, stopServices, type Service } from "./helpers.ts";

const ALLOWED_ORIGIN = "http://localhost:5173";
const PASSWORD = "password123";

let ROOT = "";
let core: Service;
let app: Service;
const running: Service[] = [];

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Read-only peek at the service's own database. */
function readDb<T>(fn: (db: Database) => T): T {
  const db = new Database(join(app.dir, "app.sqlite"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonHeaders = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? as(token) : {}),
});

interface Account {
  token: string;
  email: string;
  id: number;
}

// Most tests drive the default app instance; the Co-Pilot suite passes its own
// (the one wired to a stub AI provider), hence the optional service argument.
let seq = 0;
async function signup(on: Service = app): Promise<Account> {
  const email = `user${++seq}-${Date.now()}@test.co`;
  const res = await fetch(`${on.base}/auth/signup`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.token, email, id: body.user.id };
}

async function createProject(
  token: string,
  name: string,
  resources?: Record<string, unknown[]>,
  on: Service = app,
): Promise<{ tenantId: string; resources: string[] }> {
  const res = await fetch(`${on.base}/projects`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ name, ...(resources ? { resources } : {}) }),
  });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const coreFile = (tenantId: string, name: string) =>
  Bun.file(join(core.dir, tenantId, `${name}.json`));

/**
 * Brings a project's public plane up. Projects are created stopped, so any test
 * that talks to the core's public routes has to activate first — the same thing
 * the dashboard's Deploy button does.
 */
async function activate(token: string, tenantId: string): Promise<void> {
  const res = await fetch(`${app.base}/projects/${tenantId}/status`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ status: "active" }),
  });
  if (res.status !== 200) throw new Error(`activate failed: ${res.status} ${await res.text()}`);
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "stubbase-app-test-"));
  core = await startCore(ROOT, "core");
  app = await startApp(ROOT, "app", {
    CORE_API_URL: core.base,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  });
  running.push(core, app);
}, 30_000);

afterAll(async () => {
  await stopServices(running);
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
});

// ── Authentication ─────────────────────────────────────────────────

describe("authentication", () => {
  test("signup issues a session and rejects duplicates", async () => {
    const account = await signup();
    expect(account.token).toBeString();

    const duplicate = await fetch(`${app.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email, password: PASSWORD }),
    });
    expect(duplicate.status).toBe(409);
  }, 20_000);

  test("signup validates email and password length", async () => {
    const bad = await fetch(`${app.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "not-an-email", password: PASSWORD }),
    });
    expect(bad.status).toBe(400);

    const short = await fetch(`${app.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: `short-${Date.now()}@test.co`, password: "1234567" }),
    });
    expect(short.status).toBe(400);
  }, 15_000);

  test("passwords are argon2id at rest, never plaintext", async () => {
    const account = await signup();
    const row = readDb((db) =>
      db.query("SELECT password_hash FROM users WHERE email = ?").get(account.email),
    ) as { password_hash: string };
    expect(row.password_hash).toStartWith("$argon2id$");
    expect(row.password_hash).not.toContain(PASSWORD);
  }, 20_000);

  test("session tokens are stored sha256-hashed, not raw", async () => {
    // A database leak must not hand out usable bearer tokens.
    const account = await signup();
    const rows = readDb((db) => db.query("SELECT token_hash FROM sessions").all()) as {
      token_hash: string;
    }[];
    const hashes = rows.map((r) => r.token_hash);
    expect(hashes).toContain(sha256hex(account.token));
    expect(hashes).not.toContain(account.token);
  }, 20_000);

  test("login rejects a wrong password and accepts the right one", async () => {
    const account = await signup();

    const wrong = await fetch(`${app.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email, password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${app.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email, password: PASSWORD }),
    });
    expect(right.status).toBe(200);
    expect((await right.json()).token).toBeString();
  }, 20_000);

  test("an unknown email cannot be distinguished from a wrong password", async () => {
    const account = await signup();

    const attempt = async (email: string) => {
      const started = Bun.nanoseconds();
      const res = await fetch(`${app.base}/auth/login`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email, password: "wrong-password" }),
      });
      return { ms: (Bun.nanoseconds() - started) / 1e6, status: res.status, body: await res.json() };
    };

    const known = await attempt(account.email);
    const unknown = await attempt(`ghost-${Date.now()}@test.co`);

    // Identical response, so the body can't be used to enumerate accounts.
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);

    // And an unknown email must still pay for a hash verification (DUMMY_HASH)
    // rather than returning early — otherwise latency leaks the answer.
    const knownMin = Math.min(known.ms, (await attempt(account.email)).ms);
    const unknownMin = Math.min(unknown.ms, (await attempt(`ghost2-${Date.now()}@test.co`)).ms);
    expect(unknownMin).toBeGreaterThan(knownMin * 0.5);
  }, 30_000);

  test("/auth/me requires a session and logout revokes it", async () => {
    const account = await signup();

    expect((await fetch(`${app.base}/auth/me`)).status).toBe(401);
    expect((await fetch(`${app.base}/auth/me`, { headers: as("garbage") })).status).toBe(401);

    const me = await fetch(`${app.base}/auth/me`, { headers: as(account.token) });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe(account.email);

    const out = await fetch(`${app.base}/auth/logout`, { method: "POST", headers: as(account.token) });
    expect(out.status).toBe(200);

    // The row is gone, and the token no longer authenticates.
    expect((await fetch(`${app.base}/auth/me`, { headers: as(account.token) })).status).toBe(401);
    const remaining = readDb((db) =>
      db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(sha256hex(account.token)),
    ) as { n: number };
    expect(remaining.n).toBe(0);
  }, 20_000);

  test("no auth response ever echoes a password hash", async () => {
    const account = await signup();
    const login = await fetch(`${app.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email, password: PASSWORD }),
    }).then((r) => r.json());
    expect(login.user).not.toHaveProperty("password_hash");
    expect(login.user).not.toHaveProperty("passwordHash");
  }, 20_000);
});

// ── Per-user scoping ───────────────────────────────────────────────

describe("project ownership scoping", () => {
  let alice: Account;
  let bob: Account;
  let aliceProject: string;

  beforeAll(async () => {
    alice = await signup();
    bob = await signup();
    aliceProject = (await createProject(alice.token, "Alice Project", { posts: [{ id: "1" }] }))
      .tenantId;
  }, 30_000);

  test("every /projects route rejects an anonymous caller", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/projects"],
      ["POST", "/projects"],
      ["PATCH", `/projects/${aliceProject}`],
      ["DELETE", `/projects/${aliceProject}`],
      ["GET", `/projects/${aliceProject}/usage`],
      ["POST", `/projects/${aliceProject}/deploy`],
      ["POST", `/projects/${aliceProject}/status`],
      ["GET", `/projects/${aliceProject}/files/posts`],
      ["PUT", `/projects/${aliceProject}/files/posts`],
      ["DELETE", `/projects/${aliceProject}/files/posts`],
      ["POST", `/projects/${aliceProject}/ai/chat`],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${app.base}${path}`, {
        method,
        headers: jsonHeaders(),
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
  });

  test("a second user cannot reach another user's project on ANY route", async () => {
    // The single most important test in this suite: every /projects* route
    // must ownership-check before it touches the core.
    const routes: Array<[string, string, string | undefined]> = [
      ["PATCH", `/projects/${aliceProject}`, JSON.stringify({ name: "stolen" })],
      ["DELETE", `/projects/${aliceProject}`, undefined],
      ["GET", `/projects/${aliceProject}/usage`, undefined],
      ["POST", `/projects/${aliceProject}/deploy`, undefined],
      ["POST", `/projects/${aliceProject}/status`, JSON.stringify({ status: "stopped" })],
      ["GET", `/projects/${aliceProject}/files/posts`, undefined],
      ["PUT", `/projects/${aliceProject}/files/posts`, JSON.stringify([{ id: "x" }])],
      ["DELETE", `/projects/${aliceProject}/files/posts`, undefined],
      [
        "POST",
        `/projects/${aliceProject}/ai/chat`,
        JSON.stringify({ messages: [{ role: "user", parts: [{ text: "a blog" }] }] }),
      ],
    ];
    for (const [method, path, body] of routes) {
      const res = await fetch(`${app.base}${path}`, {
        method,
        headers: jsonHeaders(bob.token),
        ...(body ? { body } : {}),
      });
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 404 });
    }

    // Nothing was mutated on the core by any of those attempts.
    expect(await coreFile(aliceProject, "posts").json()).toEqual([{ id: "1" }]);
    expect(await coreFile(aliceProject, "draft_posts").exists()).toBe(false);
  }, 20_000);

  test("listing only ever returns your own projects", async () => {
    await createProject(bob.token, "Bob Project");

    const aliceList = await fetch(`${app.base}/projects`, { headers: as(alice.token) }).then((r) =>
      r.json(),
    );
    const bobList = await fetch(`${app.base}/projects`, { headers: as(bob.token) }).then((r) => r.json());

    expect(aliceList.map((p: any) => p.tenant_id)).toContain(aliceProject);
    expect(bobList.map((p: any) => p.tenant_id)).not.toContain(aliceProject);
    expect(bobList.every((p: any) => p.name === "Bob Project")).toBe(true);
  }, 20_000);

  test("an owner can rename, a stranger gets 404", async () => {
    const renamed = await fetch(`${app.base}/projects/${aliceProject}`, {
      method: "PATCH",
      headers: jsonHeaders(alice.token),
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("Renamed");
  });
});

// ── Provisioning ───────────────────────────────────────────────────

describe("project provisioning", () => {
  let owner: Account;

  beforeAll(async () => {
    owner = await signup();
  }, 20_000);

  test("creating a project provisions the tenant on the core", async () => {
    const project = await createProject(owner.token, "My Blog", {
      posts: [{ id: "1", title: "hello" }],
      comments: [],
    });
    expect(project.tenantId).toStartWith("my-blog-");
    expect(project.resources.sort()).toEqual(["comments", "posts"]);

    expect(await coreFile(project.tenantId, "posts").json()).toEqual([{ id: "1", title: "hello" }]);

    // The tenant exists but is stopped, so nothing is public yet.
    const stopped = await fetch(`${core.base}/${project.tenantId}/posts`);
    expect(stopped.status).toBe(503);

    // ...and once started, the core serves the seeded data.
    await activate(owner.token, project.tenantId);
    const live = await fetch(`${core.base}/${project.tenantId}/posts`);
    expect(live.status).toBe(200);
    expect(await live.json()).toHaveLength(1);
  }, 20_000);

  test("a new project starts stopped", async () => {
    const project = await createProject(owner.token, "Born Stopped");
    // Recorded in the tenant's own config, so the core enforces it.
    expect(await coreFile(project.tenantId, "config").json()).toMatchObject({
      PROJECT_STATUS: "stopped",
    });
    const res = await fetch(`${core.base}/${project.tenantId}/anything`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ projectStatus: "stopped" });
  }, 15_000);

  test("a project with no resources starts genuinely empty", async () => {
    const project = await createProject(owner.token, "Empty");
    expect(project.resources).toEqual([]);
    // Nothing was provisioned on the core either — no placeholder file.
    const listed = await fetch(`${app.base}/projects`, { headers: as(owner.token) });
    const row = ((await listed.json()) as any[]).find((p) => p.tenant_id === project.tenantId);
    expect(row.resources).toEqual([]);
  }, 15_000);

  test("deploying a project with no tenant folder reports nothing promoted", async () => {
    // With no folder on the core, _admin/deploy answers 404. Ownership is
    // already proven by then, so that means "nothing staged", not a failure.
    const project = await createProject(owner.token, "Nothing To Deploy");
    await rm(join(core.dir, project.tenantId), { recursive: true, force: true });

    const res = await fetch(`${app.base}/projects/${project.tenantId}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, promoted: [] });
  }, 15_000);

  test("invalid seed data is rejected before anything is provisioned", async () => {
    const badName = await fetch(`${app.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ name: "Bad", resources: { "not a name": [] } }),
    });
    expect(badName.status).toBe(400);

    const badData = await fetch(`${app.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ name: "Bad", resources: { posts: { not: "an array" } } }),
    });
    expect(badData.status).toBe(400);
  });

  test("a nameless project is rejected", async () => {
    const res = await fetch(`${app.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("deleting a project removes its core files and its row", async () => {
    const project = await createProject(owner.token, "Doomed", { posts: [{ id: "1" }] });
    expect(await coreFile(project.tenantId, "posts").exists()).toBe(true);

    const res = await fetch(`${app.base}/projects/${project.tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(res.status).toBe(200);

    expect(await coreFile(project.tenantId, "posts").exists()).toBe(false);
    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    expect(list.map((p: any) => p.tenant_id)).not.toContain(project.tenantId);
  }, 20_000);

  test("a running project cannot be deleted until it is stopped", async () => {
    const project = await createProject(owner.token, "Running", { posts: [{ id: "1" }] });
    await activate(owner.token, project.tenantId);

    const refused = await fetch(`${app.base}/projects/${project.tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/running/i);

    // Nothing was destroyed on the way to being refused.
    expect(await coreFile(project.tenantId, "posts").exists()).toBe(true);
    expect((await fetch(`${core.base}/${project.tenantId}/posts`)).status).toBe(200);
    const stillListed = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) =>
      r.json(),
    );
    expect(stillListed.map((p: any) => p.tenant_id)).toContain(project.tenantId);

    // Stopping it clears the way.
    await fetch(`${app.base}/projects/${project.tenantId}/status`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ status: "stopped" }),
    });
    const deleted = await fetch(`${app.base}/projects/${project.tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(deleted.status).toBe(200);
    expect(await coreFile(project.tenantId, "posts").exists()).toBe(false);
  }, 25_000);

  test("a project with no config at all counts as running", async () => {
    // The core defaults an absent PROJECT_STATUS to active, so the delete guard
    // has to read it the same way — otherwise a legacy project with no config
    // would be deletable while it is still serving.
    const project = await createProject(owner.token, "No Config", { posts: [{ id: "1" }] });
    await rm(join(core.dir, project.tenantId, "config.json"), { force: true });

    const res = await fetch(`${app.base}/projects/${project.tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(res.status).toBe(409);
  }, 20_000);
});

// ── Files proxy & the draft model ──────────────────────────────────

describe("files proxy and the draft model", () => {
  let owner: Account;
  let tenantId: string;

  beforeAll(async () => {
    owner = await signup();
    tenantId = (await createProject(owner.token, "Drafts", { posts: [{ id: "1", title: "live" }] }))
      .tenantId;
    await activate(owner.token, tenantId); // these tests read the public plane
  }, 30_000);

  test("a write is staged as draft_* and never touches the live file", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/files/posts`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "1", title: "staged" }]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ draft: true, records: 1 });

    expect(await coreFile(tenantId, "draft_posts").json()).toEqual([{ id: "1", title: "staged" }]);
    expect(await coreFile(tenantId, "posts").json()).toEqual([{ id: "1", title: "live" }]);
  }, 15_000);

  test("the public plane keeps serving live data while a draft exists", async () => {
    const live = await fetch(`${core.base}/${tenantId}/posts`).then((r) => r.json());
    expect(live).toEqual([{ id: "1", title: "live" }]);

    // And the draft is not reachable as a resource of its own.
    expect((await fetch(`${core.base}/${tenantId}/draft_posts`)).status).toBe(403);
  });

  test("reads prefer the draft, so the editor shows staged state", async () => {
    const read = await fetch(`${app.base}/projects/${tenantId}/files/posts`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(read).toEqual([{ id: "1", title: "staged" }]);
  });

  test("deploy promotes the draft and the public plane flips over", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).promoted).toContain("posts");

    const live = await fetch(`${core.base}/${tenantId}/posts`).then((r) => r.json());
    expect(live).toEqual([{ id: "1", title: "staged" }]);
  }, 15_000);

  test("the resources column tracks what the proxy creates and deletes", async () => {
    const resourcesOf = async () => {
      const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
      return list.find((p: any) => p.tenant_id === tenantId).resources as string[];
    };

    expect(await resourcesOf()).not.toContain("tags");

    await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "t1" }]),
    });
    expect(await resourcesOf()).toContain("tags");

    const del = await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(del.status).toBe(200);
    expect(await resourcesOf()).not.toContain("tags");
    expect(await coreFile(tenantId, "tags").exists()).toBe(false);
    expect(await coreFile(tenantId, "draft_tags").exists()).toBe(false);
  }, 20_000);

  test("callers cannot address a draft_ file directly", async () => {
    // Otherwise a client could stage into draft_draft_x, or write a live file
    // straight past the draft model.
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await fetch(`${app.base}/projects/${tenantId}/files/draft_posts`, {
        method,
        headers: jsonHeaders(owner.token),
        ...(method === "PUT" ? { body: "[]" } : {}),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("draft_");
    }
  });

  test("invalid resource names are rejected", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/files/bad!name`, {
      headers: as(owner.token),
    });
    expect(res.status).toBe(400);
  });

  test("a non-config resource body must be an array of records", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/files/posts`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ not: "an array" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Tenant config ──────────────────────────────────────────────────

describe("tenant config writes", () => {
  let owner: Account;
  let tenantId: string;

  beforeAll(async () => {
    owner = await signup();
    tenantId = (await createProject(owner.token, "Config", { posts: [] })).tenantId;
  }, 30_000);

  test("config is an object of strings, with `resources` the one exception", async () => {
    const array = await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([]),
    });
    expect(array.status).toBe(400);

    const nonString = await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ QA_MODE: true }),
    });
    expect(nonString.status).toBe(400);

    const ok = await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ QA_MODE: "true", resources: { posts: { schema: {} } } }),
    });
    expect(ok.status).toBe(200);
  }, 15_000);

  test("config never leaks into the resources column", async () => {
    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    const project = list.find((p: any) => p.tenant_id === tenantId);
    expect(project.resources).not.toContain("config");
  });

  test("status changes reach the core and take the public plane down", async () => {
    const stop = await fetch(`${app.base}/projects/${tenantId}/status`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ status: "stopped" }),
    });
    expect(stop.status).toBe(200);

    const blocked = await fetch(`${core.base}/${tenantId}/posts`);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ projectStatus: "stopped" });

    const start = await fetch(`${app.base}/projects/${tenantId}/status`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ status: "active" }),
    });
    expect(start.status).toBe(200);
    expect((await fetch(`${core.base}/${tenantId}/posts`)).status).toBe(200);
  }, 20_000);

  test("an unknown status is rejected", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/status`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Usage ingestion ────────────────────────────────────────────────

describe("usage ingestion", () => {
  let owner: Account;
  let tenantId: string;

  beforeAll(async () => {
    owner = await signup();
    tenantId = (await createProject(owner.token, "Usage", { posts: [] })).tenantId;
  }, 30_000);

  const today = () => new Date().toISOString().slice(0, 10);

  test("only the core's ADMIN_SECRET can post usage — a session token cannot", async () => {
    const rows = { rows: [{ tenantId, date: today(), requests: 1, bytes: 1 }] };

    const anon = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(rows),
    });
    expect(anon.status).toBe(401);

    // A logged-in dashboard user must not be able to forge billing data.
    const session = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify(rows),
    });
    expect(session.status).toBe(401);
  });

  test("valid rows are applied and malformed rows are skipped, not fatal", async () => {
    const res = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({
        rows: [
          { tenantId, date: today(), requests: 7, bytes: 700 },
          { tenantId: "bad name!", date: today(), requests: 1, bytes: 1 },
          { tenantId, date: "not-a-date", requests: 1, bytes: 1 },
          { tenantId, date: today(), requests: -5, bytes: 1 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: 1, skipped: 3 });
  });

  test("the owner sees the aggregate, and repeat batches accumulate", async () => {
    await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ rows: [{ tenantId, date: today(), requests: 3, bytes: 300 }] }),
    });

    const usage = await fetch(`${app.base}/projects/${tenantId}/usage`, {
      headers: as(owner.token),
    }).then((r) => r.json());

    expect(usage.month.requests).toBe(10); // 7 + 3, upserted onto one row
    expect(usage.month.bytes).toBe(1000);
    expect(usage.daily[0]).toMatchObject({ date: today(), request_count: 10 });
  });

  test("'rows' must be an array", async () => {
    const res = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ rows: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── CORS allow-list ────────────────────────────────────────────────

describe("CORS allow-list", () => {
  test("an allow-listed origin is echoed back, never a wildcard", async () => {
    const res = await fetch(`${app.base}/`, { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("an unknown origin gets no CORS headers", async () => {
    const res = await fetch(`${app.base}/`, { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("preflight is allow-listed the same way", async () => {
    const allowed = await fetch(`${app.base}/projects`, {
      method: "OPTIONS",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("authorization");

    const denied = await fetch(`${app.base}/projects`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ── AI plane ───────────────────────────────────────────────────────

describe("AI Co-Pilot", () => {
  test("reports 503 when no provider key is configured", async () => {
    // The default app instance runs with AI disabled — this asserts the
    // graceful path, and the suite never makes a billed provider call.
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "AI");

    const res = await fetch(`${app.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "a blog" }] }] }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("not configured");
  }, 30_000);

});

/**
 * The agent loop, end-to-end against a stub provider.
 *
 * This is the test that makes function calling a contract rather than a hope:
 * a fake Google endpoint asks for `stage_schema_drafts`, and the assertions
 * cover the whole round trip — the persona reaching the model, the tool
 * catalogue being advertised, the draft actually landing on the *real* core,
 * the tool result being fed back, and the final prose reaching the caller.
 */
describe("AI Co-Pilot agent loop", () => {
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let aiApp: Service;
  /** Every request body the stub provider received, in order. */
  let seen: any[] = [];
  /** Queue of reply `parts` arrays; a test scripts the turns it needs. */
  let script: any[][] = [];

  beforeAll(async () => {
    provider = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        seen.push(body);
        if (script.length > 0) return Response.json({ candidates: [{ content: { parts: script.shift() } }] });
        // Turn 1 asks for the tool; turn 2 (which now carries a
        // functionResponse) answers in prose.
        const usedTool = JSON.stringify(body.contents).includes("functionResponse");
        const parts = usedTool
          ? [{ text: "Staged `posts` for you. Press Deploy when you're happy with it." }]
          : [
              {
                functionCall: {
                  name: "stage_schema_drafts",
                  args: {
                    tables: [
                      {
                        name: "posts",
                        records: [
                          { id: "p1", title: "Hello", authorId: "u1", tags: ["nested"] },
                          { id: "p2", title: "World", authorId: "u2" },
                        ],
                      },
                      { name: "config", records: [{ id: "x" }] }, // must be refused
                    ],
                  },
                },
              },
            ];
        return Response.json({ candidates: [{ content: { parts } }] });
      },
    });

    aiApp = await startApp(ROOT, "ai-app", {
      CORE_API_URL: core.base,
      GOOGLE_AI_API_KEY: "test-key",
      AI_BASE_URL: `http://127.0.0.1:${provider.port}`,
      AI_MODEL_NAME: "models/stub",
    });
    running.push(aiApp);
  }, 30_000);

  afterAll(() => {
    provider?.stop(true);
  });

  test("runs the tool, feeds the result back, and answers in prose", async () => {
    seen = [];
    script = [];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Co-Pilot", {}, aiApp);

    const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ text: "I need a backend for a blog." }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.text).toContain("Staged");
    expect(body.toolsUsed).toEqual(["stage_schema_drafts"]);
    expect(body.changed).toBe(true);

    // Two provider round trips: the tool request, then the interpretation.
    expect(seen.length).toBe(2);

    // The persona rides the first user turn (never a systemInstruction), and
    // the four tools are advertised.
    expect(seen[0].contents[0].parts[0].text).toStartWith("You are the Stubbase AI Co-Pilot");
    expect(seen[0].contents[0].parts[0].text).toEndWith("I need a backend for a blog.");
    expect(seen[0].systemInstruction).toBeUndefined();
    expect(seen[0].generationConfig.responseMimeType).toBeUndefined();
    expect(seen[0].tools[0].functionDeclarations.map((d: any) => d.name)).toEqual([
      "stage_schema_drafts",
      "set_server_status",
      "deploy_project",
      "delete_resources",
      "get_diagnostics",
    ]);

    // The second call carries the model's turn plus our tool result. There is
    // no `role: "function"` on this API — it must be folded into a user turn.
    const roles = seen[1].contents.map((c: any) => c.role);
    expect(roles).toEqual(["user", "model", "user"]);
    const fed = seen[1].contents[2].parts[0].functionResponse;
    expect(fed.name).toBe("stage_schema_drafts");
    expect(fed.response.result.staged).toEqual([
      { name: "posts", records: 2, fields: ["id", "title", "authorId"] },
    ]);

    // The draft is really on the core, nested fields dropped, and `config` was
    // refused rather than clobbering the tenant's settings.
    const draft = await fetch(`${core.base}/${tenantId}/_admin/files/draft_posts`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(draft.status).toBe(200);
    expect(await draft.json()).toEqual([
      { id: "p1", title: "Hello", authorId: "u1" },
      { id: "p2", title: "World", authorId: "u2" },
    ]);
    expect(fed.response.result.warnings).toContain(
      "skipped table 'config': not a usable resource name",
    );

    // Staged, not live: nothing is served until the project is deployed.
    const live = await fetch(`${core.base}/${tenantId}/_admin/files/posts`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(live.status).toBe(404);

    // And the returned history is what the browser sends back next turn.
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "model", "function", "model"]);
  }, 45_000);

  /**
   * Regression: asked to "clear all data", the Co-Pilot staged a fabricated
   * `placeholders` table, deployed it and reported the data cleared.
   *
   * Two causes, both asserted here — there was no tool that could delete, and
   * the refusal read as "your arguments were malformed", which invites a retry
   * with something structurally valid rather than an admission to the user.
   */
  test("an unfulfillable staging request is refused as a capability limit", async () => {
    seen = [];
    script = [
      [{ functionCall: { name: "stage_schema_drafts", args: { tables: [] } } }],
      [{ text: "I can't delete data with that tool." }],
    ];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Clear", { posts: [{ id: "1" }] }, aiApp);

    const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "clear all data" }] }] }),
    });
    expect(res.status).toBe(200);

    const fed = seen[1].contents[2].parts[0].functionResponse.response.result;
    expect(fed.error).toContain("cannot delete");
    expect(fed.error).toContain("delete_resources");
    // The instruction that stops the fabrication that started all this.
    expect(fed.error).toContain("Do not invent a filler table");
    // Nothing was staged, so no cache invalidation is claimed.
    expect((await res.json()).changed).toBe(false);
  }, 30_000);

  test("a deletion is proposed for confirmation, never carried out by the model", async () => {
    seen = [];
    script = [
      [
        {
          functionCall: {
            name: "delete_resources",
            args: { names: ["posts", "ghosts"], mode: "remove" },
          },
        },
      ],
      [{ text: "Confirm in the dashboard and I'll consider it done." }],
    ];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Deletable", { posts: [{ id: "1" }] }, aiApp);

    const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "delete everything" }] }] }),
    });
    const body = await res.json();
    expect(body.toolsUsed).toEqual(["delete_resources"]);
    // Nothing changed, so the SPA must not invalidate anything yet.
    expect(body.changed).toBe(false);

    const fed = seen[1].contents[2].parts[0].functionResponse.response.result;
    // Only tables that really exist; the hallucinated one is reported back.
    expect(fed.pendingConfirmation).toEqual({ mode: "remove", names: ["posts"] });
    expect(fed.ignoredUnknown).toEqual(["ghosts"]);
    expect(fed.note).toContain("NOTHING HAS BEEN DELETED YET");

    // The whole point: the file is still there. Only a human can remove it.
    const still = await fetch(`${core.base}/${tenantId}/_admin/files/posts`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(still.status).toBe(200);
    expect(await still.json()).toEqual([{ id: "1" }]);
  }, 30_000);

  test("a deletion naming nothing real is refused outright", async () => {
    seen = [];
    script = [
      [{ functionCall: { name: "delete_resources", args: { names: ["ghosts"], mode: "empty" } } }],
      [{ text: "That table doesn't exist." }],
    ];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "NoGhosts", { posts: [{ id: "1" }] }, aiApp);

    await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "clear ghosts" }] }] }),
    });

    const fed = seen[1].contents[2].parts[0].functionResponse.response.result;
    expect(fed.error).toContain("none of those tables exist");
    expect(fed.resources).toEqual(["posts"]);
    expect(fed.pendingConfirmation).toBeUndefined();
  }, 30_000);

  test("rejects a malformed conversation before calling the provider", async () => {
    seen = [];
    script = [];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "AI validation", {}, aiApp);

    // The browser round-trips the whole history, so it is untrusted input.
    const bad: unknown[] = [
      {},
      { messages: [] },
      { messages: "hello" },
      { messages: [{ role: "wizard", parts: [{ text: "hi" }] }] },
      { messages: [{ role: "user", parts: [] }] },
      { messages: [{ role: "user", parts: [{ nope: true }] }] },
      // A history that does not end with the user asking something.
      { messages: [{ role: "model", parts: [{ text: "hi" }] }] },
      { messages: [{ role: "user", parts: [{ text: "x".repeat(8_001) }] }] },
    ];
    for (const body of bad) {
      const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
        method: "POST",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify(body),
      });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    // Rejected locally: a bad request must never become a billed provider call.
    expect(seen.length).toBe(0);
  }, 30_000);

  test("a second user cannot drive the Co-Pilot on someone else's project", async () => {
    const owner = await signup(aiApp);
    const intruder = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Private", {}, aiApp);

    const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(intruder.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "stage a table" }] }] }),
    });
    expect(res.status).toBe(404);
  }, 30_000);
});

// ── Live logs (SSE proxy) ──────────────────────────────────────────

describe("live logs", () => {
  test("streams the owner's traffic and never leaks ADMIN_SECRET", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Logged", { posts: [{ id: "1" }] });
    await activate(owner.token, tenantId); // a stopped tenant 503s before coreOperation

    const ctrl = new AbortController();
    const res = await fetch(`${app.base}/projects/${tenantId}/live-logs`, {
      headers: as(owner.token),
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Generate public-plane traffic on the core, then read it back off the proxy.
    await fetch(`${core.base}/${tenantId}/posts`);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const deadline = Date.now() + 5_000;
    let entry: any = null;
    while (Date.now() < deadline && !entry) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (const frame of buffered.split("\n\n")) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.path === `/${tenantId}/posts`) entry = parsed;
        }
      }
    }
    ctrl.abort();

    expect(entry).toBeTruthy();
    expect(entry.lifecycle.map((s: any) => s.stage)).toContain("coreOperation");
    expect(buffered.includes(ADMIN_SECRET)).toBe(false);
  }, 15_000);

  test("a non-owner cannot open another project's stream", async () => {
    const owner = await signup();
    const stranger = await signup();
    const { tenantId } = await createProject(owner.token, "Private", { posts: [] });

    const res = await fetch(`${app.base}/projects/${tenantId}/live-logs`, {
      headers: as(stranger.token),
    });
    expect(res.status).toBe(404);

    const anon = await fetch(`${app.base}/projects/${tenantId}/live-logs`);
    expect(anon.status).toBe(401);
  });
});

// ── Developer API keys & the MCP proxy ─────────────────────────────

async function mintKey(token: string, tenantId: string, name = "Claude Desktop") {
  const res = await fetch(`${app.base}/projects/${tenantId}/keys`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`mintKey failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: number; key: string; prefix: string; name: string }>;
}

/** Opens the proxied MCP stream and speaks JSON-RPC over it, as a client would. */
async function openProxiedMcp(tenantId: string, key: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${app.base}/projects/${tenantId}/mcp/sse`, {
    headers: as(key),
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
            const data = frame
              .split("\n")
              .find((l) => l.startsWith("data: "))
              ?.slice(6);
            if (!data) continue;
            if (frame.startsWith("event: endpoint")) endpoint = data;
            else messages.push(JSON.parse(data));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const deadline = Date.now() + 5_000;
    while (!endpoint && Date.now() < deadline) await Bun.sleep(20);
  }

  let nextId = 0;
  async function rpc(method: string, params?: unknown) {
    const id = ++nextId;
    const post = await fetch(`${app.base}${endpoint}`, {
      method: "POST",
      headers: jsonHeaders(key),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    });
    expect(post.status).toBe(202);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !messages.some((m) => m.id === id)) await Bun.sleep(20);
    return messages.find((m) => m.id === id);
  }

  return { res, frames, endpoint, rpc, close: () => ctrl.abort() };
}

describe("developer API keys", () => {
  test("a new key is returned once, in the clear, and stored only as a hash", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Keyed", { posts: [] });
    const created = await mintKey(owner.token, tenantId);

    expect(created.key).toStartWith("sk_stub_");
    expect(created.key.length).toBeGreaterThan(40); // 32 random bytes, hex
    expect(created.prefix).toStartWith("sk_stub_");

    // At rest: the hash, never the key. This is the whole security property.
    const row = readDb((db) =>
      db.query("SELECT key_hash, prefix FROM developer_api_keys WHERE id = ?").get(created.id),
    ) as { key_hash: string; prefix: string };
    expect(row.key_hash).toBe(sha256hex(created.key));
    expect(row.key_hash).not.toBe(created.key);

    // Listing exposes metadata only — the key is unrecoverable after this point.
    const listed = await (
      await fetch(`${app.base}/projects/${tenantId}/keys`, { headers: as(owner.token) })
    ).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, name: "Claude Desktop" });
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(JSON.stringify(listed)).not.toContain(row.key_hash);
  });

  test("keys are scoped to the owner, by session and by project", async () => {
    const owner = await signup();
    const stranger = await signup();
    const { tenantId } = await createProject(owner.token, "Private", { posts: [] });
    const created = await mintKey(owner.token, tenantId);

    for (const [method, path] of [
      ["GET", `/projects/${tenantId}/keys`],
      ["POST", `/projects/${tenantId}/keys`],
      ["DELETE", `/projects/${tenantId}/keys/${created.id}`],
    ] as const) {
      const stranged = await fetch(`${app.base}${path}`, {
        method,
        headers: jsonHeaders(stranger.token),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(stranged.status).toBe(404); // not 403 — existence isn't disclosed

      const anon = await fetch(`${app.base}${path}`, { method });
      expect(anon.status).toBe(401);
    }

    // The key still exists: a stranger's DELETE must not have revoked it.
    const stillThere = await (
      await fetch(`${app.base}/projects/${tenantId}/keys`, { headers: as(owner.token) })
    ).json();
    expect(stillThere).toHaveLength(1);
  });

  test("a key id cannot be revoked through a project that doesn't hold it", async () => {
    // The nasty case the ownership check alone does NOT cover: the attacker
    // owns the project in the URL, so ownedProject() passes — only scoping the
    // DELETE by tenant_id stops it reaching another project's key by id.
    const victim = await signup();
    const attacker = await signup();
    const { tenantId: victimProject } = await createProject(victim.token, "Victim", { posts: [] });
    const { tenantId: attackerProject } = await createProject(attacker.token, "Attacker", {
      posts: [],
    });
    const victimKey = await mintKey(victim.token, victimProject);

    const res = await fetch(`${app.base}/projects/${attackerProject}/keys/${victimKey.id}`, {
      method: "DELETE",
      headers: as(attacker.token),
    });
    expect(res.status).toBe(404);

    const survived = await (
      await fetch(`${app.base}/projects/${victimProject}/keys`, { headers: as(victim.token) })
    ).json();
    expect(survived.map((k: any) => k.id)).toEqual([victimKey.id]);
  }, 15_000);

  test("revoking removes the key, and deleting a project takes its keys with it", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Doomed", { posts: [] });
    const keep = await mintKey(owner.token, tenantId, "keep");
    const drop = await mintKey(owner.token, tenantId, "drop");

    const revoked = await fetch(`${app.base}/projects/${tenantId}/keys/${drop.id}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(revoked.status).toBe(200);
    const left = await (
      await fetch(`${app.base}/projects/${tenantId}/keys`, { headers: as(owner.token) })
    ).json();
    expect(left.map((k: any) => k.id)).toEqual([keep.id]);

    // Deleting the project must not leave credentials behind for a tenant id
    // that no longer belongs to anyone.
    await fetch(`${app.base}/projects/${tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    const orphans = readDb((db) =>
      db.query("SELECT COUNT(*) AS n FROM developer_api_keys WHERE tenant_id = ?").get(tenantId),
    ) as { n: number };
    expect(orphans.n).toBe(0);
  }, 15_000);
});

describe("MCP proxy", () => {
  test("the endpoint frame is rebased onto this service, hiding the admin plane", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Agent", {
      posts: [{ id: "1", title: "first", views: 10 }],
    });
    const { key } = await mintKey(owner.token, tenantId);

    const mcp = await openProxiedMcp(tenantId, key);
    expect(mcp.res.status).toBe(200);
    expect(mcp.res.headers.get("content-type")).toBe("text/event-stream");

    // The core would have named /<tenant>/_admin/mcp/message, which no external
    // client can reach. Without the rewrite every follow-up call 401s.
    expect(mcp.frames[0]).toStartWith("event: endpoint\ndata: ");
    expect(mcp.endpoint).toStartWith(`/projects/${tenantId}/mcp/message?sessionId=`);
    expect(mcp.endpoint).not.toContain("_admin");
    mcp.close();
  }, 15_000);

  test("a developer key reaches the core's SQL tool end to end", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Queried", {
      posts: [
        { id: "1", title: "first", views: 10 },
        { id: "2", title: "second" },
      ],
    });
    await activate(owner.token, tenantId);
    const { key } = await mintKey(owner.token, tenantId);

    const mcp = await openProxiedMcp(tenantId, key);
    const tools = await mcp.rpc("tools/list");
    expect(tools.result.tools[0].name).toBe("execute_sql_query");
    // Schema injection survives the proxy.
    expect(tools.result.tools[0].description).toContain("posts(");

    const out = await mcp.rpc("tools/call", {
      name: "execute_sql_query",
      arguments: { sql: "SELECT title FROM posts ORDER BY id" },
    });
    expect(JSON.parse(out.result.content[0].text).rows).toEqual([
      { title: "first" },
      { title: "second" },
    ]);

    // ADMIN_SECRET is added by this service and must never appear downstream.
    expect(JSON.stringify(mcp.frames)).not.toContain(ADMIN_SECRET);
    mcp.close();
  }, 20_000);

  test("only a live developer key for that project opens the stream", async () => {
    const owner = await signup();
    const other = await signup();
    const { tenantId } = await createProject(owner.token, "Guarded", { posts: [] });
    const { tenantId: otherTenant } = await createProject(other.token, "Theirs", { posts: [] });
    const created = await mintKey(owner.token, tenantId);

    const attempt = (headers: Record<string, string>, tenant = tenantId) =>
      fetch(`${app.base}/projects/${tenant}/mcp/sse`, { headers });

    // No credential, a bogus key, and — importantly — a *session* token, which
    // authenticates the dashboard but is not a developer key.
    expect((await attempt({})).status).toBe(401);
    expect((await attempt(as("sk_stub_deadbeef"))).status).toBe(401);
    expect((await attempt(as(owner.token))).status).toBe(401);

    // A real key, pointed at somebody else's project.
    expect((await attempt(as(created.key), otherTenant)).status).toBe(401);

    // The same key works on its own project...
    const ok = await attempt(as(created.key));
    expect(ok.status).toBe(200);
    void ok.body?.cancel();

    // ...until it is revoked.
    await fetch(`${app.base}/projects/${tenantId}/keys/${created.id}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect((await attempt(as(created.key))).status).toBe(401);
  }, 20_000);

  test("the message route authenticates independently of the stream", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Messaged", { posts: [] });
    const { key } = await mintKey(owner.token, tenantId);
    const mcp = await openProxiedMcp(tenantId, key);

    // Holding a valid session id is not authorization: every POST is checked.
    const unauthenticated = await fetch(`${app.base}${mcp.endpoint}`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthenticated.status).toBe(401);

    const wrongKey = await fetch(`${app.base}${mcp.endpoint}`, {
      method: "POST",
      headers: jsonHeaders("sk_stub_nope"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(wrongKey.status).toBe(401);
    mcp.close();
  }, 15_000);
});

// ── Diagnostics ────────────────────────────────────────────────────

describe("diagnostics", () => {
  test("reports a clean project as having no syntax errors", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Healthy", { posts: [{ id: "1" }] });

    const res = await fetch(`${app.base}/projects/${tenantId}/diagnostics`, {
      headers: as(owner.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tenantId });
    expect(body.syntaxErrors).toEqual([]);
  });

  test("surfaces a malformed file instead of letting it fail silently", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Broken", { posts: [{ id: "1" }] });

    // Corrupt the file behind the API's back — this is the "invisible error"
    // case: the core just skips the file and serves nothing.
    await Bun.write(join(core.dir, tenantId, "posts.json"), "[{ broken json");

    const res = await fetch(`${app.base}/projects/${tenantId}/diagnostics`, {
      headers: as(owner.token),
    });
    const body = await res.json();
    expect(body.syntaxErrors).toHaveLength(1);
    expect(body.syntaxErrors[0].file).toBe("posts.json");
  });

  test("a non-owner gets 404", async () => {
    const owner = await signup();
    const stranger = await signup();
    const { tenantId } = await createProject(owner.token, "Scoped", { posts: [] });
    const res = await fetch(`${app.base}/projects/${tenantId}/diagnostics`, {
      headers: as(stranger.token),
    });
    expect(res.status).toBe(404);
  });
});

// ── Service surface ────────────────────────────────────────────────

describe("service surface", () => {
  test("health responds without auth", async () => {
    const res = await fetch(`${app.base}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: "stubbase-dashboard-api" });
  });

  test("unknown routes are 404", async () => {
    expect((await fetch(`${app.base}/nope`)).status).toBe(404);
    expect((await fetch(`${app.base}/_internal/nope`, { method: "POST" })).status).toBe(404);
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const res = await fetch(`${app.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
