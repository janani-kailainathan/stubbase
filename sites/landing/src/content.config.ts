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

/**
 * Segment pages (use cases and roles) carry more than prose, because the thing
 * that makes them worth reading is the product actually doing the job. The
 * frontmatter holds that evidence as data so the layout can compose it, rather
 * than each page hand-rolling its own hero:
 *
 * - `proof` is the request/response pair that opens the page. It is the page's
 *   argument in one glance, so it is required — a segment we cannot demonstrate
 *   is a segment that does not have a page yet.
 * - `spec` is the reference table under the hero: what this segment gets, in the
 *   flat label/value form an API reference uses, because that is the form this
 *   audience already trusts.
 */
const segmentSchema = seoSchema.extend({
  /** Sort order within the nav group and any index listing. */
  order: z.number().default(50),
  /** The sentence under the H1's CTA row. Shorter and harder than `subheadline`. */
  promise: z.string(),
  cta: z
    .object({
      label: z.string(),
      href: z.string(),
    })
    .default({ label: 'Generate an API free', href: '' }),
  proof: z.object({
    /** What the reader is looking at, e.g. "Every post, with its author attached". */
    caption: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    /** Path only; the layout prefixes the API origin. */
    path: z.string(),
    /** Optional request headers, rendered above the response. */
    headers: z.array(z.string()).default([]),
    /** Response body, already formatted. Rendered in the syntax palette. */
    response: z.string(),
    /** Optional status line shown on the response, e.g. "503 Service Unavailable". */
    status: z.string().default('200 OK'),
  }),
  spec: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
      }),
    )
    .min(3)
    .max(6),
  /**
   * The body of the page, as composed bands rather than one prose column.
   *
   * A single Markdown blob renders as an article — which is exactly what these
   * pages must not read as. Sections let the layout alternate composition,
   * background and code placement down the page, so the result paces like a
   * landing page while the prose stays as easy to author as Markdown was.
   *
   *  - `split`     headline + prose beside a code panel; the side alternates.
   *  - `statement` one large line, standing alone. The rhythm break.
   *  - `steps`     an ordered sequence, numbered only because order carries meaning.
   */
  sections: z
    .array(
      z.object({
        kind: z.enum(['split', 'statement', 'steps']).default('split'),
        title: z.string().optional(),
        /** Paragraphs, split on blank lines. Supports `code` and **bold** inline. */
        body: z.string().default(''),
        bullets: z.array(z.string()).default([]),
        code: z
          .object({
            lang: z.enum(['bash', 'json', 'js', 'ts', 'sql', 'http']).default('bash'),
            caption: z.string().optional(),
            content: z.string(),
          })
          .optional(),
        steps: z
          .array(z.object({ title: z.string(), body: z.string() }))
          .default([]),
      }),
    )
    .min(2),
});

const spokeCollection = (dir: string) =>
  defineCollection({
    loader: glob({ pattern: '**/[^_]*.md', base: `./src/content/${dir}` }),
    schema: seoSchema,
  });

const segmentCollection = (dir: string) =>
  defineCollection({
    loader: glob({ pattern: '**/[^_]*.md', base: `./src/content/${dir}` }),
    schema: segmentSchema,
  });

export const collections = {
  'use-cases': segmentCollection('use-cases'),
  roles: segmentCollection('roles'),
  features: spokeCollection('features'),
  compare: spokeCollection('compare'),
};
