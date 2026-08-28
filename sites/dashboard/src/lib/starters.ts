/**
 * Starter APIs offered on a project's empty state.
 *
 * Ordered simplest to richest, so the list doubles as a tour of what the engine
 * does: plain CRUD, then relations, then relations behind auth.
 *
 *   tracker     one flat resource — filtering, sorting, pagination
 *   blog        `<singular>Id` foreign keys, so ?_expand= nests records
 *   storefront  the same, with AUTH_ENABLED: public reads, authenticated writes
 *
 * Foreign keys follow the core's convention exactly — `?_expand=authors`
 * singularizes to `author`, reads `authorId`, and nests the match under
 * `author` — so each `example` query works the moment it is deployed.
 * tests/starters.test.ts seeds this data into a real core and asserts exactly
 * that, plus that an `auth` starter really does reject unauthenticated writes.
 *
 * Note no starter seeds a `users` resource: with AUTH_ENABLED the core treats
 * users.json as the tenant's identity table, and signup creates it. Shipping
 * sample rows there would collide with real accounts.
 *
 * Data only — no React here, so the tests can import it directly.
 */
export interface Starter {
  id: 'tracker' | 'blog' | 'storefront'
  title: string
  blurb: string
  /** Capabilities this example demonstrates, beyond plain CRUD. */
  features: ('relations' | 'auth')[]
  /**
   * A query worth running once deployed. Not shown on the card — it is in the
   * confirmation toast, and the tests assert the data can answer it.
   */
  example: string
  /** Staged into the tenant's config.json, merged over what is already there. */
  config?: Record<string, string>
  /** Written in order; the first is opened afterwards. */
  resources: Record<string, Record<string, unknown>[]>
}

export const STARTERS: Starter[] = [
  {
    id: 'tracker',
    title: 'Issue tracker',
    blurb: 'One resource. Filter, sort and paginate it.',
    features: [],
    example: '/tasks?status=in_progress&_sort=priority&_limit=5',
    resources: {
      tasks: [
        { id: '1', title: 'Design the tenant schema', status: 'done', priority: 'high', assignee: 'ada', estimate: 3 },
        { id: '2', title: 'Add pagination to list routes', status: 'in_progress', priority: 'high', assignee: 'sam', estimate: 2 },
        { id: '3', title: 'Document the query params', status: 'todo', priority: 'low', assignee: 'mira', estimate: 1 },
        { id: '4', title: 'Wire up the log stream', status: 'in_progress', priority: 'high', assignee: 'ada', estimate: 5 },
        { id: '5', title: 'Cap the journal at 500M', status: 'done', priority: 'medium', assignee: 'sam', estimate: 1 },
        { id: '6', title: 'Chase the reconnect bug', status: 'in_progress', priority: 'medium', assignee: 'mira', estimate: 3 },
        { id: '7', title: 'Draft the pricing page', status: 'todo', priority: 'medium', assignee: 'ada', estimate: 2 },
        { id: '8', title: 'Compress the hero images', status: 'todo', priority: 'low', assignee: 'sam', estimate: 1 },
        { id: '9', title: 'Fix the mobile nav', status: 'done', priority: 'medium', assignee: 'mira', estimate: 2 },
        { id: '10', title: 'Rate-limit the public plane', status: 'todo', priority: 'high', assignee: 'ada', estimate: 5 },
      ],
    },
  },
  {
    id: 'blog',
    title: 'Blog',
    blurb: 'Posts reference authors, comments reference posts.',
    features: ['relations'],
    example: '/posts?_expand=authors&_sort=publishedAt&_order=desc',
    resources: {
      posts: [
        { id: '1', authorId: '1', title: 'Scaling to zero on a 1GB box', slug: 'scaling-to-zero', published: true, publishedAt: '2026-01-14', views: 1840 },
        { id: '2', authorId: '2', title: 'Why we dropped the ORM', slug: 'dropping-the-orm', published: true, publishedAt: '2026-02-02', views: 3120 },
        { id: '3', authorId: '1', title: 'Designing a draft model', slug: 'draft-model', published: true, publishedAt: '2026-02-19', views: 942 },
        { id: '4', authorId: '3', title: 'Argon2 in practice', slug: 'argon2-in-practice', published: true, publishedAt: '2026-03-08', views: 2210 },
        { id: '5', authorId: '2', title: 'Testing without mocks', slug: 'testing-without-mocks', published: true, publishedAt: '2026-03-27', views: 1475 },
        { id: '6', authorId: '3', title: 'A tour of the request pipeline', slug: 'request-pipeline', published: true, publishedAt: '2026-04-11', views: 688 },
        { id: '7', authorId: '1', title: 'Notes on SSE backpressure', slug: 'sse-backpressure', published: false, publishedAt: null, views: 0 },
        { id: '8', authorId: '2', title: 'Untitled draft', slug: 'untitled-draft', published: false, publishedAt: null, views: 0 },
      ],
      authors: [
        { id: '1', name: 'Ada Okonkwo', email: 'ada@example.com', role: 'editor' },
        { id: '2', name: 'Sam Reyes', email: 'sam@example.com', role: 'author' },
        { id: '3', name: 'Mira Haddad', email: 'mira@example.com', role: 'author' },
      ],
      comments: [
        { id: '1', postId: '1', name: 'Jules', body: 'This finally made eviction click for me.', createdAt: '2026-01-15' },
        { id: '2', postId: '1', name: 'Tomas', body: 'What happens to in-flight writes?', createdAt: '2026-01-16' },
        { id: '3', postId: '2', name: 'Priya', body: 'Bold call, but I get the reasoning.', createdAt: '2026-02-03' },
        { id: '4', postId: '2', name: 'Wei', body: 'Any numbers on the migration?', createdAt: '2026-02-05' },
        { id: '5', postId: '3', name: 'Lena', body: 'The staging split is underrated.', createdAt: '2026-02-20' },
        { id: '6', postId: '4', name: 'Omar', body: 'Please write up the parameter tuning.', createdAt: '2026-03-09' },
        { id: '7', postId: '5', name: 'Yusuf', body: 'Black-box tests survived our refactor too.', createdAt: '2026-03-28' },
        { id: '8', postId: '6', name: 'Ines', body: 'A diagram would help here.', createdAt: '2026-04-12' },
      ],
    },
  },
  {
    id: 'storefront',
    title: 'Storefront',
    blurb: 'Related orders, with sign-in required to write.',
    features: ['relations', 'auth'],
    example: '/orders?_expand=customers,products&status=shipped',
    // Anyone may read the catalogue and order history; creating or changing a
    // record needs a tenant JWT from /auth/signup or /auth/login. Signup is also
    // what creates users.json, which is why no user rows are seeded below.
    config: {
      AUTH_ENABLED: 'true',
      AUTH_PUBLIC_ROUTES: 'products,orders,customers',
    },
    resources: {
      orders: [
        { id: '1', customerId: '1', productId: '3', quantity: 1, total: 129.99, status: 'shipped', placedAt: '2026-03-02' },
        { id: '2', customerId: '2', productId: '1', quantity: 2, total: 49.0, status: 'shipped', placedAt: '2026-03-05' },
        { id: '3', customerId: '1', productId: '5', quantity: 1, total: 89.0, status: 'pending', placedAt: '2026-03-11' },
        { id: '4', customerId: '3', productId: '2', quantity: 3, total: 73.5, status: 'delivered', placedAt: '2026-03-14' },
        { id: '5', customerId: '4', productId: '4', quantity: 1, total: 219.0, status: 'shipped', placedAt: '2026-03-19' },
        { id: '6', customerId: '2', productId: '6', quantity: 1, total: 34.0, status: 'cancelled', placedAt: '2026-03-22' },
        { id: '7', customerId: '3', productId: '3', quantity: 1, total: 129.99, status: 'pending', placedAt: '2026-03-28' },
        { id: '8', customerId: '4', productId: '1', quantity: 4, total: 98.0, status: 'delivered', placedAt: '2026-04-02' },
      ],
      customers: [
        { id: '1', name: 'Nadia Fischer', email: 'nadia@example.com', city: 'Rotterdam' },
        { id: '2', name: 'Kofi Mensah', email: 'kofi@example.com', city: 'Accra' },
        { id: '3', name: 'Elena Rossi', email: 'elena@example.com', city: 'Bologna' },
        { id: '4', name: 'Hana Sato', email: 'hana@example.com', city: 'Osaka' },
      ],
      products: [
        { id: '1', name: 'Desk mat', sku: 'DM-001', price: 24.5, category: 'accessories', inStock: true },
        { id: '2', name: 'Cable set', sku: 'CS-014', price: 24.5, category: 'accessories', inStock: true },
        { id: '3', name: 'Mechanical keyboard', sku: 'KB-311', price: 129.99, category: 'input', inStock: true },
        { id: '4', name: '27" monitor', sku: 'MN-027', price: 219.0, category: 'displays', inStock: false },
        { id: '5', name: 'Monitor arm', sku: 'MA-002', price: 89.0, category: 'displays', inStock: true },
        { id: '6', name: 'USB-C hub', sku: 'HB-100', price: 34.0, category: 'accessories', inStock: true },
      ],
    },
  },
]

export const countRecords = (s: Starter) =>
  Object.values(s.resources).reduce((n, records) => n + records.length, 0)

/**
 * Starters that are planned but not written yet — placeholders, so the empty
 * state already shows the shape of the full set (nine) rather than growing a
 * card at a time.
 *
 * A separate type and a separate list, deliberately. `Starter` means "seedable":
 * everything in STARTERS has real records, and tests/starters.test.ts seeds each
 * one into a live core and runs its advertised query. A placeholder has nothing
 * to seed, so giving it an empty `resources` map would either break that suite
 * or force it to learn which entries to skip — and the day a placeholder is
 * filled in, moving it across is the reminder that the test now covers it.
 *
 * `resources` here is names only: what the example *will* ship, which is enough
 * for the card's middle line and honest about there being no data behind it.
 */
export interface PlannedStarter {
  id: string
  title: string
  blurb: string
  features: Starter['features']
  /** Resource names the finished example will ship. */
  resources: string[]
}

export const PLANNED_STARTERS: PlannedStarter[] = [
  {
    id: 'chat',
    title: 'Chat threads',
    blurb: 'Messages hanging off conversations.',
    features: ['relations'],
    resources: ['conversations', 'messages'],
  },
  {
    id: 'crm',
    title: 'CRM pipeline',
    blurb: 'Deals moving through stages.',
    features: ['relations'],
    resources: ['companies', 'contacts', 'deals'],
  },
  {
    id: 'telemetry',
    title: 'Device telemetry',
    blurb: 'One wide table, thousands of rows.',
    features: [],
    resources: ['readings'],
  },
  {
    id: 'bookings',
    title: 'Bookings',
    blurb: 'Slots you have to be signed in to claim.',
    features: ['relations', 'auth'],
    resources: ['venues', 'slots', 'reservations'],
  },
  {
    id: 'courses',
    title: 'Course catalog',
    blurb: 'Lessons, and who is enrolled in them.',
    features: ['relations', 'auth'],
    resources: ['courses', 'lessons', 'enrollments'],
  },
  {
    id: 'flags',
    title: 'Feature flags',
    blurb: 'Per-segment overrides on a flag.',
    features: ['relations'],
    resources: ['flags', 'overrides'],
  },
]
