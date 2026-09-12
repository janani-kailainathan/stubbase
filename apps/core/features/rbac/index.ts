/**
 * Roles and permissions for a project's own users (`system/rbac.json`).
 *
 * A permission is resource + action + scope; a role is a named bundle of them;
 * each account has one role. Only in effect with AUTH_ENABLED, RBAC_ENABLED and
 * a rules file: otherwise a project keeps the plain ownership rules (read
 * everything, change your own records). The file is staged and deployed like
 * config.
 *
 * The core calls `decide` from its rbacGuard pipeline stage, which settles
 * whether the request may happen at all and hands coreOperation the scope that
 * decides whose records it may touch. Pure functions: nothing here loads, saves
 * or knows about tenants.
 */
import { GUEST } from "./rules.ts";
import type { Action, Decision, RbacRules } from "./types.ts";

export { ACTIONS, GUEST, USERS_KEY, parseRbac } from "./rules.ts";
export type * from "./types.ts";

/**
 * Whether a request may take an action on a resource, and on whose records.
 *
 * `role` is the account's role, or undefined for a request with no token, which
 * then acts as `guest`. A role missing from the rules has no permissions. A
 * refused visitor gets 401, since signing in might help; a refused account gets
 * 403, naming its role, since it would not.
 */
export function decide(
  rules: RbacRules,
  role: string | undefined,
  resource: string,
  action: Action,
): Decision {
  const anonymous = role === undefined;
  const name = anonymous ? GUEST : role;
  const spec = rules.roles.get(name);
  if (spec?.everything) return { allowed: true, scope: "all" };
  const scope = (spec?.resources.get(resource) ?? spec?.resources.get("*"))?.[action];
  if (scope && !(anonymous && scope === "own")) return { allowed: true, scope };
  if (anonymous) return { allowed: false, status: 401, error: "valid bearer token required" };
  return { allowed: false, status: 403, error: `forbidden: role '${name}' may not ${action} ${resource}` };
}

/** Whether a role may list accounts (`read`) or change their roles (`update`). */
export function canManageUsers(rules: RbacRules, role: string, action: "read" | "update"): boolean {
  const spec = rules.roles.get(role);
  return spec !== undefined && (spec.everything || spec.users[action]);
}

export const roleExists = (rules: RbacRules, role: string) => rules.roles.has(role);
