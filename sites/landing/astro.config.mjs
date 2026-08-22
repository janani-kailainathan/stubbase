// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://stubbase.dev',

  // Markdown fences in src/content/** are highlighted at build time by Shiki —
  // no client JS, and the same theme CodeBlock.astro uses on the hub pages.
  markdown: {
    shikiConfig: { theme: 'github-dark', wrap: false },
  },

  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [sitemap()]
});