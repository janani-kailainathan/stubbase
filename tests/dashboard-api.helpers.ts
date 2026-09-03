/**
 * Shared vocabulary for the dashboard-api suites.
 *
 * Split out when authentication moved to its own file: both suites need to
 * make an account, present a bearer token and look at the row it left behind,
 * so those primitives live here rather than being duplicated. Not a test file
 * itself — the name carries no `.test.`, which is what keeps it outside bun
 * test's glob, exactly as `helpers.ts` does for the process harness.
 *
 * Everything here takes its `Service` explicitly. The originals defaulted to a
 * module-level `app`, which cannot survive the split: each suite boots its own
 * instances, so the binding belongs to the suite, not to the helper. Each file
 * re-binds the ones it uses often (`readDb`, `signup`) in one line.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Service } from "./helpers.ts";

/** The SPA origin both suites allow-list when booting a dashboard API. */
export const ALLOWED_ORIGIN = "http://localhost:5173";
export const PASSWORD = "password123";

export interface Account {
  token: string;
  email: string;
  id: number;
}

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const as = (token: string) => ({ authorization: `Bearer ${token}` });

export const jsonHeaders = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? as(token) : {}),
});

/** Read-only peek at a service's own database. */
export function readDbOf<T>(service: Service, fn: (db: Database) => T): T {
  const db = new Database(join(service.dir, "app.sqlite"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Put an account on a plan.
 *
 * Deliberately a direct UPDATE: there is no payment gateway and therefore no
 * route that changes a plan, so this is exactly what an operator does in
 * production (`UPDATE users SET plan = ...`). The column is part of the
 * contract now, which is what makes reaching for it here fair game.
 */
export function setPlanOn(service: Service, email: string, plan: string) {
  const db = new Database(join(service.dir, "app.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.query("UPDATE users SET plan = ? WHERE email = ?").run(plan, email);
  } finally {
    db.close();
  }
}

let seq = 0;

/** Signs up a fresh account on the given service and returns its session. */
export async function signupOn(on: Service): Promise<Account> {
  const email = `user${++seq}-${Date.now()}@test.co`;
  const res = await fetch(`${on.base}/auth/signup`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.token, email, id: body.user.id };
}
