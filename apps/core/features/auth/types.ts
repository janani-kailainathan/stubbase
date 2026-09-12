/**
 * The auth feature's contract with the Core Engine.
 *
 * A feature never imports `server-core.ts`. That module starts the server as a
 * side effect of loading, so importing it would boot a second server — and from
 * a module the core itself imports, it would be a cycle through a file with
 * top-level await. The core hands the feature an `AuthHost` instead: the few
 * things only the core can do, such as loading a tenant, persisting its files,
 * refusing a stopped or over-quota project, and sending through the tenant's
 * email provider.
 */

export interface OauthCredentials {
  clientId: string;
  secret: string;
}

/** The AUTH_* keys of a tenant's config, parsed. */
export interface AuthConfig {
  enabled: boolean;
  /** Resources that allow anonymous GET despite auth. */
  publicRoutes: Set<string>;
  jwtTtlSec: number;
  /** Frontend URL that receives `#token=…` after OAuth. */
  oauthRedirect: string;
  /** Frontend page a reset email links to with `#email=…&code=…`. Empty: the email carries the code alone. */
  resetUrl: string;
  google?: OauthCredentials;
  github?: OauthCredentials;
}

/** One row of `system/users.json`, the identity table. Never a CRUD resource. */
export interface UserRecord {
  id: string;
  email: string;
  role?: string;
  /** argon2id. Absent on an OAuth account that has never set a password. */
  passwordHash?: string;
  /** Tokens signed before this changed are refused — see `Claims.pwdAt`. */
  passwordChangedAt?: string;
  [key: string]: unknown;
}

/**
 * One row of `system/reset-password.json`, at most one per user.
 *
 * The row outlives its code: `issuedAt` is what throttles how often a code can
 * be sent, and deleting the row with the code would hand out a fresh allowance
 * every time one was spent.
 */
export interface ResetEntry {
  userId: string;
  /** HMAC of the code under a key derived from ADMIN_SECRET. `""` once spent. */
  codeHash: string;
  expiresAt: string;
  /** Wrong guesses against the current code. */
  attempts: number;
  /** When each code of the last hour was issued. */
  issuedAt: string[];
}

export interface Identity {
  users: UserRecord[];
  resets: ResetEntry[];
}

/** What the feature needs to see of a loaded tenant. */
export interface AuthTenant {
  config: { auth: AuthConfig };
  identity: Identity;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailResult = { ok: true } | { ok: false; status: number | null };

export interface AuthHost<T extends AuthTenant> {
  /** ADMIN_SECRET: the root every per-tenant key is derived from. Never stored. */
  secret: string;
  getTenant(tenantId: string): Promise<T | null>;
  /** A stopped project's 503 or a spent allowance's 429, else null. */
  refused(tenantId: string, tenant: T): Response | null;
  /** Write-through for `system/users.json`. */
  saveUsers(tenantId: string, tenant: T): Promise<unknown>;
  /** Write-through for `system/reset-password.json`. */
  saveResets(tenantId: string, tenant: T): Promise<unknown>;
  readJsonBody(req: Request): Promise<unknown | Response>;
  /** Public origin as the browser sees it. */
  requestOrigin(req: Request): string;
  /** Whether the tenant has an email provider to send through. */
  emailConfigured(tenant: T): boolean;
  sendEmail(tenant: T, message: EmailMessage): Promise<EmailResult>;
  /** The role a new account gets: the rules' defaultRole, or "user" without rules. */
  defaultRole(tenant: T): string;
  /** Whether a role may list accounts (read) or change their roles (update). */
  mayManageUsers(tenant: T, role: string, action: "read" | "update"): boolean;
  /** Whether a role name is one this project can give an account. */
  roleExists(tenant: T, role: string): boolean;
}

/** The claims of a tenant JWT. */
export interface Claims {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
  /** The user's `passwordChangedAt` when the token was signed. A mismatch revokes the token. */
  pwdAt?: string;
}
