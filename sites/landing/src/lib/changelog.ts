/**
 * The changelog, as data.
 *
 * A release note is a few lines that only matter in sequence, so the whole
 * history is one page reading one array — no collection, no per-entry route,
 * no SEO ambition per release. Shipping something is one object appended to
 * the top of this list.
 *
 * **A date here is the day a change reached users, never the day it was
 * built.** Stubbase has not launched, so nothing has reached anyone: the first
 * entry carries `date: null` and renders as "Unreleased" until go-live, when
 * it gets the launch date. Dating entries from commits would put a history in
 * front of readers that no user ever lived through.
 *
 * The durable artifact for a release is not the entry here: it is the feature
 * page the entry links to. Entries decay; `/features/<slug>` is what still
 * ranks in a year, so anything that changes what the product *is* gets a
 * `href` pointing at the page that describes it permanently.
 */
export type ChangeKind = 'added' | 'changed' | 'fixed';

export interface ChangeItem {
  kind: ChangeKind;
  text: string;
  /** The feature page, guide, or docs section this change is described on. */
  href?: string;
}

export interface Release {
  /** ISO date the change reached users, or null while it has not shipped. */
  date: string | null;
  /** One line naming the release, in the product's own words. */
  title: string;
  items: ChangeItem[];
}

/** Newest first. Add to the top; never rewrite history to read better. */
export const RELEASES: Release[] = [
  {
    // Set to the launch date on go-live. Everything below ships at once, so
    // until then this is one entry, not a development diary.
    date: null,
    title: 'First release',
    items: [
      {
        kind: 'added',
        text: 'The JSON-to-CRUD engine: drop in a JSON file and get a persistent REST API with relations, filtering, sorting, pagination and an OpenAPI spec — no database to configure.',
      },
      {
        kind: 'added',
        text: 'Social login for your API. Bring a Google or GitHub OAuth app and every request arrives with a signed identity and record ownership attached.',
        href: '/features/google-github-social-login',
      },
      {
        kind: 'added',
        text: 'The AI Co-Pilot: describe a schema in plain English and it stages the resources for you to review and deploy.',
        href: '/features/ai-rest-api-generation',
      },
      {
        kind: 'added',
        text: 'Draft-then-deploy editing, live request logs, usage metering and virtual start/stop, from a dashboard that never holds an admin credential.',
        href: '/features/instant-api-deployments',
      },
      {
        kind: 'added',
        text: 'MCP over HTTP and SSE, so an agent can query a project with read-only SQL using a developer API key.',
      },
      {
        kind: 'added',
        text: 'Sign in to the dashboard with Google or GitHub, alongside email and password.',
      },
    ],
  },
];
