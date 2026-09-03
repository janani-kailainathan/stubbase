/**
 * Dashboard Backend — sign-in surface.
 *
 * Split out of `dashboard-api.test.ts`: everything that decides *who someone
 * is* lives here — password login and sessions, the OAuth redirect flow for
 * Google and GitHub, and Google One Tap. The rest of that file assumes an
 * authenticated caller and tests what they may then do, which is a different
 * question and a different failure mode.
 *
 * Black-box over HTTP, same as its sibling. SQLite is opened read-only for the
 * assertions that must inspect storage rather than behaviour (are tokens
 * really hashed at rest?). Shared account/database helpers come from
 * `dashboard-api.helpers.ts`.
 *
 *   bun test tests/dashboard-api.auth.test.ts
 *   bun test tests/dashboard-api            (this file and its sibling)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { startApp, startCore, stopServices, type Service } from "./helpers.ts";
import {
  ALLOWED_ORIGIN,
  PASSWORD,
  as,
  jsonHeaders,
  readDbOf,
  sha256hex,
  signupOn,
  type Account,
} from "./dashboard-api.helpers.ts";

let ROOT = "";
let core: Service;
let app: Service;
const running: Service[] = [];

/** Bound to this suite's default instance; the OAuth block binds its own. */
const readDb = <T,>(fn: (db: Database) => T): T => readDbOf(app, fn);
const signup = (on: Service = app) => signupOn(on);

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "stubbase-app-auth-test-"));
  // Nothing here calls the core, but the dashboard API needs a CORE_API_URL
  // that resolves — booting the real one keeps this identical to the sibling
  // suite rather than relying on an unreachable address never being used.
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


// ── OAuth sign-in ──────────────────────────────────────────────────

/**
 * Dashboard OAuth, end-to-end against a stub provider.
 *
 * The provider is a real HTTP server the service exchanges a code with, so the
 * whole redirect chain is exercised: state minting, code exchange, the email
 * verification rule, and the session that comes back in the fragment. What is
 * stubbed is Google/GitHub themselves — nothing else is faked.
 */
describe("OAuth sign-in", () => {
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let oauthApp: Service;
  const SPA = "http://localhost:5199";

  /** What the stub provider will claim about the person signing in. */
  let identity: { email: string; verified: boolean; name?: string } = {
    email: "",
    verified: true,
  };

  // One Tap verifies a Google-signed ID token against Google's published keys,
  // so the stub provider has to publish a real JWKS and the suite has to hold
  // the matching private key. Nothing here is Google-specific beyond the shape.
  const KID = "test-signing-key";
  let googleKeys: CryptoKeyPair;
  let otherKeys: CryptoKeyPair;
  let publicJwk: JsonWebKey;

  const rsaKeyPair = () =>
    crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;

  beforeAll(async () => {
    googleKeys = await rsaKeyPair();
    // A structurally perfect token signed by someone who is not Google.
    otherKeys = await rsaKeyPair();
    publicJwk = await crypto.subtle.exportKey("jwk", googleKeys.publicKey);

    provider = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/certs")
          return Response.json({ keys: [{ ...publicJwk, kid: KID, use: "sig", alg: "RS256" }] });
        if (path === "/token") return Response.json({ access_token: "stub-access-token" });
        if (path === "/userinfo")
          return Response.json({
            sub: "stub-sub",
            email: identity.email,
            email_verified: identity.verified,
            name: identity.name ?? null,
          });
        // GitHub's profile deliberately carries an address that must NOT be
        // trusted — the emails endpoint is the only source the service accepts.
        if (path === "/user")
          return Response.json({ login: "stub", name: identity.name ?? null, email: "spoofed@evil.test" });
        if (path === "/user/emails")
          return Response.json([{ email: identity.email, primary: true, verified: identity.verified }]);
        return new Response("not found", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${provider.port}`;

    oauthApp = await startApp(ROOT, "oauth-app", {
      CORE_API_URL: core.base,
      DASHBOARD_URL: SPA,
      DASHBOARD_GOOGLE_CLIENT_ID: "google-client-id",
      DASHBOARD_GOOGLE_SECRET: "google-secret",
      DASHBOARD_GITHUB_CLIENT_ID: "github-client-id",
      DASHBOARD_GITHUB_SECRET: "github-secret",
      OAUTH_GOOGLE_AUTH_URL: `${base}/authorize/google`,
      OAUTH_GOOGLE_TOKEN_URL: `${base}/token`,
      OAUTH_GOOGLE_USERINFO_URL: `${base}/userinfo`,
      OAUTH_GOOGLE_CERTS_URL: `${base}/certs`,
      OAUTH_GITHUB_AUTH_URL: `${base}/authorize/github`,
      OAUTH_GITHUB_TOKEN_URL: `${base}/token`,
      OAUTH_GITHUB_USER_URL: `${base}/user`,
      OAUTH_GITHUB_EMAILS_URL: `${base}/user/emails`,
    });
    running.push(oauthApp);
  }, 30_000);

  afterAll(() => {
    provider?.stop(true);
  });

  /** Starts a sign-in and returns the state the service minted. */
  async function mintState(which: "google" | "github", on: Service = oauthApp): Promise<string> {
    const res = await fetch(`${on.base}/auth/${which}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location")!).searchParams.get("state")!;
  }

  const callback = (which: "google" | "github", state: string, code = "stub-code") =>
    fetch(`${oauthApp.base}/auth/${which}/callback?code=${code}&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });

  /** Runs a whole sign-in for `email` and returns the callback's redirect. */
  async function signIn(which: "google" | "github", email: string, verified = true) {
    identity = { email, verified };
    return callback(which, await mintState(which));
  }

  const fragment = (res: Response) => new URL(res.headers.get("location")!).hash.slice(1);

  /** This suite's service owns its own SQLite file, separate from `app`'s. */
  const readOauthDb = <T,>(fn: (db: Database) => T): T => readDbOf(oauthApp, fn);

  test("only providers with credentials are advertised", async () => {
    expect(await (await fetch(`${oauthApp.base}/auth/providers`)).json()).toEqual({
      google: true,
      github: true,
    });
    // The default instance has no OAuth env at all — no dead buttons there.
    expect(await (await fetch(`${app.base}/auth/providers`)).json()).toEqual({
      google: false,
      github: false,
    });
    const res = await fetch(`${app.base}/auth/google`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  test("starting a sign-in redirects to the provider with our client id", async () => {
    const res = await fetch(`${oauthApp.base}/auth/google`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/authorize/google");
    expect(location.searchParams.get("client_id")).toBe("google-client-id");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toEndWith("/auth/google/callback");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  test("a completed sign-in returns a working session in the fragment", async () => {
    const email = `oauth-${Date.now()}@test.co`;
    identity = { email, verified: true, name: "Ada" };
    const res = await callback("google", await mintState("google"));

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${SPA}/auth/callback`);

    const token = new URLSearchParams(fragment(res)).get("token")!;
    expect(token).toBeTruthy();
    // The fragment is the only carrier: nothing lands in the query string,
    // which is what proxies and access logs would record.
    expect(location.search).toBe("");

    const me = await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.user).toMatchObject({ email, name: "Ada" });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  test("the callback refuses a forged or missing state", async () => {
    const email = `forged-${Date.now()}@test.co`;
    identity = { email, verified: true };

    for (const state of ["", "not-a-state", `${Date.now()}.abc.def`]) {
      const res = await callback("google", state);
      expect(res.status).toBe(302);
      expect(fragment(res)).toBe("error=invalid_state");
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    }
    // …and no account was created along the way.
    const users = readOauthDb((db) =>
      db.query("SELECT id FROM users WHERE email = ?").all(email),
    );
    expect(users).toHaveLength(0);
  });

  test("a state minted for one provider cannot be replayed at the other", async () => {
    identity = { email: `replay-${Date.now()}@test.co`, verified: true };
    const googleState = await mintState("google");
    const res = await callback("github", googleState);
    expect(fragment(res)).toBe("error=invalid_state");
  });

  test("an unverified email is refused, for both providers", async () => {
    for (const which of ["google", "github"] as const) {
      const email = `unverified-${which}-${Date.now()}@test.co`;
      const res = await signIn(which, email, false);
      expect(fragment(res)).toBe("error=provider_rejected");
      expect(
        readOauthDb((db) => db.query("SELECT id FROM users WHERE email = ?").all(email)),
      ).toHaveLength(0);
    }
  });

  test("GitHub's profile email is ignored in favour of the verified one", async () => {
    const email = `gh-${Date.now()}@test.co`;
    const res = await signIn("github", email);
    const token = new URLSearchParams(fragment(res)).get("token")!;
    const me = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) })).json();
    expect(me.user.email).toBe(email);
    expect(me.user.email).not.toBe("spoofed@evil.test");
  });

  test("signing in twice reuses the account rather than duplicating it", async () => {
    const email = `repeat-${Date.now()}@test.co`;
    const first = await signIn("google", email);
    const second = await signIn("github", email);

    const ids = await Promise.all(
      [first, second].map(async (res) => {
        const token = new URLSearchParams(fragment(res)).get("token")!;
        const body = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) })).json();
        return body.user.id;
      }),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(
      readOauthDb((db) => db.query("SELECT id FROM users WHERE email = ?").all(email)),
    ).toHaveLength(1);
  });

  test("an OAuth account has no password to log in with", async () => {
    const email = `nopass-${Date.now()}@test.co`;
    await signIn("google", email);

    expect(
      readOauthDb(
        (db) => db.query("SELECT password_hash FROM users WHERE email = ?").get(email) as any,
      ).password_hash,
    ).toBeNull();

    // Password login must fail rather than succeed against a NULL hash.
    const res = await fetch(`${oauthApp.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(401);
  });

  test("OAuth links to an existing password account with the same email", async () => {
    const email = `linked-${Date.now()}@test.co`;
    const created = await fetch(`${oauthApp.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const passwordUser = (await created.json()).user;

    const res = await signIn("google", email);
    const token = new URLSearchParams(fragment(res)).get("token")!;
    const me = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) })).json();
    expect(me.user.id).toBe(passwordUser.id);
    // Linking must not cost the account its password.
    const still = await fetch(`${oauthApp.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(still.status).toBe(200);
  });

  test("an OAuth session token is stored hashed, like every other session", async () => {
    const email = `hashed-${Date.now()}@test.co`;
    const res = await signIn("google", email);
    const token = new URLSearchParams(fragment(res)).get("token")!;

    const row = readOauthDb((db) =>
      db.query("SELECT token_hash FROM sessions WHERE token_hash = ?").get(sha256hex(token)),
    );
    expect(row).toBeTruthy();
    expect(
      readOauthDb((db) => db.query("SELECT token_hash FROM sessions WHERE token_hash = ?").get(token)),
    ).toBeNull();
  });

  // ── Google One Tap ───────────────────────────────────────────────
  // Same destination as the redirect flow, different first leg: Google posts a
  // signed ID token to us instead of us exchanging a code. With no `state` and
  // no client secret in play, the token's own claims are the entire proof — so
  // each one gets a test that fails if the check is removed.
  describe("Google One Tap", () => {
    const b64url = (value: string | ArrayBuffer) =>
      Buffer.from(value as any).toString("base64url");

    /** Mints an ID token, defaulting to one this service should accept. */
    async function idToken(
      claims: Record<string, unknown> = {},
      opts: { kid?: string; alg?: string; key?: CryptoKey } = {},
    ): Promise<string> {
      const header = b64url(
        JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" }),
      );
      const payload = b64url(
        JSON.stringify({
          iss: "https://accounts.google.com",
          aud: "google-client-id",
          sub: "google-subject-id",
          exp: Math.floor(Date.now() / 1000) + 300,
          email: `onetap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.co`,
          email_verified: true,
          ...claims,
        }),
      );
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        opts.key ?? googleKeys.privateKey,
        Buffer.from(`${header}.${payload}`),
      );
      return `${header}.${payload}.${b64url(signature)}`;
    }

    const emailOf = (token: string) =>
      JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).email as string;

    /**
     * Posts to the endpoint the way Google does. `csrf` defaults to a matching
     * pair; pass `null` for either half to drop it.
     */
    function oneTap(
      credential: string,
      csrf: { body?: string | null; cookie?: string | null } = {},
      on: Service = oauthApp,
    ) {
      const bodyToken = csrf.body === undefined ? "csrf-value" : csrf.body;
      const cookieToken = csrf.cookie === undefined ? "csrf-value" : csrf.cookie;

      const form = new URLSearchParams({ credential });
      if (bodyToken !== null) form.set("g_csrf_token", bodyToken);
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (cookieToken !== null) headers.cookie = `g_csrf_token=${cookieToken}`;

      return fetch(`${on.base}/auth/google/one-tap`, {
        method: "POST",
        headers,
        body: form,
        redirect: "manual",
      });
    }

    const noAccountFor = (email: string) =>
      expect(
        readOauthDb((db) => db.query("SELECT id FROM users WHERE email = ?").all(email)),
      ).toHaveLength(0);

    test("a valid credential returns a working session in the fragment", async () => {
      const token = await idToken({ name: "Grace" });
      const res = await oneTap(token);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(`${location.origin}${location.pathname}`).toBe(`${SPA}/auth/callback`);
      // Same rule as the redirect flow: the session rides the fragment, never
      // the query string, so it cannot land in a proxy log.
      expect(location.search).toBe("");

      const session = new URLSearchParams(fragment(res)).get("token")!;
      expect(session).toBeTruthy();
      const me = await fetch(`${oauthApp.base}/auth/me`, { headers: as(session) });
      expect(me.status).toBe(200);
      expect((await me.json()).user).toMatchObject({ email: emailOf(token), name: "Grace" });
    });

    test("the CSRF cookie and body value must both be present and match", async () => {
      for (const csrf of [
        { cookie: null }, // host-only cookie never arrived
        { body: null }, // no double-submit value posted
        { body: "posted-value", cookie: "different-value" },
        { body: "", cookie: "" }, // two empties must not count as a match
      ]) {
        const token = await idToken();
        const res = await oneTap(token, csrf);
        expect(res.status).toBe(302);
        expect(fragment(res)).toBe("error=invalid_state");
        expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
        noAccountFor(emailOf(token));
      }
    });

    test("a token signed by anyone but Google is refused", async () => {
      const token = await idToken({}, { key: otherKeys.privateKey });
      expect(fragment(await oneTap(token))).toBe("error=provider_rejected");
      noAccountFor(emailOf(token));
    });

    test("a tampered payload is refused", async () => {
      const token = await idToken();
      const [header, payload, signature] = token.split(".");
      const swapped = b64url(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload, "base64url").toString()),
          email: "attacker@evil.test",
        }),
      );
      const res = await oneTap(`${header}.${swapped}.${signature}`);
      expect(fragment(res)).toBe("error=provider_rejected");
      noAccountFor("attacker@evil.test");
    });

    test("the algorithm is pinned to RS256", async () => {
      // `alg: none` with an empty signature is the classic JWT forgery; so is
      // asking for a symmetric algorithm the verifier might key with the
      // public JWK. Neither may reach the signature check.
      const header = b64url(JSON.stringify({ alg: "none", kid: KID, typ: "JWT" }));
      const payload = b64url(
        JSON.stringify({
          iss: "https://accounts.google.com",
          aud: "google-client-id",
          exp: Math.floor(Date.now() / 1000) + 300,
          email: "alg-none@test.co",
          email_verified: true,
        }),
      );
      expect(fragment(await oneTap(`${header}.${payload}.`))).toBe("error=provider_rejected");

      const hs = await idToken({ email: "alg-hs256@test.co" }, { alg: "HS256" });
      expect(fragment(await oneTap(hs))).toBe("error=provider_rejected");

      noAccountFor("alg-none@test.co");
      noAccountFor("alg-hs256@test.co");
    });

    test("a token minted for another site's client id is refused", async () => {
      // A perfectly valid Google token — just not one issued to us. Without an
      // `aud` check, any site's One Tap credential would sign in here.
      const token = await idToken({ aud: "someone-elses-client-id" });
      expect(fragment(await oneTap(token))).toBe("error=provider_rejected");
      noAccountFor(emailOf(token));
    });

    test("a foreign issuer is refused", async () => {
      const token = await idToken({ iss: "https://accounts.evil.test" });
      expect(fragment(await oneTap(token))).toBe("error=provider_rejected");
      noAccountFor(emailOf(token));
    });

    test("an expired token is refused", async () => {
      const token = await idToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
      expect(fragment(await oneTap(token))).toBe("error=provider_rejected");
      noAccountFor(emailOf(token));
    });

    test("an unverified email is refused, exactly as in the redirect flow", async () => {
      for (const email_verified of [false, "false", undefined]) {
        const token = await idToken({ email_verified });
        expect(fragment(await oneTap(token))).toBe("error=provider_rejected");
        noAccountFor(emailOf(token));
      }
    });

    test("One Tap and the redirect flow land on the same account", async () => {
      const email = `same-account-${Date.now()}@test.co`;
      const first = await signIn("google", email);
      const second = await oneTap(await idToken({ email }));

      const ids = await Promise.all(
        [first, second].map(async (res) => {
          const session = new URLSearchParams(fragment(res)).get("token")!;
          const body = await (
            await fetch(`${oauthApp.base}/auth/me`, { headers: as(session) })
          ).json();
          return body.user.id;
        }),
      );
      expect(ids[0]).toBe(ids[1]);
      expect(
        readOauthDb((db) => db.query("SELECT id FROM users WHERE email = ?").all(email)),
      ).toHaveLength(1);
    });

    test("the endpoint is absent when Google sign-in is not configured", async () => {
      const res = await oneTap(await idToken(), {}, app);
      expect(res.status).toBe(404);
    });
  });
});
