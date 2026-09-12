/**
 * Managing accounts through the project's own API — what a shop's admin screen
 * calls to see its customers and make someone staff.
 *
 *   GET /auth/users             list accounts      (a role with _users: read)
 *   PUT /auth/users/<id>/role   { role }           (a role with _users: update)
 *
 * The permission comes from the caller's role (see features/rbac), so without
 * rules nobody may use these; the project owner still can, from the dashboard,
 * which is how a project's first admin is made. A new role applies from the
 * account's next request: `authenticate` reads the role from the record, so the
 * token they already hold carries it.
 */
import { err, json } from "../../lib/http.ts";
import { findById, safeUser, type AuthContext, type Fields } from "./identity.ts";
import type { AuthHost, AuthTenant } from "./types.ts";

export function listUsers<T extends AuthTenant>(ctx: AuthContext<T>): Response {
  const claims = ctx.authenticate();
  if (!claims) return err(401, "valid bearer token required");
  if (!ctx.host.mayManageUsers(ctx.tenant, claims.role, "read"))
    return err(403, `forbidden: role '${claims.role}' may not list accounts`);
  return json(ctx.tenant.identity.users.map(safeUser));
}

export async function changeRole<T extends AuthTenant>(
  ctx: AuthContext<T>,
  userId: string,
  body: Fields,
): Promise<Response> {
  const claims = ctx.authenticate();
  if (!claims) return err(401, "valid bearer token required");
  if (!ctx.host.mayManageUsers(ctx.tenant, claims.role, "update"))
    return err(403, `forbidden: role '${claims.role}' may not change roles`);
  return setRole(ctx.host, ctx.tenantId, ctx.tenant, userId, body.role);
}

/** Shared by the public route and the dashboard's admin-plane route: the role has to be one the project defines. */
export async function setRole<T extends AuthTenant>(
  host: AuthHost<T>,
  tenantId: string,
  tenant: T,
  userId: string,
  role: unknown,
): Promise<Response> {
  if (typeof role !== "string" || role === "") return err(400, "'role' is required");
  if (!host.roleExists(tenant, role)) return err(400, `role '${role}' is not defined for this project`);
  const user = findById(tenant.identity, userId);
  if (!user) return err(404, "user not found");
  user.role = role;
  user.updatedAt = new Date().toISOString();
  await host.saveUsers(tenantId, tenant);
  return json(safeUser(user));
}
