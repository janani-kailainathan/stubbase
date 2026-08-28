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

/**
 * Guides. A guide is a spoke like any other — same SEO fields, same strict
 * schema — plus the three things a dated article has and a reference page does
 * not: a date, a byline, and screenshots.
 *
 * They live under /guides rather than /blog on purpose. These are evergreen
 * procedures, and a `blog` URL tells a reader and a crawler the opposite: that
 * the page is chronological and ages. /blog stays free for the day there is
 * something genuinely dated to publish.
 *
 * Screenshots inside the body are not declared here: `::shot <file> | <caption>`
 * in the Markdown resolves against `public/guides/<slug>/` at build time (see
 * src/lib/remark-shot.mjs), so a post can ship its prose before its images and
 * fill in later by dropping files into a folder. `hero` is the exception, since
 * the layout places it above the article rather than in the flow.
 */
const guideSchema = seoSchema.extend({
  publishedAt: z.coerce.date(),
  updatedAt: z.coerce.date().optional(),
  /** Byline. Organization by default — see PRODUCT.md's brand commitments. */
  author: z.string().default('Stubbase'),
  /** Sits under the title, in the reader's own words, for the index listing. */
  summary: z.string(),
  tags: z.array(z.string()).default([]),
  hero: z
    .object({
      src: z.string().optional(),
      alt: z.string(),
      caption: z.string().optional(),
    })
    .optional(),
  /**
   * The "AI Summary" panel, written by `scripts/ai-summary.ts` and committed
   * with the post. Generation is never part of the build — see that script for
   * why — so these are ordinary content fields by the time Astro sees them.
   * `aiSummaryHash` fingerprints the body the summary was written from, which
   * is what lets `--check` catch a summary describing an older draft.
   */
  aiSummary: z.string().optional(),
  aiSummaryModel: z.string().optional(),
  aiSummaryHash: z.string().optional(),
  /** Card tile override. Absent = the typographic tile the index draws. */
  thumbnail: z.string().optional(),
  draft: z.boolean().default(false),
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
  guides: defineCollection({
    loader: glob({ pattern: '**/[^_]*.md', base: './src/content/guides' }),
    schema: guideSchema,
  }),
  'use-cases': segmentCollection('use-cases'),
  roles: segmentCollection('roles'),
  features: spokeCollection('features'),
  compare: spokeCollection('compare'),
};
