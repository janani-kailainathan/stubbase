/**
 * The dashboard's API playground (the Live tab) may only call the route the
 * APIs rail showed.
 *
 * The user edits the record id, query params, a fixed set of headers and the
 * body — never the URL. That promise lives in the request model
 * (sites/dashboard/src/lib/playground.ts), which is plain TS so it can be
 * imported here, the same way the starter data is. Two things can quietly
 * break it, and this suite holds both:
 *
 *   - the id field. Whatever is typed, the browser must still send the request
 *     to the route on screen — so every built URL is resolved the way a browser
 *     resolves it (dot segments collapse before a request leaves) and then
 *     routed by a real core, which has to answer as that route.
 *   - the headers. A browser refuses to send a cross-origin request carrying a
 *     header the core's preflight does not allow, so every header the model
 *     can produce is checked against the preflight a real core actually sends.
 *
 *   bun test tests/playground.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { groupEndpoints, type Endpoint } from "../sites/dashboard/src/lib/endpoints.ts";
import {
  CHAOS_HEADERS,
  DIRECTIONS,
  SORT_KEYWORDS,
  countsAsUsage,
  idProblem,
  normalizeParamValue,
  paramValueKind,
  requestHeaders,
  requestPath,
  requestQuery,
  tokenFrom,
} from "../sites/dashboard/src/lib/playground.ts";
import type { UsageResponse } from "../sites/dashboard/src/lib/api.ts";
import { FLOOR_TTL_MS, applyFloor, raiseFloor } from "../sites/dashboard/src/lib/usage-floor.ts";
import { adminAuth, seedTenant, startCore, stopServices, waitFor, type Service } from "./helpers.ts";

const TENANT = "playground";

/** Every route the rail lists for a project with auth on. */
const ENDPOINTS: Endpoint[] = groupEndpoints(["users", "posts"], { AUTH_ENABLED: "true" }).flatMap(
  (g) => g.endpoints,
);

const find = (method: string, path: string) => {
  const endpoint = ENDPOINTS.find((e) => e.method === method && e.path === path);
  if (!endpoint) throw new Error(`rail does not list ${method} ${path}`);
  return endpoint;
};

/** Ids a user could type that try to leave the route: traversal, separators, a query, a fragment. */
const HOSTILE_IDS = [
  "",
  ".",
  "..",
  "../..",
  "../../other-tenant/users",
  "../_admin/files/config",
  "a/b",
  "%2e%2e",
  "%2F_admin",
  "?_expand=users",
  "#top",
  "\\..\\..",
  " 42 ",
];

/** What a browser puts on the wire for this path: the WHATWG parser collapses `.` and `..`. */
const onTheWire = (base: string, path: string) => new URL(`${base}${path}`);

let ROOT = "";
let core: Service;

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "stubbase-playground-test-"));
  core = await startCore(ROOT, "core");
  // Record ids chosen so a request that escaped its route could not land on a
  // real record by accident.
  await seedTenant(core, TENANT, {
    users: [{ id: "u1", name: "Ada" }],
    posts: [{ id: "p1", title: "Hello", usersId: "u1" }],
  });
  // Timestamps that disagree on order, so a keyword mapped to the wrong field shows.
  await seedTenant(core, "sortable", {
    notes: [
      { id: "n1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" },
      { id: "n2", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-15T00:00:00.000Z" },
    ],
  });
}, 30_000);

afterAll(async () => {
  await stopServices([core]);
  await rm(ROOT, { recursive: true, force: true });
});

describe("the rail", () => {
  test("lists a single-record read for every resource", () => {
    expect(find("GET", "/users/{id}").needsId).toBe(true);
    expect(find("GET", "/posts/{id}").needsId).toBe(true);
  });
});

describe("an id can never move a request off its route", () => {
  test("ids that would collapse into another path are refused", () => {
    for (const id of ["", ".", ".."]) expect(idProblem(id)).not.toBeNull();
  });

  for (const endpoint of ENDPOINTS.filter((e) => e.needsId)) {
    test(`${endpoint.method} ${endpoint.path}`, () => {
      const fixed = endpoint.path.split("/").filter(Boolean);
      for (const id of [...HOSTILE_IDS, "u1"]) {
        if (idProblem(id) !== null) continue;
        const url = onTheWire(core.base, requestPath(TENANT, endpoint, id));
        // Split exactly as the core's router does.
        const segments = url.pathname.split("/").filter(Boolean);
        expect(segments).toHaveLength(fixed.length + 1);
        expect(segments[0]).toBe(TENANT);
        fixed.forEach((part, i) => {
          if (part === "{id}") expect(decodeURIComponent(segments[i + 1])).toBe(id);
          else expect(segments[i + 1]).toBe(part);
        });
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
      }
    });
  }

  test("a real core answers a hostile id as a missing record of that resource", async () => {
    const getOne = find("GET", "/users/{id}");
    for (const id of HOSTILE_IDS) {
      if (idProblem(id) !== null) continue;
      const res = await fetch(onTheWire(core.base, requestPath(TENANT, getOne, id)));
      expect({ id, status: res.status }).toEqual({ id, status: 404 });
      expect(await res.json()).toEqual({ error: "record not found" });
    }
    const hit = await fetch(onTheWire(core.base, requestPath(TENANT, getOne, "u1")));
    expect(await hit.json()).toEqual({ id: "u1", name: "Ada" });
  });
});

describe("query params", () => {
  const list = find("GET", "/posts");

  test("are encoded as params and never reach the path", async () => {
    const query = requestQuery(list, [
      { key: "title", value: "Hello" },
      { key: "../../x", value: "#/_admin?a=b&c" },
      { key: "  ", value: "ignored" },
    ]);
    const url = onTheWire(core.base, `${requestPath(TENANT, list, "")}${query}`);
    expect(url.pathname).toBe(`/${TENANT}/posts`);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("../../x")).toBe("#/_admin?a=b&c");
    const res = await fetch(url);
    expect(res.status).toBe(200);
  });

  test("skip rows that are switched off", () => {
    expect(
      requestQuery(list, [
        { key: "_limit", value: "1", enabled: false },
        { key: "title", value: "Hello", enabled: true },
        { key: "_sort", value: "title" },
      ]),
    ).toBe("?title=Hello&_sort=title");
  });

  test("are only sent on reads", () => {
    const params = [{ key: "_expand", value: "users" }];
    expect(requestQuery(find("GET", "/posts/{id}"), params)).toBe("?_expand=users");
    for (const endpoint of ENDPOINTS.filter((e) => e.method !== "GET"))
      expect(requestQuery(endpoint, params)).toBe("");
  });
});

describe("headers", () => {
  test("are all ones the core's public preflight lets a browser send", async () => {
    const res = await fetch(`${core.base}/${TENANT}/posts`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.stubbase.dev",
        "access-control-request-method": "PUT",
      },
    });
    const allowed = new Set(
      (res.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
    const chaos = Object.fromEntries(CHAOS_HEADERS.map(({ name }) => [name, "1"]));
    for (const endpoint of ENDPOINTS) {
      const headers = requestHeaders(endpoint, { chaos }, {
        token: "a-token",
        authEnabled: true,
        qaMode: true,
      });
      for (const name of Object.keys(headers)) expect({ name, allowed: allowed.has(name) }).toEqual({ name, allowed: true });
    }
  });

  test("send the token and QA headers only when the deployed config uses them", () => {
    const post = find("POST", "/posts");
    const chaos = { delay: "100" };
    expect(requestHeaders(post, { chaos }, { token: "t", authEnabled: false, qaMode: false })).toEqual({
      "content-type": "application/json",
    });
    expect(requestHeaders(post, { chaos }, { token: " t ", authEnabled: true, qaMode: true })).toEqual({
      "content-type": "application/json",
      authorization: "Bearer t",
      "x-stubbase-delay": "100",
    });
  });
});

describe("query param value controls", () => {
  test("the key decides how its value is edited", () => {
    for (const key of ["_page", "_limit", "_offset", " _limit "]) expect(paramValueKind(key)).toBe("count");
    expect(paramValueKind("_direction")).toBe("direction");
    expect(paramValueKind("_sort")).toBe("sort");
    for (const key of ["title", "_expand", "price[gte]", ""]) expect(paramValueKind(key)).toBe("text");
  });

  test("renaming a row fits its value to the new key", () => {
    const sortOptions = ["created", "updated", "title"];
    expect(normalizeParamValue("_limit", "a1b2", sortOptions)).toBe("12");
    expect(normalizeParamValue("_direction", "", sortOptions)).toBe("asc");
    expect(normalizeParamValue("_direction", "desc", sortOptions)).toBe("desc");
    expect(normalizeParamValue("_sort", "nope", sortOptions)).toBe("created");
    expect(normalizeParamValue("_sort", "title", sortOptions)).toBe("title");
    expect(normalizeParamValue("title", "a1b2", sortOptions)).toBe("a1b2");
  });

  test("every sort keyword and direction on offer is one the real core honours", async () => {
    const order = async (sort: string, direction: string) => {
      const res = await fetch(`${core.base}/sortable/notes?_sort=${sort}&_direction=${direction}`);
      return (await res.json()).map((r: { id: string }) => r.id);
    };
    const expected: Record<string, string[]> = { created: ["n1", "n2"], updated: ["n2", "n1"] };
    for (const keyword of SORT_KEYWORDS) {
      expect(DIRECTIONS).toEqual(["asc", "desc"]);
      expect(await order(keyword, "asc")).toEqual(expected[keyword]);
      expect(await order(keyword, "desc")).toEqual([...expected[keyword]].reverse());
    }
  });
});

describe("token autofill", () => {
  test("adopts the token from a successful signup or login only", () => {
    const login = find("POST", "/auth/login");
    const signup = find("POST", "/auth/signup");
    const ok = JSON.stringify({ token: "jwt", user: { id: "u1" } });
    expect(tokenFrom(login, 200, ok)).toBe("jwt");
    expect(tokenFrom(signup, 201, ok)).toBe("jwt");
    expect(tokenFrom(login, 401, JSON.stringify({ token: "jwt" }))).toBeNull();
    expect(tokenFrom(login, 200, "not json")).toBeNull();
    expect(tokenFrom(find("POST", "/users"), 201, ok)).toBeNull();
  });
});

/**
 * A Send is added to the Usage panel the moment it returns. What it may add has
 * to match what the core actually meters, and what it shows must not drop back
 * when a poll lands before the core's flush — lib/usage-floor.ts.
 */
describe("the usage panel's instant count", () => {
  test("counts what the core meters, judged by a real core's responses", async () => {
    await seedTenant(core, "counted", { posts: [{ id: "p1" }] });
    await seedTenant(core, "stopped-proj", { posts: [{ id: "p1" }], config: { PROJECT_STATUS: "stopped" } });
    await seedTenant(core, "qa-proj", { posts: [{ id: "p1" }], config: { QA_MODE: "true" } });
    const hit = async (path: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`${core.base}${path}`, { headers });
      return { status: res.status, body: await res.text() };
    };

    const served = await hit("/counted/posts");
    expect(served.status).toBe(200);
    expect(countsAsUsage(served)).toBe(true);

    // An error the project answered is traffic like any other.
    const missing = await hit("/counted/posts/nope");
    expect(missing.status).toBe(404);
    expect(countsAsUsage(missing)).toBe(true);

    // The platform refusing on the owner's behalf is not.
    const stopped = await hit("/stopped-proj/posts");
    expect(stopped.status).toBe(503);
    expect(countsAsUsage(stopped)).toBe(false);

    // A status a QA project was asked to return is served traffic, whatever it is.
    for (const status of [503, 429]) {
      const simulated = await hit("/qa-proj/posts", { "x-stubbase-status": String(status) });
      expect(simulated.status).toBe(status);
      expect(countsAsUsage(simulated)).toBe(true);
    }
    expect(countsAsUsage({ status: 503, body: JSON.stringify({ error: "Simulated Flakiness" }) })).toBe(true);

    // No response at all never reached the core.
    expect(countsAsUsage({ status: 0, body: "Failed to fetch" })).toBe(false);
  }, 30_000);

  test("a spent allowance's 429 from a real core is not counted", async () => {
    let flushes = 0;
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { rows?: { tenantId: string }[] };
        flushes += 1;
        return Response.json({
          ok: true,
          quotas: (body.rows ?? []).map((r) => ({ tenantId: r.tenantId, limit: 1, used: 1 })),
        });
      },
    });
    let metered: Service | undefined;
    try {
      metered = await startCore(ROOT, "core-quota", {
        USAGE_SINK_URL: `http://127.0.0.1:${sink.port}/_internal/usage`,
        USAGE_FLUSH_MS: "600000",
      });
      await seedTenant(metered, "capped", { posts: [{ id: "p1" }] });
      await fetch(`${metered.base}/capped/posts`);
      await fetch(`${metered.base}/capped/_admin/flush`, { method: "POST", headers: adminAuth });
      await waitFor(() => flushes > 0);

      const res = await fetch(`${metered.base}/capped/posts`);
      const refused = { status: res.status, body: await res.text() };
      expect(refused.status).toBe(429);
      expect(countsAsUsage(refused)).toBe(false);
    } finally {
      sink.stop(true);
      if (metered) await stopServices([metered]);
    }
  }, 30_000);

  const NOW = Date.parse("2026-09-12T10:00:00Z");
  const usage = (over: Partial<UsageResponse> = {}): UsageResponse => ({
    tenantId: "t",
    month: { requests: 10, bytes: 1_000 },
    daily: [{ date: "2026-09-12", request_count: 4, bandwidth_bytes: 400 }],
    limit: 50_000,
    account: { requests: 30 },
    ...over,
  });

  test("a Send shows at once: a request, its bytes, today's bar and the account's total", () => {
    const shown = applyFloor(usage(), raiseFloor(usage(), 1_920, NOW), NOW);
    expect(shown.month).toEqual({ requests: 11, bytes: 2_920 });
    expect(shown.account).toEqual({ requests: 31 });
    expect(shown.daily[0]).toEqual({ date: "2026-09-12", request_count: 5, bandwidth_bytes: 2_320 });
  });

  test("a poll that lands before the core's flush cannot take the Send back", () => {
    const floor = raiseFloor(usage(), 1_920, NOW);
    // Thirty seconds on, the server still reports the figures from before the Send.
    const polled = applyFloor(usage(), floor, NOW + 30_000);
    expect(polled.month).toEqual({ requests: 11, bytes: 2_920 });
    expect(polled.account.requests).toBe(31);
  });

  test("once the server has counted it, the server's figures win — other traffic included", () => {
    const floor = raiseFloor(usage(), 1_920, NOW);
    const caughtUp = usage({
      month: { requests: 15, bytes: 9_000 },
      account: { requests: 40 },
      daily: [{ date: "2026-09-12", request_count: 9, bandwidth_bytes: 8_400 }],
    });
    expect(applyFloor(caughtUp, floor, NOW + 90_000)).toEqual(caughtUp);
  });

  test("Sends stack, each raised from what is already on screen", () => {
    let shown = usage();
    for (let i = 0; i < 3; i++) shown = applyFloor(usage(), raiseFloor(shown, 100, NOW), NOW);
    expect(shown.month).toEqual({ requests: 13, bytes: 1_300 });
    expect(shown.account.requests).toBe(33);
  });

  test("a floor lapses, so a Send the core did not count can only overstate briefly", () => {
    const floor = raiseFloor(usage(), 1_920, NOW);
    expect(applyFloor(usage(), floor, NOW + FLOOR_TTL_MS)).toEqual(usage());
  });

  test("a floor from last month never props up this month's figures", () => {
    const floor = raiseFloor(usage({ daily: [] }), 100, Date.parse("2026-09-30T23:59:30Z"));
    const fresh = usage({ month: { requests: 0, bytes: 0 }, account: { requests: 0 }, daily: [] });
    expect(applyFloor(fresh, floor, Date.parse("2026-10-01T00:00:30Z"))).toEqual(fresh);
  });

  test("the first Send of a day adds that day to the daily figures, newest first", () => {
    const yesterday = { date: "2026-09-11", request_count: 7, bandwidth_bytes: 70 };
    const before = usage({ daily: [yesterday] });
    const shown = applyFloor(before, raiseFloor(before, 50, NOW), NOW);
    expect(shown.daily).toEqual([{ date: "2026-09-12", request_count: 1, bandwidth_bytes: 50 }, yesterday]);
  });
});
