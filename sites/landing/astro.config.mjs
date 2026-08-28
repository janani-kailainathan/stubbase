// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A guide is written before its screenshots exist, so every figure ships as
 * a drawn frame (`figure.shot--pending`) until an <img> replaces it. That is
 * invisible to a build that only reports errors, so count the frames still
 * empty and say so once, at the end.
 */
function pendingShots() {
  const dir = 'src/content/guides';
  const pending = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const matches = readFileSync(join(dir, file), 'utf8').match(/shot--pending/g);
    if (matches) pending.push(`${file}: ${matches.length}`);
  }
  return pending;
}

// https://astro.build/config
export default defineConfig({
  site: 'https://stubbase.dev',

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
    plugins: [tailwindcss()]
  },

  integrations: [
    sitemap(),
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