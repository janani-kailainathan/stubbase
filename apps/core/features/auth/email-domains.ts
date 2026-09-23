/**
 * Which email domains may open an account on a project's API.
 *
 * Four things decide it, in this order, and each is read from the tenant's own
 * config so one project can refuse what another accepts:
 *
 *   AUTH_EMAIL_DOMAINS_ONLY      a gate — when set, nothing else may sign up
 *   AUTH_EMAIL_DOMAINS_ALLOWED   exceptions, which beat both refusals below
 *   AUTH_EMAIL_DOMAINS_BLOCKED   always refused
 *   AUTH_BLOCK_DISPOSABLE_EMAIL  the vendored throwaway-provider list
 *
 * ONLY and ALLOWED are deliberately separate keys with opposite jobs: ONLY is
 * a whitelist that refuses everything absent from it, ALLOWED only says "not
 * this one" about a domain something else would have refused. One key doing
 * both would mean a project that wanted to unblock a single false positive had
 * silently locked every other address out.
 *
 * Unlike the Dashboard API's copy of this, the core holds nothing in memory.
 * It binary-searches the sorted file by byte range — about seventeen 512-byte
 * reads, 0.4 ms, against a sign-up that already spends ~100 ms in argon2 — and
 * this process is the one caching tenant data on a single shared box, so the ~9 MB the
 * dashboard's table would have cost belongs to tenants instead. The file is a
 * committed snapshot; scripts/refresh-email-domains.ts rewrites both copies
 * and `--check` fails when they drift.
 */
import { join } from "node:path";
import type { AuthConfig } from "./types.ts";

const BLOCKED_DOMAINS_FILE = join(import.meta.dir, "..", "..", "blocked-email-domains.txt");
const file = Bun.file(BLOCKED_DOMAINS_FILE);
/** Read once at module load; 0 when the file is absent, which disables the list. */
let fileSize = 0;
try {
  fileSize = file.size;
} catch {
  fileSize = 0;
}

/** A config value that is a comma-separated domain list. `@acme.test` and `acme.test` both read the same. */
export const parseDomainList = (raw: string): Set<string> =>
  new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );

/**
 * The domain and every parent of it down to two labels, most specific first.
 * Two, because one label is a TLD: a list holding a bare "com" must not be able
 * to refuse the internet.
 */
function candidates(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i + 1 < labels.length; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * Whether the sorted file holds this exact domain.
 *
 * Each step reads a window around the midpoint and snaps to the line containing
 * it, so no index and no copy of the file is ever built. Comment and blank
 * lines are skipped forward, which is safe because the header sits above every
 * domain and sorted order is preserved either way.
 */
async function listedAsDisposable(domain: string): Promise<boolean> {
  if (fileSize === 0) return false;
  const decoder = new TextDecoder();
  let lo = 0;
  let hi = fileSize;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const from = Math.max(0, mid - 256);
    const to = Math.min(fileSize, mid + 256);
    const chunk = decoder.decode(new Uint8Array(await file.slice(from, to).arrayBuffer()));
    const rel = mid - from;
    const start = chunk.lastIndexOf("\n", rel) + 1;
    let end = chunk.indexOf("\n", start);
    if (end < 0) end = chunk.length;
    const line = chunk.slice(start, end).trim();
    if (!line || line.startsWith("#")) {
      lo = from + end + 1;
      continue;
    }
    if (line === domain) return true;
    if (line < domain) lo = from + end + 1;
    else hi = from + start;
  }
  return false;
}

/**
 * Why this address may not open an account here, or null if it may.
 *
 * The string is the refusal the caller sees, so it says which rule applied —
 * the project's owner wrote these rules and has to be able to tell from a
 * support email which one is biting.
 */
export async function signupDomainRefusal(
  email: string,
  cfg: AuthConfig,
): Promise<string | null> {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!domain) return null;
  const parents = candidates(domain);

  if (cfg.emailDomainsOnly.size > 0 && !parents.some((c) => cfg.emailDomainsOnly.has(c)))
    return "that email domain is not accepted for sign-up on this API";

  for (const candidate of parents) {
    if (cfg.emailDomainsAllowed.has(candidate)) return null;
    if (cfg.emailDomainsBlocked.has(candidate))
      return "that email domain is not accepted for sign-up on this API";
  }
  if (!cfg.blockDisposableEmail) return null;
  for (const candidate of parents)
    if (await listedAsDisposable(candidate))
      return "that email provider is not accepted: please sign up with a permanent address";
  return null;
}
