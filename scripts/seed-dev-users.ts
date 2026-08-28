/**
 * Seeds one dashboard account per plan, so the entitlement work can actually be
 * exercised locally — there is no payment gateway, so a plan is a column value
 * and these three rows are how you see all three sides of it.
 *
 *   free@stubbase.dev   Free      5,000 requests/mo, no paid features
 *   pro@stubbase.dev    Pro QA    50,000/mo, ChaosGuard + AuthGuard
 *   ai@stubbase.dev     Pro + AI  250,000/mo, everything incl. the Co-Pilot
 *
 * All three share the password below. Dev-only: this writes to the local
 * app.sqlite that scripts/dev.ts points the Dashboard API at, and nothing here
 * is deployed. In production a plan is set by hand:
 *
 *   UPDATE users SET plan = 'pro_ai' WHERE email = 'someone@example.com';
 *
 * Existing rows are left alone except for the plan, which is re-asserted every
 * run — so a plan you changed by hand while testing snaps back, and a password
 * you changed does not. Run standalone:
 *
 *   bun run scripts/seed-dev-users.ts
 */
import { Database } from "bun:sqlite";

const DB_PATH = process.env.DB_PATH ?? "./app.sqlite";
export const DEV_PASSWORD = "devpassword123";

// Same OWASP argon2id baseline the Dashboard API verifies against; a hash made
// with different parameters still verifies, but matching keeps the cost honest.
const ARGON = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;

export const DEV_USERS = [
  { email: "free@stubbase.dev", name: "Free Tier", plan: "free" },
  { email: "pro@stubbase.dev", name: "Pro QA", plan: "pro" },
  { email: "ai@stubbase.dev", name: "Pro Plus AI", plan: "pro_ai" },
] as const;

/**
 * Returns the number of accounts created (0 when they all already existed).
 *
 * Creates the `users` table if the Dashboard API has not booted yet, so this
 * works whichever order the dev stack starts things in. The column list is the
 * subset this script needs; the API's own CREATE TABLE IF NOT EXISTS is
 * authoritative and adds the rest.
 */
export async function seedDevUsers(): Promise<number> {
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT,
      password_hash TEXT,
      oauth_provider TEXT,
      plan          TEXT NOT NULL DEFAULT 'free',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  let created = 0;
  for (const user of DEV_USERS) {
    const existing = db.query("SELECT id FROM users WHERE email = ?").get(user.email) as
      | { id: number }
      | null;
    if (existing) {
      // Re-assert the plan only: the point of these three is which tier they
      // are on, and a run of this script should restore that.
      db.query("UPDATE users SET plan = ? WHERE id = ?").run(user.plan, existing.id);
      continue;
    }
    const hash = await Bun.password.hash(DEV_PASSWORD, ARGON);
    db.query(
      "INSERT INTO users (email, name, password_hash, plan) VALUES (?, ?, ?, ?)",
    ).run(user.email, user.name, hash, user.plan);
    created += 1;
  }
  db.close();
  return created;
}

if (import.meta.main) {
  const created = await seedDevUsers();
  console.log(
    created > 0
      ? `seeded ${created} dev account(s) in ${DB_PATH} — password ${DEV_PASSWORD}`
      : `dev accounts already present in ${DB_PATH} (plans re-asserted)`,
  );
}
