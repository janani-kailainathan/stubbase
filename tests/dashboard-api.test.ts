/**
 * Dashboard Backend — regression suite for the invariants in CLAUDE.md.
 *
 * Black-box over HTTP against a real `server-app.ts` wired to a real
 * `server-core.ts`, both on scratch state. The pairing matters: the files
 * proxy, the draft model and deploy are only meaningful end-to-end, and the
 * whole point of this service is that ADMIN_SECRET stays on its side of that
 * boundary.
 *
 * Everything here assumes an authenticated caller and asks what they may then
 * do. How someone *becomes* authenticated — password login, sessions, OAuth,
 * One Tap — is `dashboard-api.auth.test.ts`; shared account and database
 * helpers are in `dashboard-api.helpers.ts`.
 *
 * SQLite is opened read-only from the tests for the few assertions that must
 * inspect storage rather than behaviour (are tokens really hashed at rest?).
 *
 *   bun test tests/dashboard-api.test.ts   (or: bun run scripts/build.ts -pl dashboard-api)
 *   bun test tests/dashboard-api           (this file and the auth suite)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
// Data only, React-free: the Co-Pilot's prompt must offer exactly these.
import { STARTERS } from "../sites/dashboard/src/lib/starters.ts";
import {
  ADMIN_SECRET,
  startApp,
  startCore,
  stopServices,
  systemFilePath,
  tenantFilePath,
  type Service,
} from "./helpers.ts";
import {
  ALLOWED_ORIGIN,
  PASSWORD,
  as,
  jsonHeaders,
  readDbOf,
  writeDbOf,
  grantPackOn,
  setPlanOn,
  sha256hex,
  signupOn,
  type Account,
} from "./dashboard-api.helpers.ts";

let ROOT = "";
let core: Service;
let app: Service;
const running: Service[] = [];

// Bound to this suite's default instance; the AI block passes its own service
// where it needs one, which is why the shared helpers all take a Service.
const readDb = <T,>(fn: (db: Database) => T): T => readDbOf(app, fn);
const setPlan = (email: string, plan: string) => setPlanOn(app, email, plan);
const grantPack = (email: string, addon: string, opts?: Parameters<typeof grantPackOn>[3]) =>
  grantPackOn(app, email, addon, opts);
const signup = (on: Service = app) => signupOn(on);

/** Signs up an account that is entitled to everything. */
async function signupOnPaidPlan(on: Service = app): Promise<Account> {
  const account = await signup(on);
  setPlanOn(on, account.email, "pro");
  return account;
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

const coreFile = (tenantId: string, name: string) => Bun.file(tenantFilePath(core, tenantId, name));

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

  /**
   * Every per-project route, with a body where one is required.
   *
   * Kept as one list because the anonymous check, the cross-user check and the
   * deep-link check all have to cover the *same* surface: a route that is added
   * to one of them and not the others is exactly the gap these tests exist to
   * close. Adding a `/projects/<id>/…` route to server-app.ts means adding a
   * row here.
   */
  const projectRoutes = (
    tenantId: string,
  ): Array<{ method: string; path: string; body?: string }> => [
    { method: "PATCH", path: `/projects/${tenantId}`, body: JSON.stringify({ name: "stolen" }) },
    { method: "DELETE", path: `/projects/${tenantId}` },
    { method: "GET", path: `/projects/${tenantId}/usage` },
    { method: "GET", path: `/projects/${tenantId}/diagnostics` },
    { method: "GET", path: `/projects/${tenantId}/live-logs` },
    { method: "GET", path: `/projects/${tenantId}/keys` },
    { method: "POST", path: `/projects/${tenantId}/keys`, body: JSON.stringify({ name: "k" }) },
    { method: "POST", path: `/projects/${tenantId}/deploy` },
    {
      method: "POST",
      path: `/projects/${tenantId}/duplicate`,
      body: JSON.stringify({ name: "stolen", copyEnv: true }),
    },
    {
      method: "POST",
      path: `/projects/${tenantId}/status`,
      body: JSON.stringify({ status: "stopped" }),
    },
    { method: "GET", path: `/projects/${tenantId}/status` },
    { method: "GET", path: `/projects/${tenantId}/files/config` },
    { method: "GET", path: `/projects/${tenantId}/files/config?source=live` },
    {
      method: "PUT",
      path: `/projects/${tenantId}/files/config`,
      body: JSON.stringify({ QA_MODE: "true" }),
    },
    { method: "GET", path: `/projects/${tenantId}/files/posts` },
    { method: "PUT", path: `/projects/${tenantId}/files/posts`, body: JSON.stringify([{ id: "x" }]) },
    { method: "DELETE", path: `/projects/${tenantId}/files/posts` },
    { method: "GET", path: `/projects/${tenantId}/system` },
    { method: "GET", path: `/projects/${tenantId}/system/users` },
    {
      method: "PUT",
      path: `/projects/${tenantId}/system/users/nobody/role`,
      body: JSON.stringify({ role: "admin" }),
    },
    {
      method: "POST",
      path: `/projects/${tenantId}/ai/chat`,
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "a blog" }] }] }),
    },
  ];

  /** Fires one row of the matrix. Never leaves an SSE body streaming. */
  async function callRoute(
    { method, path, body }: { method: string; path: string; body?: string },
    token?: string,
  ): Promise<number> {
    const res = await fetch(`${app.base}${path}`, {
      method,
      headers: jsonHeaders(token),
      ...(body ? { body } : {}),
    });
    await res.body?.cancel();
    return res.status;
  }

  test("every /projects route rejects an anonymous caller", async () => {
    for (const route of [
      { method: "GET", path: "/projects" },
      { method: "POST", path: "/projects", body: "{}" },
      ...projectRoutes(aliceProject),
    ]) {
      const status = await callRoute(route);
      expect({ ...route, status }).toEqual({ ...route, status: 401 });
    }
  }, 20_000);

  test("a second user cannot reach another user's project on ANY route", async () => {
    // The single most important test in this suite: every /projects* route
    // must ownership-check before it touches the core.
    for (const route of projectRoutes(aliceProject)) {
      const status = await callRoute(route, bob.token);
      expect({ ...route, status }).toEqual({ ...route, status: 404 });
    }

    // Nothing was mutated on the core by any of those attempts.
    expect(await coreFile(aliceProject, "posts").json()).toEqual([{ id: "1" }]);
    expect(await coreFile(aliceProject, "draft_posts").exists()).toBe(false);
    expect(await coreFile(aliceProject, "draft_config").exists()).toBe(false);
  }, 30_000);

  test("a stranger's project id in the URL opens nothing", async () => {
    // The dashboard puts the tenant id in its own address bar (`/p/<id>`), so
    // a project link is now something a person can copy, bookmark and paste
    // into an account that does not own it. That is a UI convenience and must
    // never be an authorisation one: the id is a *name*, and knowing it grants
    // nothing. Bob signing in and loading Alice's URL is exactly this.
    //
    // Guarded here rather than in the SPA because the SPA is static and its
    // session token is in the browser — anything it decides, its user can
    // undo with devtools. The 404s below are the actual boundary.
    const seenByBob = await fetch(`${app.base}/projects`, { headers: as(bob.token) }).then((r) =>
      r.json(),
    );
    expect(seenByBob.map((p: any) => p.tenant_id)).not.toContain(aliceProject);

    // Everything the workspace loads when a project id is opened.
    for (const path of [
      `/projects/${aliceProject}/files/posts`,
      `/projects/${aliceProject}/files/config`,
      `/projects/${aliceProject}/files/config?source=live`,
      `/projects/${aliceProject}/usage`,
      `/projects/${aliceProject}/diagnostics`,
      `/projects/${aliceProject}/live-logs`,
      `/projects/${aliceProject}/keys`,
    ]) {
      const res = await fetch(`${app.base}${path}`, { headers: as(bob.token) });
      const text = await res.text();
      // 404, not 403: a 403 would confirm that a project with this id exists,
      // which is the one bit the id alone should not buy you.
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      // And the refusal itself leaks nothing about Alice's project.
      expect(text).not.toContain("Alice");
      expect(text).not.toContain("posts");
    }
  }, 30_000);

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
    // Recorded in the tenant's own status file, so the core enforces it.
    expect(await Bun.file(systemFilePath(core, project.tenantId, "status")).json()).toEqual({ status: "stopped" });
    const shown = await fetch(`${app.base}/projects/${project.tenantId}/status`, { headers: as(owner.token) });
    expect(await shown.json()).toEqual({ tenant: project.tenantId, status: "stopped" });
    const res = await fetch(`${core.base}/${project.tenantId}/anything`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ projectStatus: "stopped" });
  }, 15_000);

  /** Every fixed key the core reads from a tenant's config (ENVIRONMENT.md §2). */
  const CORE_TENANT_KEYS = [
    "QA_MODE",
    "AUTH_ENABLED",
    "AUTH_EMAIL_VERIFICATION",
    "AUTH_PUBLIC_ROUTES",
    "AUTH_JWT_TTL_SECONDS",
    "AUTH_REFRESH_TTL_SECONDS",
    "AUTH_OAUTH_REDIRECT",
    "AUTH_RESET_URL",
    "AUTH_EMAIL_DOMAINS_ONLY",
    "AUTH_EMAIL_DOMAINS_ALLOWED",
    "AUTH_EMAIL_DOMAINS_BLOCKED",
    "AUTH_BLOCK_DISPOSABLE_EMAIL",
    "RBAC_ENABLED",
    "AUTH_GOOGLE_CLIENT_ID",
    "AUTH_GOOGLE_SECRET",
    "AUTH_GITHUB_CLIENT_ID",
    "AUTH_GITHUB_SECRET",
    "RESEND_API_KEY",
    "RESEND_FROM",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
  ];

  const readConfig = (tenantId: string) =>
    fetch(`${app.base}/projects/${tenantId}/files/config`, { headers: as(owner.token) }).then((r) => r.json());

  test("a new project's .env lists every setting, all commented out", async () => {
    const project = await createProject(owner.token, "Templated");
    const { __raw: raw, ...keys } = await readConfig(project.tenantId);
    expect(typeof raw).toBe("string");

    // The template switches nothing on: not one live line, and no key at all.
    const live = (raw as string).split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(live).toEqual([]);
    expect(keys).toEqual({});

    // …and every key the core reads is there to uncomment, patterns included.
    const offered = [...(raw as string).matchAll(/^#\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    for (const key of CORE_TENANT_KEYS) expect({ key, offered: offered.includes(key) }).toEqual({ key, offered: true });
    expect(offered.some((k) => /^SCHEMA_[A-Z0-9_]+$/.test(k))).toBe(true);
    expect(offered.some((k) => /^HOOK_(BEFORE|AFTER)_(INSERT|UPDATE|DELETE)_[A-Z0-9_]+$/.test(k))).toBe(true);
    expect(new Set(offered).size).toBe(offered.length); // each offered once, or uncommenting is ambiguous
    expect(offered).not.toContain("PROJECT_STATUS"); // not a setting: it is system/status.json

    // The OAuth callbacks it tells you to register are this project's own.
    expect(raw).toContain(`/${project.tenantId}/auth/google/callback`);
    expect(raw).toContain(`/${project.tenantId}/auth/github/callback`);
    // …with the guide to getting the keys above each provider's pair.
    expect((raw as string).match(/^# How to get the keys: https:\/\/stubbase\.dev\/guides\/google-github-oauth-keys$/gm)).toHaveLength(2);
  }, 15_000);

  test("a new project's .env is numbered as a hierarchy, and its contents list matches it", async () => {
    const project = await createProject(owner.token, "Numbered");
    const lines = ((await readConfig(project.tenantId)).__raw as string).split("\n");

    // The contents list: "#   1. Auth", "#      1.1 Sign-up…", "#          1.5.1 Google".
    const from = lines.indexOf("# Sections, in order:") + 1;
    const contents = lines.slice(from, lines.indexOf("#", from)).map((line) => {
      const m = /^#\s+(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(line);
      expect({ line, parsed: Boolean(m) }).toEqual({ line, parsed: true });
      return { number: m![1], title: m![2] };
    });

    // The headings themselves, in the order they appear.
    const headings = lines.flatMap((line) => {
      const m =
        /^# ══ (\d+)\. (.+?) ═+$/.exec(line) ??
        /^# ── (\d+\.\d+) (.+?) ─+$/.exec(line) ??
        /^# (\d+\.\d+\.\d+) (.+?) — /.exec(line);
      return m ? [{ number: m[1], title: m[2] }] : [];
    });

    const numbers = headings.map((h) => h.number);
    expect(numbers).toEqual(["1", "1.1", "1.2", "1.3", "1.4", "1.5", "1.5.1", "1.5.2", "1.6", "2", "2.1", "2.2", "3", "4", "5"]);
    expect(contents.map((c) => c.number)).toEqual(numbers);
    // Each heading reads as its contents entry does (a heading may add a note, e.g. "(needs AUTH_ENABLED=true)").
    headings.forEach((h, i) => expect({ n: h.number, starts: h.title.startsWith(contents[i].title) }).toEqual({ n: h.number, starts: true }));
    // Every number is inside the one before it or its sibling: no 1.5.1 without a 1.5, no gap in a level.
    numbers.forEach((n, i) => {
      const parts = n.split(".").map(Number);
      const prev = i === 0 ? [0] : numbers[i - 1].split(".").map(Number);
      const child = parts.length === prev.length + 1 && parts.slice(0, -1).join(".") === prev.join(".") && parts.at(-1) === 1;
      const next = parts.length <= prev.length && parts.slice(0, -1).join(".") === prev.slice(0, parts.length - 1).join(".") && parts.at(-1) === prev[parts.length - 1] + 1;
      expect({ n, follows: child || next }).toEqual({ n, follows: true });
    });
    // Cross-references in the comments point at sections that exist.
    const refs = [...lines.join("\n").matchAll(/\((\d+(?:\.\d+)+)\)|Shared by (\d+(?:\.\d+)+) and (\d+(?:\.\d+)+)/g)].flatMap((m) => m.slice(1).filter(Boolean));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect({ ref, exists: numbers.includes(ref) }).toEqual({ ref, exists: true });
  }, 15_000);

  test("saving the template untouched is allowed on any plan, and changes nothing", async () => {
    const free = await signup(); // Free: no paid feature may be switched on
    const project = await createProject(free.token, "Untouched");
    const config = await fetch(`${app.base}/projects/${project.tenantId}/files/config`, { headers: as(free.token) }).then((r) => r.json());
    const saved = await fetch(`${app.base}/projects/${project.tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(free.token),
      body: JSON.stringify(config),
    });
    expect(saved.status).toBe(200);
  }, 15_000);

  test("start/stop never touches the .env", async () => {
    const project = await createProject(owner.token, "Toggled");
    const before = await readConfig(project.tenantId);
    await activate(owner.token, project.tenantId);
    expect(await readConfig(project.tenantId)).toEqual(before);
    const shown = await fetch(`${app.base}/projects/${project.tenantId}/status`, { headers: as(owner.token) });
    expect((await shown.json()).status).toBe("active");
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

  test("a project with no status file counts as running", async () => {
    // The core serves a tenant with no status file, so the delete guard has to
    // read it the same way — otherwise a project whose file went missing would
    // be deletable while it is still serving.
    const project = await createProject(owner.token, "No Status", { posts: [{ id: "1" }] });
    await rm(systemFilePath(core, project.tenantId, "status"), { force: true });

    const res = await fetch(`${app.base}/projects/${project.tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(res.status).toBe(409);
  }, 20_000);
});

// ── Duplicating ───────────────────────────────────────────────────

describe("duplicating a project", () => {
  let owner: Account;

  beforeAll(async () => {
    owner = await signup();
  }, 20_000);

  const RULES = { defaultRole: "customer", roles: { customer: { posts: ["read"] }, admin: "*" } };

  const duplicate = (tenantId: string, body: unknown) =>
    fetch(`${app.base}/projects/${tenantId}/duplicate`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify(body),
    });
  const put = (tenantId: string, name: string, body: unknown) =>
    fetch(`${app.base}/projects/${tenantId}/files/${name}`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify(body),
    });
  const read = (tenantId: string, name: string, live = false) =>
    fetch(`${app.base}/projects/${tenantId}/files/${name}${live ? "?source=live" : ""}`, {
      headers: as(owner.token),
    });

  test("copies the resources as the editor shows them, into a project that starts stopped and clean", async () => {
    const source = await createProject(owner.token, "Original", {
      posts: [{ id: "1", title: "live" }],
      comments: [{ id: "c1" }],
    });
    await activate(owner.token, source.tenantId);
    // A staged edit: the editor shows it, the running API does not serve it yet.
    expect((await put(source.tenantId, "posts", [{ id: "1", title: "staged" }])).status).toBe(200);

    const res = await duplicate(source.tenantId, { name: "Original copy" });
    expect(res.status).toBe(201);
    const copy = await res.json();
    expect(copy.tenantId).toStartWith("original-copy-");
    expect(copy.resources.sort()).toEqual(["comments", "posts"]);

    // The edit, written as the copy's live file — nothing is left staged.
    expect(await coreFile(copy.tenantId, "posts").json()).toEqual([{ id: "1", title: "staged" }]);
    expect(await coreFile(copy.tenantId, "draft_posts").exists()).toBe(false);
    expect(await coreFile(copy.tenantId, "comments").json()).toEqual([{ id: "c1" }]);
    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    expect(list.find((p: any) => p.tenant_id === copy.tenantId)).toMatchObject({
      name: "Original copy",
      dirty: false,
    });

    // Stopped, though the project it came from is running.
    expect(await Bun.file(systemFilePath(core, copy.tenantId, "status")).json()).toEqual({ status: "stopped" });
    expect((await fetch(`${core.base}/${copy.tenantId}/posts`)).status).toBe(503);

    // …and the source is untouched: still serving, its edit still staged.
    expect(await coreFile(source.tenantId, "posts").json()).toEqual([{ id: "1", title: "live" }]);
    expect(await coreFile(source.tenantId, "draft_posts").json()).toEqual([{ id: "1", title: "staged" }]);
    expect((await fetch(`${core.base}/${source.tenantId}/posts`)).status).toBe(200);
  }, 30_000);

  test("without copyEnv the copy starts from a fresh .env and no roles", async () => {
    const source = await createProject(owner.token, "Configured", { posts: [] });
    const settings = { AUTH_ENABLED: "true", RBAC_ENABLED: "true", RESEND_API_KEY: "re_secret" };
    expect((await put(source.tenantId, "config", settings)).status).toBe(200);
    expect((await put(source.tenantId, "rbac", RULES)).status).toBe(200);

    for (const body of [{ name: "Fresh" }, { name: "Fresh", copyEnv: false }]) {
      const res = await duplicate(source.tenantId, body);
      expect(res.status).toBe(201);
      const copy = await res.json();
      const { __raw: raw, ...keys } = await (await read(copy.tenantId, "config")).json();
      expect(keys).toEqual({});
      expect(raw).toContain(`/${copy.tenantId}/auth/google/callback`);
      expect(raw).not.toContain("re_secret");
      expect((await read(copy.tenantId, "rbac")).status).toBe(404);
    }
  }, 30_000);

  test("with copyEnv the .env and rbac.json come along, pointed at the copy", async () => {
    const source = await createProject(owner.token, "Settled", { posts: [] });
    const template = (await (await read(source.tenantId, "config")).json()).__raw as string;
    expect(template).toContain(`/${source.tenantId}/auth/google/callback`);
    // Staged, not deployed: the copy takes the edit, as it does for resources.
    const settings = {
      __raw: `${template}\nAUTH_ENABLED=true\nRBAC_ENABLED=true\nRESEND_API_KEY=re_secret`,
      AUTH_ENABLED: "true",
      RBAC_ENABLED: "true",
      RESEND_API_KEY: "re_secret",
    };
    expect((await put(source.tenantId, "config", settings)).status).toBe(200);
    expect((await put(source.tenantId, "rbac", RULES)).status).toBe(200);

    const res = await duplicate(source.tenantId, { name: "Settled copy", copyEnv: true });
    expect(res.status).toBe(201);
    const copy = await res.json();

    const config = await (await read(copy.tenantId, "config", true)).json();
    expect(config).toMatchObject({ AUTH_ENABLED: "true", RBAC_ENABLED: "true", RESEND_API_KEY: "re_secret" });
    // The callback URLs to register are the copy's own, never the source's.
    expect(config.__raw).toContain(`/${copy.tenantId}/auth/google/callback`);
    expect(config.__raw).toContain(`/${copy.tenantId}/auth/github/callback`);
    expect(config.__raw).not.toContain(source.tenantId);
    expect(await (await read(copy.tenantId, "rbac", true)).json()).toEqual(RULES);
  }, 30_000);

  test("accounts, sessions and developer keys never come along", async () => {
    const source = await createProject(owner.token, "Populated", { posts: [] });
    expect((await put(source.tenantId, "config", { AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "false" })).status).toBe(200);
    await activate(owner.token, source.tenantId);
    await fetch(`${app.base}/projects/${source.tenantId}/deploy`, { method: "POST", headers: as(owner.token) });
    const signed = await fetch(`${core.base}/${source.tenantId}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@test.co", password: "password123" }),
    });
    expect(signed.status).toBe(201);
    const key = await fetch(`${app.base}/projects/${source.tenantId}/keys`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ name: "agent" }),
    });
    expect(key.ok).toBe(true);
    // The source really has them, so their absence below means something.
    for (const file of ["users", "sessions"])
      expect(await Bun.file(systemFilePath(core, source.tenantId, file)).exists()).toBe(true);

    const copy = await (await duplicate(source.tenantId, { name: "Populated copy", copyEnv: true })).json();
    for (const file of ["users", "sessions"])
      expect({ file, exists: await Bun.file(systemFilePath(core, copy.tenantId, file)).exists() }).toEqual({ file, exists: false });
    const keys = await fetch(`${app.base}/projects/${copy.tenantId}/keys`, { headers: as(owner.token) });
    expect(await keys.json()).toEqual([]);
  }, 30_000);

  test("a duplicate needs a name, and copyEnv must be a boolean", async () => {
    const source = await createProject(owner.token, "Strict");
    expect((await duplicate(source.tenantId, {})).status).toBe(400);
    expect((await duplicate(source.tenantId, { name: "  " })).status).toBe(400);
    expect((await duplicate(source.tenantId, { name: "Strict copy", copyEnv: "yes" })).status).toBe(400);
    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    expect(list.some((p: any) => p.name === "Strict copy")).toBe(false);
  }, 15_000);
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

  /**
   * Deploy consumes the draft, so the editor falls back to the live file — which
   * is the only copy the public API writes to.
   *
   * Left in place, a promoted draft is a frozen snapshot that reads take in
   * preference to live data: every record created through the project's own API
   * became invisible in the dashboard the moment its owner deployed once, and
   * the next deploy rolled the live file back over them. Both symptoms come from
   * the same leftover file, so both are pinned here.
   */
  test("records created through the live API show up in the editor after a deploy", async () => {
    const { tenantId: id } = await createProject(owner.token, "Library", {
      books: [{ id: "1", title: "Dune" }],
    });
    await activate(owner.token, id);

    // One ordinary dashboard edit, deployed. This is what used to strand a draft.
    await fetch(`${app.base}/projects/${id}/files/books`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "1", title: "Dune" }]),
    });
    await fetch(`${app.base}/projects/${id}/deploy`, { method: "POST", headers: as(owner.token) });
    expect(await coreFile(id, "draft_books").exists()).toBe(false);

    // Now the project's own API creates a record, as a real client would.
    const created = await fetch(`${core.base}/${id}/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Neuromancer" }),
    });
    expect(created.status).toBe(201);

    const editor = await fetch(`${app.base}/projects/${id}/files/books`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(editor.map((b: any) => b.title)).toEqual(["Dune", "Neuromancer"]);
  }, 30_000);

  /**
   * The same symptom from the other direction: a draft that is already on disk
   * with nothing staged. Deploys made before drafts were consumed left one
   * behind for every resource ever edited, and the editor served that frozen
   * snapshot in preference to the live file — so the fix above stops new ones
   * appearing but cannot help a project that already has them. Reads gate on
   * `dirty` instead of on the file existing, which makes a stranded draft inert
   * without having to hunt it down first.
   */
  test("a stranded draft is ignored when the project has nothing staged", async () => {
    const { tenantId: id } = await createProject(owner.token, "Stranded", {
      books: [{ id: "1", title: "Dune" }],
    });
    await activate(owner.token, id);

    // Exactly the on-disk shape a pre-fix deploy left: a draft beside a live
    // file the API has since moved on from, and dirty already cleared.
    await Bun.write(coreFile(id, "draft_books").name!, JSON.stringify([{ id: "1", title: "Dune" }]));
    await fetch(`${core.base}/${id}/_admin/flush`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_SECRET}` } });
    await fetch(`${core.base}/${id}/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Neuromancer" }),
    });

    const project = await fetch(`${app.base}/projects`, { headers: as(owner.token) })
      .then((r) => r.json())
      .then((rows: any[]) => rows.find((p) => p.tenant_id === id));
    expect(project.dirty).toBe(false); // nothing staged — the draft is a leftover

    const editor = await fetch(`${app.base}/projects/${id}/files/books`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(editor.map((b: any) => b.title)).toEqual(["Dune", "Neuromancer"]);
  }, 30_000);

  test("a resource that exists only as a draft is still readable", async () => {
    // `dirty` was added by ALTER TABLE defaulting to 0 and never back-filled,
    // so a project older than the column reads clean while genuinely holding
    // un-deployed drafts. Trusting the flag alone would 404 its only copy.
    const { tenantId: id } = await createProject(owner.token, "DraftOnly");
    // Staged straight on the core, the way a file predating the flag looks:
    // a draft on disk with no live counterpart and the project reading clean.
    await Bun.write(coreFile(id, "draft_products").name!, JSON.stringify([{ id: "p1", name: "Widget" }]));
    const project = await fetch(`${app.base}/projects`, { headers: as(owner.token) })
      .then((r) => r.json())
      .then((rows: any[]) => rows.find((p) => p.tenant_id === id));
    expect(project.dirty).toBe(false);

    const res = await fetch(`${app.base}/projects/${id}/files/products`, {
      headers: as(owner.token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "p1", name: "Widget" }]);
  }, 30_000);

  test("an actually-staged edit is still what the editor shows", async () => {
    const { tenantId: id } = await createProject(owner.token, "Staged", {
      books: [{ id: "1", title: "Dune" }],
    });
    // A real dashboard edit: dirty is set, and the draft must win over live.
    await fetch(`${app.base}/projects/${id}/files/books`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "1", title: "Dune (staged)" }]),
    });
    const editor = await fetch(`${app.base}/projects/${id}/files/books`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(editor.map((b: any) => b.title)).toEqual(["Dune (staged)"]);
  }, 30_000);

  test("deploying one resource does not roll another one back over live data", async () => {
    const { tenantId: id } = await createProject(owner.token, "Catalogue", {
      books: [{ id: "1", title: "Dune" }],
      authors: [],
    });
    await activate(owner.token, id);

    await fetch(`${app.base}/projects/${id}/files/books`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "1", title: "Dune" }]),
    });
    await fetch(`${app.base}/projects/${id}/deploy`, { method: "POST", headers: as(owner.token) });

    await fetch(`${core.base}/${id}/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Snow Crash" }),
    });

    // An edit to an unrelated resource. `books` must not be touched by it.
    await fetch(`${app.base}/projects/${id}/files/authors`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ name: "Gibson" }]),
    });
    const deployed = await fetch(`${app.base}/projects/${id}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(deployed.promoted).toEqual(["authors"]);

    const books = await fetch(`${core.base}/${id}/books`).then((r) => r.json());
    expect(books.map((b: any) => b.title)).toEqual(["Dune", "Snow Crash"]);
  }, 30_000);

  /**
   * The `resources` column is a projection of what is on the core's disk, and
   * every writer rebuilds the whole list. Bun.serve interleaves requests while
   * one is awaiting the core, so a writer that took its snapshot *before* that
   * await writes back a list that never saw the others — the files land on
   * disk, the column loses them, and the sidebar shows nothing with no error
   * anywhere. These two pin the read-modify-write shut.
   */
  test("concurrent creates all survive in the resources column", async () => {
    const { tenantId: id } = await createProject(owner.token, "Concurrent");
    const names = ["books", "authors", "orders", "shelves", "labels"];

    const writes = await Promise.all(
      names.map((n) =>
        fetch(`${app.base}/projects/${id}/files/${n}`, {
          method: "PUT",
          headers: jsonHeaders(owner.token),
          body: JSON.stringify([{ n }]),
        }),
      ),
    );
    for (const res of writes) expect(res.status).toBe(200);

    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    const resources = list.find((p: any) => p.tenant_id === id).resources as string[];
    expect(resources.sort()).toEqual([...names].sort());

    // The column is only believable if it matches what really got written.
    for (const n of names) expect(await coreFile(id, `draft_${n}`).exists()).toBe(true);
  }, 30_000);

  test("a create is not erased by a delete of another resource running alongside it", async () => {
    const { tenantId: id } = await createProject(owner.token, "CreateVsDelete");
    await fetch(`${app.base}/projects/${id}/files/old`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "1" }]),
    });

    const [create, remove] = await Promise.all([
      fetch(`${app.base}/projects/${id}/files/brand_new`, {
        method: "PUT",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify([{ id: "2" }]),
      }),
      fetch(`${app.base}/projects/${id}/files/old`, { method: "DELETE", headers: as(owner.token) }),
    ]);
    expect(create.status).toBe(200);
    expect(remove.status).toBe(200);

    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    const resources = list.find((p: any) => p.tenant_id === id).resources as string[];
    expect(resources).toEqual(["brand_new"]);
  }, 30_000);

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

  /**
   * `?source=live` is the read for UI that describes the *running* API rather
   * than the edit in progress — the dashboard's APIs rail, whose list of routes
   * follows the deployed config. A list that moved on save would advertise
   * routes the public plane still 404s, and retire routes it is still serving.
   * `dirty` cannot answer this: it says an edit exists, not what the edit said.
   */
  test("?source=live reads the deployed config and ignores a staged edit", async () => {
    const pro = await signup();
    setPlan(pro.email, "pro"); // AUTH_ENABLED is plan-gated at write time
    const id = (await createProject(pro.token, "Live config", { posts: [] })).tenantId;

    const liveConfig = () =>
      fetch(`${app.base}/projects/${id}/files/config?source=live`, { headers: as(pro.token) }).then(
        (r) => r.json(),
      );
    const editorConfig = () =>
      fetch(`${app.base}/projects/${id}/files/config`, { headers: as(pro.token) }).then((r) =>
        r.json(),
      );
    const stage = (value: string) =>
      fetch(`${app.base}/projects/${id}/files/config`, {
        method: "PUT",
        headers: jsonHeaders(pro.token),
        body: JSON.stringify({ AUTH_ENABLED: value }),
      });
    const deploy = () =>
      fetch(`${app.base}/projects/${id}/deploy`, { method: "POST", headers: as(pro.token) });

    // Staged, not deployed: the editor shows the edit, the live read does not.
    expect((await stage("true")).status).toBe(200);
    expect(await editorConfig()).toMatchObject({ AUTH_ENABLED: "true" });
    expect(await liveConfig()).not.toHaveProperty("AUTH_ENABLED");

    // Deploying is what turns it on.
    expect((await deploy()).status).toBe(200);
    expect(await liveConfig()).toMatchObject({ AUTH_ENABLED: "true" });

    // …and the same holds in the other direction, which is the half that is
    // easy to get wrong: switching a feature off must not retire its routes
    // until the deploy that actually stops serving them.
    expect((await stage("false")).status).toBe(200);
    expect(await editorConfig()).toMatchObject({ AUTH_ENABLED: "false" });
    expect(await liveConfig()).toMatchObject({ AUTH_ENABLED: "true" });

    expect((await deploy()).status).toBe(200);
    expect(await liveConfig()).toMatchObject({ AUTH_ENABLED: "false" });
  }, 30_000);

  test("?source=live does not fall back to a draft", async () => {
    // The fallback the editor's read depends on would defeat the point here: a
    // file that exists only as a draft is not live, and saying so is the whole
    // job of this mode.
    const res = await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "t1" }]),
    });
    expect(res.status).toBe(200);

    const editor = await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      headers: as(owner.token),
    });
    expect(editor.status).toBe(200);
    expect(await editor.json()).toEqual([{ id: "t1" }]);

    const live = await fetch(`${app.base}/projects/${tenantId}/files/tags?source=live`, {
      headers: as(owner.token),
    });
    expect(live.status).toBe(404);

    await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      method: "DELETE",
      headers: as(owner.token),
    });
  }, 20_000);
});

// ── The dirty flag ─────────────────────────────────────────────────

/**
 * `dirty` is what tells the dashboard a running project's live API is behind.
 * It has to be a record of the *edit*, not of the draft file: deploy copies a
 * draft over its live file and leaves the draft in place, so file existence
 * would read as "changed" forever after the first save.
 *
 * Because it is a projection, every writer of a draft has to maintain it —
 * which is what these tests pin down.
 */
describe("the dirty flag", () => {
  let owner: Account;
  let tenantId: string;

  const dirtyOf = async (id = tenantId, token = owner.token): Promise<boolean> => {
    const list = await fetch(`${app.base}/projects`, { headers: as(token) }).then((r) => r.json());
    return list.find((p: any) => p.tenant_id === id).dirty;
  };

  beforeAll(async () => {
    owner = await signup();
    tenantId = (await createProject(owner.token, "Dirty", { posts: [{ id: "1" }] })).tenantId;
  }, 30_000);

  test("a project seeded at creation is clean", async () => {
    // createProject writes live files, not drafts — a new project is already
    // consistent with what it would serve, so it must not nag for a deploy.
    expect(await dirtyOf()).toBe(false);
  });

  test("saving a resource marks it dirty", async () => {
    await fetch(`${app.base}/projects/${tenantId}/files/posts`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "1", title: "edited" }]),
    });
    expect(await dirtyOf()).toBe(true);
  }, 15_000);

  test("deploy clears it", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    });
    expect(res.status).toBe(200);
    expect(await dirtyOf()).toBe(false);
  }, 15_000);

  test("saving the .env marks it dirty too", async () => {
    await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ QA_MODE: "false" }),
    });
    expect(await dirtyOf()).toBe(true);

    await fetch(`${app.base}/projects/${tenantId}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    });
    expect(await dirtyOf()).toBe(false);
  }, 20_000);

  test("a refused write leaves it clean", async () => {
    const res = await fetch(`${app.base}/projects/${tenantId}/files/rejected`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ not: "an array" }),
    });
    expect(res.status).toBe(400);
    expect(await dirtyOf()).toBe(false);
  });

  test("a refused deploy leaves it dirty", async () => {
    // The safe direction: over-reporting costs a redundant redeploy, while
    // under-reporting serves stale data with a dashboard that looks clean. A
    // stand-in core accepts every write and fails only the deploy.
    const refusing = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname.endsWith("/_admin/deploy")
          ? Response.json({ error: "disk full" }, { status: 500 })
          : Response.json({ ok: true }, { status: req.method === "POST" ? 201 : 200 }),
    });
    try {
      const other = await startApp(ROOT, "app-refused-deploy", {
        CORE_API_URL: `http://127.0.0.1:${refusing.port}`,
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      });
      running.push(other);
      const account = await signup(other);
      const project = (await createProject(account.token, "Refused", { posts: [] }, other)).tenantId;
      const dirty = async () => {
        const list = await fetch(`${other.base}/projects`, { headers: as(account.token) }).then((r) => r.json());
        return list.find((p: any) => p.tenant_id === project).dirty;
      };

      const write = await fetch(`${other.base}/projects/${project}/files/posts`, {
        method: "PUT",
        headers: jsonHeaders(account.token),
        body: JSON.stringify([{ id: "1" }]),
      });
      expect(write.status).toBe(200);
      expect(await dirty()).toBe(true);

      const deploy = await fetch(`${other.base}/projects/${project}/deploy`, {
        method: "POST",
        headers: as(account.token),
      });
      expect(deploy.status).toBe(502);
      expect(await dirty()).toBe(true);
    } finally {
      refusing.stop(true);
    }
  }, 30_000);

  test("deleting a resource does not clear it", async () => {
    // A delete stages nothing, but one boolean cannot say whether *other*
    // resources are still staged — so it deliberately leaves the flag alone
    // rather than risk hiding them. Over-reporting is the safe direction.
    await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify([{ id: "t1" }]),
    });
    expect(await dirtyOf()).toBe(true);

    const del = await fetch(`${app.base}/projects/${tenantId}/files/tags`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(del.status).toBe(200);
    expect(await dirtyOf()).toBe(true);
  }, 20_000);
});

// ── Tenant config ──────────────────────────────────────────────────

describe("tenant config writes", () => {
  let owner: Account;
  let tenantId: string;

  beforeAll(async () => {
    owner = await signup();
    // QA_MODE is a paid key; this block is about the config *shape*, so take
    // the entitlement out of the picture. The gate has its own suite below.
    setPlan(owner.email, "pro");
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

  test("a stale .env that still says active cannot restart a stopped API", async () => {
    // Why status left config: an editor opened while the API was running, then
    // saved and deployed after Stop was clicked, used to start it again.
    const stop = await fetch(`${app.base}/projects/${tenantId}/status`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ status: "stopped" }),
    });
    expect(stop.status).toBe(200);

    const saved = await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ PROJECT_STATUS: "active", __raw: "PROJECT_STATUS=active\n" }),
    });
    expect(saved.status).toBe(200);
    const deployed = await fetch(`${app.base}/projects/${tenantId}/deploy`, { method: "POST", headers: as(owner.token) });
    expect(deployed.status).toBe(200);

    expect((await fetch(`${core.base}/${tenantId}/posts`)).status).toBe(503);
    const shown = await fetch(`${app.base}/projects/${tenantId}/status`, { headers: as(owner.token) });
    expect((await shown.json()).status).toBe("stopped");
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

// ── Plans and entitlements ─────────────────────────────────────────

/**
 * The three tiers differ by request allowance, handed to the core on the
 * usage-flush reply. Every project feature is on every plan; the Co-Pilot is
 * the one gated feature, refused by its own route. What the SPA does with
 * `features` is presentation — these are the checks that hold when the browser
 * is lying.
 */
describe("plans and entitlements", () => {
  const config = (token: string, tenantId: string, body: Record<string, unknown>) =>
    fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    });

  test("a new account is on Free, and says so with its entitlements resolved", async () => {
    const owner = await signup();
    const { user } = await fetch(`${app.base}/auth/me`, { headers: as(owner.token) }).then((r) =>
      r.json(),
    );
    expect(user.plan).toBe("free");
    expect(user.planName).toBe("Free");
    expect(user.monthlyRequests).toBe(10_000);
    expect(user.requestsPerSecond).toBe(5);
    expect(user.burst).toBe(20);
    // Resolved server-side so the browser never keeps its own plan table —
    // and no plan-feature list any more: the Co-Pilot is metered, not gated.
    expect(user.features).toBeUndefined();
  }, 30_000);

  test("an unknown plan string reads as Free, never as unlimited", async () => {
    const owner = await signup();
    // A typo, a tier that went away, and names every JavaScript object answers to.
    for (const plan of ["enterprise-gold", "constructor", "__proto__"]) {
      setPlan(owner.email, plan);
      const { user } = await fetch(`${app.base}/auth/me`, { headers: as(owner.token) }).then((r) =>
        r.json(),
      );
      expect(user.monthlyRequests).toBe(10_000);
      expect(user.requestsPerSecond).toBe(5);
    }
  }, 30_000);

  test("every plan can switch on every project feature, and deploy it", async () => {
    // Plans differ by request allowance alone: nothing a project's .env can
    // turn on is refused on Free.
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Everything", { posts: [] });
    const all = await config(owner.token, tenantId, {
      QA_MODE: "true",
      AUTH_ENABLED: "true",
      HOOK_AFTER_INSERT_POSTS: "https://example.com/hook",
    });
    expect(all.status).toBe(200);

    const deploy = await fetch(`${app.base}/projects/${tenantId}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    });
    expect(deploy.status).toBe(200);
    const live = await fetch(`${core.base}/${tenantId}/_admin/files/config`, {
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    }).then((r) => r.json());
    expect(live).toMatchObject({ QA_MODE: "true", AUTH_ENABLED: "true" });
  }, 30_000);

  const ask = (token: string, tenantId: string, on: Service = app) =>
    fetch(`${on.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
  /** Spends every credit an account holds, as a run of turns would. */
  const spendAllCredits = (email: string) =>
    writeDbOf(app, (db) =>
      db.query("UPDATE ai_credits SET used = 1000000 WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(email),
    );

  test("the Co-Pilot is on every plan, and refused only when the credits run out", async () => {
    // This instance has no AI key, so an allowed turn ends in 503 — which is
    // how these tests tell "let through" from "refused for credit" (402).
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "FreeAi", { posts: [] });
    expect((await ask(owner.token, tenantId)).status).toBe(503); // Free, on its gift

    spendAllCredits(owner.email);
    const refused = await ask(owner.token, tenantId);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ creditsRemaining: 0, error: expect.stringContaining("no AI credits") });

    // Pro's monthly credits are a grant of their own, made on first use.
    setPlan(owner.email, "pro");
    expect((await ask(owner.token, tenantId)).status).toBe(503);
  }, 30_000);

  test("the Co-Pilot's credit check comes before the provider key, so it can't probe the server", async () => {
    // Out of credit, the answer is 402 whether or not this deployment holds a
    // key; only an account with credit learns that the Co-Pilot is off. If the
    // order were reversed, the refusal would leak whether the server is configured.
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Order");
    spendAllCredits(owner.email);
    expect((await ask(owner.token, tenantId)).status).toBe(402);
    setPlan(owner.email, "pro");
    expect((await ask(owner.token, tenantId)).status).toBe(503);
  }, 30_000);

  test("ownership still comes first: a stranger gets 404, not a plan lecture", async () => {
    const owner = await signup();
    const stranger = await signup();
    setPlan(stranger.email, "free");
    const { tenantId } = await createProject(owner.token, "Private", { posts: [] });

    const res = await config(stranger.token, tenantId, { QA_MODE: "true" });
    expect(res.status).toBe(404);
  }, 30_000);

  test("a deploy carrying no staged config is unaffected", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "PlainDeploy", { posts: [{ id: "1" }] });
    const res = await fetch(`${app.base}/projects/${tenantId}/deploy`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
    });
    expect(res.status).toBe(200);
  }, 30_000);

  test("the platform's own demo tenant is never quoted an allowance", async () => {
    // `public` backs the landing site's live demo and belongs to no account.
    // Metering it against the Free plan would 429 the marketing site once all
    // its visitors together crossed 10,000 requests in a month.
    const date = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({
        rows: [
          { tenantId: "public", date, requests: 9_000, bytes: 90 },
          { tenantId: "unowned-demo", date, requests: 1, bytes: 1 },
        ],
      }),
    });
    const body = await res.json();
    // Still counted — the usage is real and worth seeing — just not capped.
    expect(body.applied).toBe(2);
    expect(body.quotas.map((q: any) => q.tenantId)).toEqual(["unowned-demo"]);
  }, 30_000);

  test("the usage flush reply carries each tenant's allowance back to the core", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Quota", { posts: [] });
    const date = new Date().toISOString().slice(0, 10);

    const res = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ rows: [{ tenantId, date, requests: 12, bytes: 120 }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Numbers per tenant — the core is never told what a plan is.
    expect(body.quotas).toEqual([
      { tenantId, limit: 250_000, used: 12, rps: 50, burst: 150, bucket: expect.any(String) },
    ]);
  }, 30_000);

  /** Report usage the way the core does; returns the quotas it is answered with, by tenant. */
  async function reportUsage(rows: { tenantId: string; requests: number; date?: string }[], on: Service = app) {
    const date = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${on.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ rows: rows.map((r) => ({ date, ...r, bytes: r.requests })) }),
    });
    expect(res.status).toBe(200);
    const { quotas } = (await res.json()) as {
      quotas: { tenantId: string; limit: number; used: number; rps: number; burst: number; bucket: string }[];
    };
    return new Map(quotas.map((q) => [q.tenantId, q]));
  }

  test("the settings page's used figure is the one the allowance is enforced on", async () => {
    const owner = await signup();
    const stranger = await signup();
    setPlan(owner.email, "pro");
    const a = await createProject(owner.token, "SummaryA", { posts: [] });
    const b = await createProject(owner.token, "SummaryB", { posts: [] });
    const other = await createProject(stranger.token, "NotMine", { posts: [] });
    const summary = async (token: string) => {
      const res = await fetch(`${app.base}/auth/account`, { headers: as(token) });
      expect(res.status).toBe(200);
      return (await res.json()).account;
    };

    const quotas = await reportUsage([
      { tenantId: a.tenantId, requests: 30 },
      { tenantId: b.tenantId, requests: 12 },
      { tenantId: other.tenantId, requests: 500 },
    ]);
    const account = await summary(owner.token);
    expect(account.requestsUsed).toBe(quotas.get(a.tenantId)!.used);
    expect(account).toMatchObject({
      email: owner.email,
      plan: "pro",
      planName: "Pro",
      monthlyRequests: quotas.get(a.tenantId)!.limit,
      requestsUsed: 42,
    });
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    expect(account.resetsOn).toBe(nextMonth.toISOString().slice(0, 10));
    expect(Date.parse(account.memberSince)).toBeLessThanOrEqual(Date.now());
    expect(account.memberSince).toMatch(/Z$/);

    // A deleted project's traffic stays in the pool, on the page as in the quota.
    const gone = await fetch(`${app.base}/projects/${b.tenantId}`, { method: "DELETE", headers: as(owner.token) });
    expect(gone.status).toBe(200);
    expect((await summary(owner.token)).requestsUsed).toBe(42);
    expect((await summary(stranger.token)).requestsUsed).toBe(500);
  }, 30_000);

  test("an account's projects share one monthly allowance", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const a = await createProject(owner.token, "PoolA", { posts: [] });
    const b = await createProject(owner.token, "PoolB", { posts: [] });

    const quotas = await reportUsage([
      { tenantId: a.tenantId, requests: 30 },
      { tenantId: b.tenantId, requests: 12 },
    ]);
    // Not 30 and 12 against 250,000 each: 42 against the one allowance.
    expect(quotas.get(a.tenantId)).toMatchObject({ tenantId: a.tenantId, limit: 250_000, used: 42 });
    expect(quotas.get(b.tenantId)).toMatchObject({ tenantId: b.tenantId, limit: 250_000, used: 42 });
  }, 30_000);

  test("one project's report quotes the account's idle projects too, so they stop together", async () => {
    const owner = await signup(); // Free: 10,000
    const busy = await createProject(owner.token, "Busy", { posts: [] });
    const idle = await createProject(owner.token, "Idle", { posts: [] });

    const quotas = await reportUsage([{ tenantId: busy.tenantId, requests: 10_000 }]);
    // The idle project sent nothing this minute, but the pool it draws on is spent.
    expect(quotas.get(idle.tenantId)).toMatchObject({ tenantId: idle.tenantId, limit: 10_000, used: 10_000 });
  }, 30_000);

  test("another account's traffic never joins the pool", async () => {
    const owner = await signup();
    const stranger = await signup();
    const mine = await createProject(owner.token, "Mine", { posts: [] });
    const theirs = await createProject(stranger.token, "Theirs", { posts: [] });
    const theirOther = await createProject(stranger.token, "TheirOther", { posts: [] });

    const quotas = await reportUsage([
      { tenantId: mine.tenantId, requests: 7 },
      { tenantId: theirs.tenantId, requests: 3 },
    ]);
    expect(quotas.get(mine.tenantId)?.used).toBe(7);
    expect(quotas.get(theirs.tenantId)?.used).toBe(3);
    expect(quotas.get(theirOther.tenantId)?.used).toBe(3);
  }, 30_000);

  test("a deleted project's traffic still counts, so deleting and recreating buys nothing", async () => {
    const owner = await signup(); // Free: 5,000
    const kept = await createProject(owner.token, "Kept", { posts: [] });
    const doomed = await createProject(owner.token, "Doomed", { posts: [] });
    await reportUsage([{ tenantId: doomed.tenantId, requests: 4_000 }]);

    // Projects are created stopped, so it can be deleted straight away.
    const deleted = await fetch(`${app.base}/projects/${doomed.tenantId}`, {
      method: "DELETE",
      headers: as(owner.token),
    });
    expect(deleted.status).toBe(200);

    const fresh = await createProject(owner.token, "Fresh", { posts: [] });
    const quotas = await reportUsage([{ tenantId: fresh.tenantId, requests: 1 }]);
    expect(quotas.get(fresh.tenantId)?.used).toBe(4_001);
    expect(quotas.get(kept.tenantId)?.used).toBe(4_001);
    expect(quotas.has(doomed.tenantId)).toBe(false);
  }, 30_000);

  test("platform tenant traffic is never charged to the account that owns its row", async () => {
    // `public` normally belongs to no account, but nothing stops an operator
    // giving it a project row. Its visitors must still not spend that
    // account's allowance, or the marketing site could 429 a customer's API.
    const owner = await signup();
    const mine = await createProject(owner.token, "BesideDemo", { posts: [] });
    const rw = new Database(join(app.dir, "app.sqlite"));
    try {
      rw.exec("PRAGMA busy_timeout = 5000;");
      rw.query("INSERT INTO projects (tenant_id, user_id, name) VALUES ('public', ?, 'Demo')").run(owner.id);
    } finally {
      rw.close();
    }
    try {
      const quotas = await reportUsage([
        { tenantId: "public", requests: 9_000 },
        { tenantId: mine.tenantId, requests: 1 },
      ]);
      expect(quotas.get(mine.tenantId)?.used).toBe(1);
      expect(quotas.has("public")).toBe(false);
    } finally {
      const cleanup = new Database(join(app.dir, "app.sqlite"));
      try {
        cleanup.exec("PRAGMA busy_timeout = 5000;");
        cleanup.query("DELETE FROM projects WHERE tenant_id = 'public'").run();
      } finally {
        cleanup.close();
      }
    }
  }, 30_000);

  test("the usage view gives this project's own traffic and the account's pooled total", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const a = await createProject(owner.token, "ViewA", { posts: [] });
    const b = await createProject(owner.token, "ViewB", { posts: [] });
    await reportUsage([
      { tenantId: a.tenantId, requests: 20 },
      { tenantId: b.tenantId, requests: 5 },
    ]);

    const usage = await fetch(`${app.base}/projects/${a.tenantId}/usage`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(usage.month.requests).toBe(20);
    expect(usage.account).toEqual({ requests: 25 });
    expect(usage.limit).toBe(250_000);
  }, 30_000);

  test("a database from before pooling is backfilled when the service starts on it", async () => {
    // The shape api_usage had before rows remembered their account.
    const dir = join(ROOT, "legacy-usage");
    await mkdir(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const legacy = new Database(join(dir, "app.sqlite"));
    try {
      legacy.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
          plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE projects (
          tenant_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL,
          resources TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE api_usage (
          tenant_id TEXT NOT NULL, date TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0, bandwidth_bytes INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (tenant_id, date));
      `);
      legacy.query("INSERT INTO users (id, email, plan) VALUES (1, 'legacy@test.co', 'pro')").run();
      for (const tenantId of ["legacy-a", "legacy-b", "public"])
        legacy.query("INSERT INTO projects (tenant_id, user_id, name) VALUES (?, 1, ?)").run(tenantId, tenantId);
      for (const [tenantId, n] of [["legacy-a", 7], ["legacy-b", 5], ["public", 1_000]] as const)
        legacy
          .query("INSERT INTO api_usage (tenant_id, date, request_count, bandwidth_bytes) VALUES (?, ?, ?, 0)")
          .run(tenantId, date, n);
    } finally {
      legacy.close();
    }

    const upgraded = await startApp(ROOT, "legacy-usage", {
      CORE_API_URL: core.base,
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    });
    running.push(upgraded);

    const quotas = await reportUsage([{ tenantId: "legacy-a", requests: 1 }], upgraded);
    // 7 + 5 from before the upgrade, 1 after; the platform tenant's 1,000 stays out.
    expect(quotas.get("legacy-a")).toMatchObject({ tenantId: "legacy-a", limit: 250_000, used: 13 });
    expect(quotas.get("legacy-b")).toMatchObject({ tenantId: "legacy-b", limit: 250_000, used: 13 });
    expect(quotas.has("public")).toBe(false);
  }, 30_000);

  test("a tenant with no project row is quoted the smallest plan, not unlimited", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ rows: [{ tenantId: "orphaned", date, requests: 4, bytes: 40 }] }),
    });
    expect((await res.json()).quotas).toEqual([
      {
        tenantId: "orphaned",
        limit: 10_000,
        used: 4,
        rps: 5,
        burst: 20,
        bucket: expect.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
      },
    ]);
  }, 30_000);

  test("the owner's usage view reports the allowance it is measured against", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Panel", { posts: [] });

    const usage = await fetch(`${app.base}/projects/${tenantId}/usage`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(usage.limit).toBe(250_000);
  }, 30_000);

  test("each plan quotes its per-second limit, in one bucket per account", async () => {
    const owner = await signup();
    const stranger = await signup();
    setPlan(owner.email, "pro");
    const a = await createProject(owner.token, "RateA", { posts: [] });
    const b = await createProject(owner.token, "RateB", { posts: [] });
    const other = await createProject(stranger.token, "RateOther", { posts: [] });

    const quotas = await reportUsage([
      { tenantId: a.tenantId, requests: 1 },
      { tenantId: other.tenantId, requests: 1 },
    ]);
    expect(quotas.get(a.tenantId)).toMatchObject({ rps: 50, burst: 150 });
    expect(quotas.get(other.tenantId)).toMatchObject({ rps: 5, burst: 20 });
    // A second project draws on the first one's bucket rather than bringing a rate of its own…
    expect(quotas.get(b.tenantId)!.bucket).toBe(quotas.get(a.tenantId)!.bucket);
    // …and another account's projects never do.
    expect(quotas.get(other.tenantId)!.bucket).not.toBe(quotas.get(a.tenantId)!.bucket);
    // A name the core will accept.
    for (const { bucket } of quotas.values()) expect(bucket).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

    const { user } = await fetch(`${app.base}/auth/me`, { headers: as(owner.token) }).then((r) => r.json());
    expect(user).toMatchObject({ requestsPerSecond: 50, burst: 150 });
  }, 30_000);

  const account = async (token: string) =>
    (await fetch(`${app.base}/auth/account`, { headers: as(token) }).then((r) => r.json())).account;
  /** A date in last month, UTC — a flush can carry one across midnight on the 1st. */
  const lastMonth = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
  };

  test("request packs add their requests on Pro, stack, and leave the rate alone", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Packed", { posts: [] });
    grantPack(owner.email, "requests_250k");
    grantPack(owner.email, "requests_1m");
    const total = 250_000 + 250_000 + 1_000_000;

    // The core is held to the sum…
    const quotas = await reportUsage([{ tenantId, requests: 3 }]);
    expect(quotas.get(tenantId)).toMatchObject({ limit: total, used: 3, rps: 50, burst: 150 });

    // …and everywhere the allowance is shown, it is the same number.
    const { user } = await fetch(`${app.base}/auth/me`, { headers: as(owner.token) }).then((r) => r.json());
    expect(user).toMatchObject({ plan: "pro", monthlyRequests: total, requestsPerSecond: 50 });
    const usage = await fetch(`${app.base}/projects/${tenantId}/usage`, { headers: as(owner.token) }).then((r) =>
      r.json(),
    );
    expect(usage.limit).toBe(total);
    const summary = await account(owner.token);
    expect(summary).toMatchObject({
      monthlyRequests: total,
      planMonthlyRequests: 250_000,
      packRequests: 1_250_000,
      requestsPerSecond: 50,
      burst: 150,
    });
    const nextYear = String(new Date().getUTCFullYear() + 1);
    expect(summary.requestPacks).toEqual([
      { name: "+250,000 requests", requests: 250_000, remaining: 250_000, expiresOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      { name: "+1,000,000 requests", requests: 1_000_000, remaining: 1_000_000, expiresOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    ]);
    // Valid for twelve months from the grant.
    for (const pack of summary.requestPacks) expect(pack.expiresOn.slice(0, 4)).toBe(nextYear);
  }, 30_000);

  test("a pack is drawn only past the plan's allowance, and what is left carries into the next month", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Pool", { posts: [] });
    grantPack(owner.email, "requests_250k");
    const month = lastMonth();

    // Inside last month's 250,000: the pack is not touched.
    await reportUsage([{ tenantId, requests: 240_000, date: month }]);
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(250_000);

    // 20,000 more crosses the allowance by 10,000, and only that is drawn.
    await reportUsage([{ tenantId, requests: 20_000, date: month }]);
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(240_000);

    // A new month starts the plan's allowance again; the pack keeps what is left.
    const quotas = await reportUsage([{ tenantId, requests: 1 }]);
    expect(quotas.get(tenantId)).toMatchObject({ used: 1, limit: 250_000 + 240_000 });
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(240_000);
  }, 30_000);

  test("packs are drawn soonest-lapsing first, and the quote counts what they paid for", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "TwoPools", { posts: [] });
    grantPack(owner.email, "requests_1m");
    grantPack(owner.email, "requests_250k", { grantedAt: "-11 months" });

    // 300,000 past the allowance: the older pack's 250,000 first, then 50,000 of the newer.
    const quotas = await reportUsage([{ tenantId, requests: 550_000 }]);
    const summary = await account(owner.token);
    expect(summary.requestPacks).toEqual([
      expect.objectContaining({ name: "+1,000,000 requests", remaining: 950_000 }),
    ]);
    // Everything used this month, plus what the newer pack still holds.
    expect(quotas.get(tenantId)).toMatchObject({ used: 550_000, limit: 550_000 + 950_000 });
    expect(summary.monthlyRequests).toBe(1_500_000);
  }, 30_000);

  test("a spent pack stops the API the way a spent allowance does", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Spent", { posts: [] });
    grantPack(owner.email, "requests_250k", { used: 249_990 });

    // 20 past the allowance, and the pack held only 10 of them.
    const quotas = await reportUsage([{ tenantId, requests: 250_020 }]);
    const quote = quotas.get(tenantId)!;
    expect(quote.used).toBe(250_020);
    expect(quote.used).toBeGreaterThanOrEqual(quote.limit);
    expect((await account(owner.token)).requestPacks).toEqual([]);
  }, 30_000);

  test("on Free a pack is neither counted nor drawn, and is still there on Pro", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "FreePack", { posts: [] });
    grantPack(owner.email, "requests_250k");

    // Past Free's 10,000: stopped, and the pack pays for none of it.
    let quote = (await reportUsage([{ tenantId, requests: 10_005 }])).get(tenantId)!;
    expect(quote).toMatchObject({ used: 10_005, limit: 10_005 });
    let summary = await account(owner.token);
    expect(summary).toMatchObject({ monthlyRequests: 10_005, packRequests: 0 });
    expect(summary.requestPacks).toEqual([expect.objectContaining({ remaining: 250_000 })]);

    // On Pro the same pack counts in full: the Free overage was never charged to it.
    setPlan(owner.email, "pro");
    quote = (await reportUsage([{ tenantId, requests: 1 }])).get(tenantId)!;
    expect(quote).toMatchObject({ used: 10_006, limit: 250_000 + 250_000 });
    summary = await account(owner.token);
    expect(summary.packRequests).toBe(250_000);
  }, 30_000);

  test("a pack that has lapsed, is used up or is not sold adds nothing", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "NotPacked", { posts: [] });
    grantPack(owner.email, "requests_250k", { grantedAt: "-13 months" }); // lapsed
    grantPack(owner.email, "requests_1m", { used: 1_000_000 }); // used up
    grantPack(owner.email, "requests_100k"); // retired
    grantPack(owner.email, "requests_unlimited"); // mistyped, or never real
    grantPack(owner.email, "constructor"); // a name every JavaScript object answers to

    const quotas = await reportUsage([{ tenantId, requests: 1 }]);
    expect(quotas.get(tenantId)?.limit).toBe(250_000);
    expect(await account(owner.token)).toMatchObject({ monthlyRequests: 250_000, packRequests: 0, requestPacks: [] });
  }, 30_000);

  test("every project of an account draws on the one pool", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const a = await createProject(owner.token, "PoolA", { posts: [] });
    const b = await createProject(owner.token, "PoolB", { posts: [] });
    grantPack(owner.email, "requests_250k");

    // 300,000 between them is 50,000 past the one allowance, whichever project sent it.
    const quotas = await reportUsage([
      { tenantId: a.tenantId, requests: 200_000 },
      { tenantId: b.tenantId, requests: 100_000 },
    ]);
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(200_000);
    // Both projects are held to the same number, so they stop together.
    for (const { tenantId } of [a, b])
      expect(quotas.get(tenantId)).toMatchObject({ used: 300_000, limit: 300_000 + 200_000 });
  }, 30_000);

  test("a flush straddling the 1st charges each side to its own month", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Midnight", { posts: [] });
    grantPack(owner.email, "requests_250k");

    // This month is close to its allowance but inside it.
    await reportUsage([{ tenantId, requests: 245_000 }]);
    // One batch: last month ran 10,000 past its own allowance, and this month stays inside.
    // Measured against the wrong month, last month's row would drain the whole pack.
    const quotas = await reportUsage([
      { tenantId, requests: 260_000, date: lastMonth() },
      { tenantId, requests: 3_000 },
    ]);
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(240_000);
    expect(quotas.get(tenantId)).toMatchObject({ used: 248_000, limit: 250_000 + 240_000 });
  }, 30_000);

  test("a pack granted after the allowance ran out pays only for what comes next", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "LateGrant", { posts: [] });

    // Past the allowance with no pack: stopped.
    let quote = (await reportUsage([{ tenantId, requests: 260_000 }])).get(tenantId)!;
    expect(quote).toMatchObject({ used: 260_000, limit: 260_000 });

    // The pack does not pay for the 10,000 already served; the API starts again at once.
    grantPack(owner.email, "requests_250k");
    quote = (await reportUsage([{ tenantId, requests: 1 }])).get(tenantId)!;
    expect(quote).toMatchObject({ used: 260_001, limit: 260_001 + 249_999 });
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(249_999);
  }, 30_000);

  test("another account's traffic never draws your pack", async () => {
    const owner = await signup();
    const stranger = await signup();
    setPlan(owner.email, "pro");
    setPlan(stranger.email, "pro");
    const mine = await createProject(owner.token, "MinePack", { posts: [] });
    const theirs = await createProject(stranger.token, "TheirsNoPack", { posts: [] });
    grantPack(owner.email, "requests_250k");

    const quotas = await reportUsage([
      { tenantId: mine.tenantId, requests: 1 },
      { tenantId: theirs.tenantId, requests: 300_000 },
    ]);
    expect((await account(owner.token)).requestPacks[0].remaining).toBe(250_000);
    expect(quotas.get(theirs.tenantId)).toMatchObject({ used: 300_000, limit: 300_000 });
    expect(quotas.get(mine.tenantId)).toMatchObject({ used: 1, limit: 500_000 });
  }, 30_000);

  test("a pack lapses twelve months after its grant, to the minute", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Lapse", { posts: [] });
    grantPack(owner.email, "requests_250k", { grantedAt: ["-12 months", "+1 minutes"] }); // a minute to go
    grantPack(owner.email, "requests_1m", { grantedAt: ["-12 months", "-1 minutes"] }); // a minute gone

    const quotas = await reportUsage([{ tenantId, requests: 1 }]);
    expect(quotas.get(tenantId)?.limit).toBe(250_000 + 250_000);
    expect((await account(owner.token)).requestPacks).toEqual([
      expect.objectContaining({ name: "+250,000 requests", remaining: 250_000 }),
    ]);
  }, 30_000);

  test("packs granted together are drawn in the order they were granted", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "SameDay", { posts: [] });
    grantPack(owner.email, "requests_1m");
    grantPack(owner.email, "requests_250k");

    await reportUsage([{ tenantId, requests: 350_000 }]);
    expect((await account(owner.token)).requestPacks).toEqual([
      expect.objectContaining({ name: "+1,000,000 requests", remaining: 900_000 }),
      expect.objectContaining({ name: "+250,000 requests", remaining: 250_000 }),
    ]);
  }, 30_000);

  test("a downgrade leaves what is left in a pack for when the account is back on Pro", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    const { tenantId } = await createProject(owner.token, "Downgrade", { posts: [] });
    grantPack(owner.email, "requests_250k");
    await reportUsage([{ tenantId, requests: 260_000 }]); // draws 10,000

    // On Free the rest is held back, and more traffic does not touch it.
    setPlan(owner.email, "free");
    const quote = (await reportUsage([{ tenantId, requests: 5_000 }])).get(tenantId)!;
    expect(quote).toMatchObject({ used: 265_000, limit: 265_000 });
    expect(await account(owner.token)).toMatchObject({
      packRequests: 0,
      requestPacks: [expect.objectContaining({ remaining: 240_000 })],
    });

    setPlan(owner.email, "pro");
    expect((await account(owner.token)).packRequests).toBe(240_000);
  }, 30_000);

  test("deleting an account gives up its request packs", async () => {
    const owner = await signup();
    grantPack(owner.email, "requests_250k");
    const res = await fetch(`${app.base}/auth/delete-account`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const held = readDb((db) =>
      db.query("SELECT COUNT(*) AS n FROM request_packs WHERE user_id = ?").get(owner.id),
    );
    expect(held).toEqual({ n: 0 });
  }, 30_000);
});

// ── AI credits ─────────────────────────────────────────────────────

/**
 * The Co-Pilot's ledger, read through /auth/account. Charging is exercised
 * against a stub provider in "AI Co-Pilot agent loop"; this is where credits
 * come from and when they stop counting.
 */
describe("AI credits", () => {
  const credits = async (token: string) =>
    (await fetch(`${app.base}/auth/account`, { headers: as(token) }).then((r) => r.json())).account.aiCredits;
  const grant = (email: string, source: string, grantedAt: string[] = []) =>
    writeDbOf(app, (db) =>
      db
        .query(
          `INSERT INTO ai_credits (user_id, source, granted_at)
           VALUES ((SELECT id FROM users WHERE email = ?), ?, datetime('now'${", ?".repeat(grantedAt.length)}))`,
        )
        .run(email, source, ...grantedAt),
    );
  const yearMonth = (monthsAhead: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1)).toISOString().slice(0, 7);
  };

  test("a new account starts with 100 gift credits, valid for three months", async () => {
    const owner = await signup();
    const summary = await credits(owner.token);
    expect(summary).toMatchObject({ balance: 100, monthly: 0 });
    expect(summary.grants).toEqual([
      { name: "Gift credits", credits: 100, remaining: 100, expiresAt: expect.stringMatching(/Z$/) },
    ]);
    // Three months on from today (the day of the month can roll a little at a month's end).
    expect([yearMonth(3), yearMonth(4)]).toContain(summary.grants[0].expiresAt.slice(0, 7));
  }, 30_000);

  test("the gift lapses three months after sign-up, to the minute", async () => {
    const early = await signup();
    const late = await signup();
    const backdate = (email: string, modifiers: string[]) =>
      writeDbOf(app, (db) =>
        db
          .query(
            `UPDATE ai_credits SET granted_at = datetime('now', ?, ?)
             WHERE source = 'gift' AND user_id = (SELECT id FROM users WHERE email = ?)`,
          )
          .run(...modifiers, email),
      );
    backdate(early.email, ["-3 months", "+1 minutes"]); // a minute to go
    backdate(late.email, ["-3 months", "-1 minutes"]); // a minute gone
    expect((await credits(early.token)).balance).toBe(100);
    expect(await credits(late.token)).toMatchObject({ balance: 0, grants: [] });
  }, 30_000);

  test("Pro gets 1,000 credits each month, and last month's leftovers are gone", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    grant(owner.email, `monthly:${yearMonth(-1)}`); // last month's, never spent

    const summary = await credits(owner.token);
    expect(summary).toMatchObject({ balance: 1_100, monthly: 1_000 });
    // This month's credits end first, so they are listed — and spent — before the gift.
    expect(summary.grants).toEqual([
      expect.objectContaining({ name: "Pro monthly credits", credits: 1_000, remaining: 1_000, expiresAt: `${yearMonth(1)}-01T00:00:00Z` }),
      expect.objectContaining({ name: "Gift credits", remaining: 100 }),
    ]);
    // Reading the balance again does not grant the month twice.
    expect((await credits(owner.token)).balance).toBe(1_100);
  }, 30_000);

  test("a downgrade drops the month's plan credits but keeps the gift and packs", async () => {
    const owner = await signup();
    setPlan(owner.email, "pro");
    grant(owner.email, "credits_5k");
    expect((await credits(owner.token)).balance).toBe(1_000 + 100 + 5_000);

    setPlan(owner.email, "free");
    expect(await credits(owner.token)).toMatchObject({ balance: 100 + 5_000, monthly: 0 });
  }, 30_000);

  test("credit packs stack on any plan and last twelve months; anything unsold adds nothing", async () => {
    const owner = await signup(); // Free
    grant(owner.email, "credits_5k");
    grant(owner.email, "credits_60k", ["-12 months", "+1 minutes"]); // a minute to go
    grant(owner.email, "credits_20k", ["-12 months", "-1 minutes"]); // lapsed
    grant(owner.email, "credits_unlimited"); // never sold
    grant(owner.email, "constructor"); // a name every JavaScript object answers to
    grant(owner.email, "monthly:2020-01"); // a plan grant long gone

    const summary = await credits(owner.token);
    expect(summary.balance).toBe(100 + 5_000 + 60_000);
    // Spent soonest-expiring first: the pack with a minute left goes before the gift.
    expect(summary.grants.map((g: any) => g.name)).toEqual(["Scale pack", "Gift credits", "Starter pack"]);
  }, 30_000);
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
    // graceful path, and the suite never makes a billed provider call. The
    // account has credit (every new account has its gift), or it would meet
    // the credit check first, which "AI credits" covers.
    const owner = await signupOnPaidPlan();
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
  /**
   * Queue of scripted replies; a test scripts the turns it needs. An entry is
   * a `parts` array, or `{ parts, usage, delayMs }` — `usage` becomes the
   * envelope's usageMetadata, and `parts: null` a reply with no content.
   */
  let script: (any[] | { parts: any[] | null; usage?: Record<string, number>; delayMs?: number })[] = [];

  beforeAll(async () => {
    provider = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        seen.push(body);
        if (script.length > 0) {
          const next = script.shift()!;
          const item = Array.isArray(next) ? { parts: next } : next;
          if (item.delayMs) await Bun.sleep(item.delayMs);
          return Response.json({
            candidates: item.parts ? [{ content: { parts: item.parts } }] : [{ finishReason: "SAFETY" }],
            ...(item.usage ? { usageMetadata: item.usage } : {}),
          });
        }
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
    const owner = await signupOnPaidPlan(aiApp);
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
      "change_settings",
      "use_starter",
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
    const owner = await signupOnPaidPlan(aiApp);
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
    const owner = await signupOnPaidPlan(aiApp);
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
    const owner = await signupOnPaidPlan(aiApp);
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
    const owner = await signupOnPaidPlan(aiApp);
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
    const owner = await signupOnPaidPlan(aiApp);
    const intruder = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Private", {}, aiApp);

    const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(intruder.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "stage a table" }] }] }),
    });
    expect(res.status).toBe(404);
  }, 30_000);

  // ── Settings and starters ──

  /** Runs one turn in which the model calls `name` with `args`; returns what the tool handed back. */
  async function toolResult(token: string, tenantId: string, name: string, args: Record<string, unknown>) {
    seen = [];
    script = [[{ functionCall: { name, args } }], [{ text: "Done." }]];
    const res = await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "please" }] }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const tool = body.messages.find((m: any) => m.role === "function");
    return tool.parts[0].functionResponse.response.result;
  }
  const coreFile = (tenantId: string, name: string) =>
    fetch(`${core.base}/${tenantId}/_admin/files/${name}`, { headers: { authorization: `Bearer ${ADMIN_SECRET}` } });
  const writeCoreFile = (tenantId: string, name: string, body: unknown) =>
    fetch(`${core.base}/${tenantId}/_admin/files/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("the prompt offers every starter the dashboard has, and the tool accepts exactly those", async () => {
    seen = [];
    script = [[{ text: "Hello." }]];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Starters listed", {}, aiApp);
    await fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    const persona = seen[0].contents[0].parts[0].text as string;
    // The server keeps its own copy of the list; this is what keeps it honest.
    for (const starter of STARTERS) {
      expect(persona).toContain(`${starter.id} `);
      expect(persona).toContain(starter.title);
      for (const table of Object.keys(starter.resources)) expect(persona).toContain(table);
    }
    const useStarter = seen[0].tools[0].functionDeclarations.find((d: any) => d.name === "use_starter");
    expect(useStarter.parameters.properties.id.enum).toEqual(STARTERS.map((s) => s.id));
  }, 30_000);

  test("a settings proposal changes nothing, and only settings the agent may set get into it", async () => {
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Settings", { posts: [] }, aiApp);
    const draftBefore = (await coreFile(tenantId, "draft_config")).status;

    const result = await toolResult(owner.token, tenantId, "change_settings", {
      settings: [
        { key: "AUTH_ENABLED", value: "true" },
        { key: "qa_mode", value: true }, // any case, and a boolean the model sent as one
        { key: "AUTH_PUBLIC_ROUTES", value: "posts,comments" },
        { key: "SCHEMA_POSTS", value: '{"type":"object","required":["title"]}' },
        { key: "AUTH_GOOGLE_SECRET", value: "GOCSPX-stolen" }, // a credential
        { key: "HOOK_AFTER_INSERT_POSTS", value: "https://attacker.example/steal" }, // a URL
        { key: "AUTH_MAGIC_LINKS", value: "true" }, // not a feature
        { key: "AUTH_JWT_TTL_SECONDS", value: "5" }, // below the minimum
        { key: "SCHEMA_TAGS", value: "not json" },
      ],
    });

    expect(result.pendingConfirmation).toEqual({
      kind: "settings",
      set: {
        AUTH_ENABLED: "true",
        QA_MODE: "true",
        AUTH_PUBLIC_ROUTES: "posts,comments",
        SCHEMA_POSTS: '{"type":"object","required":["title"]}',
      },
    });
    const refused = Object.fromEntries(result.refused.map((r: any) => [r.key, r.reason]));
    expect(refused.AUTH_GOOGLE_SECRET).toContain("only the user sets");
    expect(refused.HOOK_AFTER_INSERT_POSTS).toContain("only the user sets");
    expect(refused.AUTH_MAGIC_LINKS).toContain("does not exist");
    expect(refused.AUTH_JWT_TTL_SECONDS).toContain("at least 60");
    expect(refused.SCHEMA_TAGS).toContain("JSON Schema");
    expect(result.note).toContain("NOTHING HAS CHANGED YET");

    // A proposal writes nothing: no draft appears, the project is not dirty.
    expect((await coreFile(tenantId, "draft_config")).status).toBe(draftBefore);
    const projects = await fetch(`${aiApp.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    expect(projects.find((p: any) => p.tenant_id === tenantId).dirty).toBeFalsy();

    // Nothing usable at all is an error, and names what can be set.
    const none = await toolResult(owner.token, tenantId, "change_settings", {
      settings: [{ key: "AUTH_MAGIC_LINKS", value: "true" }],
    });
    expect(none.error).toBeString();
    expect(none.pendingConfirmation).toBeUndefined();
    expect(none.supported).toContain("AUTH_ENABLED");
  }, 30_000);

  test("a starter is proposed only for an empty project, and only one that exists", async () => {
    const owner = await signup(aiApp);
    const empty = await createProject(owner.token, "Empty", {}, aiApp);
    const full = await createProject(owner.token, "Full", { notes: [{ id: "1" }] }, aiApp);

    const proposed = await toolResult(owner.token, empty.tenantId, "use_starter", { id: "blog" });
    expect(proposed.pendingConfirmation).toEqual({
      kind: "starter",
      id: "blog",
      title: "Blog",
      tables: ["posts", "authors", "comments"],
    });
    // Proposed, not applied.
    expect((await coreFile(empty.tenantId, "draft_posts")).status).toBe(404);

    const refused = await toolResult(owner.token, full.tenantId, "use_starter", { id: "blog" });
    expect(refused.pendingConfirmation).toBeUndefined();
    expect(refused.error).toContain("already has tables");
    expect(refused.resources).toEqual(["notes"]);

    const unknown = await toolResult(owner.token, empty.tenantId, "use_starter", { id: "crm" });
    expect(unknown.error).toContain("no starter");
    expect(unknown.starters).toEqual(STARTERS.map((s) => s.id));
  }, 30_000);

  test("diagnostics show the settings in force and staged, but never a credential or a URL", async () => {
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Diag settings", { posts: [] }, aiApp);
    await writeCoreFile(tenantId, "config", {
      AUTH_ENABLED: "true",
      QA_MODE: "",
      RESEND_API_KEY: "re_live_secret",
      HOOK_AFTER_INSERT_POSTS: "https://hooks.example/in?token=abc123",
    });
    await writeCoreFile(tenantId, "draft_config", { AUTH_ENABLED: "false", RESEND_API_KEY: "re_live_secret" });

    const result = await toolResult(owner.token, tenantId, "get_diagnostics", {});
    expect(result.settings).toEqual({
      deployed: { values: { AUTH_ENABLED: "true" }, alsoSet: ["HOOK_AFTER_INSERT_POSTS", "RESEND_API_KEY"] },
      staged: { values: { AUTH_ENABLED: "false" }, alsoSet: ["RESEND_API_KEY"] },
    });
    // Nowhere in what went to the provider.
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain("re_live_secret");
    expect(sent).not.toContain("abc123");
  }, 30_000);

  // ── Charging ──

  const chat = (token: string, tenantId: string) =>
    fetch(`${aiApp.base}/projects/${tenantId}/ai/chat`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "how is my API doing?" }] }] }),
    });
  const credits = async (token: string) =>
    (await fetch(`${aiApp.base}/auth/account`, { headers: as(token) }).then((r) => r.json())).account.aiCredits;

  test("a turn is charged once, for every round's tokens, rounded up to whole credits", async () => {
    seen = [];
    script = [
      { parts: [{ functionCall: { name: "get_diagnostics", args: {} } }], usage: { totalTokenCount: 1_500 } },
      // No total: the parts are summed, thinking tokens included.
      { parts: [{ text: "All quiet." }], usage: { promptTokenCount: 400, candidatesTokenCount: 200, thoughtsTokenCount: 100 } },
    ];
    const owner = await signupOnPaidPlan(aiApp); // Pro: 1,000 this month + the 100 gift
    const { tenantId } = await createProject(owner.token, "Charged", {}, aiApp);

    const res = await chat(owner.token, tenantId);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 1,500 + 700 = 2,200 tokens is 3 credits, not 2 and not one per round.
    expect(body).toMatchObject({ creditsCharged: 3, creditsRemaining: 1_097 });
    expect(seen.length).toBe(2);

    // Spent soonest-expiring first: this month's credits, not the gift.
    const { balance, grants } = await credits(owner.token);
    expect(balance).toBe(1_097);
    expect(grants).toEqual([
      expect.objectContaining({ name: "Pro monthly credits", credits: 1_000, remaining: 997 }),
      expect.objectContaining({ name: "Gift credits", credits: 100, remaining: 100 }),
    ]);
  }, 30_000);

  test("a failed turn still charges the tokens the provider billed", async () => {
    seen = [];
    // Two empty turns — the first attempt and its one retry — each billed.
    script = [
      { parts: [], usage: { totalTokenCount: 1_200 } },
      { parts: [], usage: { totalTokenCount: 1_200 } },
    ];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "Failed", {}, aiApp);

    const res = await chat(owner.token, tenantId);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ creditsCharged: 3, creditsRemaining: 97 });
    expect(seen.length).toBe(2);

    // A reply with no content at all (a safety block) is not retried, and the
    // prompt it read is still charged.
    seen = [];
    script = [{ parts: null, usage: { totalTokenCount: 900 } }];
    const blocked = await chat(owner.token, tenantId);
    expect(blocked.status).toBe(502);
    expect(await blocked.json()).toMatchObject({ creditsCharged: 1, creditsRemaining: 96 });
    expect(seen.length).toBe(1);
  }, 30_000);

  test("a turn that costs more than is left stops the balance at zero, and the next is refused", async () => {
    seen = [];
    script = [{ parts: [{ text: "Done." }], usage: { totalTokenCount: 5_000 } }];
    const owner = await signup(aiApp); // the 100 gift
    const { tenantId } = await createProject(owner.token, "Overrun", {}, aiApp);
    writeDbOf(aiApp, (db) =>
      db.query("UPDATE ai_credits SET used = 99 WHERE user_id = ? AND source = 'gift'").run(owner.id),
    );

    const res = await chat(owner.token, tenantId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ creditsCharged: 5, creditsRemaining: 0 });
    expect((await credits(owner.token)).balance).toBe(0);

    // Refused before any provider call: an empty balance costs nothing.
    const refused = await chat(owner.token, tenantId);
    expect(refused.status).toBe(402);
    expect(seen.length).toBe(1);
  }, 30_000);

  test("an account runs one turn at a time", async () => {
    seen = [];
    script = [{ parts: [{ text: "Slow answer." }], usage: { totalTokenCount: 10 }, delayMs: 600 }];
    const owner = await signup(aiApp);
    const { tenantId } = await createProject(owner.token, "OneAtATime", {}, aiApp);

    const first = chat(owner.token, tenantId);
    await Bun.sleep(150);
    const second = await chat(owner.token, tenantId);
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);

    // Once the first has finished, the account can ask again.
    script = [{ parts: [{ text: "Next." }] }];
    expect((await chat(owner.token, tenantId)).status).toBe(200);
  }, 30_000);
});

/**
 * The Vertex AI provider, against a stub that plays both Google's token
 * endpoint and Vertex itself. What it holds: the service-account JWT is really
 * signed by the key file's key and says what Google requires, the exchange
 * happens once and the token is reused, and the model is addressed under the
 * configured project and location with that token.
 */
describe("Vertex AI provider", () => {
  let stub: ReturnType<typeof Bun.serve> | undefined;
  let vertexApp: Service;
  let publicKey: CryptoKey;
  const exchanges: URLSearchParams[] = [];
  const calls: { path: string; authorization: string | null; body: any }[] = [];

  const b64url = (text: string) => Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    publicKey = pair.publicKey;
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const keyFile = join(ROOT, "vertex-sa.json");
    await Bun.write(
      keyFile,
      JSON.stringify({ type: "service_account", client_email: "copilot@stub-project.iam.gserviceaccount.com", private_key: pem }),
    );

    stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/token") {
          exchanges.push(new URLSearchParams(await req.text()));
          return Response.json({ access_token: `tok-${exchanges.length}`, expires_in: 3600, token_type: "Bearer" });
        }
        calls.push({ path: url.pathname, authorization: req.headers.get("authorization"), body: await req.json() });
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Hello from Vertex." }] } }],
          usageMetadata: { totalTokenCount: 1_001 },
        });
      },
    });

    vertexApp = await startApp(ROOT, "vertex-app", {
      CORE_API_URL: core.base,
      VERTEX_PROJECT_ID: "stub-project",
      VERTEX_LOCATION: "us-central1",
      VERTEX_CREDENTIALS_FILE: keyFile,
      VERTEX_TOKEN_URL: `http://127.0.0.1:${stub.port}/token`,
      AI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
    });
    running.push(vertexApp);
  }, 30_000);

  afterAll(() => {
    stub?.stop(true);
  });

  test("signs a service-account JWT, exchanges it once, and calls the project's model", async () => {
    const owner = await signup(vertexApp);
    const { tenantId } = await createProject(owner.token, "Vertex", {}, vertexApp);
    const ask = () =>
      fetch(`${vertexApp.base}/projects/${tenantId}/ai/chat`, {
        method: "POST",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify({ messages: [{ role: "user", parts: [{ text: "hello" }] }] }),
      });

    const first = await ask();
    expect(first.status).toBe(200);
    // Setting VERTEX_PROJECT_ID is enough to pick Vertex, with Flash-Lite by default.
    expect(await first.json()).toMatchObject({
      provider: "vertex-ai",
      model: "gemini-3.1-flash-lite",
      text: "Hello from Vertex.",
      creditsCharged: 2,
    });
    expect((await ask()).status).toBe(200);

    // One exchange for both turns: the token is cached, not fetched per call.
    expect(exchanges.length).toBe(1);
    expect(exchanges[0].get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    // The assertion is signed by the key in the file, and claims what Google requires.
    const [header, claims, signature] = exchanges[0].get("assertion")!.split(".");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
    expect(JSON.parse(b64url(header).toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(b64url(claims).toString());
    expect(payload).toMatchObject({
      iss: "copilot@stub-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: `http://127.0.0.1:${stub!.port}/token`,
    });
    expect(payload.exp - payload.iat).toBe(3600);

    // The model, under the configured project and location, with the exchanged token.
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.path).toBe(
        "/v1/projects/stub-project/locations/us-central1/publishers/google/models/gemini-3.1-flash-lite:generateContent",
      );
      expect(call.authorization).toBe("Bearer tok-1");
    }
    // The same Gemini body as AI Studio: persona on the first user turn, tools advertised.
    expect(calls[0].body.contents[0].parts[0].text).toStartWith("You are the Stubbase AI Co-Pilot");
    expect(calls[0].body.tools[0].functionDeclarations.length).toBeGreaterThan(0);
  }, 30_000);

  test("a missing or unusable key file fails the boot rather than every turn", async () => {
    const broken = join(ROOT, "not-a-key.json");
    await Bun.write(broken, JSON.stringify({ client_email: "x@y.z" }));
    for (const [name, file] of [
      ["vertex-missing-key", join(ROOT, "no-such-file.json")],
      ["vertex-broken-key", broken],
    ] as const)
      await expect(
        startApp(ROOT, name, {
          CORE_API_URL: core.base,
          VERTEX_PROJECT_ID: "stub-project",
          VERTEX_CREDENTIALS_FILE: file,
        }),
      ).rejects.toThrow("never reported a port");
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

// ── System files (read-only) ───────────────────────────────────────

describe("system files", () => {
  test("an owner can see who signed up — without a password hash — and cannot write it", async () => {
    const owner = await signupOnPaidPlan();
    const { tenantId } = await createProject(owner.token, "With Accounts", { posts: [] });
    const staged = await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      // Verification off, so the signup below is an account at once (the core suite covers the pending kind).
      body: JSON.stringify({ AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "false" }),
    });
    expect(staged.status).toBe(200);
    await activate(owner.token, tenantId);
    expect((await fetch(`${app.base}/projects/${tenantId}/deploy`, { method: "POST", headers: as(owner.token) })).status).toBe(200);

    const list = () =>
      fetch(`${app.base}/projects/${tenantId}/system`, { headers: as(owner.token) }).then((r) => r.json());
    // config lives in system/ too, but it has its own door and is not listed.
    expect(await list()).toEqual({ files: [] });

    // One end user signs up through the project's public API.
    const signed = await fetch(`${core.base}/${tenantId}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "end-user@test.co", password: "password123" }),
    });
    expect(signed.status).toBe(201);

    // The signup opened a session as well as an account.
    expect(await list()).toEqual({ files: ["users", "sessions"] });
    const users = await fetch(`${app.base}/projects/${tenantId}/system/users`, { headers: as(owner.token) });
    expect(users.status).toBe(200);
    const rows = await users.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "end-user@test.co", role: "user" });
    expect(rows[0]).not.toHaveProperty("passwordHash");

    const sessions = await fetch(`${app.base}/projects/${tenantId}/system/sessions`, { headers: as(owner.token) });
    expect(sessions.status).toBe(200);
    const [session, ...more] = await sessions.json();
    expect(more).toHaveLength(0);
    expect(session).toMatchObject({ userId: rows[0].id });
    expect(session).not.toHaveProperty("tokenHash");
    expect(session).not.toHaveProperty("previousHash");

    // No write route exists, and the files proxy cannot reach it either: `users` there is data/.
    for (const method of ["PUT", "DELETE"]) {
      const res = await fetch(`${app.base}/projects/${tenantId}/system/users`, {
        method,
        headers: jsonHeaders(owner.token),
        ...(method === "PUT" ? { body: "[]" } : {}),
      });
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${app.base}/projects/${tenantId}/files/users`, { headers: as(owner.token) })).status).toBe(404);
    expect(await Bun.file(systemFilePath(core, tenantId, "users")).json()).toHaveLength(1);
  }, 30_000);

  test("a file name that is not a system file is a 404", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "No Such File");
    for (const name of ["config", "posts", "nope"]) {
      const res = await fetch(`${app.base}/projects/${tenantId}/system/${name}`, { headers: as(owner.token) });
      expect({ name, status: res.status }).toEqual({ name, status: 404 });
    }
  }, 15_000);
});

// ── Roles and permissions (rbac.json) ──────────────────────────────

describe("roles and permissions", () => {
  const RULES = {
    defaultRole: "customer",
    roles: { customer: { posts: ["read"] }, staff: { posts: "*" }, admin: "*" },
  };

  test("rbac.json is validated by the core, staged like config, and deployed", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Rules", { posts: [] });
    const put = (body: unknown) =>
      fetch(`${app.base}/projects/${tenantId}/files/rbac`, {
        method: "PUT",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify(body),
      });
    const read = (live = false) =>
      fetch(`${app.base}/projects/${tenantId}/files/rbac${live ? "?source=live" : ""}`, {
        headers: as(owner.token),
      });

    // Roles have their own switch: rbac.json can't be created until it is on.
    const early = await put(RULES);
    expect(early.status).toBe(409);
    expect((await early.json()).error).toContain("RBAC_ENABLED");
    const switched = await fetch(`${app.base}/projects/${tenantId}/files/config`, {
      method: "PUT",
      headers: jsonHeaders(owner.token),
      body: JSON.stringify({ AUTH_ENABLED: "true", RBAC_ENABLED: "true" }),
    });
    expect(switched.status).toBe(200);

    const bad = await put({ defaultRole: "nobody", roles: {} });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("defaultRole");
    expect((await put([])).status).toBe(400);

    expect((await put(RULES)).status).toBe(200);
    const list = await fetch(`${app.base}/projects`, { headers: as(owner.token) }).then((r) => r.json());
    const row = list.find((p: any) => p.tenant_id === tenantId);
    expect(row.resources).not.toContain("rbac");
    expect(row.dirty).toBe(true);
    expect(await (await read()).json()).toEqual(RULES);
    expect((await read(true)).status).toBe(404); // staged, not live

    const deploy = await fetch(`${app.base}/projects/${tenantId}/deploy`, {
      method: "POST",
      headers: as(owner.token),
    });
    expect((await deploy.json()).promoted).toContain("rbac");
    expect(await (await read(true)).json()).toEqual(RULES);
  }, 30_000);

  test("the owner sets an account's role from the dashboard", async () => {
    const owner = await signup();
    const { tenantId } = await createProject(owner.token, "Roles", { posts: [] });
    for (const [name, body] of [
      ["config", { AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "false", RBAC_ENABLED: "true" }],
      ["rbac", RULES],
    ] as const) {
      const res = await fetch(`${app.base}/projects/${tenantId}/files/${name}`, {
        method: "PUT",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }
    await activate(owner.token, tenantId);
    await fetch(`${app.base}/projects/${tenantId}/deploy`, { method: "POST", headers: as(owner.token) });

    const signed = await fetch(`${core.base}/${tenantId}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "shopper@test.co", password: "password123" }),
    }).then((r) => r.json());
    expect(signed.user.role).toBe("customer");

    const set = (userId: string, role: string) =>
      fetch(`${app.base}/projects/${tenantId}/system/users/${userId}/role`, {
        method: "PUT",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify({ role }),
      });
    const ok = await set(signed.user.id, "staff");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: signed.user.id, role: "staff" });
    const shown = await fetch(`${app.base}/projects/${tenantId}/system/users`, {
      headers: as(owner.token),
    }).then((r) => r.json());
    expect(shown[0].role).toBe("staff");

    expect((await set(signed.user.id, "wizard")).status).toBe(400);
    expect((await set("no-such-user", "staff")).status).toBe(404);
    expect((await set("not a valid id", "staff")).status).toBe(400);
  }, 30_000);
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
    await Bun.write(tenantFilePath(core, tenantId, "posts"), "[{ broken json");

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
