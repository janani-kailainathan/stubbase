// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import { readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIndexed, isReleased, normalizePath } from './src/lib/released.ts';

/**
 * A guide is written before its screenshots exist, so every figure ships as
 * a drawn frame (`figure.shot--pending`) until an <img> replaces it. That is
 * invisible to a build that only reports errors, so count the frames still
 * empty and say so once, at the end.
 */
function pendingShots() {
  const pending = [];
  for (const dir of ['src/content/guides', 'src/content/user-guide']) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      const frontmatter = text.split('\n---')[0];
      // A `hero` without a `src` is drawn as a pending frame too.
      const heroPending = /^hero:/m.test(frontmatter) && !/^\s+src:/m.test(frontmatter);
      const frames = (text.match(/shot--pending/g)?.length ?? 0) + (heroPending ? 1 : 0);
      if (frames) pending.push(`${file}: ${frames}`);
    }
  }
  return pending;
}

/**
 * Ships only the pages src/lib/released.ts lists. Every page is built, so an
 * unreleased one still compiles; this deletes its HTML from dist/ afterwards,
 * which is all Caddy serves, so its URL answers with the site's 404. 404.html
 * and every asset stay.
 *
 * Then it fails the build if a released page links to one it just removed —
 * a link that would quietly become a 404 in production. It deletes first and
 * checks second on purpose: a failed build leaves dist/ in place, and that
 * dist/ must never be the unfiltered site. The bare "/" is exempt from both:
 * it is the redirect to the students page (see `redirects` below), not a page.
 */
function releasePages() {
  return {
    name: 'stubbase:release',
    hooks: {
      'astro:build:done': ({ dir, pages, logger }) => {
        const root = fileURLToPath(dir);
        const paths = pages
          .map((page) => normalizePath('/' + page.pathname))
          .filter((path) => path !== '/404' && path !== '/');
        const fileOf = (path) => join(root, path, 'index.html');

        const removed = new Set(paths.filter((path) => !isReleased(path)));
        for (const path of removed) {
          rmSync(fileOf(path), { force: true });
          // Drop directories the page leaves empty; one holding assets stays.
          for (let folder = dirname(fileOf(path)); folder !== root; folder = dirname(folder)) {
            try {
              rmdirSync(folder);
            } catch {
              break;
            }
          }
        }
        logger.info(`shipped ${paths.length - removed.size} of ${paths.length} pages; the rest are unreleased (src/lib/released.ts)`);

        const broken = [];
        for (const path of paths.filter((path) => !removed.has(path))) {
          const html = readFileSync(fileOf(path), 'utf8');
          for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
            const url = new URL(href, `https://stubbase.dev${path}/`);
            if (url.hostname !== 'stubbase.dev') continue;
            const target = normalizePath(url.pathname);
            if (target !== '/' && removed.has(target)) broken.push(`${path} → ${target}`);
          }
        }
        if (broken.length > 0) {
          throw new Error(
            `released pages link to unreleased ones, which 404 in production — release the target in src/lib/released.ts or drop the link:\n  ${[...new Set(broken)].join('\n  ')}`,
          );
        }
      },
    },
  };
}

// https://astro.build/config
export default defineConfig({
  site: 'https://stubbase.dev',

  // The bare root opens the students page, here as well as in Caddy, so
  // `astro dev` answers "/" exactly as production does. Caddy's 302 is what
  // production clients see; the static build's stub for it (a meta refresh)
  // is what anything serving dist/ without Caddy gets. The home page itself
  // lives at /home, unreleased.
  redirects: {
    '/': { status: 302, destination: '/uses/ai-backend-generator-for-students' },
  },

  // Markdown fences in src/content/** are highlighted at build time by Shiki —
  // no client JS, and the same theme pair CodeBlock.astro uses on the hub pages.
  //
  // `defaultColor: 'dark'` makes Shiki write the DARK color inline and expose the
  // light one as `--shiki-light`. That direction matters: it means a page with no
  // JS (or a crawler that does not run it) shows exactly what this site showed
  // before light mode existed, and light is the layer that overrides. global.css
  // does that override.
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: 'dark',
      wrap: false,
    },
  },

  vite: {
    plugins: [tailwindcss()],

    // One Tap posts its credential to /auth/google/one-tap on *this* origin,
    // because the g_csrf_token cookie GSI sets is host-only and never reaches
    // a sibling subdomain. Hand that one path to the Dashboard API, exactly as
    // the Caddyfiles do for docker and production.
    server: {
      proxy: {
        '/auth/google/one-tap': 'http://127.0.0.1:3001',
      },
    },
  },

  integrations: [
    // Only the released pages that may be indexed (src/lib/released.ts).
    sitemap({ filter: (page) => isIndexed(page) }),
    releasePages(),
    {
      name: 'stubbase:pending-shots',
      hooks: {
        'astro:build:done': ({ logger }) => {
          const pending = pendingShots();
          if (pending.length === 0) return;
          logger.warn(
            `guides with screenshot frames still empty — ${pending.join(', ')}`,
          );
        },
      },
    },
  ]
});