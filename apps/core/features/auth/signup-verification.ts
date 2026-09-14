/**
 * Email verification: a password sign-up becomes an account only once the code
 * sent to its address comes back.
 *
 *   POST /auth/signup          { email, password, name? }  → 202 { verificationId, email, expiresIn, delivery }
 *   POST /auth/signup/verify   { verificationId, code }    → 201 { token, refreshToken, expiresIn, user }
 *   POST /auth/signup/resend   { verificationId }          → 202, a new code replaces the last
 *
 * On whenever AUTH_ENABLED is, unless AUTH_EMAIL_VERIFICATION=false. The code
 * is emailed through the project's Resend key, or put in the project's request
 * log when it has none (codes.ts).
 *
 * Until the code comes back nothing is written to users.json: the pending
 * sign-up waits in signups.json. OAuth links accounts by email, so an
 * unverified account there would belong to whoever signed up first with your
 * address — including when you later arrive through Google.
 *
 * The rules, each load-bearing:
 *   - a code, never a link, bound to the sign-up's id, which only the caller who
 *     signed up is given. A new sign-up for the address replaces the old one,
 *     so a mailbox can hold two codes; the id is what stops the code for
 *     somebody else's sign-up — and their password — completing yours;
 *   - a correct code removes the pending sign-up and creates the account in one
 *     synchronous turn, so two racing requests cannot both use it, and an
 *     account that appeared in the meantime (through OAuth) wins with 409;
 *   - a code lives CODE_TTL_MS and MAX_ATTEMPTS wrong guesses spend it; the
 *     sign-up itself lasts PENDING_TTL_MS however many codes it is sent;
 *   - at most MAX_CODES_PER_HOUR codes per address per hour, sign-ups and
 *     resends together. The count is persisted in the row, and a new sign-up
 *     carries it over, so neither signing up again nor an eviction resets it;
 *   - one error answers every way a code can be wrong.
 */
import { err, json, withLogNote } from "../../lib/http.ts";
import { newTimestamps } from "../../lib/timestamps.ts";
import {
  CODE_RE,
  CODE_TTL_MS,
  HOUR_MS,
  MAX_ATTEMPTS,
  MAX_CODES_PER_HOUR,
  codeHash,
  codeNote,
  escapeHtml,
  iso,
  newCode,
  recentIssues,
  sameCode,
  sendCode,
} from "./codes.ts";
import { findByEmail, signedIn, type AuthContext, type Fields } from "./identity.ts";
import type { AuthTenant, EmailMessage, Identity, SignupEntry, UserRecord } from "./types.ts";

const PENDING_TTL_MS = 24 * HOUR_MS;

const isLive = (s: SignupEntry, now: number) => Date.parse(s.expiresAt) > now;

const findPending = (identity: Identity, email: string) =>
  identity.signups.find((s) => s.email.toLowerCase() === email.toLowerCase());

/** Drops sign-ups that can no longer complete and have nothing left to throttle. */
function prune(identity: Identity, now: number) {
  identity.signups = identity.signups.filter((s) => isLive(s, now) || recentIssues(s.issuedAt, now).length > 0);
}

const tooMany = () => err(429, "too many verification codes for this address; try again later");

/** Whether an address has used up its codes for the hour — checked before a sign-up pays for its hash. */
export function signupThrottled(identity: Identity, email: string): boolean {
  const pending = findPending(identity, email);
  return recentIssues(pending?.issuedAt ?? [], Date.now()).length >= MAX_CODES_PER_HOUR;
}

/** The sign-up an address is still waiting to verify, if any — so login can say why it refuses. */
export function pendingSignupFor(identity: Identity, email: string): SignupEntry | undefined {
  const pending = findPending(identity, email);
  return pending && isLive(pending, Date.now()) ? pending : undefined;
}

function verificationEmail(to: string, code: string): EmailMessage {
  const minutes = CODE_TTL_MS / 60_000;
  const text = [
    `Your verification code is ${code}.`,
    `Enter it to finish creating your account. It expires in ${minutes} minutes.`,
    "If you did not sign up, ignore this email — no account has been created.",
  ].join("\n\n");
  const html = [
    `<p>Your verification code is <strong style="font-size:1.25em;letter-spacing:0.1em">${escapeHtml(code)}</strong>.</p>`,
    `<p>Enter it to finish creating your account. It expires in ${minutes} minutes.</p>`,
    "<p>If you did not sign up, ignore this email — no account has been created.</p>",
  ].join("\n");
  return { to, subject: "Your verification code", text, html };
}

/** Sends a sign-up's freshly issued code and answers with what the client needs to finish. */
async function deliver<T extends AuthTenant>(ctx: AuthContext<T>, entry: SignupEntry, code: string): Promise<Response> {
  const delivery = await sendCode(ctx.host, ctx.tenant, verificationEmail(entry.email, code));
  if (delivery instanceof Response) return delivery;
  const res = json(
    {
      verificationRequired: true,
      verificationId: entry.id,
      email: entry.email,
      expiresIn: CODE_TTL_MS / 1000,
      delivery,
      message:
        delivery === "email"
          ? "We sent a 6-digit code to that address. Send it with the verificationId to /auth/signup/verify to finish signing up."
          : "This project has no email provider, so the 6-digit code is in the project's logs. Send it with the verificationId to /auth/signup/verify to finish signing up.",
    },
    202,
  );
  return delivery === "logs" ? withLogNote(res, codeNote("Sign-up verification", entry.email, code)) : res;
}

/**
 * Called by signup once the password is hashed and the address is known to be
 * free. From here to the new row is synchronous, so the hourly count cannot be
 * raced by sign-ups arriving together.
 */
export async function startSignup<T extends AuthTenant>(
  ctx: AuthContext<T>,
  email: string,
  name: string | undefined,
  passwordHash: string,
): Promise<Response> {
  const { tenantId, tenant, host } = ctx;
  const now = Date.now();
  prune(tenant.identity, now);
  const previous = findPending(tenant.identity, email);
  const recent = recentIssues(previous?.issuedAt ?? [], now);
  if (recent.length >= MAX_CODES_PER_HOUR) return tooMany();

  const id = crypto.randomUUID();
  const code = newCode();
  const entry: SignupEntry = {
    id,
    email,
    ...(name ? { name } : {}),
    passwordHash,
    codeHash: codeHash(host.secret, "signup", tenantId, id, code),
    codeExpiresAt: iso(now + CODE_TTL_MS),
    attempts: 0,
    issuedAt: [...recent, iso(now)],
    createdAt: iso(now),
    expiresAt: iso(now + PENDING_TTL_MS),
  };
  // Replaced, not added to: the previous sign-up's id stops working here.
  tenant.identity.signups = [...tenant.identity.signups.filter((s) => s !== previous), entry];
  await host.saveSignups(tenantId, tenant);
  return deliver(ctx, entry, code);
}

export async function verifySignup<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { tenantId, tenant, host } = ctx;
  const { verificationId, code } = body;
  if (typeof verificationId !== "string" || verificationId === "") return err(400, "verificationId is required");
  if (typeof code !== "string" || !CODE_RE.test(code))
    return err(400, "code must be the 6-digit code from the verification email");

  // One answer for every way a code can be wrong, so none of them can be told apart.
  const invalid = () => err(400, "invalid or expired verification code");
  const now = Date.now();
  const entry = tenant.identity.signups.find((s) => s.id === verificationId);
  if (!entry || !isLive(entry, now) || entry.codeHash === "" || Date.parse(entry.codeExpiresAt) <= now) return invalid();

  if (!sameCode(codeHash(host.secret, "signup", tenantId, entry.id, code), entry.codeHash)) {
    entry.attempts += 1;
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.codeHash = "";
      entry.codeExpiresAt = iso(now);
    }
    await host.saveSignups(tenantId, tenant);
    return invalid();
  }

  // Nothing yields from here to the push: the sign-up is gone before a second
  // request with the same code could find it.
  tenant.identity.signups = tenant.identity.signups.filter((s) => s !== entry);
  if (findByEmail(tenant.identity, entry.email)) {
    await host.saveSignups(tenantId, tenant);
    return err(409, "email already registered");
  }
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email: entry.email,
    ...(entry.name ? { name: entry.name } : {}),
    role: host.defaultRole(tenant),
    passwordHash: entry.passwordHash,
    emailVerifiedAt: iso(now),
    ...newTimestamps(),
  };
  tenant.identity.users.push(user);
  await Promise.all([host.saveUsers(tenantId, tenant), host.saveSignups(tenantId, tenant)]);
  return signedIn(ctx, user, 201);
}

export async function resendSignupCode<T extends AuthTenant>(ctx: AuthContext<T>, body: Fields): Promise<Response> {
  const { tenantId, tenant, host } = ctx;
  const { verificationId } = body;
  if (typeof verificationId !== "string" || verificationId === "") return err(400, "verificationId is required");

  const now = Date.now();
  const entry = tenant.identity.signups.find((s) => s.id === verificationId);
  if (!entry || !isLive(entry, now)) return err(400, "invalid or expired verificationId — sign up again");
  if (findByEmail(tenant.identity, entry.email)) return err(409, "email already registered");
  const recent = recentIssues(entry.issuedAt, now);
  if (recent.length >= MAX_CODES_PER_HOUR) return tooMany();

  // The new code replaces the last one, and gets a fresh set of guesses.
  const code = newCode();
  entry.codeHash = codeHash(host.secret, "signup", tenantId, entry.id, code);
  entry.codeExpiresAt = iso(now + CODE_TTL_MS);
  entry.attempts = 0;
  entry.issuedAt = [...recent, iso(now)];
  await host.saveSignups(tenantId, tenant);
  return deliver(ctx, entry, code);
}
