---
version: 1
slug: "sites-landing-src-layouts-guidelayout-astro"
primary_target: "sites/landing/src/layouts/GuideLayout.astro"
related_targets: ["sites/landing/src/pages/guides/index.astro"]
---

## Scope

`/guides` and `/guides/<slug>` on the landing site: index, guide template, and
the Markdown collection behind them.

The route is `/guides`, not `/blog`: this content is evergreen procedure, and a
`blog` URL tells a reader and a crawler that the page is chronological and
ages. `/blog` stays unclaimed for genuinely dated posts, which is also why the
schema is TechArticle rather than BlogPosting — the same type the Features and
Compare spokes emit.

## Visitor mode

Read. The visitor arrives mid-task from a search, with a provider console open
in the next tab. Comprehension and wayfinding outrank expression; the post is a
procedure, and the page's job is to be followed, not admired.

## Audience and job

Developers adding social login to an API they are building. They need four
values out of two consoles and the exact place those values go. Success is the
reader closing the tab because the login works.

## Structure

Pinned by the brief to the reference blog's (xmind.com/blog).

**Index:** centered masthead over a search field, the newest post as one wide
feature, a three-up grid, then a closing panel inside crop marks. The footer's
own CTA is deliberately unused here — two closing calls to action read as two
footers. Search appears at 6 posts, Load more past 9; below those counts
neither ships, because a control that filters one card is furniture.

**Guide:** article column at a 3xl measure with a sticky contents rail at 15rem,
which tracks the reader's position and ends in the page's one CTA. Below `lg`
the rail is replaced by an inline contents list. Order is title, byline, AI
summary, hero, prose — the summary sits above the hero on purpose, since a
summary you scroll past a screenshot to reach is not one.

## Conventions this route owns

- **Byline is the organisation** ("Stubbase"), never a person. JSON-LD author is
  an Organization; changing this changes the schema, not just the label.
- **`dateModified` is always emitted**, falling back to the publish date.
  Answer engines weigh it when deciding whether a procedure still describes the
  world, so bump it when a console gets renamed under you.
- **Screenshots arrive after the prose.** `<figure class="shot shot--pending">`
  ships a drawn frame naming the file it waits for; swapping in `<img>` is the
  only edit. The build warns while any frame is still empty.
- **Discovery is the footer only**, under Resources. The header stays unchanged
  until the set is large enough to earn a top-level slot.
- Guides are the one collection carrying a date, so anything sorted or dated on
  this site sorts by `publishedAt`, newest first.
- **Card artwork is drawn, never photographed.** `.post-tile` sets the post's
  own title and tag on a tinted ground, so the grid is complete the moment a
  post exists; `thumbnail` overrides it per post.
- **The AI summary is generated out of band and committed** (`scripts/ai-summary.ts`),
  never at build time, and the panel names the model that wrote it. A panel
  labelled "AI Summary" that a human wrote would be a false provenance claim,
  which is why the label and the pipeline were decided together.

## Unresolved

- No DESIGN.md exists for the site; this route inherits the world from code
  (`src/styles/global.css`) rather than a document.
- Guide two is unplanned. With one entry the index is masthead, feature and
  closing panel; the grid, search and Load more only appear as the set grows.
- Nothing is deployed yet, which is why the route could be renamed for free.
  After launch this decision costs redirects.
