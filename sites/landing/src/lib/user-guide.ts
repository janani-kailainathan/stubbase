// The user guide's chapters, in reading order. The rail, the index's card grid
// and each article's previous/next links all read this list, so a chapter is
// added here once and every surface picks it up.
//
// A chapter with no published article still shows — in the rail as "Soon" and
// on the index as an unlinked card — so the guide's shape is visible from the
// first article, and filling a chapter in is only a matter of adding Markdown
// to src/content/user-guide/ with that chapter's key.
import type { DoodleName } from '../components/role/Doodle.astro';

export interface GuideChapter {
  key: string;
  label: string;
  /** One clause, under the card title on the index. */
  blurb: string;
  doodle: DoodleName;
}

export const GUIDE_CHAPTERS = [
  {
    key: 'getting-started',
    label: 'Getting started',
    blurb: 'From an empty account to a live API you can call.',
    doodle: 'rocket',
  },
  {
    key: 'data',
    label: 'Tables and records',
    blurb: 'Resources, the editor, timestamps and relations.',
    doodle: 'database',
  },
  {
    key: 'querying',
    label: 'Querying your API',
    blurb: 'Filters, sorting, pages and _expand.',
    doodle: 'terminal',
  },
  {
    key: 'auth',
    label: 'Sign-up and login',
    blurb: 'Accounts, Google and GitHub, codes and resets for your users.',
    doodle: 'lock',
  },
  {
    key: 'roles',
    label: 'Roles and permissions',
    blurb: 'Who may read and change what, from rbac.json.',
    doodle: 'key',
  },
  {
    key: 'settings',
    label: 'Settings and the .env',
    blurb: 'Schemas, webhooks, QA mode and read-only APIs.',
    doodle: 'braces',
  },
  {
    key: 'copilot',
    label: 'AI Co-Pilot',
    blurb: 'Design tables, change records and settings by asking.',
    doodle: 'robot',
  },
  {
    key: 'account',
    label: 'Account and plan',
    blurb: 'Requests, credits, MCP keys and your account settings.',
    doodle: 'bill',
  },
] as const satisfies readonly GuideChapter[];

export type GuideChapterKey = (typeof GUIDE_CHAPTERS)[number]['key'];

export const CHAPTER_KEYS = GUIDE_CHAPTERS.map((chapter) => chapter.key) as [
  GuideChapterKey,
  ...GuideChapterKey[],
];
