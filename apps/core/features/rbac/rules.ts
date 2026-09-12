/**
 * Reading `system/rbac.json`.
 *
 *   {
 *     "defaultRole": "customer",
 *     "roles": {
 *       "guest":    { "products": ["read"] },
 *       "customer": { "products": ["read"],
 *                     "orders":   { "create": "own", "read": "own", "update": "own" } },
 *       "staff":    { "products": "*", "orders": { "read": "all", "update": "all" },
 *                     "_users": ["read"] },
 *       "admin":    "*"
 *     }
 *   }
 *
 * A role is `"*"` or an object keyed by resource name (or `"*"` for any
 * resource it does not name). Each value is `"*"` (everything), a list of
 * actions (each on every record), or an object of action → `"own"` | `"all"`.
 * `_users` is not a resource — the leading underscore keeps it from ever being
 * one — and grants `"read"` (list accounts) and `"update"` (change a role).
 * `guest` is the role for requests without a token: it has no account, so it
 * can hold neither `"own"` nor `_users`.
 *
 * Every mistake is reported rather than skipped. A typo that quietly dropped a
 * permission would look like a working file that denies something it meant to
 * allow — or, worse, allows what a mistyped restriction meant to deny.
 */
import { NAME_RE } from "../../lib/names.ts";
import type { Action, Grants, RbacRules, Role } from "./types.ts";

export const GUEST = "guest";
export const USERS_KEY = "_users";
export const ACTIONS: readonly Action[] = ["read", "create", "update", "delete"];

const EVERYTHING: Grants = { read: "all", create: "all", update: "all", delete: "all" };

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isAction = (v: unknown): v is Action => typeof v === "string" && (ACTIONS as string[]).includes(v);

export function parseRbac(raw: unknown): { rules: RbacRules; problems: string[] } {
  const problems: string[] = [];
  const rules: RbacRules = { defaultRole: "", roles: new Map() };
  if (!isObject(raw)) return { rules, problems: ["rbac.json must be a JSON object"] };

  for (const key of Object.keys(raw))
    if (key !== "defaultRole" && key !== "roles")
      problems.push(`unknown key '${key}' — rbac.json holds defaultRole and roles`);

  if (!isObject(raw.roles)) {
    problems.push("'roles' must be an object mapping each role name to its permissions");
  } else {
    for (const [name, spec] of Object.entries(raw.roles)) {
      if (!NAME_RE.test(name)) {
        problems.push(`role '${name}': a role name uses letters, digits, - and _`);
        continue;
      }
      const role = parseRole(name, spec, problems);
      if (role) rules.roles.set(name, role);
    }
  }

  const fallback = raw.defaultRole;
  if (typeof fallback !== "string" || fallback === "")
    problems.push("'defaultRole' must name the role every new account gets");
  else if (fallback === GUEST)
    problems.push("'defaultRole' can't be guest — guest is for requests without a token");
  else if (!rules.roles.has(fallback))
    problems.push(`'defaultRole' is '${fallback}', which is not one of the roles`);
  else rules.defaultRole = fallback;

  return { rules, problems };
}

function parseRole(name: string, spec: unknown, problems: string[]): Role | null {
  const role: Role = { everything: false, resources: new Map(), users: { read: false, update: false } };
  if (spec === "*") {
    // A guest has no account to manage anything with, so "*" is every resource and no more.
    if (name === GUEST) role.resources.set("*", EVERYTHING);
    else role.everything = true;
    return role;
  }
  if (!isObject(spec)) {
    problems.push(`role '${name}': must be "*" or an object of resource permissions`);
    return null;
  }
  for (const [key, grant] of Object.entries(spec)) {
    const at = `role '${name}', '${key}'`;
    if (key === USERS_KEY) {
      parseUsers(name, at, grant, role, problems);
      continue;
    }
    if (key !== "*" && !NAME_RE.test(key)) {
      problems.push(`${at}: not a resource name`);
      continue;
    }
    const grants = parseGrants(at, grant, problems);
    if (!grants) continue;
    if (name === GUEST && Object.values(grants).includes("own")) {
      problems.push(`${at}: a guest has no account, so "own" can't apply — use "all" or a list of actions`);
      continue;
    }
    role.resources.set(key, grants);
  }
  return role;
}

function parseGrants(at: string, grant: unknown, problems: string[]): Grants | null {
  if (grant === "*") return { ...EVERYTHING };
  const unknownAction = (a: unknown) =>
    problems.push(`${at}: unknown action ${JSON.stringify(a)} — use read, create, update or delete`);
  if (Array.isArray(grant)) {
    const grants: Grants = {};
    for (const action of grant) {
      if (!isAction(action)) return unknownAction(action), null;
      grants[action] = "all";
    }
    return grants;
  }
  if (isObject(grant)) {
    const grants: Grants = {};
    for (const [action, scope] of Object.entries(grant)) {
      if (!isAction(action)) return unknownAction(action), null;
      if (scope !== "own" && scope !== "all") {
        problems.push(`${at}: '${action}' must be "own" or "all"`);
        return null;
      }
      grants[action] = scope;
    }
    return grants;
  }
  problems.push(`${at}: must be "*", a list of actions, or an object of action → "own" | "all"`);
  return null;
}

function parseUsers(name: string, at: string, grant: unknown, role: Role, problems: string[]) {
  if (name === GUEST) {
    problems.push(`${at}: a guest has no account, so it can't manage accounts`);
    return;
  }
  const list = grant === "*" ? ["read", "update"] : grant;
  if (!Array.isArray(list) || list.some((a) => a !== "read" && a !== "update")) {
    problems.push(`${at}: must be "*" or a list of "read" (list accounts) and "update" (change a role)`);
    return;
  }
  for (const action of list as ("read" | "update")[]) role.users[action] = true;
}
