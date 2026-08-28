#!/usr/bin/env bun
/**
 * Generates the "AI Summary" panel that opens each guide.
 *
 *   bun run scripts/ai-summary.ts                      # every guide missing one
 *   bun run scripts/ai-summary.ts <slug> [<slug>...]   # named guides, re-generated
 *   bun run scripts/ai-summary.ts --all                # re-generate everything
 *   bun run scripts/ai-summary.ts --check              # CI: is any guide stale?
 *
 * Deliberately NOT part of the site build. The landing site is static and
 * builds without secrets; a build that phoned an AI provider would be
 * non-reproducible, would fail on any machine without a key, and would spend
 * money every time someone fixed a typo. So generation is an explicit act and
 * its output is committed content: the summary lands in the post's own
 * frontmatter, gets reviewed in the diff like prose, and the site renders it
 * with no key present.
 *
 * `bodyHash` is what makes the panel honest. It records the body the summary
 * was written from, so `--check` can tell a summary that still describes the
 * post from one that describes an older draft.
 *
 * Reads GOOGLE_AI_API_KEY (repo-root .env, auto-loaded by Bun) and the same
 * AI_MODEL_NAME as the dashboard. Zero npm dependencies, like everything else.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const POSTS_DIR = "sites/landing/src/content/guides";
const BASE_URL = (process.env.AI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const MODEL = (process.env.AI_MODEL_NAME ?? "models/gemini-3.5-flash-lite").replace(/^models\//, "");
const API_KEY = process.env.GOOGLE_AI_API_KEY ?? "";

const PROMPT = `You are summarising a technical how-to article for developers, for a short panel at the very top of the page.

Write 2 to 3 sentences, 45 words at most, in plain prose. Rules:
- State what the reader will be able to do when they finish, and name the concrete things the article covers (the consoles, the values, the config keys).
- Use the article's own vocabulary. Never invent a fact, a number, or a capability the article does not state.
- No marketing language, no "in this article", no "this guide will", no first person, no bullet points, no headings.
- Plain sentences only. No Markdown.

Return the summary text and nothing else.`;

interface Post {
  slug: string;
  path: string;
  raw: string;
  frontmatter: string;
  body: string;
}

const bodyHash = (body: string) => createHash("sha256").update(body.trim()).digest("hex").slice(0, 12);

async function loadPosts(): Promise<Post[]> {
  const names = (await readdir(POSTS_DIR)).filter((n) => n.endsWith(".md"));
  return Promise.all(
    names.map(async (name) => {
      const path = join(POSTS_DIR, name);
      const raw = await Bun.file(path).text();
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error(`${name}: no frontmatter block`);
      return { slug: name.replace(/\.md$/, ""), path, raw, frontmatter: match[1], body: match[2] };
    }),
  );
}

const readField = (frontmatter: string, key: string): string | null => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(?:'([^']*)'|"([^"]*)"|(.*))$`, "m"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
};

/** Replaces a frontmatter field, or appends it when absent. Quotes with `'`. */
function writeField(frontmatter: string, key: string, value: string): string {
  const line = `${key}: '${value.replace(/'/g, "''")}'`;
  const re = new RegExp(`^${key}:.*$`, "m");
  return re.test(frontmatter) ? frontmatter.replace(re, line) : `${frontmatter}\n${line}`;
}

const isStale = (post: Post) =>
  !readField(post.frontmatter, "aiSummary") ||
  readField(post.frontmatter, "aiSummaryHash") !== bodyHash(post.body);

async function summarise(post: Post): Promise<string> {
  const res = await fetch(`${BASE_URL}/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${PROMPT}\n\n---\n\n${post.body}` }] }],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 512 },
    }),
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS ?? 60_000)),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`provider returned ${res.status}: ${raw.slice(0, 300)}`);
  const text = JSON.parse(raw)?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === "string")?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("provider returned no text");

  // One paragraph, no stray Markdown, no smart quotes that would break the
  // single-quoted YAML scalar this lands in.
  return text
    .trim()
    .replace(/\s*\n+\s*/g, " ")
    .replace(/^["'`*#\s]+|["'`*\s]+$/g, "")
    .replace(/[“”]/g, '"')
    .trim();
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const all = args.includes("--all");
const named = args.filter((a) => !a.startsWith("--"));

const posts = await loadPosts();
const targets = named.length > 0 ? posts.filter((p) => named.includes(p.slug)) : posts;
if (named.length > 0 && targets.length !== named.length) {
  const missing = named.filter((slug) => !posts.some((p) => p.slug === slug));
  console.error(`unknown guide(s): ${missing.join(", ")}`);
  process.exit(1);
}

if (check) {
  const stale = targets.filter(isStale);
  for (const post of stale) console.error(`stale AI summary: ${post.slug}`);
  console.log(stale.length === 0 ? `✓ ${targets.length} post(s) have a current AI summary` : "");
  process.exit(stale.length === 0 ? 0 : 1);
}

const todo = all || named.length > 0 ? targets : targets.filter(isStale);
if (todo.length === 0) {
  console.log(`✓ nothing to do — ${targets.length} post(s) already summarised (--all to redo)`);
  process.exit(0);
}
if (!API_KEY) {
  console.error("GOOGLE_AI_API_KEY is not set — add it to the repo-root .env");
  process.exit(1);
}

for (const post of todo) {
  process.stdout.write(`${post.slug} … `);
  const summary = await summarise(post);
  let frontmatter = writeField(post.frontmatter, "aiSummary", summary);
  frontmatter = writeField(frontmatter, "aiSummaryModel", MODEL);
  frontmatter = writeField(frontmatter, "aiSummaryHash", bodyHash(post.body));
  await Bun.write(post.path, `---\n${frontmatter}\n---\n${post.body}`);
  console.log(`${summary.split(/\s+/).length} words`);
}
console.log(`\nwrote ${todo.length} summar${todo.length === 1 ? "y" : "ies"} — review the diff before committing`);
