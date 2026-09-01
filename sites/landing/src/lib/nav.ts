// Single source of truth for the hub-and-spoke navigation. Header, footer and
// the segment pages all read it, so a new spoke needs one entry here plus one
// Markdown file — that cheapness is the point, because this set is meant to
// keep growing.

/** The two audience-segmented collections. Both render through SegmentLayout. */
export type SegmentKey = 'use-cases' | 'roles';
export type NavGroupKey = SegmentKey | 'features' | 'compare';

export interface NavLink {
  href: string;
  label: string;
  /** One line, shown in the Solutions mega-menu. Keep it to a single clause. */
  blurb?: string;
}

export interface NavGroup {
  key: NavGroupKey;
  label: string;
  links: NavLink[];
}

/**
 * The Solutions panel: use cases answer "what am I doing", roles answer "who am
 * I". A visitor arrives knowing one or the other, never both, so the menu asks
 * the question twice rather than forcing one taxonomy on everyone.
 */
export const USE_CASES: NavGroup = {
  key: 'use-cases',
  label: 'Use cases',
  links: [
    {
      href: '/use-cases/mock-apis',
      label: 'Mock APIs',
      blurb: 'A JSON file becomes a relational REST API you can build against.',
    },
    {
      href: '/use-cases/mvp-backend',
      label: 'MVP backend',
      blurb: 'Auth, ownership and webhooks without running a server.',
    },
  ],
};

export const ROLES: NavGroup = {
  key: 'roles',
  label: 'Roles',
  links: [
    {
      href: '/roles/frontend-developer',
      label: 'Frontend developer',
      blurb: 'Stop waiting on the backend to start building the real UI.',
    },
    {
      href: '/roles/qa-engineer',
      label: 'QA engineer',
      blurb: 'Make the API fail on purpose, the same way every run.',
    },
    {
      href: '/roles/ai-engineer',
      label: 'AI engineer',
      blurb: 'Give an agent a real datastore it can query with SQL.',
    },
    {
      href: '/roles/indie-hacker',
      label: 'Indie hacker',
      blurb: 'Ship the whole thing this weekend, with no infrastructure phase.',
    },
    {
      href: '/roles/student',
      label: 'Student',
      blurb: 'Learn REST against a real API without installing a database.',
    },
  ],
};

export const NAV_GROUPS: NavGroup[] = [
  USE_CASES,
  ROLES,
  {
    key: 'features',
    label: 'Features',
    links: [
      {
        href: '/features/ai-rest-api-generation',
        label: 'AI API Generation',
        blurb: 'Describe a domain in one sentence and get a relational schema, seed data and live endpoints.',
      },
      {
        href: '/features/google-github-social-login',
        label: 'Social Login',
        blurb: 'Google and GitHub sign-in from four config values, with verified-email identity and record ownership.',
      },
      {
        href: '/features/instant-api-deployments',
        label: 'Instant Deployments',
        blurb: 'Stage every edit as a draft, then swap it live with no downtime — or stop the project outright.',
      },
    ],
  },
  {
    key: 'compare',
    label: 'Compare',
    links: [
      { href: '/compare/stubbase-vs-json-server', label: 'vs. JSON Server' },
      { href: '/compare/stubbase-vs-firebase', label: 'vs. Firebase' },
    ],
  },
];

/** Groups that live inside the Solutions mega-menu rather than their own trigger. */
export const SOLUTION_GROUPS: NavGroup[] = [USE_CASES, ROLES];

/** Groups that keep their own top-level dropdown. */
export const MENU_GROUPS: NavGroup[] = NAV_GROUPS.filter(
  (group) => group.key === 'features' || group.key === 'compare',
);

/** Flat pages that sit alongside the grouped spokes. */
export const RESOURCE_LINKS: NavLink[] = [
  { href: '/quick-start', label: 'API Reference' },
  { href: '/guides', label: 'Guides' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/faqs', label: 'FAQs' },
  { href: '/contact', label: 'Contact' },
];

export const LEGAL_LINKS: NavLink[] = [
  { href: '/terms', label: 'Terms of service' },
  { href: '/privacy', label: 'Privacy' },
];
