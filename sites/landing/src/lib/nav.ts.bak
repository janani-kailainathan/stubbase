// Single source of truth for the hub-and-spoke navigation. Header, footer and
// the solution pages (RoleLayout's "Explore more solutions") all read it, so a
// new page needs one entry here — and a page missing from it is one nobody finds.

/** The two audience-segmented groups. Each page in them renders through RoleLayout. */
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
        blurb: 'New tables and settings wait as drafts, then go live with no downtime — or stop the project outright.',
      },
      {
        href: '/features',
        label: 'All features',
        blurb: 'Everything a project can do, on one page — and every feature on every plan.',
      },
    ],
  },
  // Compare is hidden (2026-10-06): its route and Markdown are kept as .bak
  // files under src/pages/compare and src/content/compare. To bring it back,
  // restore those and this entry, and the Compare menu and footer column.
  // {
  //   key: 'compare',
  //   label: 'Compare',
  //   links: [
  //     {
  //       href: '/compare/stubbase-vs-json-server',
  //       label: 'vs. JSON Server',
  //       blurb: 'The same JSON-file workflow, deployed and persistent instead of local.',
  //     },
  //     {
  //       href: '/compare/stubbase-vs-firebase',
  //       label: 'vs. Firebase',
  //       blurb: 'A zero-config REST API against a NoSQL document store.',
  //     },
  //   ],
  // },
];

/** Groups that live inside the Solutions mega-menu rather than their own trigger. */
export const SOLUTION_GROUPS: NavGroup[] = [USE_CASES, ROLES];

/** Groups that keep their own top-level dropdown. */
export const MENU_GROUPS: NavGroup[] = NAV_GROUPS.filter(
  (group) => group.key === 'features',
);

/** Flat pages that sit alongside the grouped spokes. */
export const RESOURCE_LINKS: NavLink[] = [
  { href: '/quick-start', label: 'API Reference', blurb: 'Call a live API in one line, then make it slow or fail.' },
  { href: '/free-api', label: 'Free API', blurb: 'Six resources of sample data to practise against, no sign-up.' },
  { href: '/user-guide', label: 'User guide', blurb: 'How to do each thing in Stubbase, one task to a page.' },
  { href: '/guides', label: 'Guides', blurb: 'Step-by-step setups, from OAuth keys onwards.' },
  { href: '/changelog', label: 'Changelog', blurb: 'What shipped, newest first.' },
  { href: '/faqs', label: 'FAQs', blurb: 'Quick answers to common questions.' },
  { href: '/contact', label: 'Contact', blurb: 'Enterprise volumes, support, or anything else.' },
];

export const LEGAL_LINKS: NavLink[] = [
  { href: '/terms', label: 'Terms of service' },
  { href: '/privacy', label: 'Privacy' },
];
