/**
 * Keeping a sign-in going, and ending it. The session model and the rules it
 * keeps are in sessions.ts.
 *
 *   POST /auth/refresh  { refreshToken }                     → { token, refreshToken, expiresIn, user }
 *   POST /auth/logout   Bearer token and/or { refreshToken }  → 204
 */
import { err, json } from "../../lib/http.ts";
import { findById, safeUser, type AuthContext, type Fields } from "./identity.ts";
import { closeByRefreshToken, closeSession, redeemRefreshToken } from "./sessions.ts";
import type { AuthTenant } from "./types.ts";

export async function refresh<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { tenantId, tenant, host, jwt } = ctx;
  const { refreshToken } = body;
  if (typeof refreshToken !== "string" || refreshToken === "") return err(400, "refreshToken is required");

  // One answer for every way a refresh token can be wrong, a replayed one included.
  const invalid = () => err(401, "invalid or expired refresh token");
  const { jwtTtlSec, refreshTtlSec } = tenant.config.auth;
  const redeemed = redeemRefreshToken(host.secret, tenantId, tenant.identity, refreshToken, refreshTtlSec);
  if (redeemed.kind === "invalid") return invalid();
  if (redeemed.kind === "replayed") {
    await host.saveSessions(tenantId, tenant);
    return invalid();
  }

  const { session } = redeemed;
  const user = findById(tenant.identity, session.userId);
  if (!user) {
    closeSession(tenant.identity, session.id);
    await host.saveSessions(tenantId, tenant);
    return invalid();
  }
  const token = jwt.sign(tenantId, user, session.id, jwtTtlSec);
  await host.saveSessions(tenantId, tenant);
  return json({ token, refreshToken: redeemed.refreshToken, expiresIn: jwtTtlSec, user: safeUser(user) });
}

/**
 * Ends the session behind the request, named by its access token, its refresh
 * token, or both — the refresh token is how a client whose access token has
 * already run out still signs out. Always 204: ending a session that is
 * already gone is still a logout, and the answer says nothing about which
 * tokens were live.
 */
export async function logout<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { tenantId, tenant, host } = ctx;
  const claims = ctx.authenticate();
  let closed = claims ? closeSession(tenant.identity, claims.sid) : false;
  if (typeof body.refreshToken === "string")
    closed = closeByRefreshToken(host.secret, tenantId, tenant.identity, body.refreshToken) || closed;
  if (closed) await host.saveSessions(tenantId, tenant);
  return new Response(null, { status: 204 });
}
