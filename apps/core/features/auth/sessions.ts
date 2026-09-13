/**
 * Sessions: one row per sign-in, and the refresh token that keeps it going.
 * The routes that use them are tokens.ts; every sign-in opens one through
 * `issueTokens` (identity.ts).
 *
 * The access token names its session (`sid`), and `authenticate` refuses a
 * token whose session is closed — that is what makes logout take effect at
 * once rather than when the token runs out. The refresh token is
 * `<session id>.<secret>`: the id finds the row, the secret proves the caller
 * holds it.
 *
 * Every rule here is load-bearing:
 *   - the secret is kept only as an HMAC under a key derived from ADMIN_SECRET
 *     and bound to the project and the session, so a row copied to another
 *     project, or its hash moved to another session, never matches;
 *   - a refresh spends the secret it was given and hands out the next one in a
 *     single synchronous turn, so two requests racing with one token cannot
 *     both succeed;
 *   - the secret a refresh already spent, presented again, means two holders
 *     share the chain — a stolen copy — so the session ends, taking the
 *     thief's fresh token with it. A secret that matches nothing ends nothing:
 *     the session id can be read out of any access token, and a guess must not
 *     be able to sign someone out;
 *   - expiry slides: each refresh starts AUTH_REFRESH_TTL_SECONDS again;
 *   - a user keeps at most MAX_SESSIONS_PER_USER, and signing in past that
 *     ends the session refreshed longest ago;
 *   - changing or resetting a password ends every session the user has.
 *
 * Nothing here imports identity.ts: that module opens sessions, and a cycle
 * through its top-level await is not worth the risk.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Identity, SessionEntry } from "./types.ts";

export const MAX_SESSIONS_PER_USER = 10;
const SECRET_BYTES = 32;

/** Bound to the project and the session, so a hash can never be moved to another row. */
function secretHash(secret: string, tenantId: string, sessionId: string, value: string): string {
  const key = createHmac("sha256", secret).update(`refresh:${tenantId}`).digest();
  return createHmac("sha256", key).update(`${sessionId}:${value}`).digest("base64url");
}

/** Constant-time; an empty stored hash (no refresh spent yet) never matches. */
function sameHash(given: string, stored: string): boolean {
  const a = Buffer.from(given, "base64url");
  const b = Buffer.from(stored, "base64url");
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const newSecret = () => randomBytes(SECRET_BYTES).toString("base64url");
const iso = (ms: number) => new Date(ms).toISOString();
const isOpen = (s: SessionEntry, now: number) => Date.parse(s.expiresAt) > now;
const timeOf = (stamp: string) => Date.parse(stamp) || 0;

/** Splits `<session id>.<secret>`; anything else has no session to find. */
function parse(presented: string): { id: string; value: string } | null {
  const dot = presented.indexOf(".");
  return dot > 0 ? { id: presented.slice(0, dot), value: presented.slice(dot + 1) } : null;
}

/**
 * Opens a session for a user who has just proved who they are, and returns the
 * refresh token that belongs to it. Also where the file is kept small: expired
 * rows go, and so does whatever pushes the user past their session cap.
 */
export function openSession(
  secret: string,
  tenantId: string,
  identity: Identity,
  userId: string,
  ttlSec: number,
): { session: SessionEntry; refreshToken: string } {
  const now = Date.now();
  const open = identity.sessions.filter((s) => isOpen(s, now));
  const mine = open.filter((s) => s.userId === userId);
  const excess = mine.length - MAX_SESSIONS_PER_USER + 1;
  // Stable sort: sessions refreshed in the same millisecond keep the order they were opened in.
  const ended = new Set(excess > 0 ? [...mine].sort((a, b) => timeOf(a.refreshedAt) - timeOf(b.refreshedAt)).slice(0, excess) : []);
  identity.sessions = open.filter((s) => !ended.has(s));

  const id = crypto.randomUUID();
  const value = newSecret();
  const session: SessionEntry = {
    id,
    userId,
    tokenHash: secretHash(secret, tenantId, id, value),
    previousHash: "",
    createdAt: iso(now),
    refreshedAt: iso(now),
    expiresAt: iso(now + ttlSec * 1000),
  };
  identity.sessions.push(session);
  return { session, refreshToken: `${id}.${value}` };
}

/** Whether an access token's session is still open, for the user the token names. */
export function sessionOpen(identity: Identity, sessionId: string, userId: string): boolean {
  const now = Date.now();
  return identity.sessions.some((s) => s.id === sessionId && s.userId === userId && isOpen(s, now));
}

export type Redeemed =
  | { kind: "rotated"; session: SessionEntry; refreshToken: string }
  /** A spent secret came back: the session is closed now. */
  | { kind: "replayed" }
  | { kind: "invalid" };

/**
 * Trades a refresh token for the next one. Synchronous from lookup to rotation
 * on purpose — nothing may yield between checking a secret and spending it.
 */
export function redeemRefreshToken(
  secret: string,
  tenantId: string,
  identity: Identity,
  presented: string,
  ttlSec: number,
): Redeemed {
  const now = Date.now();
  const parts = parse(presented);
  const session = parts && identity.sessions.find((s) => s.id === parts.id && isOpen(s, now));
  if (!parts || !session) return { kind: "invalid" };

  const given = secretHash(secret, tenantId, parts.id, parts.value);
  if (sameHash(given, session.tokenHash)) {
    const value = newSecret();
    session.previousHash = session.tokenHash;
    session.tokenHash = secretHash(secret, tenantId, parts.id, value);
    session.refreshedAt = iso(now);
    session.expiresAt = iso(now + ttlSec * 1000);
    return { kind: "rotated", session, refreshToken: `${parts.id}.${value}` };
  }
  if (sameHash(given, session.previousHash)) {
    closeSession(identity, parts.id);
    return { kind: "replayed" };
  }
  return { kind: "invalid" };
}

/** Ends one session. True if there was one to end. */
export function closeSession(identity: Identity, sessionId: string): boolean {
  const before = identity.sessions.length;
  identity.sessions = identity.sessions.filter((s) => s.id !== sessionId);
  return identity.sessions.length !== before;
}

/**
 * Ends the session a refresh token belongs to — logout, which may arrive after
 * the access token has run out. The secret has to match, current or just spent
 * (a spent one would end the session anyway); a bare session id ends nothing.
 */
export function closeByRefreshToken(secret: string, tenantId: string, identity: Identity, presented: string): boolean {
  const parts = parse(presented);
  const session = parts && identity.sessions.find((s) => s.id === parts.id);
  if (!parts || !session) return false;
  const given = secretHash(secret, tenantId, parts.id, parts.value);
  if (!sameHash(given, session.tokenHash) && !sameHash(given, session.previousHash)) return false;
  return closeSession(identity, parts.id);
}

/** Ends every session a user has. True if any were open. */
export function closeUserSessions(identity: Identity, userId: string): boolean {
  const before = identity.sessions.length;
  identity.sessions = identity.sessions.filter((s) => s.userId !== userId);
  return identity.sessions.length !== before;
}
