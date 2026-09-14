/**
 * One-time 6-digit codes, shared by sign-up verification and password reset,
 * and how a code reaches the person it is for.
 *
 * Six digits are guessable, so each caller keeps limits around them (a short
 * life, a few guesses, a few codes an hour); what lives here is what the two
 * have in common. A code is stored only as an HMAC under a key derived from
 * ADMIN_SECRET and the code's purpose, bound to the row it was issued for, so a
 * hash can never be moved to another row, project or purpose — and a million
 * candidates is nothing to brute-force from a bare hash.
 *
 * Delivery goes through the project's Resend key. A project without one gets
 * the code in its own request log instead, as a note only the owner's
 * dashboard sees, so sign-up and reset can be tried before email is set up.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { err } from "../../lib/http.ts";
import type { AuthHost, AuthTenant, EmailMessage } from "./types.ts";

export const CODE_TTL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 5;
export const HOUR_MS = 60 * 60_000;
export const CODE_RE = /^\d{6}$/;

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const iso = (ms: number) => new Date(ms).toISOString();

export function codeHash(
  secret: string,
  purpose: "reset" | "signup",
  tenantId: string,
  rowId: string,
  code: string,
): string {
  const key = createHmac("sha256", secret).update(`${purpose}:${tenantId}`).digest();
  return createHmac("sha256", key).update(`${rowId}:${code}`).digest("base64url");
}

/** Constant-time; an empty stored hash (a spent code) never matches. */
export function sameCode(given: string, stored: string): boolean {
  const a = Buffer.from(given, "base64url");
  const b = Buffer.from(stored, "base64url");
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** The issue times still inside the hourly allowance. */
export const recentIssues = (issuedAt: string[], now: number) =>
  issuedAt.filter((t) => now - Date.parse(t) < HOUR_MS);

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Where a code went: the user's inbox, or the owner's request log. */
export type Delivery = "email" | "logs";

/** Sends a code's email, or reports that the log is where it goes. A provider that refuses is a 502. */
export async function sendCode<T extends AuthTenant>(
  host: AuthHost<T>,
  tenant: T,
  message: EmailMessage,
): Promise<Delivery | Response> {
  if (!host.emailConfigured(tenant)) return "logs";
  const sent = await host.sendEmail(tenant, message);
  return sent.ok ? "email" : err(502, `email provider rejected the request (${sent.status ?? "unreachable"})`);
}

/** The owner's log line for a code that could not be emailed. */
export const codeNote = (kind: string, email: string, code: string) =>
  `${kind} code for ${email}: ${code} — valid ${CODE_TTL_MS / 60_000} minutes. ` +
  "Shown only in your logs because this project has no RESEND_API_KEY; nothing was emailed.";
