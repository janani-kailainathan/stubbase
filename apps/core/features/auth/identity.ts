/**
 * The identity table and what may be done with it.
 *
 * `system/users.json` and `system/reset-password.json` are the auth feature's
 * own files. They are never mounted as CRUD resources and never reach the SQL
 * projection, so the only ways out of the server are the auth routes (through
 * `safeUser`) and the dashboard's read-only system view (through
 * `viewSystemFile`). A project can still have a `data/users.json`: that is an
 * ordinary resource and has nothing to do with sign-in.
 */
import { json } from "../../lib/http.ts";
import type { Jwt } from "./jwt.ts";
import type { AuthHost, AuthTenant, Claims, Identity, ResetEntry, UserRecord } from "./types.ts";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LEN = 8;
export const PASSWORD_RULE = `password must be at least ${MIN_PASSWORD_LEN} characters`;
// Same OWASP argon2id baseline as the dashboard API — 19 MiB transient per
// hash keeps concurrent signups affordable on the 1GB box.
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

/** A fresh token and the user it speaks for — the answer to every successful sign-in. */
export const signedIn = <T extends AuthTenant>(ctx: AuthContext<T>, user: UserRecord, status = 200) =>
  json(
    { token: ctx.jwt.sign(ctx.tenantId, user, ctx.tenant.config.auth.jwtTtlSec), user: safeUser(user) },
    status,
  );

/**
 * Sets a new password and revokes every token issued before it.
 *
 * Revocation rides `passwordChangedAt`: each token carries the value it was
 * signed under, and `authenticate` refuses one that no longer matches. Any reset
 * code still outstanding is spent too, or it could undo the change just made.
 */
export async function setPassword<T extends AuthTenant>(ctx: AuthContext<T>, user: UserRecord, password: string) {
  const passwordHash = await Bun.password.hash(password, ARGON);
  const now = new Date().toISOString();
  user.passwordHash = passwordHash;
  user.passwordChangedAt = now;
  user.updatedAt = now;
  const spent = spendResetCode(ctx.tenant.identity, String(user.id));
  await ctx.host.saveUsers(ctx.tenantId, ctx.tenant);
  if (spent) await ctx.host.saveResets(ctx.tenantId, ctx.tenant);
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

/**
 * Builds the in-RAM identity from the two system files as read off disk. Rows
 * that are not the right shape are dropped rather than trusted: nothing else
 * about this table is allowed to be surprising.
 */
export function readIdentity(usersRaw: unknown, resetsRaw: unknown): Identity {
  const users = (Array.isArray(usersRaw) ? usersRaw : []).filter(
    (u): u is UserRecord => isObject(u) && (typeof u.id === "string" || typeof u.id === "number") && typeof u.email === "string",
  );
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
  return { users, resets };
}

/**
 * The system files the dashboard may look at, and how each is shown. Neither
 * view carries a credential: a password hash is stripped, and so is a reset
 * code's HMAC, since six digits are recoverable from their hash by anyone who
 * could also get at the key.
 */
const SYSTEM_VIEWS = {
  users: (row: Record<string, unknown>) => {
    const { passwordHash: _ph, ...rest } = row;
    return rest;
  },
  "reset-password": (row: Record<string, unknown>) => {
    const { codeHash: _ch, ...rest } = row;
    return rest;
  },
};

export type SystemFileName = keyof typeof SYSTEM_VIEWS;

export const SYSTEM_FILE_NAMES = Object.keys(SYSTEM_VIEWS) as SystemFileName[];

export const isSystemFileName = (name: string): name is SystemFileName =>
  Object.hasOwn(SYSTEM_VIEWS, name);

export const viewSystemFile = (name: SystemFileName, rows: unknown[]) =>
  rows.filter(isObject).map(SYSTEM_VIEWS[name]);
