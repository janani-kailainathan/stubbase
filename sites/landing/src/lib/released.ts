/**
 * The pages that ship. Every page under src/pages is still built — so all of
 * them keep compiling and `astro dev` still shows them for preview — but the
 * `stubbase:release` step in astro.config.mjs deletes every page not listed
 * here from dist/ before deploy, so its URL is the site's 404. Releasing a
 * page is one line here: its URL, its sitemap entry and its indexing follow.
 *
 * `indexed: false` ships a page that search engines should not list (it gets
 * noindex and stays out of the sitemap) — the legal pages, which sign-up links
 * to. robots.txt never Disallows anything: a crawler blocked there never sees
 * a page's noindex and can keep an indexed URL in results indefinitely.
 *
 * The bare "/" is not here: it redirects to the students page, in
 * astro.config.mjs and in Caddy alike. The home page is /home.
 */
export const RELEASED: { path: string; indexed: boolean }[] = [
  { path: '/uses/ai-backend-generator-for-students', indexed: true },
  { path: '/terms', indexed: false },
  { path: '/privacy', indexed: false },
];

/** A path or full URL as the list spells it: no trailing slash, "/" for the root. */
export function normalizePath(pathOrUrl: string): string {
  return new URL(pathOrUrl, 'https://stubbase.dev').pathname.replace(/\/+$/, '') || '/';
}

export function isReleased(pathOrUrl: string): boolean {
  const path = normalizePath(pathOrUrl);
  return RELEASED.some((page) => page.path === path);
}

export function isIndexed(pathOrUrl: string): boolean {
  const path = normalizePath(pathOrUrl);
  return RELEASED.some((page) => page.path === path && page.indexed);
}
