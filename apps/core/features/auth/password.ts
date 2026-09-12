/**
 * Email-and-password accounts: signup, login, and changing a password you know.
 * Forgetting one is `password-reset.ts`.
 */
import { err } from "../../lib/http.ts";
import { newTimestamps } from "../../lib/timestamps.ts";
import {
  ARGON,
  DUMMY_HASH,
  EMAIL_RE,
  MIN_PASSWORD_LEN,
  PASSWORD_RULE,
  findByEmail,
  findById,
  setPassword,
  signedIn,
  type AuthContext,
  type Fields,
} from "./identity.ts";
import type { AuthTenant, UserRecord } from "./types.ts";

export async function signup<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { email, password, name } = body;
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return err(400, "valid email required");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) return err(400, PASSWORD_RULE);

  const { identity } = ctx.tenant;
  if (findByEmail(identity, email)) return err(409, "email already registered");
  const passwordHash = await Bun.password.hash(password, ARGON);
  if (findByEmail(identity, email)) return err(409, "email already registered"); // re-check: hashing yielded
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email,
    ...(typeof name === "string" && name ? { name } : {}),
    role: ctx.host.defaultRole(ctx.tenant),
    passwordHash,
    ...newTimestamps(),
  };
  identity.users.push(user);
  await ctx.host.saveUsers(ctx.tenantId, ctx.tenant);
  return signedIn(ctx, user, 201);
}

export async function login<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { email, password } = body;
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return err(400, "valid email required");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) return err(400, PASSWORD_RULE);

  // Always verify against some hash, so an unknown email takes as long as a wrong password.
  const existing = findByEmail(ctx.tenant.identity, email);
  const hash = typeof existing?.passwordHash === "string" ? existing.passwordHash : DUMMY_HASH;
  const ok = await Bun.password.verify(password, hash).catch(() => false);
  if (!ok || !existing) return err(401, "invalid email or password");
  return signedIn(ctx, existing);
}

/**
 * POST /auth/change-password — for someone signed in who knows their password.
 *
 * The token alone is not enough: whoever holds a stolen token could otherwise
 * set a new password and lock the owner out for good, so the current password
 * is asked for too. Every other token is revoked, and the answer is a fresh one
 * so the caller stays signed in.
 */
export async function changePassword<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const claims = ctx.authenticate();
  if (!claims) return err(401, "valid bearer token required");
  const { currentPassword, password } = body;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) return err(400, PASSWORD_RULE);

  const user = findById(ctx.tenant.identity, claims.sub);
  if (!user) return err(401, "valid bearer token required");
  if (typeof user.passwordHash !== "string")
    return err(400, "this account has no password yet — set one with POST /auth/forgot-password");
  if (typeof currentPassword !== "string") return err(400, "currentPassword is required");
  // 403, not 401: the token is fine, and a client that signs out on 401 should not do so here.
  const ok = await Bun.password.verify(currentPassword, user.passwordHash).catch(() => false);
  if (!ok) return err(403, "current password is incorrect");

  await setPassword(ctx, user, password);
  return signedIn(ctx, user);
}
