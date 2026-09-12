/** The four things a request can do to a resource: GET, POST, PUT, DELETE. */
export type Action = "read" | "create" | "update" | "delete";

/** Whose records a permission reaches: those stamped with the caller's id, or every one. */
export type Scope = "own" | "all";

/** What one role may do to one resource: each action it can take, with its scope. */
export type Grants = Partial<Record<Action, Scope>>;

export interface Role {
  /** `"*"`: every action on every resource, managing accounts included. */
  everything: boolean;
  /** Per resource. The `"*"` key applies to any resource without an entry of its own. */
  resources: Map<string, Grants>;
  /** Managing accounts through the API (`_users`): list them, change their role. */
  users: { read: boolean; update: boolean };
}

export interface RbacRules {
  /** The role every new account gets. */
  defaultRole: string;
  roles: Map<string, Role>;
}

export type Decision =
  | { allowed: true; scope: Scope }
  | { allowed: false; status: 401 | 403; error: string };
