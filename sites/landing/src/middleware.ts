import { defineMiddleware } from 'astro:middleware';
import { isReleased, normalizePath } from './lib/released';

/**
 * `astro dev` answers an unreleased page with the site's 404, as production
 * does once the build's stubbase:release step has removed it (see
 * src/lib/released.ts) — so what you click through locally is what ships.
 * Run the dev server with PREVIEW_UNRELEASED=true to open them anyway while
 * you work on one.
 *
 * Dev only. The static build prerenders every page through this middleware,
 * and must still build the unreleased ones, so it never acts there.
 */
const preview = process.env.PREVIEW_UNRELEASED === 'true';

export const onRequest = defineMiddleware(async (context, next) => {
  if (!import.meta.env.DEV || preview) return next();
  const path = normalizePath(context.url.pathname);
  // "/" is the redirect to the students page, and /_… are Astro's own routes.
  if (path === '/' || path === '/404' || path.startsWith('/_') || isReleased(path)) return next();
  const notFound = await context.rewrite('/404');
  return new Response(notFound.body, { status: 404, headers: notFound.headers });
});
