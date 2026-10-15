/**
 * The pages search engines may index. Every other page is still built and
 * still served, but carries `noindex` (BaseLayout) and is left out of the
 * sitemap (astro.config.mjs), so it drops out of results without breaking
 * a link anyone already has. To bring a page back, add its path here.
 *
 * robots.txt deliberately does not Disallow the rest: a crawler blocked there
 * never fetches the page, never sees its noindex, and can keep an already
 * indexed URL in results indefinitely.
 */
export const INDEXED_PATHS = ['/uses/ai-backend-generator-for-students'];

/** Whether a path (or a full URL), with or without its trailing slash, is indexed. */
export function isIndexed(pathOrUrl: string): boolean {
  const path = new URL(pathOrUrl, 'https://stubbase.dev').pathname.replace(/\/+$/, '') || '/';
  return INDEXED_PATHS.includes(path);
}
