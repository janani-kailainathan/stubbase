/**
 * Starter APIs offered on a project's empty state.
 *
 * Ordered simplest to richest, so the list doubles as a tour of what the engine
 * does: plain CRUD, then relations, then relations behind auth, then roles.
 *
 *   tracker     one flat resource — filtering, sorting, pagination
 *   blog        `<singular>Id` foreign keys, so ?_expand= nests records
 *   storefront  the same, with AUTH_ENABLED: public reads, authenticated writes
 *   recipes     Forkful, a recipe community: every auth setting that works
 *               without credentials, and a whole product's worth of resources
 *   helpdesk    Deskline, a support desk: rbac.json roles — customers see their
 *               own tickets, agents the whole queue, a lead can promote agents
 *
 * Foreign keys follow the core's convention exactly — `?_expand=authors`
 * singularizes to `author`, reads `authorId`, and nests the match under
 * `author` — so each `example` query works the moment it is deployed.
 * tests/starters.test.ts seeds this data into a real core and asserts exactly
 * that, plus that an `auth` starter really does reject unauthenticated writes.
 *
 * A `users` resource is fine to ship: the accounts signup creates live in the
 * project's system/users.json, never in a resource, so sample rows in a
 * data/users.json cannot collide with them.
 *
 * Seed records carry no `userId`: accounts only exist once someone signs up, so
 * seeded rows are nobody's. Under an "own" permission they are invisible to a
 * customer and fully visible to a role with "all", which is what the example
 * shows.
 *
 * Data only — no React here, so the tests can import it directly.
 */
import type { RbacRules } from './rbac'

export interface Starter {
  id: 'tracker' | 'blog' | 'storefront' | 'recipes' | 'helpdesk'
  title: string
  blurb: string
  /** Capabilities this example demonstrates, beyond plain CRUD. */
  features: ('relations' | 'auth' | 'rbac')[]
  /**
   * A query worth running once deployed. Not shown on the card — it is in the
   * confirmation toast, and the tests assert the data can answer it without a
   * token.
   */
  example: string
  /** Staged into the tenant's config.json, merged over what is already there. */
  config?: Record<string, string>
  /**
   * Staged as the project's rbac.json. Written after `config`, because the
   * files proxy refuses rbac.json until RBAC_ENABLED is staged alongside it.
   */
  rbac?: RbacRules
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
    example: '/posts?_expand=authors&_sort=publishedAt&_direction=desc',
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
    // what creates the account (in system/users.json, never a resource).
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
  {
    id: 'recipes',
    title: 'Forkful recipes',
    blurb: 'Browse recipes freely; sign in to review and save.',
    features: ['relations', 'auth'],
    example: '/recipes?_expand=cuisines&difficulty=easy&_sort=publishedAt&_direction=desc',
    // Every auth setting that works without a credential. Anyone may browse the
    // cookbook; reviewing, posting and saving collections needs an account from
    // /auth/signup (or /auth/login), and a signed-in user edits only what they
    // wrote. A login lasts a week, as a phone app would want. The redirect and
    // reset page are real Forkful URLs; Google, GitHub and email sending need
    // the owner's own keys, which stay commented in the .env to fill in.
    config: {
      AUTH_ENABLED: 'true',
      AUTH_PUBLIC_ROUTES: 'recipes,cuisines,ingredients,steps,reviews',
      AUTH_JWT_TTL_SECONDS: '604800',
      AUTH_OAUTH_REDIRECT: 'https://forkful.app/auth/callback',
      AUTH_RESET_URL: 'https://forkful.app/reset-password',
    },
    resources: {
      recipes: [
        { id: '1', cuisineId: '1', title: 'Weeknight cacio e pepe', slug: 'cacio-e-pepe', difficulty: 'easy', prepMinutes: 20, servings: 2, tags: ['pasta', 'vegetarian'], publishedAt: '2026-02-03', rating: 4.7 },
        { id: '2', cuisineId: '2', title: 'Miso-glazed salmon', slug: 'miso-salmon', difficulty: 'medium', prepMinutes: 30, servings: 2, tags: ['fish', 'high-protein'], publishedAt: '2026-02-17', rating: 4.8 },
        { id: '3', cuisineId: '3', title: 'Charred corn tacos', slug: 'charred-corn-tacos', difficulty: 'easy', prepMinutes: 25, servings: 4, tags: ['vegetarian', 'street-food'], publishedAt: '2026-03-01', rating: 4.5 },
        { id: '4', cuisineId: '4', title: 'One-pot chana masala', slug: 'chana-masala', difficulty: 'easy', prepMinutes: 40, servings: 4, tags: ['vegan', 'one-pot'], publishedAt: '2026-03-12', rating: 4.9 },
        { id: '5', cuisineId: '1', title: 'Wild mushroom risotto', slug: 'mushroom-risotto', difficulty: 'medium', prepMinutes: 45, servings: 4, tags: ['vegetarian', 'comfort'], publishedAt: '2026-03-26', rating: 4.6 },
        { id: '6', cuisineId: '2', title: 'Tonkotsu ramen from scratch', slug: 'tonkotsu-ramen', difficulty: 'hard', prepMinutes: 720, servings: 6, tags: ['pork', 'weekend-project'], publishedAt: '2026-04-09', rating: 4.4 },
      ],
      cuisines: [
        { id: '1', name: 'Italian', region: 'Southern Europe' },
        { id: '2', name: 'Japanese', region: 'East Asia' },
        { id: '3', name: 'Mexican', region: 'Latin America' },
        { id: '4', name: 'Indian', region: 'South Asia' },
      ],
      ingredients: [
        { id: '1', recipeId: '1', name: 'Spaghetti', quantity: 200, unit: 'g' },
        { id: '2', recipeId: '1', name: 'Pecorino Romano', quantity: 80, unit: 'g' },
        { id: '3', recipeId: '1', name: 'Black pepper, freshly cracked', quantity: 2, unit: 'tsp' },
        { id: '4', recipeId: '2', name: 'Salmon fillets', quantity: 2, unit: 'pieces' },
        { id: '5', recipeId: '2', name: 'White miso', quantity: 2, unit: 'tbsp' },
        { id: '6', recipeId: '2', name: 'Mirin', quantity: 1, unit: 'tbsp' },
        { id: '7', recipeId: '3', name: 'Sweet corn kernels', quantity: 3, unit: 'cups' },
        { id: '8', recipeId: '3', name: 'Corn tortillas', quantity: 8, unit: 'pieces' },
        { id: '9', recipeId: '4', name: 'Chickpeas, cooked', quantity: 800, unit: 'g' },
        { id: '10', recipeId: '4', name: 'Garam masala', quantity: 2, unit: 'tsp' },
      ],
      steps: [
        { id: '1', recipeId: '1', position: 1, text: 'Boil the pasta in well-salted water until just shy of al dente.' },
        { id: '2', recipeId: '1', position: 2, text: 'Toast the pepper in a dry pan, then add a ladle of pasta water.' },
        { id: '3', recipeId: '1', position: 3, text: 'Toss the pasta in the pan and stir in the cheese off the heat.' },
        { id: '4', recipeId: '2', position: 1, text: 'Brush the fillets with miso and mirin and rest for 10 minutes.' },
        { id: '5', recipeId: '2', position: 2, text: 'Grill skin-side down until the glaze caramelises.' },
        { id: '6', recipeId: '4', position: 1, text: 'Soften onion, garlic and ginger, then bloom the spices.' },
        { id: '7', recipeId: '4', position: 2, text: 'Add tomatoes and chickpeas and simmer for 25 minutes.' },
      ],
      reviews: [
        { id: '1', recipeId: '1', stars: 5, reviewer: 'Giulia', body: 'Finally no clumps. The pan-water trick works.', createdOn: '2026-02-08' },
        { id: '2', recipeId: '4', stars: 5, reviewer: 'Arjun', body: 'Tastes like home. Doubled the ginger.', createdOn: '2026-03-15' },
        { id: '3', recipeId: '2', stars: 4, reviewer: 'Mei', body: 'Great glaze; watch the grill closely.', createdOn: '2026-02-21' },
        { id: '4', recipeId: '3', stars: 4, reviewer: 'Diego', body: 'Add lime and cotija at the end.', createdOn: '2026-03-04' },
        { id: '5', recipeId: '6', stars: 3, reviewer: 'Kenji', body: 'Worth it, but it really does take all day.', createdOn: '2026-04-14' },
      ],
      collections: [
        { id: '1', name: 'Weeknight dinners', description: 'On the table in under 45 minutes.', recipeIds: ['1', '3', '4'] },
        { id: '2', name: 'Meat-free Mondays', description: 'Vegetarian and vegan favourites.', recipeIds: ['1', '3', '4', '5'] },
        { id: '3', name: 'Weekend projects', description: 'Slow cooking for a free afternoon.', recipeIds: ['6'] },
      ],
    },
  },
  {
    id: 'helpdesk',
    title: 'Deskline helpdesk',
    blurb: 'Customers see their own tickets; agents see them all.',
    features: ['relations', 'auth', 'rbac'],
    example: '/articles?_expand=topics&published=true',
    // Roles and permissions: the help centre is public, a customer opens and
    // follows only their own tickets, an agent works the whole queue and owns
    // the canned replies, a lead can also promote agents, an admin does
    // anything. New accounts are customers; make the first agent from the
    // dashboard's system/users.json.
    config: {
      AUTH_ENABLED: 'true',
      RBAC_ENABLED: 'true',
    },
    rbac: {
      defaultRole: 'customer',
      roles: {
        guest: { articles: ['read'], topics: ['read'] },
        customer: {
          articles: ['read'],
          topics: ['read'],
          tickets: { create: 'own', read: 'own', update: 'own' },
          ratings: { create: 'own', read: 'own' },
        },
        agent: {
          articles: ['read', 'create', 'update'],
          topics: ['read'],
          tickets: { read: 'all', update: 'all' },
          macros: ['read', 'create', 'update', 'delete'],
          ratings: { read: 'all' },
          _users: ['read'],
        },
        lead: {
          articles: '*',
          topics: '*',
          tickets: '*',
          macros: '*',
          ratings: { read: 'all' },
          _users: ['read', 'update'],
        },
        admin: '*',
      },
    },
    resources: {
      articles: [
        { id: '1', topicId: '1', title: 'Update your payment method', slug: 'update-payment-method', published: true, helpfulVotes: 128, revisedOn: '2026-03-02' },
        { id: '2', topicId: '2', title: 'Reset two-factor authentication', slug: 'reset-2fa', published: true, helpfulVotes: 342, revisedOn: '2026-02-18' },
        { id: '3', topicId: '3', title: 'Connect Deskline to Slack', slug: 'slack-integration', published: true, helpfulVotes: 97, revisedOn: '2026-03-20' },
        { id: '4', topicId: '1', title: 'Understanding prorated charges', slug: 'prorated-charges', published: true, helpfulVotes: 61, revisedOn: '2026-01-29' },
        { id: '5', topicId: '4', title: 'Report a bug we can reproduce', slug: 'reporting-bugs', published: true, helpfulVotes: 45, revisedOn: '2026-03-11' },
        { id: '6', topicId: '3', title: 'Webhooks for ticket events', slug: 'ticket-webhooks', published: false, helpfulVotes: 0, revisedOn: '2026-04-02' },
      ],
      topics: [
        { id: '1', name: 'Billing' },
        { id: '2', name: 'Account & login' },
        { id: '3', name: 'Integrations' },
        { id: '4', name: 'Bug reports' },
      ],
      tickets: [
        { id: '1', topicId: '2', subject: 'Locked out after changing phones', status: 'open', priority: 'urgent', channel: 'email', requester: 'Priya Nair', openedOn: '2026-04-01', messages: [{ from: 'customer', body: 'My authenticator app was on my old phone.', at: '2026-04-01T09:12:00Z' }] },
        { id: '2', topicId: '1', subject: 'Charged twice this month', status: 'pending', priority: 'high', channel: 'chat', requester: 'Tom Becker', openedOn: '2026-04-02', messages: [{ from: 'customer', body: 'Two charges on the 1st.', at: '2026-04-02T14:03:00Z' }, { from: 'agent', body: 'Refund issued for the duplicate — 3 to 5 days.', at: '2026-04-02T14:20:00Z' }] },
        { id: '3', topicId: '3', subject: 'Slack notifications stopped', status: 'open', priority: 'normal', channel: 'web', requester: 'Lucía Romero', openedOn: '2026-04-03', messages: [{ from: 'customer', body: 'Nothing posted since yesterday.', at: '2026-04-03T08:45:00Z' }] },
        { id: '4', topicId: '4', subject: 'Export to CSV drops accents', status: 'solved', priority: 'normal', channel: 'email', requester: 'Émile Durand', openedOn: '2026-03-28', messages: [{ from: 'customer', body: 'Names like Zoë come out garbled.', at: '2026-03-28T11:30:00Z' }, { from: 'agent', body: 'Fixed in today’s release — exports are UTF-8 now.', at: '2026-03-30T16:10:00Z' }] },
        { id: '5', topicId: '1', subject: 'Need an invoice with our VAT number', status: 'solved', priority: 'low', channel: 'email', requester: 'Anders Holm', openedOn: '2026-03-25', messages: [{ from: 'customer', body: 'Our accountant needs the VAT ID on it.', at: '2026-03-25T10:00:00Z' }] },
        { id: '6', topicId: '2', subject: 'SSO login loops back to sign-in', status: 'open', priority: 'high', channel: 'chat', requester: 'Grace Liu', openedOn: '2026-04-04', messages: [{ from: 'customer', body: 'Okta sends me straight back to the login page.', at: '2026-04-04T07:55:00Z' }] },
        { id: '7', topicId: '3', subject: 'Zapier trigger fires twice', status: 'pending', priority: 'normal', channel: 'web', requester: 'Samuel Okafor', openedOn: '2026-04-04', messages: [{ from: 'customer', body: 'Every new ticket creates two Trello cards.', at: '2026-04-04T13:22:00Z' }] },
        { id: '8', topicId: '4', subject: 'Dark mode hides the reply button', status: 'open', priority: 'low', channel: 'web', requester: 'Noor Haddad', openedOn: '2026-04-05', messages: [{ from: 'customer', body: 'The send button is black on black.', at: '2026-04-05T19:40:00Z' }] },
      ],
      macros: [
        { id: '1', topicId: '1', title: 'Duplicate charge refunded', body: 'We have refunded the duplicate charge. It usually appears within 3–5 business days.' },
        { id: '2', topicId: '2', title: 'Two-factor reset steps', body: 'For your security we need to verify your identity first — please reply with your account email.' },
        { id: '3', topicId: '3', title: 'Reconnect an integration', body: 'Please disconnect and reconnect the integration from Settings → Integrations.' },
        { id: '4', topicId: '4', title: 'Bug logged', body: 'Thanks — our engineers can reproduce this and it is now on the roadmap.' },
      ],
      ratings: [
        { id: '1', ticketId: '2', score: 5, comment: 'Refunded within minutes.', ratedOn: '2026-04-02' },
        { id: '2', ticketId: '4', score: 4, comment: 'Took two days, but fixed properly.', ratedOn: '2026-03-31' },
        { id: '3', ticketId: '5', score: 3, comment: 'Had to ask twice.', ratedOn: '2026-03-27' },
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
    id: 'flags',
    title: 'Feature flags',
    blurb: 'Per-segment overrides on a flag.',
    features: ['relations'],
    resources: ['flags', 'overrides'],
  },
]
