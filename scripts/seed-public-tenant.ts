/**
 * Seeds the `public` demo tenant — the six free resources the landing site
 * advertises (`sites/landing/src/pages/index.astro`) and the target of its
 * Home "Try it live" runner (`GET /public/users/1`).
 *
 * Data is generated from a fixed seed, so every machine gets byte-identical
 * files. `tenants/*` is gitignored (except `tenants/demo/`), so this is how the
 * tenant comes into existence locally — `scripts/dev.ts` calls it on startup.
 *
 * Run standalone:  bun run scripts/seed-public-tenant.ts [--reseed]
 */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const TENANTS_DIR = process.env.TENANTS_DIR ?? "./tenants";
const TENANT_ID = "public";

// Deterministic LCG — no RNG seeding differences between machines or runs.
let seed = 20260725;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const FIRST = [
  "Ava", "Noah", "Mia", "Liam", "Zoe", "Kai", "Ivy", "Omar", "Lena", "Theo",
  "Nina", "Ravi", "Sara", "Jonas", "Elif", "Marco", "Yuki", "Priya", "Hugo", "Clara",
] as const;
const LAST = [
  "Chen", "Okafor", "Silva", "Novak", "Haddad", "Muller", "Rossi", "Kim", "Ali", "Petrov",
  "Nakamura", "Dubois", "Andersson", "Costa", "Iqbal", "Weber", "Moreau", "Santos", "Lund", "Reyes",
] as const;
const WORDS = [
  "api", "mock", "schema", "payload", "endpoint", "sandbox", "prototype", "fixture",
  "request", "response", "record", "resource", "draft", "preview", "latency", "cursor",
  "shipping", "billing", "onboarding", "dashboard", "widget", "handoff", "rollout", "sprint",
] as const;

const words = (n: number) => range(n).map(() => pick(WORDS)).join(" ");
const sentence = (n: number) => {
  const s = words(n);
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
};
const paragraph = (n: number) => range(n).map(() => sentence(6 + Math.floor(rand() * 6))).join(" ");

const people = range(10).map((id) => {
  const first = pick(FIRST);
  const last = pick(LAST);
  return { id, first, last, username: `${first}${last}`.toLowerCase() };
});

const users = people.map((p) => ({
  id: p.id,
  name: `${p.first} ${p.last}`,
  username: p.username,
  email: `${p.username}@example.com`,
  phone: `+1-555-${String(1000 + p.id * 37).slice(0, 4)}`,
  website: `${p.username}.example.com`,
  company: `${p.last} ${pick(["Labs", "Studio", "Systems", "Works", "Collective"])}`,
  active: rand() > 0.2,
}));

const posts = range(100).map((id) => ({
  id,
  userId: ((id - 1) % 10) + 1,
  title: words(4 + Math.floor(rand() * 4)),
  body: paragraph(2),
}));

// 5 per post = 500
const comments = range(500).map((id) => {
  const postId = Math.ceil(id / 5);
  const p = pick(people);
  return {
    id,
    postId,
    name: words(3 + Math.floor(rand() * 3)),
    email: `${p.username}@example.com`,
    body: paragraph(1),
  };
});

// 10 per user = 100
const albums = range(100).map((id) => ({
  id,
  userId: Math.ceil(id / 10),
  title: words(3 + Math.floor(rand() * 3)),
}));

// 50 per album = 5000
const photos = range(5000).map((id) => ({
  id,
  albumId: Math.ceil(id / 50),
  title: words(3 + Math.floor(rand() * 3)),
  url: `https://picsum.photos/seed/stubbase-${id}/600/600`,
  thumbnailUrl: `https://picsum.photos/seed/stubbase-${id}/150/150`,
}));

// 20 per user = 200
const todos = range(200).map((id) => ({
  id,
  userId: Math.ceil(id / 20),
  title: words(3 + Math.floor(rand() * 4)),
  completed: rand() > 0.55,
}));

const RESOURCES = { posts, comments, albums, photos, todos, users };

/**
 * Writes the tenant's JSON files. No-ops when the folder already exists unless
 * `force` is set, so local edits to the demo data survive a restart.
 * Returns true when files were written.
 */
export async function seedPublicTenant(force = false): Promise<boolean> {
  const dir = join(TENANTS_DIR, TENANT_ID);
  if (!force && (await stat(dir).catch(() => null))) return false;

  await mkdir(dir, { recursive: true });
  for (const [name, rows] of Object.entries(RESOURCES)) {
    await Bun.write(join(dir, `${name}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  }
  return true;
}

if (import.meta.main) {
  const written = await seedPublicTenant(process.argv.includes("--reseed"));
  const counts = Object.entries(RESOURCES)
    .map(([name, rows]) => `${rows.length} ${name}`)
    .join(", ");
  console.log(
    written
      ? `[seed] wrote ${join(TENANTS_DIR, TENANT_ID)} — ${counts}`
      : `[seed] ${join(TENANTS_DIR, TENANT_ID)} already exists (use --reseed to overwrite)`,
  );
}
