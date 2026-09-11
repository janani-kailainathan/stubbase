/**
 * The Logs pane's per-tab copy of the request log
 * (sites/dashboard/src/lib/log-storage.ts), kept in sessionStorage.
 *
 * The copy is written to browser storage, so the rule that matters most is
 * that it never holds a credential — and a signup or login response carries
 * the project's user token, which the dashboard otherwise keeps in memory
 * only. That is checked against real log entries: a real core with auth on
 * serves a real signup and login, and the entries come from its own log
 * snapshot, so the check follows whatever the core actually records rather
 * than a guess at its shape.
 *
 * Also held here: Clear sticks against the core's replay-on-connect, logout
 * forgets every copy and disarms stores opened before it, projects never share
 * a copy, and storage that is missing, full or corrupt never breaks the pane.
 *
 *   bun test tests/log-storage.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LogEntry } from "../sites/dashboard/src/lib/api.ts";
import {
  LOG_ENTRY_CAP,
  LOG_STORAGE_PREFIX,
  afterClear,
  clearedAtFor,
  forgetAllTabLogs,
  isAuthEntry,
  mergeEntry,
  openTabLogStore,
} from "../sites/dashboard/src/lib/log-storage.ts";
import { adminAuth, seedTenant, startCore, stopServices, type Service } from "./helpers.ts";

const TENANT = "logstore";
const OTHER = "logstore-other";
const PASSWORD = "correct-horse-battery-staple";

/** Web Storage over a Map — Bun has no sessionStorage of its own. */
class MemoryStorage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  clear() {
    this.#items.clear();
  }
}

const session = () => (globalThis as { sessionStorage?: MemoryStorage }).sessionStorage!;
const raw = (tenant: string) => session().getItem(LOG_STORAGE_PREFIX + tenant);

let ROOT = "";
let core: Service;
let signupToken = "";
let loginToken = "";

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${core.base}/${TENANT}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** The core's own record of this project's traffic. */
async function coreLog(): Promise<LogEntry[]> {
  const res = await fetch(`${core.base}/${TENANT}/_admin/logs`, { headers: adminAuth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: LogEntry[] }).entries;
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "stubbase-log-storage-test-"));
  core = await startCore(ROOT, "core");
  await seedTenant(core, TENANT, {
    posts: [{ id: "p1", title: "Hello" }],
    config: { AUTH_ENABLED: "true" },
  });

  const signup = await call("POST", "/auth/signup", { email: "ada@example.com", password: PASSWORD });
  expect(signup.status).toBeLessThan(300);
  signupToken = signup.json.token;
  const login = await call("POST", "/auth/login", { email: "ada@example.com", password: PASSWORD });
  expect(login.status).toBe(200);
  loginToken = login.json.token;
  expect(signupToken).toBeTruthy();
  expect(loginToken).toBeTruthy();

  const created = await call("POST", "/posts", { title: "Written by Ada" }, loginToken);
  expect(created.status).toBe(201);
  expect((await call("GET", "/posts", undefined, loginToken)).status).toBe(200);
}, 30_000);

afterAll(async () => {
  await stopServices([core]);
  await rm(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  (globalThis as { sessionStorage?: MemoryStorage }).sessionStorage = new MemoryStorage();
});

describe("no credential reaches storage", () => {
  test("the core's log really carries the tokens — otherwise this suite proves nothing", async () => {
    const logged = JSON.stringify(await coreLog());
    expect(logged).toContain(signupToken);
    expect(logged).toContain(loginToken);
  });

  test("a real signup and login are stored without the token, and still listed", async () => {
    const entries = await coreLog();
    openTabLogStore(TENANT).save({ entries, clearedAt: null });

    const stored = raw(TENANT)!;
    expect(stored).not.toContain(signupToken);
    expect(stored).not.toContain(loginToken);
    expect(stored).not.toContain(PASSWORD);
    // Every request is still in the copy — only the bodies are gone.
    for (const entry of entries) expect(stored).toContain(entry.correlationId);

    const loaded = openTabLogStore(TENANT).load().entries;
    const auth = loaded.filter((e) => e.path.startsWith(`/${TENANT}/auth/`));
    expect(auth.map((e) => e.path).sort()).toEqual([`/${TENANT}/auth/login`, `/${TENANT}/auth/signup`]);
    for (const entry of auth) {
      expect(entry.requestBody).toBeNull();
      expect(entry.responseBody).toBeNull();
    }
  });

  test("every real entry is classified the way the core routed it", async () => {
    for (const entry of await coreLog())
      expect(isAuthEntry(entry)).toBe(entry.path.startsWith(`/${TENANT}/auth/`));
    // A resource that merely starts with "auth", and a project named "auth".
    expect(isAuthEntry({ path: `/${TENANT}/authors` })).toBe(false);
    expect(isAuthEntry({ path: "/auth/posts" })).toBe(false);
    expect(isAuthEntry({ path: "/auth/auth/login" })).toBe(true);
  });

  test("CRUD entries keep their bodies", async () => {
    const entries = await coreLog();
    openTabLogStore(TENANT).save({ entries, clearedAt: null });
    const post = openTabLogStore(TENANT)
      .load()
      .entries.find((e) => e.method === "POST" && e.path === `/${TENANT}/posts`);
    expect(post?.requestBody).toContain("Written by Ada");
    expect(post?.responseBody).toContain("Written by Ada");
  });

  test("a copy written before the rules is re-held to them on load", async () => {
    const entries = await coreLog();
    session().setItem(LOG_STORAGE_PREFIX + TENANT, JSON.stringify({ clearedAt: null, entries }));
    const loaded = JSON.stringify(openTabLogStore(TENANT).load());
    expect(loaded).not.toContain(loginToken);
    expect(loaded).not.toContain(signupToken);
  });
});

describe("merging the core's replay", () => {
  test("a replayed entry is not shown twice, and the same array comes back", async () => {
    let shown: LogEntry[] = [];
    for (const entry of await coreLog()) shown = mergeEntry(shown, entry);
    const count = shown.length;
    for (const entry of await coreLog()) expect(mergeEntry(shown, entry)).toBe(shown);
    expect(shown.length).toBe(count);
  });

  test("entries are ordered by server time and capped at the newest LOG_ENTRY_CAP", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 8, 12, 10, 0, s)).toISOString();
    const make = (s: number): LogEntry => ({
      correlationId: `c${s}`,
      ts: at(s),
      tenantId: TENANT,
      method: "GET",
      path: `/${TENANT}/posts`,
      query: "",
      status: 200,
      durationMs: 1,
      requestBody: null,
      responseBody: "[]",
      lifecycle: [],
    });
    let shown: LogEntry[] = [];
    // Arrive out of order: newest half first, as a restored copy then a replay can.
    for (let s = 60; s >= 1; s--) shown = mergeEntry(shown, make(s));
    expect(shown.length).toBe(LOG_ENTRY_CAP);
    expect(shown[0].correlationId).toBe("c11");
    expect(shown.at(-1)!.correlationId).toBe("c60");
  });
});

describe("Clear sticks", () => {
  test("the core's replay cannot bring cleared entries back; later requests still show", async () => {
    const before = await coreLog();
    const store = openTabLogStore(TENANT);
    const cut = clearedAtFor(before, null);
    store.save({ entries: [], clearedAt: cut });

    // What the next connect replays: the whole ring, cleared entries included.
    expect(before.filter((e) => afterClear(e, cut))).toEqual([]);
    expect(store.load()).toEqual({ entries: [], clearedAt: cut });

    await Bun.sleep(5); // a later server millisecond
    expect((await call("GET", "/posts", undefined, loginToken)).status).toBe(200);
    const fresh = (await coreLog()).filter((e) => afterClear(e, cut));
    expect(fresh.length).toBe(1);
  });

  test("cleared entries left in a stored copy are dropped on load", async () => {
    const entries = await coreLog();
    const cut = clearedAtFor(entries, null);
    session().setItem(LOG_STORAGE_PREFIX + TENANT, JSON.stringify({ clearedAt: cut, entries }));
    expect(openTabLogStore(TENANT).load().entries).toEqual([]);
  });

  test("the cut is the newest server timestamp, and an empty Clear keeps the last cut", async () => {
    const entries = await coreLog();
    const newest = entries.map((e) => e.ts).sort().at(-1)!;
    expect(clearedAtFor(entries, null)).toBe(newest);
    expect(clearedAtFor([], newest)).toBe(newest);
    expect(clearedAtFor([], null)).toBeNull();
  });
});

describe("logout", () => {
  test("forgets every project's copy and nothing else in the tab", async () => {
    const entries = await coreLog();
    openTabLogStore(TENANT).save({ entries, clearedAt: null });
    openTabLogStore(OTHER).save({ entries, clearedAt: null });
    session().setItem("unrelated", "kept");

    forgetAllTabLogs();

    expect(raw(TENANT)).toBeNull();
    expect(raw(OTHER)).toBeNull();
    expect(session().getItem("unrelated")).toBe("kept");
  });

  test("a store opened before logout can never write again; one opened after can", async () => {
    const entries = await coreLog();
    const beforeLogout = openTabLogStore(TENANT);

    forgetAllTabLogs();
    // The pane unmounts a render after logout and flushes what was pending.
    beforeLogout.save({ entries, clearedAt: null });
    expect(raw(TENANT)).toBeNull();

    openTabLogStore(TENANT).save({ entries, clearedAt: null });
    expect(raw(TENANT)).not.toBeNull();
  });
});

describe("isolation and failure", () => {
  test("projects never share a copy", async () => {
    openTabLogStore(TENANT).save({ entries: await coreLog(), clearedAt: null });
    expect(openTabLogStore(OTHER).load()).toEqual({ entries: [], clearedAt: null });
  });

  test("no sessionStorage at all: loads empty, saves nowhere, never throws", async () => {
    delete (globalThis as { sessionStorage?: MemoryStorage }).sessionStorage;
    const store = openTabLogStore(TENANT);
    expect(store.load()).toEqual({ entries: [], clearedAt: null });
    expect(() => store.save({ entries: [], clearedAt: null })).not.toThrow();
    expect(() => forgetAllTabLogs()).not.toThrow();
  });

  test("full storage never throws out of a save", async () => {
    session().setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const entries = await coreLog();
    expect(() => openTabLogStore(TENANT).save({ entries, clearedAt: null })).not.toThrow();
  });

  test("a corrupt or foreign copy loads as empty rather than breaking the pane", () => {
    const store = openTabLogStore(TENANT);
    for (const junk of ["{not json", "null", "42", '{"entries":"nope"}', '{"entries":[{"id":1},null]}']) {
      session().setItem(LOG_STORAGE_PREFIX + TENANT, junk);
      expect(store.load().entries).toEqual([]);
    }
  });
});
