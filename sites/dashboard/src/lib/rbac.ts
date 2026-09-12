/**
 * Roles and permissions (a project's system/rbac.json), as the dashboard needs
 * them. The Core Engine is the authority on what a valid file is — it checks
 * every write and the editor shows its reasons — so this holds only a starting
 * point and the role names an account can be given.
 *
 * React-free, like lib/env.ts.
 */

export interface RbacRules {
  defaultRole?: string
  roles?: Record<string, unknown>
}

/** A small shop: what a project with no rules starts editing from. */
export const RBAC_EXAMPLE: RbacRules = {
  defaultRole: 'customer',
  roles: {
    guest: { products: ['read'] },
    customer: {
      products: ['read'],
      orders: { create: 'own', read: 'own', update: 'own' },
    },
    staff: {
      products: ['read', 'create', 'update'],
      orders: { read: 'all', update: 'all' },
      _users: ['read'],
    },
    admin: '*',
  },
}

/**
 * The roles an account can hold. With rules, every role they define except
 * guest, which is for requests without a token. Without rules, the two the
 * plain ownership rules understand.
 */
export function assignableRoles(rules: RbacRules | null | undefined): string[] {
  if (!rules?.roles) return ['user', 'admin']
  return Object.keys(rules.roles).filter((role) => role !== 'guest')
}
