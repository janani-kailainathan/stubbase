/**
 * The identity table and what may be done with it.
 *
 * `system/users.json`, `system/signups.json`, `system/reset-password.json` and
 * `system/sessions.json` are the auth feature's own files. They are never mounted as CRUD resources
 * and never reach the SQL projection, so the only ways out of the server are
 * the auth routes (through `safeUser`) and the dashboard's read-only system
 * view (through `viewSystemFile`). A project can still have a
 * `data/users.json`: that is an ordinary resource and has nothing to do with
 * sign-in.
 */
import { json } from "../../lib/http.ts";
import type { Jwt } from "./jwt.ts";
import { closeUserSessions, openSession } from "./sessions.ts";
import type { AuthHost, AuthTenant, Claims, Identity, ResetEntry, SessionEntry, SignupEntry, UserRecord } from "./types.ts";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LEN = 8;
export const PASSWORD_RULE = `password must be at least ${MIN_PASSWORD_LEN} characters`;
// Same OWASP argon2id baseline as the dashboard API — 19 MiB transient per
// hash keeps concurrent signups affordable on the one shared box.
export const ARGON = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
// Verified against when a login email is unknown, so response time can't enumerate users.
export const DUMMY_HASH = await Bun.password.hash("stubbase.invalid", ARGON);

/** A parsed JSON request body; anything that was not an object reads as empty. */
export type Fields = Record<string, unknown>;

/** Everything one auth request needs, built once by the router. */
export interface AuthContext<T extends AuthTenant> {
  req: Request;
  tenantId: string;
  tenant: T;
  host: AuthHost<T>;
  jwt: Jwt;
  /** The request's bearer token, verified and still honoured — or null. */
  authenticate(): Claims | null;
}

export const safeUser = (u: UserRecord) => {
  const { passwordHash: _ph, ...rest } = u;
  return rest;
};

export const findByEmail = (identity: Identity, email: string) =>
  identity.users.find((u) => typeof u.email === "string" && u.email.toLowerCase() === email.toLowerCase());

export const findById = (identity: Identity, id: string) =>
  identity.users.find((u) => String(u.id) === id);

/**
 * Opens a session for someone who has just proved who they are, and returns
 * its tokens. Every sign-in comes through here — password, reset code or OAuth.
 */
export async function issueTokens<T extends AuthTenant>(ctx: AuthContext<T>, user: UserRecord) {
  const { tenantId, tenant, host, jwt } = ctx;
  const { jwtTtlSec, refreshTtlSec } = tenant.config.auth;
  const { session, refreshToken } = openSession(host.secret, tenantId, tenant.identity, String(user.id), refreshTtlSec);
  const token = jwt.sign(tenantId, user, session.id, jwtTtlSec);
  await host.saveSessions(tenantId, tenant);
  return { token, refreshToken, expiresIn: jwtTtlSec };
}

/** A fresh session and the user it speaks for — the answer to every successful sign-in. */
export const signedIn = async <T extends AuthTenant>(ctx: AuthContext<T>, user: UserRecord, status = 200) =>
  json({ ...(await issueTokens(ctx, user)), user: safeUser(user) }, status);

/**
 * Sets a new password and signs the user out everywhere.
 *
 * Two things end: every session the user had, so no refresh token outlives the
 * change, and — through `passwordChangedAt`, which each token carries and
 * `authenticate` compares — every access token signed before it. Any reset
 * code still outstanding is spent too, or it could undo the change just made.
 * The caller then opens a fresh session with `signedIn`.
 */
export async function setPassword<T extends AuthTenant>(ctx: AuthContext<T>, user: UserRecord, password: string) {
  const passwordHash = await Bun.password.hash(password, ARGON);
  const now = new Date().toISOString();
  user.passwordHash = passwordHash;
  user.passwordChangedAt = now;
  user.updatedAt = now;
  const spent = spendResetCode(ctx.tenant.identity, String(user.id));
  const closed = closeUserSessions(ctx.tenant.identity, String(user.id));
  await ctx.host.saveUsers(ctx.tenantId, ctx.tenant);
  if (spent) await ctx.host.saveResets(ctx.tenantId, ctx.tenant);
  if (closed) await ctx.host.saveSessions(ctx.tenantId, ctx.tenant);
}

/** Burns a user's outstanding code, keeping the row for its issue history. True if one was live. */
export function spendResetCode(identity: Identity, userId: string): boolean {
  const entry = identity.resets.find((r) => r.userId === userId);
  if (!entry || entry.codeHash === "") return false;
  entry.codeHash = "";
  entry.expiresAt = new Date().toISOString();
  return true;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Builds the in-RAM identity from the four system files as read off disk.
 * Rows that are not the right shape are dropped rather than trusted: nothing
 * else about this table is allowed to be surprising.
 */
export function readIdentity(usersRaw: unknown, signupsRaw: unknown, resetsRaw: unknown, sessionsRaw: unknown): Identity {
  const users = (Array.isArray(usersRaw) ? usersRaw : []).filter(
    (u): u is UserRecord => isObject(u) && (typeof u.id === "string" || typeof u.id === "number") && typeof u.email === "string",
  );
  const signups: SignupEntry[] = [];
  for (const s of Array.isArray(signupsRaw) ? signupsRaw : []) {
    if (!isObject(s) || typeof s.id !== "string" || typeof s.email !== "string") continue;
    if (typeof s.passwordHash !== "string" || typeof s.expiresAt !== "string") continue;
    signups.push({
      id: s.id,
      email: s.email,
      ...(typeof s.name === "string" && s.name ? { name: s.name } : {}),
      passwordHash: s.passwordHash,
      codeHash: text(s.codeHash),
      codeExpiresAt: typeof s.codeExpiresAt === "string" ? s.codeExpiresAt : new Date(0).toISOString(),
      attempts: typeof s.attempts === "number" ? s.attempts : 0,
      issuedAt: Array.isArray(s.issuedAt) ? s.issuedAt.filter((t): t is string => typeof t === "string") : [],
      createdAt: text(s.createdAt),
      expiresAt: s.expiresAt,
    });
  }
  const resets: ResetEntry[] = [];
  for (const r of Array.isArray(resetsRaw) ? resetsRaw : []) {
    if (!isObject(r) || typeof r.userId !== "string") continue;
    resets.push({
      userId: r.userId,
      codeHash: typeof r.codeHash === "string" ? r.codeHash : "",
      expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : new Date(0).toISOString(),
      attempts: typeof r.attempts === "number" ? r.attempts : 0,
      issuedAt: Array.isArray(r.issuedAt) ? r.issuedAt.filter((t): t is string => typeof t === "string") : [],
    });
  }
  const sessions: SessionEntry[] = [];
  for (const s of Array.isArray(sessionsRaw) ? sessionsRaw : []) {
    if (!isObject(s) || typeof s.id !== "string" || typeof s.userId !== "string") continue;
    if (typeof s.tokenHash !== "string" || typeof s.expiresAt !== "string") continue;
    sessions.push({
      id: s.id,
      userId: s.userId,
      tokenHash: s.tokenHash,
      previousHash: text(s.previousHash),
      createdAt: text(s.createdAt),
      refreshedAt: text(s.refreshedAt),
      expiresAt: s.expiresAt,
    });
  }
  return { users, signups, resets, sessions };
}

/**
 * The system files the dashboard may look at, and how each is shown. No view
 * carries a credential: a password hash is stripped — a pending sign-up's too —
 * and so is a code's HMAC, since six digits are recoverable from their hash by
 * anyone who could also get at the key, and so are a session's refresh-token
 * hashes.
 */
const SYSTEM_VIEWS = {
  users: (row: Record<string, unknown>) => {
    const { passwordHash: _ph, ...rest } = row;
    return rest;
  },
  signups: (row: Record<string, unknown>) => {
    const { passwordHash: _ph, codeHash: _ch, ...rest } = row;
    return rest;
  },
  "reset-password": (row: Record<string, unknown>) => {
    const { codeHash: _ch, ...rest } = row;
    return rest;
  },
  sessions: (row: Record<string, unknown>) => {
    const { tokenHash: _th, previousHash: _ph, ...rest } = row;
    return rest;
  },
};

export type SystemFileName = keyof typeof SYSTEM_VIEWS;

export const SYSTEM_FILE_NAMES = Object.keys(SYSTEM_VIEWS) as SystemFileName[];

export const isSystemFileName = (name: string): name is SystemFileName =>
  Object.hasOwn(SYSTEM_VIEWS, name);

export const viewSystemFile = (name: SystemFileName, rows: unknown[]) =>
  rows.filter(isObject).map(SYSTEM_VIEWS[name]);

const TOKEN_FIELDS = ["token", "refreshToken"];

/**
 * An auth response body as the request log may keep it. The tokens a sign-in
 * hands out are replaced; the user and any error stay readable. The log
 * streams to the project owner's dashboard, and a refresh token there would be
 * a month-long credential for somebody else's account. A body that is not JSON
 * is dropped rather than kept unexamined.
 */
export function redactAuthBody(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isObject(parsed) || !TOKEN_FIELDS.some((f) => f in parsed)) return body;
    const copy: Record<string, unknown> = { ...parsed };
    for (const f of TOKEN_FIELDS) if (f in copy) copy[f] = "[redacted]";
    return JSON.stringify(copy);
  } catch {
    return null;
  }
}
