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
  endsSession,
  finishesSignup,
  idProblem,
  initialInputs,
  refreshTokenFrom,
  verificationBody,
  verificationIdFrom,
  normalizeParamValue,
  paramValueKind,
  requestHeaders,
  requestPath,
  requestQuery,
  tokenFrom,
} from "../sites/dashboard/src/lib/playground.ts";
import type { UsageResponse } from "../sites/dashboard/src/lib/api.ts";
import { FLOOR_TTL_MS, applyFloor, raiseFloor } from "../sites/dashboard/src/lib/usage-floor.ts";
import { adminAuth, seedStatus, seedTenant, startCore, stopServices, waitFor, type Service } from "./helpers.ts";

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
  test("adopts the token from any auth route that successfully issues one", () => {
    const login = find("POST", "/auth/login");
    const signup = find("POST", "/auth/signup");
    const ok = JSON.stringify({ token: "jwt", user: { id: "u1" } });
    expect(tokenFrom(login, 200, ok)).toBe("jwt");
    expect(tokenFrom(signup, 201, ok)).toBe("jwt");
    // A password change or reset revokes the old token, so the new one has to be taken up.
    expect(tokenFrom(find("POST", "/auth/change-password"), 200, ok)).toBe("jwt");
    expect(tokenFrom(find("POST", "/auth/reset-password"), 200, ok)).toBe("jwt");
    expect(tokenFrom(find("POST", "/auth/forgot-password"), 202, JSON.stringify({ ok: true }))).toBeNull();
    expect(tokenFrom(login, 401, JSON.stringify({ token: "jwt" }))).toBeNull();
    expect(tokenFrom(login, 200, "not json")).toBeNull();
    expect(tokenFrom(find("POST", "/users"), 201, ok)).toBeNull();
    // A refresh answers with the next token, which replaces the one it was issued alongside.
    expect(tokenFrom(find("POST", "/auth/refresh"), 200, ok)).toBe("jwt");
  });

  test("adopts the refresh token alongside it, and knows when a logout ended both", () => {
    const pair = JSON.stringify({ token: "jwt", refreshToken: "sid.secret", expiresIn: 900, user: { id: "u1" } });
    for (const path of ["/auth/signup", "/auth/login", "/auth/refresh", "/auth/change-password", "/auth/reset-password"])
      expect({ path, adopted: refreshTokenFrom(find("POST", path), 200, pair) }).toEqual({ path, adopted: "sid.secret" });
    expect(refreshTokenFrom(find("POST", "/auth/refresh"), 401, pair)).toBeNull();
    expect(refreshTokenFrom(find("POST", "/posts"), 201, pair)).toBeNull();

    expect(endsSession(find("POST", "/auth/logout"), 204)).toBe(true);
    expect(endsSession(find("POST", "/auth/logout"), 503)).toBe(false);
    expect(endsSession(find("POST", "/auth/login"), 200)).toBe(false);

    // The refresh route opens with the token the playground holds, and with the documented shape without one.
    const refreshRoute = find("POST", "/auth/refresh");
    expect(JSON.parse(initialInputs(refreshRoute, null, "sid.secret").body)).toEqual({ refreshToken: "sid.secret" });
    expect(JSON.parse(initialInputs(refreshRoute, null).body)).toHaveProperty("refreshToken");
    expect(JSON.parse(initialInputs(find("POST", "/auth/login"), null, "sid.secret").body)).not.toHaveProperty("refreshToken");
  });

  test("adopts a pending sign-up's verificationId into the verify and resend bodies, and lists those routes only while verification is on", () => {
    const pending = JSON.stringify({ verificationRequired: true, verificationId: "v-1", email: "a@b.co" });
    expect(verificationIdFrom(find("POST", "/auth/signup"), 202, pending)).toBe("v-1");
    expect(verificationIdFrom(find("POST", "/auth/signup/resend"), 202, pending)).toBe("v-1");
    // A login refused until the address is verified carries it too.
    expect(verificationIdFrom(find("POST", "/auth/login"), 403, pending)).toBe("v-1");
    expect(verificationIdFrom(find("POST", "/auth/login"), 401, pending)).toBeNull();
    expect(verificationIdFrom(find("POST", "/posts"), 202, pending)).toBeNull();
    expect(tokenFrom(find("POST", "/auth/signup"), 202, pending)).toBeNull();

    const verify = find("POST", "/auth/signup/verify");
    expect(JSON.parse(initialInputs(verify, null, "", "v-1").body)).toEqual({ verificationId: "v-1", code: "" });
    expect(JSON.parse(initialInputs(find("POST", "/auth/signup/resend"), null, "", "v-1").body)).toEqual({ verificationId: "v-1" });
    expect(JSON.parse(initialInputs(verify, null).body)).toHaveProperty("verificationId"); // the documented shape without one
    // A new id keeps the code already typed, and no other route takes one.
    const typed = JSON.stringify({ verificationId: "v-1", code: "123456" });
    expect(JSON.parse(verificationBody(verify, "v-2", typed)!)).toEqual({ verificationId: "v-2", code: "123456" });
    expect(verificationBody(find("POST", "/auth/login"), "v-1")).toBeNull();
    expect(finishesSignup(verify, 201)).toBe(true);
    expect(finishesSignup(verify, 400)).toBe(false);

    // Read as the core reads AUTH_EMAIL_VERIFICATION: only a literal false turns it off.
    const paths = (config: Record<string, string>) =>
      groupEndpoints([], config).flatMap((g) => g.endpoints).map((e) => e.path);
    expect(paths({ AUTH_ENABLED: "true" })).toContain("/auth/signup/verify");
    expect(paths({ AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: " FALSE " })).not.toContain("/auth/signup/verify");
    expect(paths({ AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "false" })).not.toContain("/auth/signup/resend");
    expect(paths({ AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "no" })).toContain("/auth/signup/resend");
    expect(paths({ AUTH_EMAIL_VERIFICATION: "true" })).toEqual([]);
  });

  test("finishes a real sign-up with the adopted id and the code from the project's log", async () => {
    await seedTenant(core, "playverify", { posts: [], config: { AUTH_ENABLED: "true" } });
    const send = async (path: string, body: string) => {
      const endpoint = find("POST", path);
      const res = await fetch(`${core.base}${requestPath("playverify", endpoint, "")}`, {
        method: "POST",
        headers: requestHeaders(endpoint, { chaos: {} }, { token: "", authEnabled: true, qaMode: false }),
        body,
      });
      return { endpoint, status: res.status, body: await res.text(), correlationId: res.headers.get("x-correlation-id") };
    };

    const signup = await send("/auth/signup", JSON.stringify({ email: "pv@test.co", password: "password123" }));
    expect(signup.status).toBe(202);
    const verificationId = verificationIdFrom(signup.endpoint, signup.status, signup.body)!;
    expect(verificationId).toBeString();

    // The code the project had no email provider to send, read off the log the way the Logs tab shows it.
    const { entries } = await fetch(`${core.base}/playverify/_admin/logs`, { headers: adminAuth }).then((r) => r.json());
    const note: string = entries.find((e: { correlationId: string }) => e.correlationId === signup.correlationId).note;
    const code = /: (\d{6}) —/.exec(note)![1];

    const verify = find("POST", "/auth/signup/verify");
    const opened = initialInputs(verify, null, "", verificationId).body;
    const verified = await send("/auth/signup/verify", JSON.stringify({ ...JSON.parse(opened), code }));
    expect(verified.status).toBe(201);
    expect(tokenFrom(verified.endpoint, verified.status, verified.body)).toBeString();
    expect(finishesSignup(verified.endpoint, verified.status)).toBe(true);
  }, 20_000);

  test("carries a real session through refresh and logout, sending only what the rail offers", async () => {
    // Verification off, so signup itself opens the session (the test above finishes a pending one).
    await seedTenant(core, "playauth", { posts: [], config: { AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "false" } });
    const send = async (path: string, body: string, token = "") => {
      const endpoint = find("POST", path);
      const res = await fetch(`${core.base}${requestPath("playauth", endpoint, "")}`, {
        method: "POST",
        headers: requestHeaders(endpoint, { chaos: {} }, { token, authEnabled: true, qaMode: false }),
        body,
      });
      return { endpoint, status: res.status, body: await res.text() };
    };

    const signup = await send("/auth/signup", JSON.stringify({ email: "pg@test.co", password: "password123" }));
    const refreshToken = refreshTokenFrom(signup.endpoint, signup.status, signup.body);
    expect(refreshToken).toBeString();

    const refreshed = await send("/auth/refresh", initialInputs(find("POST", "/auth/refresh"), null, refreshToken!).body);
    expect(refreshed.status).toBe(200);
    const token = tokenFrom(refreshed.endpoint, refreshed.status, refreshed.body);
    expect(refreshTokenFrom(refreshed.endpoint, refreshed.status, refreshed.body)).not.toBe(refreshToken);

    const loggedOut = await send("/auth/logout", initialInputs(find("POST", "/auth/logout"), null).body, token!);
    expect(endsSession(loggedOut.endpoint, loggedOut.status)).toBe(true);
    const after = await fetch(`${core.base}/playauth/posts`, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  }, 20_000);
});

describe("the auth samples", () => {
  test("are one account across the routes, and each is a request a real core accepts", async () => {
    await seedTenant(core, "samples", { posts: [], config: { AUTH_ENABLED: "true", AUTH_EMAIL_VERIFICATION: "false" } });
    const sample = (path: string) => JSON.parse(initialInputs(find("POST", path), null).body);
    const call = async (path: string, payload: unknown, token = "") => {
      const endpoint = find("POST", path);
      const res = await fetch(`${core.base}${requestPath("samples", endpoint, "")}`, {
        method: "POST",
        headers: requestHeaders(endpoint, { chaos: {} }, { token, authEnabled: true, qaMode: false }),
        body: JSON.stringify(payload),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    // The same account everywhere, so signup, then login, change and reset line up with nothing retyped.
    const signup = sample("/auth/signup");
    expect(sample("/auth/login")).toEqual({ email: signup.email, password: signup.password });
    expect(sample("/auth/forgot-password")).toEqual({ email: signup.email });
    expect(sample("/auth/reset-password")).toMatchObject({ email: signup.email });
    expect(sample("/auth/change-password")).toMatchObject({ currentPassword: signup.password });
    expect(sample("/auth/change-password").password).toBe(sample("/auth/reset-password").password);

    // Sent as they stand, each passes the core's validation.
    const created = await call("/auth/signup", signup);
    expect(created.status).toBe(201);
    expect((await call("/auth/login", sample("/auth/login"))).status).toBe(200);
    expect((await call("/auth/change-password", sample("/auth/change-password"), created.json.token)).status).toBe(200);
    expect((await call("/auth/forgot-password", sample("/auth/forgot-password"))).status).toBe(202);
    // Only the reset's placeholder code is wrong, and it is refused as a code, not as a malformed body.
    expect((await call("/auth/reset-password", sample("/auth/reset-password"))).json).toEqual({
      error: "invalid or expired reset code",
    });
  }, 20_000);
});

/**
 * A Send is added to the Usage panel the moment it returns. What it may add has
 * to match what the core actually meters, and what it shows must not drop back
 * when a poll lands before the core's flush — lib/usage-floor.ts.
 */
describe("the usage panel's instant count", () => {
  test("counts what the core meters, judged by a real core's responses", async () => {
    await seedTenant(core, "counted", { posts: [{ id: "p1" }] });
    await seedTenant(core, "stopped-proj", { posts: [{ id: "p1" }] });
    await seedStatus(core, "stopped-proj", "stopped");
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
