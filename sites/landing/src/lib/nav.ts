// Single source of truth for the hub-and-spoke navigation. Header and Footer
// both read it, so a new spoke page only needs one edit here.

export interface NavLink {
  href: string;
  label: string;
}

export interface NavGroup {
  key: 'solutions' | 'features' | 'compare';
  label: string;
  links: NavLink[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'solutions',
    label: 'Solutions',
    links: [
      { href: '/solutions/frontend-mock-api-generator', label: 'Frontend Mock APIs' },
      { href: '/solutions/api-testing-chaos-engineering', label: 'QA Chaos Engineering' },
      { href: '/solutions/headless-baas-mvp', label: 'Indie Hacker BaaS' },
    ],
  },
  {
    key: 'features',
    label: 'Features',
    links: [
      { href: '/features/ai-rest-api-generation', label: 'AI API Generation' },
      { href: '/features/instant-api-deployments', label: 'Instant Deployments' },
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

/** Flat pages that sit alongside the grouped spokes. */
export const RESOURCE_LINKS: NavLink[] = [
  { href: '/quick-start', label: 'API Reference' },
  { href: '/faqs', label: 'FAQs' },
  { href: '/contact', label: 'Contact' },
];

export const LEGAL_LINKS: NavLink[] = [
  { href: '/terms', label: 'Terms of service' },
  { href: '/privacy', label: 'Privacy' },
];
