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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ADMIN_SECRET, startApp, startCore, stopServices, waitFor, type Service } from "./helpers.ts";
import {
  ALLOWED_ORIGIN,
  PASSWORD,
  as,
  jsonHeaders,
  loggedResetCode,
  loggedSignupCode,
  readDbOf,
  setAddonOn,
  setPlanOn,
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
  test("a verified signup issues a session and rejects duplicates", async () => {
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

// ── Email verification ─────────────────────────────────────────────

/**
 * Password sign-up, end-to-end against a stub Resend.
 *
 * The mailer is a real HTTP server the service posts to, so what is asserted is
 * what would reach a mailbox: the key, the sender, the address and the code.
 * Each rule the limits rest on is broken here on purpose.
 */
describe("email verification", () => {
  const mail: { from: string; to: string; subject: string; text: string; authorization: string | null }[] = [];
  let mailStatus = 200;
  let mailer: ReturnType<typeof Bun.serve>;
  let mailApp: Service;
  let unconfigured: Service;

  beforeAll(async () => {
    mailer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as any;
        if (mailStatus !== 200)
          return Response.json({ message: "The stubbase.test domain is not verified" }, { status: mailStatus });
        mail.push({ ...body, authorization: req.headers.get("authorization") });
        return Response.json({ id: `email_${mail.length}` });
      },
    });
    [mailApp, unconfigured] = await Promise.all([
      startApp(ROOT, "mail-app", {
        CORE_API_URL: core.base,
        DASHBOARD_EMAIL_LOG_CODES: "",
        DASHBOARD_RESEND_API_KEY: "re_test_key",
        DASHBOARD_EMAIL_FROM: "Stubbase <no-reply@stubbase.test>",
        RESEND_API_URL: `http://127.0.0.1:${mailer.port}/emails`,
      }),
      startApp(ROOT, "no-mail-app", { CORE_API_URL: core.base, DASHBOARD_EMAIL_LOG_CODES: "" }),
    ]);
    running.push(mailApp, unconfigured);
  }, 30_000);

  afterAll(() => mailer.stop(true));

  let n = 0;
  const freshEmail = (tag: string) => `${tag}-${++n}-${Date.now()}@test.co`;
  const post = (route: string, body: unknown, on: Service = mailApp) =>
    fetch(`${on.base}/auth/${route}`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
  const codesTo = (to: string) =>
    mail.filter((m) => m.to === to).map((m) => /\b(\d{6})\b/.exec(m.text)?.[1] ?? "");
  const lastCodeTo = (to: string) => codesTo(to).at(-1) ?? "";
  const begin = async (email: string, password = PASSWORD) => {
    const res = await post("signup", { email, password });
    expect(res.status).toBe(202);
    return (await res.json()).verificationId as string;
  };
  const verify = (verificationId: string, code: string) => post("signup/verify", { verificationId, code });
  const login = (email: string, password = PASSWORD) => post("login", { email, password });
  const otherThan = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  const readMailDb = <T,>(fn: (db: Database) => T): T => readDbOf(mailApp, fn);
  const INVALID = { error: "invalid or expired verification code" };

  test("signup mails a code through Resend and creates no account until it comes back", async () => {
    const email = freshEmail("mailed");
    const res = await post("signup", { email, password: PASSWORD, name: "Ada" });
    expect(res.status).toBe(202);
    const pending = await res.json();
    expect(pending).toEqual({ verificationId: expect.stringMatching(/^[0-9a-f]{32}$/), email, expiresIn: 900 });

    const [sent] = mail.filter((m) => m.to === email);
    expect(sent.authorization).toBe("Bearer re_test_key");
    expect(sent.from).toBe("Stubbase <no-reply@stubbase.test>");
    const code = lastCodeTo(email);
    expect(code).toMatch(/^\d{6}$/);

    // Pending is not an account: nothing to log in to, and the code is not at rest.
    expect(readMailDb((db) => db.query("SELECT 1 FROM users WHERE email = ?").get(email))).toBeNull();
    expect((await login(email)).status).toBe(401);
    const row = readMailDb((db) =>
      db.query("SELECT code_hash, password_hash FROM signup_verifications WHERE email = ?").get(email),
    ) as { code_hash: string; password_hash: string };
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).not.toBe(sha256hex(code));
    expect(row.password_hash).toStartWith("$argon2id$");

    const done = await verify(pending.verificationId, code);
    expect(done.status).toBe(201);
    const { token, user } = await done.json();
    expect(user).toMatchObject({ email, name: "Ada" });
    expect((await fetch(`${mailApp.base}/auth/me`, { headers: as(token) })).status).toBe(200);
    expect((await login(email)).status).toBe(200);

    // Spent, and a taken address is refused without mailing anyone.
    expect(await (await verify(pending.verificationId, code)).json()).toEqual(INVALID);
    expect((await post("signup", { email, password: PASSWORD })).status).toBe(409);
    expect(codesTo(email)).toHaveLength(1);
  }, 20_000);

  test("wrong guesses all read alike, and the fifth locks the code", async () => {
    const email = freshEmail("guess");
    const id = await begin(email);
    const code = lastCodeTo(email);

    expect((await verify("not-an-id", code)).status).toBe(400);
    expect((await verify(id, "12ab56")).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      const wrong = await verify(id, otherThan(code));
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toEqual(INVALID);
    }
    // Locked: even the right code is now just "invalid".
    expect(await (await verify(id, code)).json()).toEqual(INVALID);

    // A new code starts over, and the old one stays dead.
    const resent = await post("signup/resend", { verificationId: id });
    expect(resent.status).toBe(202);
    const fresh = lastCodeTo(email);
    if (fresh !== code) expect((await verify(id, code)).status).toBe(400);
    expect((await verify(id, fresh)).status).toBe(201);
  }, 20_000);

  test("an expired code is refused", async () => {
    const email = freshEmail("expired");
    const id = await begin(email);
    const { Database: WritableDb } = await import("bun:sqlite");
    const db = new WritableDb(join(mailApp.dir, "app.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.query("UPDATE signup_verifications SET code_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
    } finally {
      db.close();
    }
    expect(await (await verify(id, lastCodeTo(email))).json()).toEqual(INVALID);
  }, 20_000);

  test("a code completes only the sign-up it was issued for", async () => {
    // Someone else starts a sign-up with your address and their own password,
    // then you start yours. Their email lands in your inbox too — and must be
    // useless to both of you.
    const email = freshEmail("victim");
    const theirs = await begin(email, "attacker-password");
    const yours = await begin(email);
    const [theirCode, yourCode] = codesTo(email);

    if (theirCode !== yourCode) expect((await verify(yours, theirCode)).status).toBe(400);
    expect((await verify(yours, yourCode)).status).toBe(201);

    // Verifying ended every other pending sign-up for the address.
    expect(await (await verify(theirs, theirCode)).json()).toEqual(INVALID);
    expect((await post("signup/resend", { verificationId: theirs })).status).toBe(404);
    expect((await login(email, "attacker-password")).status).toBe(401);
    expect((await login(email)).status).toBe(200);
  }, 30_000);

  test("an address gets at most five emails an hour, sign-ups and resends together", async () => {
    const email = freshEmail("throttle");
    const id = await begin(email);
    for (let i = 0; i < 4; i++) expect((await post("signup/resend", { verificationId: id })).status).toBe(202);

    expect((await post("signup/resend", { verificationId: id })).status).toBe(429);
    expect((await post("signup", { email, password: PASSWORD })).status).toBe(429);
    expect(codesTo(email)).toHaveLength(5);
  }, 30_000);

  test("Resend refusing the email is a 502 and leaves nothing to verify", async () => {
    const email = freshEmail("bounced");
    mailStatus = 403;
    try {
      expect((await post("signup", { email, password: PASSWORD })).status).toBe(502);
    } finally {
      mailStatus = 200;
    }
    expect(
      readMailDb((db) => db.query("SELECT COUNT(*) AS n FROM signup_verifications WHERE email = ?").get(email)),
    ).toEqual({ n: 0 });
  }, 20_000);

  test("without an email provider, password sign-up is refused rather than let through unverified", async () => {
    const email = freshEmail("nomail");
    expect((await post("signup", { email, password: PASSWORD }, unconfigured)).status).toBe(503);
    expect((await post("signup/resend", { verificationId: "0".repeat(32) }, unconfigured)).status).toBe(503);
    expect(readDbOf(unconfigured, (db) => db.query("SELECT 1 FROM users WHERE email = ?").get(email))).toBeNull();
  }, 20_000);
});

// ── Password reset ─────────────────────────────────────────────────

/**
 * "Forgot password?", end-to-end against a stub Resend. The service does not
 * await the send (so an unknown address answers as fast as a real one), which
 * is why every assertion about mail waits for it to arrive.
 */
describe("password reset", () => {
  const SPA = "http://localhost:5198";
  const RESET_SUBJECT = "Reset your Stubbase password";
  const NEW_PASSWORD = "brand-new-password";
  const INVALID = { error: "invalid or expired reset code" };
  const mail: { to: string; subject: string; text: string; html: string }[] = [];
  let mailer: ReturnType<typeof Bun.serve>;
  let resetApp: Service;
  let unconfigured: Service;

  beforeAll(async () => {
    mailer = Bun.serve({
      port: 0,
      async fetch(req) {
        mail.push((await req.json()) as any);
        return Response.json({ id: `email_${mail.length}` });
      },
    });
    [resetApp, unconfigured] = await Promise.all([
      // Codes are logged (so signupOn can make accounts) and mailed (so resets can be read back).
      startApp(ROOT, "reset-app", {
        CORE_API_URL: core.base,
        DASHBOARD_URL: SPA,
        DASHBOARD_RESEND_API_KEY: "re_test_key",
        RESEND_API_URL: `http://127.0.0.1:${mailer.port}/emails`,
      }),
      startApp(ROOT, "reset-no-mail-app", { CORE_API_URL: core.base, DASHBOARD_EMAIL_LOG_CODES: "" }),
    ]);
    running.push(resetApp, unconfigured);
  }, 30_000);

  afterAll(() => mailer.stop(true));

  const post = (route: string, body: unknown, headers: Record<string, string> = {}, on: Service = resetApp) =>
    fetch(`${on.base}/auth/${route}`, {
      method: "POST",
      headers: { ...jsonHeaders(), ...headers },
      body: JSON.stringify(body),
    });
  const forgot = (email: string, headers?: Record<string, string>) => post("forgot-password", { email }, headers);
  const reset = (email: string, code: string, password = NEW_PASSWORD) =>
    post("reset-password", { email, code, password });
  const login = (email: string, password: string) => post("login", { email, password });
  const me = (token: string) => fetch(`${resetApp.base}/auth/me`, { headers: as(token) });
  const resetMailTo = (to: string) => mail.filter((m) => m.to === to && m.subject === RESET_SUBJECT);
  const otherThan = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  /** Waits for the `n`th reset email to `to` and returns its code. */
  async function nthResetCode(to: string, n: number): Promise<string> {
    await waitFor(() => resetMailTo(to).length >= n);
    const code = /\b(\d{6})\b/.exec(resetMailTo(to)[n - 1]?.text ?? "")?.[1];
    if (!code) throw new Error(`reset email #${n} to ${to} never arrived`);
    return code;
  }

  test("answers the same for every address, and mails a code and link only to a real account", async () => {
    const account = await signupOn(resetApp);
    const ghostEmail = `ghost-${Date.now()}@test.co`;

    const ghost = await forgot(ghostEmail);
    // The link must come from DASHBOARD_URL, whatever host the request claims.
    const real = await forgot(account.email.toUpperCase(), { "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" });
    expect([ghost.status, real.status]).toEqual([202, 202]);
    expect(await real.json()).toEqual(await ghost.json());

    const code = await nthResetCode(account.email, 1);
    const [sent] = resetMailTo(account.email);
    expect(sent.text).toContain(`${SPA}/forgot-password#${new URLSearchParams({ email: account.email, code })}`);
    expect(sent.text + sent.html).not.toContain("evil.test");
    await Bun.sleep(200);
    expect(mail.some((m) => m.to === ghostEmail)).toBe(false);

    // Stored as an HMAC, never the code itself.
    const row = readDbOf(resetApp, (db) =>
      db.query("SELECT code_hash FROM password_resets WHERE user_id = ?").get(account.id),
    ) as { code_hash: string };
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).not.toBe(sha256hex(code));
  }, 20_000);

  test("a correct code sets the new password, ends every session and signs you in", async () => {
    const account = await signupOn(resetApp);
    const otherDevice = (await (await login(account.email, PASSWORD)).json()).token;
    await forgot(account.email);
    const code = await nthResetCode(account.email, 1);

    const done = await reset(account.email, code);
    expect(done.status).toBe(200);
    const { token, user } = await done.json();
    expect(user.email).toBe(account.email);
    expect(user).not.toHaveProperty("password_hash");

    for (const stale of [account.token, otherDevice]) expect((await me(stale)).status).toBe(401);
    expect((await me(token)).status).toBe(200);
    expect((await login(account.email, PASSWORD)).status).toBe(401);
    expect((await login(account.email, NEW_PASSWORD)).status).toBe(200);

    // Spent by its first use.
    expect(await (await reset(account.email, code, "another-password")).json()).toEqual(INVALID);
  }, 20_000);

  test("wrong guesses read alike, a new request replaces the code, and the fifth wrong guess locks it", async () => {
    const account = await signupOn(resetApp);
    await forgot(account.email);
    const first = await nthResetCode(account.email, 1);

    expect((await reset(account.email, "12ab56")).status).toBe(400);
    expect((await reset(account.email, first, "short")).status).toBe(400);
    expect(await (await reset(`ghost-${Date.now()}@test.co`, first)).json()).toEqual(INVALID);

    await forgot(account.email);
    const second = await nthResetCode(account.email, 2);
    let wrong = 0;
    if (first !== second) {
      expect(await (await reset(account.email, first)).json()).toEqual(INVALID); // replaced
      wrong++;
    }
    for (; wrong < 5; wrong++) expect(await (await reset(account.email, otherThan(second))).json()).toEqual(INVALID);
    // Locked: even the right code is now just "invalid", and the password never changed.
    expect(await (await reset(account.email, second)).json()).toEqual(INVALID);
    expect((await login(account.email, PASSWORD)).status).toBe(200);

    await forgot(account.email);
    expect((await reset(account.email, await nthResetCode(account.email, 3))).status).toBe(200);
  }, 30_000);

  test("an expired code is refused", async () => {
    const account = await signupOn(resetApp);
    await forgot(account.email);
    const code = await nthResetCode(account.email, 1);
    const { Database: WritableDb } = await import("bun:sqlite");
    const db = new WritableDb(join(resetApp.dir, "app.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.query("UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(account.id);
    } finally {
      db.close();
    }
    expect(await (await reset(account.email, code)).json()).toEqual(INVALID);
  }, 20_000);

  test("two requests racing with one code: exactly one wins", async () => {
    const account = await signupOn(resetApp);
    await forgot(account.email);
    const code = await nthResetCode(account.email, 1);

    const results = await Promise.all([
      reset(account.email, code, "racer-one-password"),
      reset(account.email, code, "racer-two-password"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  }, 20_000);

  test("an address gets at most five reset emails an hour, throttled without saying so", async () => {
    const account = await signupOn(resetApp);
    for (let i = 0; i < 6; i++) expect((await forgot(account.email)).status).toBe(202);
    await nthResetCode(account.email, 5);
    await Bun.sleep(300);
    expect(resetMailTo(account.email)).toHaveLength(5);
  }, 20_000);

  test("without an email provider, reset is refused rather than silently doing nothing", async () => {
    const res = await post("forgot-password", { email: `anyone-${Date.now()}@test.co` }, {}, unconfigured);
    expect(res.status).toBe(503);
  }, 20_000);
});

// ── Change password ────────────────────────────────────────────────

/** "Change password" in the account menu: signed in, with the current password. */
describe("change password", () => {
  const NEW_PASSWORD = "a-brand-new-password";
  const change = (token: string | null, body: unknown) =>
    fetch(`${app.base}/auth/change-password`, {
      method: "POST",
      headers: jsonHeaders(token ?? undefined),
      body: JSON.stringify(body),
    });
  const login = (email: string, password: string) =>
    fetch(`${app.base}/auth/login`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ email, password }) });
  const me = (token: string) => fetch(`${app.base}/auth/me`, { headers: as(token) });
  const tokenFrom = async (res: Response) => (await res.json()).token as string;

  test("needs a session, and /auth/me says the account has a password", async () => {
    expect((await change(null, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
    const account = await signup();
    expect((await (await me(account.token)).json()).user.hasPassword).toBe(true);
  }, 20_000);

  test("the right current password changes it, keeps this session and ends every other one", async () => {
    const account = await signup();
    const otherDevice = await tokenFrom(await login(account.email, PASSWORD));

    const res = await change(account.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ email: account.email, hasPassword: true });

    expect((await me(account.token)).status).toBe(200);
    expect((await me(otherDevice)).status).toBe(401);
    expect((await login(account.email, PASSWORD)).status).toBe(401);
    expect((await login(account.email, NEW_PASSWORD)).status).toBe(200);
  }, 20_000);

  test("a wrong current password changes nothing and signs nobody out", async () => {
    const account = await signup();
    const otherDevice = await tokenFrom(await login(account.email, PASSWORD));

    const res = await change(account.token, { currentPassword: "not-my-password", newPassword: NEW_PASSWORD });
    expect(res.status).toBe(403);
    expect((await login(account.email, PASSWORD)).status).toBe(200);
    expect((await login(account.email, NEW_PASSWORD)).status).toBe(401);
    expect((await me(otherDevice)).status).toBe(200);
  }, 20_000);

  test("refuses a missing current password, and a short or unchanged new one", async () => {
    const account = await signup();
    for (const body of [
      { newPassword: NEW_PASSWORD },
      { currentPassword: PASSWORD, newPassword: "short" },
      { currentPassword: PASSWORD },
      { currentPassword: PASSWORD, newPassword: PASSWORD },
    ])
      expect((await change(account.token, body)).status).toBe(400);
    expect((await login(account.email, PASSWORD)).status).toBe(200);
  }, 20_000);

  test("a reset code requested before the change cannot undo it", async () => {
    const account = await signup();
    await fetch(`${app.base}/auth/forgot-password`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email }),
    });
    const code = await loggedResetCode(app, account.email);

    expect((await change(account.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    const reset = await fetch(`${app.base}/auth/reset-password`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email, code, password: "someone-elses-password" }),
    });
    expect(await reset.json()).toEqual({ error: "invalid or expired reset code" });
    expect((await login(account.email, NEW_PASSWORD)).status).toBe(200);
  }, 20_000);

  test("two changes racing from the same current password: exactly one wins", async () => {
    const account = await signup();
    const [one, two] = await Promise.all([
      change(account.token, { currentPassword: PASSWORD, newPassword: "racer-one-password" }),
      change(account.token, { currentPassword: PASSWORD, newPassword: "racer-two-password" }),
    ]);
    expect([one.status, two.status].filter((s) => s === 200)).toHaveLength(1);

    const [winner, loser] = one.status === 200
      ? ["racer-one-password", "racer-two-password"]
      : ["racer-two-password", "racer-one-password"];
    expect((await login(account.email, winner)).status).toBe(200);
    expect((await login(account.email, loser)).status).toBe(401);
  }, 20_000);
});

// ── Account settings ───────────────────────────────────────────────

describe("account settings", () => {
  interface SessionView {
    id: string;
    userAgent: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
    current: boolean;
  }
  const loginToken = async (email: string, userAgent?: string, on: Service = app) => {
    const res = await fetch(`${on.base}/auth/login`, {
      method: "POST",
      headers: { ...jsonHeaders(), ...(userAgent ? { "user-agent": userAgent } : {}) },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).token as string;
  };
  const me = (token: string, on: Service = app) => fetch(`${on.base}/auth/me`, { headers: as(token) });
  const sessions = async (token: string, on: Service = app): Promise<SessionView[]> => {
    const res = await fetch(`${on.base}/auth/sessions`, { headers: as(token) });
    expect(res.status).toBe(200);
    return (await res.json()).sessions;
  };
  const end = (token: string, id: string) =>
    fetch(`${app.base}/auth/sessions/${id}`, { method: "DELETE", headers: as(token) });
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1";

  test("every account route needs a session", async () => {
    const routes: [string, string][] = [
      ["PATCH", "/auth/me"],
      ["GET", "/auth/account"],
      ["POST", "/auth/delete-account"],
      ["GET", "/auth/sessions"],
      ["DELETE", "/auth/sessions/others"],
      ["DELETE", `/auth/sessions/${"a".repeat(32)}`],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${app.base}${path}`, {
        method,
        headers: jsonHeaders(),
        body: method === "PATCH" || method === "POST" ? "{}" : undefined,
      });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
  });

  test("renaming trims the name, an empty one clears it, and a long one is refused", async () => {
    const account = await signup();
    const rename = (name: unknown) =>
      fetch(`${app.base}/auth/me`, {
        method: "PATCH",
        headers: jsonHeaders(account.token),
        body: JSON.stringify({ name }),
      });

    const res = await rename("  Ada Lovelace  ");
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ name: "Ada Lovelace", email: account.email });
    expect((await (await me(account.token)).json()).user.name).toBe("Ada Lovelace");

    expect((await (await rename("   ")).json()).user.name).toBeNull();
    expect((await rename("x".repeat(101))).status).toBe(400);
    expect((await rename(42)).status).toBe(400);
    expect((await (await me(account.token)).json()).user.name).toBeNull();
  }, 20_000);

  test("sessions list this account's devices, this one marked, and never a token or its hash", async () => {
    const account = await signup();
    const phone = await loginToken(account.email, IPHONE);
    const stranger = await signup();

    const list = await sessions(account.token);
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.current)).toEqual([true, false]);
    expect(list[1].userAgent).toBe(IPHONE);
    for (const s of list) {
      expect(s.id).toMatch(/^[0-9a-f]{32}$/);
      for (const at of [s.createdAt, s.lastUsedAt!, s.expiresAt]) expect(at).toMatch(/Z$/);
      expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.now());
    }
    const shown = JSON.stringify(list);
    for (const secret of [account.token, phone, sha256hex(account.token), sha256hex(phone)])
      expect(shown).not.toContain(secret);

    // Seen from the phone, the phone is the current one.
    expect((await sessions(phone)).find((s) => s.current)!.userAgent).toBe(IPHONE);
    // And nothing of another account's is in anyone's list.
    const theirs = (await sessions(stranger.token)).map((s) => s.id);
    expect(list.some((s) => theirs.includes(s.id))).toBe(false);
  }, 20_000);

  test("signing one device out ends it at once and leaves the others", async () => {
    const account = await signup();
    const laptop = await loginToken(account.email);
    const phone = await loginToken(account.email, IPHONE);
    const phoneId = (await sessions(phone)).find((s) => s.current)!.id;

    expect((await end(account.token, phoneId)).status).toBe(200);
    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(200);
    expect((await me(account.token)).status).toBe(200);
    expect((await end(account.token, phoneId)).status).toBe(404);
    expect((await end(account.token, "not-a-session-id")).status).toBe(404);
  }, 20_000);

  test("another account's session id ends nothing", async () => {
    const victim = await signup();
    const attacker = await signup();
    const victimSession = (await sessions(victim.token))[0].id;

    expect((await end(attacker.token, victimSession)).status).toBe(404);
    expect((await me(victim.token)).status).toBe(200);
  }, 20_000);

  test("signing out every other device keeps this one", async () => {
    const account = await signup();
    const others = [await loginToken(account.email), await loginToken(account.email, IPHONE)];

    const res = await fetch(`${app.base}/auth/sessions/others`, { method: "DELETE", headers: as(account.token) });
    expect(await res.json()).toEqual({ ok: true, ended: 2 });
    for (const token of others) expect((await me(token)).status).toBe(401);
    expect((await me(account.token)).status).toBe(200);
    expect((await sessions(account.token)).map((s) => s.current)).toEqual([true]);
  }, 20_000);

  test("a session from before the device columns existed is listed, and can be ended", async () => {
    // A database as the service left it before sessions had ids: the migration
    // must give the old row one rather than leave it unlistable or unendable.
    const dir = join(ROOT, "legacy-app");
    await mkdir(dir, { recursive: true });
    const token = "a".repeat(64);
    const legacy = new Database(join(dir, "app.sqlite"), { create: true });
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, password_hash TEXT,
        oauth_provider TEXT, plan TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL
      );
    `);
    legacy.query("INSERT INTO users (id, email) VALUES (1, 'legacy@test.co')").run();
    legacy.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, datetime('now', '+1 day'))").run(sha256hex(token));
    legacy.close();

    const legacyApp = await startApp(ROOT, "legacy-app", { CORE_API_URL: core.base });
    running.push(legacyApp);

    const [old] = await sessions(token, legacyApp);
    expect(old).toMatchObject({ current: true, userAgent: null });
    expect(old.id).toMatch(/^[0-9a-f]{32}$/);
    const res = await fetch(`${legacyApp.base}/auth/sessions/${old.id}`, { method: "DELETE", headers: as(token) });
    expect(res.status).toBe(200);
    expect((await me(token, legacyApp)).status).toBe(401);
  }, 30_000);
});

// ── Delete account ─────────────────────────────────────────────────

describe("delete account", () => {
  const remove = (token: string, password?: string) =>
    fetch(`${app.base}/auth/delete-account`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ password }),
    });
  const login = (email: string, password = PASSWORD) =>
    fetch(`${app.base}/auth/login`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ email, password }) });
  const me = (token: string) => fetch(`${app.base}/auth/me`, { headers: as(token) });

  test("a wrong or missing password deletes nothing", async () => {
    const account = await signup();
    expect((await remove(account.token, "not-my-password")).status).toBe(403);
    expect((await remove(account.token)).status).toBe(400);
    expect((await me(account.token)).status).toBe(200);
    expect((await login(account.email)).status).toBe(200);
  }, 20_000);

  test("the password deletes it: every session ends, and nothing is left to sign in with", async () => {
    const account = await signup();
    const otherDevice = (await (await login(account.email)).json()).token as string;
    await fetch(`${app.base}/auth/me`, {
      method: "PATCH",
      headers: jsonHeaders(account.token),
      body: JSON.stringify({ name: "Soon Gone" }),
    });

    expect(await (await remove(account.token, PASSWORD)).json()).toEqual({ ok: true });
    for (const token of [account.token, otherDevice]) expect((await me(token)).status).toBe(401);
    expect((await login(account.email)).status).toBe(401);

    const row = readDb((db) =>
      db.query("SELECT email, name, password_hash, deleted_at FROM users WHERE id = ?").get(account.id),
    ) as { email: string; name: string | null; password_hash: string | null; deleted_at: string | null };
    expect(row.email).not.toContain(account.email);
    expect(row).toMatchObject({ name: null, password_hash: null });
    expect(row.deleted_at).toBeString();
    expect(readDb((db) => db.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(account.id))).toEqual({ n: 0 });
  }, 20_000);

  test("the address is free to sign up again, and the next account never inherits the old id", async () => {
    const deleted = await signup();
    expect((await remove(deleted.token, PASSWORD)).status).toBe(200);

    // The deleted account was the newest, so a row actually deleted would hand
    // its id straight to this one — and with it that id's usage history.
    const next = await signup();
    expect(next.id).toBeGreaterThan(deleted.id);

    const again = await fetch(`${app.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: deleted.email, password: PASSWORD }),
    });
    expect(again.status).toBe(202);
  }, 20_000);

  test("refused while the account owns a project", async () => {
    const account = await signup();
    const created = await fetch(`${app.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(account.token),
      body: JSON.stringify({ name: "Still Here" }),
    });
    expect(created.status).toBe(201);
    const { tenantId } = await created.json();

    const refused = await remove(account.token, PASSWORD);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("1 project");
    expect((await me(account.token)).status).toBe(200);

    // A new project starts stopped, so it can go straight away — and then the account can.
    const gone = await fetch(`${app.base}/projects/${tenantId}`, { method: "DELETE", headers: as(account.token) });
    expect(gone.status).toBe(200);
    expect((await remove(account.token, PASSWORD)).status).toBe(200);
  }, 30_000);

  test("two deletions racing: exactly one wins", async () => {
    const account = await signup();
    const results = await Promise.all([remove(account.token, PASSWORD), remove(account.token, PASSWORD)]);
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
  }, 20_000);

  // ── Coming back ──
  //
  // The reason the row is kept: an address that signs up again lands on its
  // original id, so the month's requests are still charged to it and deleting
  // the account is not a way to start the allowance over.

  /** Report usage for a tenant the way the core's flush does. */
  const reportUsage = async (tenantId: string, requests: number) => {
    const res = await fetch(`${app.base}/_internal/usage`, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({
        rows: [{ tenantId, date: new Date().toISOString().slice(0, 10), requests, bytes: requests }],
      }),
    });
    expect(res.status).toBe(200);
  };
  const requestsUsed = async (token: string) =>
    (
      (await (await fetch(`${app.base}/auth/account`, { headers: as(token) })).json()) as {
        account: { requestsUsed: number };
      }
    ).account.requestsUsed;

  test("signing up again with the address comes back on the same id, and the month's usage with it", async () => {
    const account = await signup();
    const created = await fetch(`${app.base}/projects`, {
      method: "POST",
      headers: jsonHeaders(account.token),
      body: JSON.stringify({ name: "Spent Some" }),
    });
    expect(created.status).toBe(201);
    const { tenantId } = await created.json();
    await reportUsage(tenantId, 137);
    expect(await requestsUsed(account.token)).toBe(137);

    expect((await fetch(`${app.base}/projects/${tenantId}`, { method: "DELETE", headers: as(account.token) })).status).toBe(200);
    expect((await remove(account.token, PASSWORD)).status).toBe(200);

    const back = await signupOn(app, account.email);
    expect(back.id).toBe(account.id);
    // The whole point: the allowance continues where it left off. The project
    // that spent it is gone, which is exactly the case api_usage.user_id exists
    // for — the count cannot be rebuilt by joining through projects.
    expect(await requestsUsed(back.token)).toBe(137);
  }, 30_000);

  test("nothing but the id and the usage comes back: not the plan, the add-ons or the name", async () => {
    const account = await signup();
    await fetch(`${app.base}/auth/me`, {
      method: "PATCH",
      headers: jsonHeaders(account.token),
      body: JSON.stringify({ name: "Old Name" }),
    });
    setPlanOn(app, account.email, "pro_ai");
    setAddonOn(app, account.email, "requests_100k", 3);
    expect((await remove(account.token, PASSWORD)).status).toBe(200);

    const back = await signupOn(app, account.email);
    expect(back.id).toBe(account.id);
    const me = (await (await fetch(`${app.base}/auth/me`, { headers: as(back.token) })).json()) as {
      user: { planName: string; name: string | null; monthlyRequests: number };
    };
    expect(me.user.planName).toBe("Free");
    expect(me.user.name).toBeNull();
    expect(me.user.monthlyRequests).toBe(5_000); // Free, with no add-ons on top
    expect(readDb((db) => db.query("SELECT COUNT(*) AS n FROM account_addons WHERE user_id = ?").get(account.id))).toEqual({ n: 0 });
  }, 30_000);

  test("the deleted row keeps no readable trace of the address", async () => {
    const account = await signup();
    expect((await remove(account.token, PASSWORD)).status).toBe(200);
    const row = readDb((db) =>
      db.query("SELECT * FROM users WHERE id = ?").get(account.id),
    ) as Record<string, unknown>;
    for (const value of Object.values(row))
      if (typeof value === "string") expect(value).not.toContain(account.email);
  }, 20_000);

  test("a second account for the address, once revived, is refused as normal", async () => {
    const account = await signup();
    expect((await remove(account.token, PASSWORD)).status).toBe(200);
    const back = await signupOn(app, account.email);
    expect(back.id).toBe(account.id);

    // The lineage is spent: the address is live again, so this is an ordinary
    // duplicate, refused where any duplicate is, and revives nothing a second time.
    const again = await fetch(`${app.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: account.email, password: PASSWORD }),
    });
    expect(again.status).toBe(409);
    expect(
      readDb((db) => db.query("SELECT deleted_at, deleted_email_hash FROM users WHERE id = ?").get(account.id)),
    ).toEqual({ deleted_at: null, deleted_email_hash: null });
  }, 30_000);
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
// ── Disposable email domains ───────────────────────────────────────

/**
 * Throwaway addresses refused at sign-up, from the vendored
 * blocked-email-domains.txt. Black-box: the domains used here are real
 * entries in that file, so a refresh that dropped mailinator would show up.
 */
describe("disposable email domains", () => {
  let strict: Service;
  let relaxed: Service;
  let off: Service;

  beforeAll(async () => {
    strict = await startApp(ROOT, "disposable-strict", {
      CORE_API_URL: core.base,
      // A domain the vendored file does not list, blocked by configuration alone.
      DASHBOARD_EMAIL_DOMAIN_BLOCKLIST: "corp-throwaway.test, @spaced.test",
    });
    relaxed = await startApp(ROOT, "disposable-relaxed", {
      CORE_API_URL: core.base,
      // The escape hatch: the same domain the file blocks, let through.
      DASHBOARD_EMAIL_DOMAIN_ALLOWLIST: "mailinator.com",
      DASHBOARD_EMAIL_DOMAIN_BLOCKLIST: "mailinator.com",
    });
    off = await startApp(ROOT, "disposable-off", {
      CORE_API_URL: core.base,
      DASHBOARD_BLOCK_DISPOSABLE_EMAIL: "false",
      DASHBOARD_EMAIL_DOMAIN_BLOCKLIST: "corp-throwaway.test",
    });
    running.push(strict, relaxed, off);
  }, 30_000);

  const start = (on: Service, email: string) =>
    fetch(`${on.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });

  test("a throwaway address is refused, and nothing is written or emailed", async () => {
    for (const email of ["someone@mailinator.com", "someone@yopmail.com", "someone@guerrillamail.com"]) {
      const res = await start(strict, email);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("permanent address");
      expect(
        readDbOf(strict, (db) => db.query("SELECT id FROM signup_verifications WHERE email = ?").all(email)),
      ).toHaveLength(0);
      // The hourly send budget must not be spent by a refusal either.
      expect(
        readDbOf(strict, (db) => db.query("SELECT email FROM signup_email_sends WHERE email = ?").all(email)),
      ).toHaveLength(0);
    }
  }, 30_000);

  test("a subdomain of a listed domain is refused too", async () => {
    const res = await start(strict, "someone@inbox.mailinator.com");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("permanent address");
  }, 20_000);

  test("an ordinary address still signs up, whatever its case or spacing", async () => {
    const account = await signupOn(strict, `Fine-${Date.now()}@Example-Corp.test`.toLowerCase());
    expect(account.id).toBeNumber();
    const res = await start(strict, `  Mixed-${Date.now()}@Example-Corp.test  `);
    expect(res.status).toBe(202);
  }, 30_000);

  test("DASHBOARD_EMAIL_DOMAIN_BLOCKLIST blocks a domain the file never listed", async () => {
    for (const email of ["someone@corp-throwaway.test", "someone@spaced.test", "someone@sub.corp-throwaway.test"]) {
      const res = await start(strict, email);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("permanent address");
    }
    // …and only on the service configured for it.
    expect((await start(off, `fine-${Date.now()}@corp-throwaway.test`)).status).toBe(202);
  }, 30_000);

  test("DASHBOARD_EMAIL_DOMAIN_ALLOWLIST wins over both lists", async () => {
    // mailinator.com is in the vendored file *and* in this service's extra
    // block-list, and the allow-list still lets it through: the hatch has to
    // work no matter why a domain was blocked.
    expect((await start(relaxed, `let-me-in-${Date.now()}@mailinator.com`)).status).toBe(202);
    // …and it reaches subdomains the way blocking one does, or unblocking a
    // provider would let its customers in only at the bare domain.
    expect((await start(relaxed, `sub-${Date.now()}@inbox.mailinator.com`)).status).toBe(202);
    // A different throwaway domain is still refused, so the hatch is not a switch.
    expect((await start(relaxed, "someone@yopmail.com")).status).toBe(400);
  }, 30_000);

  test("DASHBOARD_BLOCK_DISPOSABLE_EMAIL=false turns the whole thing off", async () => {
    expect((await start(off, `throwaway-${Date.now()}@mailinator.com`)).status).toBe(202);
    // Nothing was loaded, so the table stays empty rather than being consulted.
    expect(readDbOf(off, (db) => db.query("SELECT COUNT(*) AS n FROM blocked_email_domains").get())).toEqual({ n: 0 });
  }, 20_000);

  test("the list is loaded once and reused: a second boot on the same database does not reload", async () => {
    const rows = () =>
      (readDbOf(strict, (db) => db.query("SELECT COUNT(*) AS n FROM blocked_email_domains").get()) as { n: number }).n;
    expect(rows()).toBeGreaterThan(50_000);
    const fingerprint = readDbOf(strict, (db) =>
      db.query("SELECT value FROM app_meta WHERE key = 'blocked_email_domains'").get(),
    ) as { value: string };
    expect(fingerprint.value).toMatch(/^[0-9a-f]{64}$/);

    const again = await startApp(ROOT, "disposable-again", {
      CORE_API_URL: core.base,
      DB_PATH: join(strict.dir, "app.sqlite"),
    });
    running.push(again);
    expect(again.output.join("")).not.toContain("disposable email domains");
    expect((await start(again, "someone@mailinator.com")).status).toBe(400);
  }, 30_000);

  test("a refreshed list is picked up on the next boot, with no migration to write", async () => {
    // A database of its own: this rewrites the loaded state, and the other
    // services here are answering sign-ups from the same table.
    const first = await startApp(ROOT, `disposable-reload-${Date.now()}`, { CORE_API_URL: core.base });
    running.push(first);
    const dbPath = join(first.dir, "app.sqlite");
    expect((await start(first, "someone@mailinator.com")).status).toBe(400);

    // What vendoring a new file looks like from the database's side: the rows
    // are whatever the last one held, and the fingerprint no longer matches.
    const handle = new Database(dbPath);
    handle.exec("PRAGMA busy_timeout = 5000;");
    handle.query("DELETE FROM blocked_email_domains").run();
    handle.query("UPDATE app_meta SET value = 'a-previous-list' WHERE key = 'blocked_email_domains'").run();
    handle.close();

    const rebooted = await startApp(ROOT, `disposable-reloaded-${Date.now()}`, {
      CORE_API_URL: core.base,
      DB_PATH: dbPath,
    });
    running.push(rebooted);
    expect(rebooted.output.join("")).toContain("disposable email domains");
    expect((await start(rebooted, "someone@mailinator.com")).status).toBe(400);
    // Read through `first`, which is the service whose directory holds the
    // database both of them are using.
    const { n } = readDbOf(first, (db) =>
      db.query("SELECT COUNT(*) AS n FROM blocked_email_domains").get(),
    ) as { n: number };
    expect(n).toBeGreaterThan(50_000);
    // The fingerprint was replaced, not appended to, so the next boot is quiet again.
    expect(
      readDbOf(first, (db) => db.query("SELECT COUNT(*) AS n FROM app_meta").get()),
    ).toEqual({ n: 1 });
  }, 30_000);
});

describe("OAuth sign-in", () => {
  let provider: ReturnType<typeof Bun.serve> | undefined;
  let oauthApp: Service;
  let providerBase = "";
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
    providerBase = `http://127.0.0.1:${provider.port}`;
    const base = providerBase;

    oauthApp = await startApp(ROOT, "oauth-app", {
      CORE_API_URL: core.base,
      DASHBOARD_URL: SPA,
      // A domain the vendored file does not list, so the disposable-email
      // tests below can block one without depending on the file's contents.
      DASHBOARD_EMAIL_DOMAIN_BLOCKLIST: "legacy-throwaway.test",
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
    const passwordUser = await signupOn(oauthApp, email);

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

  test("OAuth never inherits a password from a sign-up nobody verified", async () => {
    // The pre-hijack: someone registers your address with their password, you
    // later sign in with Google, and the link-by-email join lands you in an
    // account they can still log in to. A pending sign-up is not an account, so
    // the OAuth sign-in creates a fresh one and the stale code cannot finish.
    const email = `prehijack-${Date.now()}@test.co`;
    const started = await fetch(`${oauthApp.base}/auth/signup`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: "attacker-password" }),
    });
    expect(started.status).toBe(202);
    const { verificationId } = await started.json();

    const res = await signIn("google", email);
    expect(new URLSearchParams(fragment(res)).get("token")).toBeString();
    expect(
      readOauthDb(
        (db) => db.query("SELECT password_hash FROM users WHERE email = ?").get(email) as any,
      ).password_hash,
    ).toBeNull();

    const finished = await fetch(`${oauthApp.base}/auth/signup/verify`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ verificationId, code: await loggedSignupCode(oauthApp, email) }),
    });
    expect(finished.status).toBe(409);
    const login = await fetch(`${oauthApp.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: "attacker-password" }),
    });
    expect(login.status).toBe(401);
  }, 20_000);

  test("an OAuth account has no password to change, and is told to use an emailed code", async () => {
    const email = `nopassword-${Date.now()}@test.co`;
    const token = new URLSearchParams(fragment(await signIn("google", email))).get("token")!;

    const me = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) })).json();
    expect(me.user.hasPassword).toBe(false);

    const res = await fetch(`${oauthApp.base}/auth/change-password`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ currentPassword: "anything-at-all", newPassword: PASSWORD }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("code sent to your email");
  }, 20_000);

  test("an OAuth account has no password to delete with, and is told to set one first", async () => {
    const email = `nodelete-${Date.now()}@test.co`;
    const token = new URLSearchParams(fragment(await signIn("github", email))).get("token")!;

    const res = await fetch(`${oauthApp.base}/auth/delete-account`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ password: "anything-at-all" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("set one");
    expect((await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) })).status).toBe(200);
  }, 20_000);

  // The other caller of createOrReviveUser. A deleted address that comes back
  // through Google or GitHub has to land on its own row exactly as one coming
  // back through a password sign-up does, or the allowance resets for anyone
  // who signs in with a provider.

  /** Sign in with a provider and read back whose account it was. */
  const signedInAs = async (which: "google" | "github", email: string) => {
    const token = new URLSearchParams(fragment(await signIn(which, email))).get("token")!;
    const body = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(token) })).json();
    return { token, id: body.user.id as number, user: body.user as Record<string, unknown> };
  };

  test("OAuth brings a deleted address back to its own account, not a new one", async () => {
    // Deleting needs a password, so the account starts as a password sign-up —
    // which is also the case that matters: the address is verified either way,
    // and the link-by-email join must see the dormant row.
    const email = `oauth-revive-${Date.now()}@test.co`;
    const original = await signupOn(oauthApp, email);
    const deleted = await fetch(`${oauthApp.base}/auth/delete-account`, {
      method: "POST",
      headers: jsonHeaders(original.token),
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(deleted.status).toBe(200);

    const back = await signedInAs("google", email);
    expect(back.id).toBe(original.id);
    // Revived, not duplicated: one row for the address, and it is that one.
    expect(readOauthDb((db) => db.query("SELECT id FROM users WHERE email = ?").all(email))).toEqual([
      { id: original.id },
    ]);
    // The credential is the one that just proved the mailbox, so the deleted
    // account's password must not be waiting on the revived row.
    expect(back.user.hasPassword).toBe(false);
    const oldPassword = await fetch(`${oauthApp.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(oldPassword.status).toBe(401);
  }, 30_000);

  test("a lineage never forks: delete and come back twice, always the same account", async () => {
    const email = `oauth-relapse-${Date.now()}@test.co`;
    const original = await signupOn(oauthApp, email);
    const remove = async (token: string) =>
      (
        await fetch(`${oauthApp.base}/auth/delete-account`, {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify({ password: PASSWORD }),
        })
      ).status;
    expect(await remove(original.token)).toBe(200);

    // Back by OAuth, which leaves no password — so the second deletion needs
    // one set first, by the emailed reset code, the way the settings page does it.
    const first = await signedInAs("github", email);
    expect(first.id).toBe(original.id);
    await fetch(`${oauthApp.base}/auth/forgot-password`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email }),
    });
    const reset = await fetch(`${oauthApp.base}/auth/reset-password`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, code: await loggedResetCode(oauthApp, email), password: PASSWORD }),
    });
    expect(reset.status).toBe(200);

    const token = (await (await fetch(`${oauthApp.base}/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    })).json()).token as string;
    expect(await remove(token)).toBe(200);

    const second = await signedInAs("google", email);
    expect(second.id).toBe(original.id);
    // One dormant row was set and reused each time, never a second one.
    expect(
      readOauthDb((db) =>
        db.query("SELECT COUNT(*) AS n FROM users WHERE deleted_email_hash IS NOT NULL AND id = ?").get(original.id),
      ),
    ).toEqual({ n: 0 });
  }, 30_000);

  // ── Disposable addresses ──
  //
  // GitHub will verify a throwaway address quite happily, so the provider leg
  // is the hole the sign-up check alone leaves open. The refusal is on account
  // creation only: someone who already has an account keeps signing in.

  test("a throwaway address cannot open an account through a provider", async () => {
    for (const which of ["google", "github"] as const) {
      const email = `oauth-throwaway-${which}-${Date.now()}@mailinator.com`;
      const res = await signIn(which, email);
      expect(fragment(res)).toBe("error=disposable_email");
      // Bounced to the login page, where the SPA reads the reason.
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      expect(readOauthDb((db) => db.query("SELECT id FROM users WHERE email = ?").all(email))).toHaveLength(0);
    }
  }, 30_000);

  test("an account that already exists signs in whatever its domain", async () => {
    // The account has to be made while the domain is allowed, which is what a
    // customer signed up before their provider was added to the list looks
    // like. A second service on the same database is how that is arranged.
    const email = `grandfathered-${Date.now()}@legacy-throwaway.test`;
    const openApp = await startApp(ROOT, `oauth-open-${Date.now()}`, {
      CORE_API_URL: core.base,
      DB_PATH: join(oauthApp.dir, "app.sqlite"),
      DASHBOARD_BLOCK_DISPOSABLE_EMAIL: "false",
    });
    running.push(openApp);
    const existing = await signupOn(openApp, email);

    // oauthApp blocks that domain, and must still let the account in.
    const res = await signIn("google", email);
    const token = new URLSearchParams(fragment(res)).get("token");
    expect(token).toBeString();
    const me = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(token!) })).json();
    expect(me.user.id).toBe(existing.id);

    // A *new* account on that same domain is still refused, so the exemption
    // is the existing row and not the domain.
    const fresh = await signIn("github", `newcomer-${Date.now()}@legacy-throwaway.test`);
    expect(fragment(fresh)).toBe("error=disposable_email");
  }, 30_000);

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

    test("a throwaway address cannot open an account through One Tap either", async () => {
      // The third door into signInWithIdentity, and the one easiest to forget:
      // it skips the redirect flow entirely. The refusal has to come from the
      // shared helper, or One Tap quietly becomes the way around the list.
      const email = `onetap-throwaway-${Date.now()}@mailinator.com`;
      const res = await oneTap(await idToken({ email }));
      expect(res.status).toBe(302);
      expect(fragment(res)).toBe("error=disposable_email");
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      noAccountFor(email);
    });

    test("One Tap lets an existing account in whatever its domain", async () => {
      const email = `onetap-grandfathered-${Date.now()}@legacy-throwaway.test`;
      const openApp = await startApp(ROOT, `onetap-open-${Date.now()}`, {
        CORE_API_URL: core.base,
        DB_PATH: join(oauthApp.dir, "app.sqlite"),
        DASHBOARD_BLOCK_DISPOSABLE_EMAIL: "false",
      });
      running.push(openApp);
      const existing = await signupOn(openApp, email);

      const res = await oneTap(await idToken({ email }));
      const session = new URLSearchParams(fragment(res)).get("token");
      expect(session).toBeString();
      const me = await (await fetch(`${oauthApp.base}/auth/me`, { headers: as(session!) })).json();
      expect(me.user.id).toBe(existing.id);
    }, 30_000);

    test("the endpoint is absent when Google sign-in is not configured", async () => {
      const res = await oneTap(await idToken(), {}, app);
      expect(res.status).toBe(404);
    });
  });
});
