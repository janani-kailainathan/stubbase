/**
 * Forgot password: a one-time 6-digit code, sent by email, traded for a new password.
 *
 *   POST /auth/forgot-password  { email }                  → 202, whether or not the account exists
 *   POST /auth/reset-password   { email, code, password }  → { token, user }
 *
 * One kind of credential, two ways to present it. The email always shows the
 * code, which works in any client (a mobile app, a CLI, a SPA with no reset
 * page). When the project sets AUTH_RESET_URL the email also links there with
 * the email and code in the fragment, for a web app that wants a one-click page.
 * The link adds no second credential: a code is a code wherever it is typed.
 *
 * Six digits are guessable, so the security is in the limits around them, and
 * every one is load-bearing:
 *   - a code lives CODE_TTL_MS and is spent by its first correct use;
 *   - MAX_ATTEMPTS wrong guesses spend it;
 *   - a new request replaces the previous code rather than adding to it;
 *   - at most MAX_CODES_PER_HOUR codes per user per hour, counted from the row's
 *     `issuedAt` and persisted, so neither spending a code nor evicting the
 *     tenant hands out a fresh allowance.
 * Codes are stored as an HMAC under a key derived from ADMIN_SECRET, not a bare
 * hash: a million candidates is nothing to brute-force, and the dashboard shows
 * this file.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { err, json } from "../../lib/http.ts";
import {
  EMAIL_RE,
  MIN_PASSWORD_LEN,
  PASSWORD_RULE,
  findByEmail,
  setPassword,
  signedIn,
  type AuthContext,
  type Fields,
} from "./identity.ts";
import type { AuthTenant, EmailMessage, Identity, ResetEntry } from "./types.ts";

/** Local dev and tests only: write each reset code to the log. NEVER set in production. */
export const LOG_RESET_CODES = process.env.AUTH_RESET_LOG_CODES === "true";

const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;
const CODE_RE = /^\d{6}$/;

/** Bound to the user as well as the code, so a hash can never be moved to another row. */
function codeHash(secret: string, tenantId: string, userId: string, code: string): string {
  const key = createHmac("sha256", secret).update(`reset:${tenantId}`).digest();
  return createHmac("sha256", key).update(`${userId}:${code}`).digest("base64url");
}

/** Drops rows with nothing left to do: no live code, and nothing issued within the hour to throttle. */
function prune(identity: Identity, now: number) {
  identity.resets = identity.resets.filter(
    (r) =>
      (r.codeHash !== "" && Date.parse(r.expiresAt) > now) ||
      r.issuedAt.some((t) => now - Date.parse(t) < HOUR_MS),
  );
}

function resetLink(base: string, email: string, code: string): string {
  if (!base) return "";
  const url = new URL(base);
  url.hash = new URLSearchParams({ email, code }).toString();
  return url.toString();
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function resetEmail(to: string, code: string, link: string): EmailMessage {
  const minutes = CODE_TTL_MS / 60_000;
  const text = [
    `Your password reset code is ${code}.`,
    `It expires in ${minutes} minutes and works once.`,
    ...(link ? [`Or choose a new password here: ${link}`] : []),
    "If you did not ask to reset your password, ignore this email — your password has not changed.",
  ].join("\n\n");
  const html = [
    `<p>Your password reset code is <strong style="font-size:1.25em;letter-spacing:0.1em">${code}</strong>.</p>`,
    `<p>It expires in ${minutes} minutes and works once.</p>`,
    ...(link ? [`<p><a href="${escapeHtml(link)}">Choose a new password</a></p>`] : []),
    "<p>If you did not ask to reset your password, ignore this email — your password has not changed.</p>",
  ].join("\n");
  return { to, subject: "Your password reset code", text, html };
}

export async function forgotPassword<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { tenantId, tenant, host } = ctx;
  const { email } = body;
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return err(400, "valid email required");

  // Said the same for every address, so it tells a caller nothing about who has an account.
  const emailReady = host.emailConfigured(tenant);
  if (!emailReady && !LOG_RESET_CODES)
    return err(404, "password reset is not configured for this project: set RESEND_API_KEY");

  const accepted = () =>
    json({ ok: true, message: "If that email has an account, a reset code is on its way." }, 202);

  const user = findByEmail(tenant.identity, email);
  if (!user) return accepted();
  const userId = String(user.id);

  const now = Date.now();
  prune(tenant.identity, now);
  const previous = tenant.identity.resets.find((r) => r.userId === userId);
  const recent = (previous?.issuedAt ?? []).filter((t) => now - Date.parse(t) < HOUR_MS);
  // Throttled quietly: a 429 only an existing account could earn would give the account away.
  if (recent.length >= MAX_CODES_PER_HOUR) return accepted();

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const entry: ResetEntry = {
    userId,
    codeHash: codeHash(host.secret, tenantId, userId, code),
    expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
    attempts: 0,
    issuedAt: [...recent, new Date(now).toISOString()],
  };
  tenant.identity.resets = [...tenant.identity.resets.filter((r) => r.userId !== userId), entry];
  await host.saveResets(tenantId, tenant);

  const link = resetLink(tenant.config.auth.resetUrl, user.email, code);
  if (LOG_RESET_CODES)
    console.log(`[core] ${tenantId}: password reset code for ${user.email} is ${code}${link ? ` — ${link}` : ""}`);
  if (emailReady) {
    const sent = await host.sendEmail(tenant, resetEmail(user.email, code, link));
    if (!sent.ok) return err(502, `email provider rejected the request (${sent.status ?? "unreachable"})`);
  }
  return accepted();
}

export async function resetPassword<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { tenantId, tenant, host } = ctx;
  const { email, code, password } = body;
  if (typeof email !== "string" || !EMAIL_RE.test(email)) return err(400, "valid email required");
  if (typeof code !== "string" || !CODE_RE.test(code))
    return err(400, "code must be the 6-digit code from the reset email");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) return err(400, PASSWORD_RULE);

  // One answer for every way a code can be wrong, so none of them can be told apart.
  const invalid = () => err(400, "invalid or expired reset code");
  const user = findByEmail(tenant.identity, email);
  const entry = user ? tenant.identity.resets.find((r) => r.userId === String(user.id)) : undefined;
  if (!user || !entry || entry.codeHash === "" || Date.parse(entry.expiresAt) <= Date.now()) return invalid();

  const given = Buffer.from(codeHash(host.secret, tenantId, String(user.id), code), "base64url");
  const stored = Buffer.from(entry.codeHash, "base64url");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    entry.attempts += 1;
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.codeHash = "";
      entry.expiresAt = new Date().toISOString();
    }
    await host.saveResets(tenantId, tenant);
    return invalid();
  }

  // Spent before anything yields: two requests racing with the same code must
  // not both get past this line, and setPassword awaits a hash.
  entry.codeHash = "";
  entry.expiresAt = new Date().toISOString();
  void host.saveResets(tenantId, tenant);

  await setPassword(ctx, user, password);
  return signedIn(ctx, user);
}
