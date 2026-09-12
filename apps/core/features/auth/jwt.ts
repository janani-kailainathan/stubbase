import { createHmac, timingSafeEqual } from "node:crypto";
import type { Claims, UserRecord } from "./types.ts";

/**
 * HS256, zero-dependency. Per-tenant signing keys are derived from ADMIN_SECRET,
 * so they survive restarts and evictions without ever being stored on disk, and
 * a token signed for one tenant never verifies under another.
 */
export function createJwt(secret: string) {
  const key = (tenantId: string): Buffer =>
    createHmac("sha256", secret).update(`jwt:${tenantId}`).digest();

  function sign(tenantId: string, user: UserRecord, ttlSec: number): string {
    const now = Math.floor(Date.now() / 1000);
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const head = enc({ alg: "HS256", typ: "JWT" });
    const claims: Claims = {
      sub: String(user.id),
      email: String(user.email),
      role: String(user.role ?? "user"),
      iat: now,
      exp: now + ttlSec,
    };
    if (typeof user.passwordChangedAt === "string") claims.pwdAt = user.passwordChangedAt;
    const body = enc(claims);
    const sig = createHmac("sha256", key(tenantId)).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  }

  /** Signature and expiry only. Whether the token still speaks for a user is `authenticate`'s call. */
  function verify(tenantId: string, token: string): Claims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const expected = createHmac("sha256", key(tenantId)).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Claims;
      if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
      if (typeof claims.sub !== "string") return null;
      return claims;
    } catch {
      return null;
    }
  }

  return { key, sign, verify };
}

export type Jwt = ReturnType<typeof createJwt>;
