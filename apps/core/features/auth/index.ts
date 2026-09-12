/**
 * Auth — sign-up, login and password recovery for a tenant's end users.
 *
 *   POST /<tenant>/auth/signup            { email, password, name? }         → 201 { token, user }
 *   POST /<tenant>/auth/login             { email, password }                → { token, user }
 *   POST /<tenant>/auth/change-password   { currentPassword, password } + JWT → { token, user }
 *   POST /<tenant>/auth/forgot-password   { email }                          → 202
 *   POST /<tenant>/auth/reset-password    { email, code, password }          → { token, user }
 *   GET  /<tenant>/auth/google|github[/callback]                             (when configured)
 *   GET  /<tenant>/auth/users                                                (role with _users: read)
 *   PUT  /<tenant>/auth/users/<id>/role   { role }                           (role with _users: update)
 *
 * Every route needs AUTH_ENABLED. The identity table is `system/users.json` and
 * outstanding reset codes are `system/reset-password.json`; neither is a CRUD
 * resource (see identity.ts).
 *
 * The core builds one instance with `createAuth(host)` and calls `handle` for
 * the auth routes and `authenticate` wherever a request's bearer token matters
 * (its authGuard pipeline stage, the notify proxy).
 */
import { err } from "../../lib/http.ts";
import { findById, type AuthContext, type Fields } from "./identity.ts";
import { createJwt } from "./jwt.ts";
import { handleOauth } from "./oauth.ts";
import { changePassword, login, signup } from "./password.ts";
import { forgotPassword, resetPassword } from "./password-reset.ts";
import type { AuthHost, AuthTenant, Claims } from "./types.ts";
import { changeRole, listUsers, setRole } from "./users.ts";

/** A parsed JSON body as fields; anything that was not an object reads as empty. */
const asFields = (body: unknown): Fields =>
  body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Fields) : {};

export { parseAuthConfig } from "./config.ts";
export { LOG_RESET_CODES } from "./password-reset.ts";
export {
  SYSTEM_FILE_NAMES,
  isSystemFileName,
  readIdentity,
  viewSystemFile,
  type SystemFileName,
} from "./identity.ts";
export type * from "./types.ts";

export function createAuth<T extends AuthTenant>(host: AuthHost<T>) {
  const jwt = createJwt(host.secret);

  /**
   * The claims of the request's bearer token, or null.
   *
   * A valid signature is not enough on its own. The user it names has to still
   * exist, and the token has to have been signed under their current
   * `passwordChangedAt`, which is how changing or resetting a password signs
   * that user out everywhere else. The role comes from the user record rather
   * than from the token, so it can never be staler than the table.
   */
  function authenticate(tenantId: string, tenant: T, req: Request): Claims | null {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const claims = jwt.verify(tenantId, header.slice(7));
    if (!claims) return null;
    const user = findById(tenant.identity, claims.sub);
    if (!user) return null;
    const changedAt = typeof user.passwordChangedAt === "string" ? user.passwordChangedAt : undefined;
    if (claims.pwdAt !== changedAt) return null;
    return { ...claims, email: String(user.email), role: String(user.role ?? "user") };
  }

  // A Map, not an object literal: `constructor` must not look like a route.
  const POST_ROUTES = new Map<string, (ctx: AuthContext<T>, body: Fields) => Promise<Response>>([
    ["signup", signup],
    ["login", login],
    ["change-password", changePassword],
    ["forgot-password", forgotPassword],
    ["reset-password", resetPassword],
  ]);

  async function handle(req: Request, tenantId: string, segments: string[]): Promise<Response> {
    const tenant = await host.getTenant(tenantId);
    if (!tenant) return err(404, "tenant not found");
    const refused = host.refused(tenantId, tenant);
    if (refused) return refused;
    if (!tenant.config.auth.enabled) return err(404, "auth is not enabled for this tenant");

    const ctx: AuthContext<T> = {
      req,
      tenantId,
      tenant,
      host,
      jwt,
      authenticate: () => authenticate(tenantId, tenant, req),
    };

    const [action, sub] = segments;
    if (action === "users") {
      if (req.method === "GET" && segments.length === 1) return listUsers(ctx);
      if (req.method === "PUT" && segments.length === 3 && segments[2] === "role") {
        const body = await host.readJsonBody(req);
        if (body instanceof Response) return body;
        return changeRole(ctx, segments[1], asFields(body));
      }
      return err(404, "unknown auth route");
    }
    if (req.method === "GET" && (action === "google" || action === "github") && segments.length <= 2) {
      if (sub !== undefined && sub !== "callback") return err(404, "unknown auth route");
      return handleOauth(ctx, action, sub === "callback");
    }

    const route = req.method === "POST" && segments.length === 1 ? POST_ROUTES.get(action) : undefined;
    if (!route) return err(404, "unknown auth route");
    const body = await host.readJsonBody(req);
    if (body instanceof Response) return body;
    return route(ctx, asFields(body));
  }

  /**
   * The project owner changing an account's role from the dashboard, through
   * the core's admin plane: no token, the owner's authority. Not refused for a
   * stopped project — the admin plane never is.
   */
  async function assignRole(tenantId: string, userId: string, role: unknown): Promise<Response> {
    const tenant = await host.getTenant(tenantId);
    if (!tenant) return err(404, "tenant not found");
    return setRole(host, tenantId, tenant, userId, role);
  }

  return { handle, authenticate, assignRole };
}
