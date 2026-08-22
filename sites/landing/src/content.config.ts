// Astro 7 collections config. Note the filename: `src/content/config.ts` was
// the legacy location — since Astro 5 the config lives at `src/content.config.ts`
// and every collection declares an explicit loader.
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

/**
 * Every spoke page carries the same four fields. Answer engines index the
 * structured metadata as much as the prose, so the schema is strict on purpose:
 * a missing `h1` or `subheadline` fails the build rather than shipping a page
 * with no semantic anchor.
 */
const seoSchema = z.object({
  title: z.string(),
  description: z.string(),
  h1: z.string(),
  subheadline: z.string(),
});

const spokeCollection = (dir: string) =>
  defineCollection({
    loader: glob({ pattern: '**/[^_]*.md', base: `./src/content/${dir}` }),
    schema: seoSchema,
  });

export const collections = {
  solutions: spokeCollection('solutions'),
  features: spokeCollection('features'),
  compare: spokeCollection('compare'),
};
