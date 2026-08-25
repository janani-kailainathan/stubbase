// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

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

  integrations: [sitemap()]
});