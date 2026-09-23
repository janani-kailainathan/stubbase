#!/usr/bin/env bun
/**
 * Refreshes the vendored disposable-email domain list.
 *
 *   bun run scripts/refresh-email-domains.ts           # fetch upstream, rewrite both copies
 *   bun run scripts/refresh-email-domains.ts --check   # CI: are the two copies identical?
 *
 * Two apps read this list and they cannot share a file: each Dockerfile's build
 * context is its own app directory, so a copy lives under apps/core/ and another
 * under apps/dashboard-api/. That duplication is the reason this script exists —
 * two files that must agree, kept in step by one command rather than by memory.
 *
 * Deliberately NOT part of the build, for the same reason ai-summary.ts is not:
 * a build that fetched a list off the internet would be non-reproducible, would
 * fail on a machine with no network, and would quietly change who may sign up.
 * Refreshing is an explicit act whose output is committed data.
 *
 * `--check` compares the two copies to each other, not to the internet, so CI
 * stays offline and deterministic. It catches the failure that actually
 * happens: someone edits one copy, or adds a file to one app and not the other.
 * Whether the snapshot has aged is a judgement call for whoever runs the fetch.
 *
 * READ THE DIFF BEFORE COMMITTING A REFRESH. These community lists
 * occasionally sweep in a real provider, and this decides who can open an
 * account — on the dashboard, and on every project that switched the block on.
 * The script refuses a list that has lost a big share of its domains or that
 * names a well-known provider, but it cannot know about yours.
 */
const SOURCE = "https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt";
const LICENCE = "https://github.com/disposable/disposable-email-domains (MIT)";
const COPIES = ["apps/core/blocked-email-domains.txt", "apps/dashboard-api/blocked-email-domains.txt"];

/**
 * Public suffixes: registries, not registrable domains. One of these on the
 * list would refuse every address under it, because the matcher walks a
 * domain's parents. Its floor of two labels stops a bare "com" but cannot stop
 * "co.uk", so that job is here.
 */
const PUBLIC_SUFFIXES = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "com.br", "com.mx", "com.ar", "co.za", "co.in", "co.jp", "ne.jp", "or.jp",
  "com.cn", "edu.cn", "com.tr", "edu.pl", "com.pl", "org.pl", "co.kr", "com.sg", "com.hk",
  "biz.id", "co.id", "ac.id", "com.es", "com.pt", "com.ua", "co.il", "com.my", "com.ph",
];

/** Providers that must never be on the list. A hit means the upstream list is wrong, not that we are. */
const MUST_NOT_BLOCK = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.de", "web.de", "mail.ru", "yandex.ru", "qq.com", "163.com", "naver.com",
  "fastmail.com", "zoho.com", "tutanota.com", "posteo.de", "mailbox.org",
];

const header = (count: number) =>
  [
    "# Disposable / throwaway email domains, refused at Stubbase sign-up.",
    "#",
    `# Source:  ${LICENCE}`,
    "# File:    domains.txt",
    `# Vendored: ${new Date().toISOString().slice(0, 10)}`,
    `# Domains: ${count}`,
    "#",
    "# One domain per line, lower-case, sorted, comments and blank lines ignored.",
    "# A sign-up is refused when its domain, or any parent of it down to two",
    "# labels, appears here — so listing mailinator.com also covers",
    "# anything.mailinator.com.",
    "#",
    "# This is a snapshot, not a feed: nothing fetches it at run time. Refresh it",
    "# with `bun run scripts/refresh-email-domains.ts`, which rewrites both copies",
    "# (the core's and the Dashboard API's — their build contexts cannot share one).",
    "#",
    "# Before committing a refresh, diff it and check that no real provider has",
    "# been swept in — these community lists occasionally add one by mistake.",
    "# A domain can be let through without a redeploy: the dashboard's own",
    "# sign-up has DASHBOARD_EMAIL_DOMAIN_ALLOWLIST, a project has",
    "# AUTH_EMAIL_DOMAINS_ALLOWED.",
    "",
  ].join("\n");

const domainsOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));

if (process.argv.includes("--check")) {
  const read = await Promise.all(COPIES.map(async (p) => ({ path: p, file: Bun.file(p) })));
  for (const { path, file } of read)
    if (!(await file.exists())) {
      console.error(`[domains] missing: ${path}`);
      process.exit(1);
    }
  const [a, b] = await Promise.all(read.map(({ file }) => file.text()));
  const [da, db] = [domainsOf(a!), domainsOf(b!)];
  if (da.length !== db.length || da.some((d, i) => d !== db[i])) {
    const onlyA = da.filter((d) => !db.includes(d)).slice(0, 5);
    const onlyB = db.filter((d) => !da.includes(d)).slice(0, 5);
    console.error(`[domains] the two copies differ: ${da.length} vs ${db.length} domains`);
    if (onlyA.length) console.error(`  only in ${COPIES[0]}: ${onlyA.join(", ")}`);
    if (onlyB.length) console.error(`  only in ${COPIES[1]}: ${onlyB.join(", ")}`);
    console.error("  run: bun run scripts/refresh-email-domains.ts");
    process.exit(1);
  }
  console.log(`[domains] both copies agree — ${da.length} domains`);
  process.exit(0);
}

console.log(`[domains] fetching ${SOURCE}`);
const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) {
  console.error(`[domains] upstream answered ${res.status}`);
  process.exit(1);
}
const fetched = [...new Set(domainsOf(await res.text()))].sort();

// Sanity, because this decides who may open an account.
const malformed = fetched.filter((d) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
const bareTld = fetched.filter((d) => !d.includes("."));
const wrong = MUST_NOT_BLOCK.filter((d) => fetched.includes(d));
const suffixes = PUBLIC_SUFFIXES.filter((d) => fetched.includes(d));
const existing = await Bun.file(COPIES[0]!).exists() ? domainsOf(await Bun.file(COPIES[0]!).text()).length : 0;

if (wrong.length) {
  console.error(`[domains] refusing: upstream now lists real providers — ${wrong.join(", ")}`);
  process.exit(1);
}
if (suffixes.length) {
  console.error(`[domains] refusing: upstream lists public suffixes, which would block every domain under them — ${suffixes.join(", ")}`);
  process.exit(1);
}
if (bareTld.length) {
  console.error(`[domains] refusing: bare TLDs would block everything under them — ${bareTld.slice(0, 5).join(", ")}`);
  process.exit(1);
}
if (existing && fetched.length < existing * 0.8) {
  console.error(`[domains] refusing: ${fetched.length} domains is far below the ${existing} vendored now`);
  console.error("  upstream may be truncated; check it by hand before forcing this through");
  process.exit(1);
}
if (malformed.length)
  console.warn(`[domains] skipping ${malformed.length} malformed entries, e.g. ${malformed.slice(0, 3).join(", ")}`);

const keep = fetched.filter((d) => !malformed.includes(d));
const body = header(keep.length) + keep.join("\n") + "\n";
for (const path of COPIES) await Bun.write(path, body);
console.log(`[domains] wrote ${keep.length} domains to ${COPIES.length} copies (was ${existing})`);
