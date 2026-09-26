/**
 * The name the New project form fills in, so creating a project never starts
 * with a blank field to think about. Only a default: the whole of it is
 * selected, and typing replaces it.
 *
 * The name also seeds the project's permanent id (`quiet-harbor-3fa9c2b1`),
 * whose random suffix already makes it unique — so these only have to read
 * well in a URL and stand apart from the account's own projects, never anyone
 * else's. React-free, so a test can import it.
 */

// Neutral words only: nobody should be handed a name they would rather not share.
const ADJECTIVES = [
  'amber', 'bold', 'brave', 'bright', 'calm', 'clever', 'cosmic', 'crisp', 'dapper', 'eager',
  'gentle', 'golden', 'happy', 'humble', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'mellow',
  'merry', 'misty', 'nimble', 'noble', 'patient', 'plucky', 'polished', 'proud', 'quick', 'quiet',
  'rapid', 'ready', 'rosy', 'silver', 'sleek', 'smooth', 'snowy', 'solar', 'spry', 'steady',
  'sunny', 'swift', 'tidy', 'trusty', 'vivid', 'warm', 'wise', 'zesty', 'breezy', 'cheerful',
]

const NOUNS = [
  'badger', 'beacon', 'birch', 'brook', 'canyon', 'cedar', 'comet', 'coral', 'crane', 'delta',
  'dune', 'ember', 'falcon', 'fern', 'fjord', 'forest', 'harbor', 'heron', 'island', 'lagoon',
  'lantern', 'lark', 'maple', 'meadow', 'meteor', 'orbit', 'otter', 'owl', 'panda', 'pebble',
  'pine', 'prairie', 'quartz', 'raven', 'reef', 'ridge', 'river', 'robin', 'sparrow', 'spruce',
  'summit', 'tiger', 'tundra', 'valley', 'walrus', 'willow', 'wren', 'zephyr', 'glacier', 'harvest',
]

const key = (name: string) => name.trim().toLowerCase()

/**
 * `base` if no project is called that yet, otherwise the first free "base 2",
 * "base 3"… — so a second project from the same starter can be told apart in
 * the list. Compared without regard to case or surrounding space.
 */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map(key))
  if (!used.has(key(base))) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(key(candidate))) return candidate
  }
}

/** An adjective-noun name, such as `quiet-harbor`, that none of `taken` already is. */
export function generatedName(taken: readonly string[], random: () => number = Math.random): string {
  const used = new Set(taken.map(key))
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]
  // 2,500 pairs: a few random tries all but always land on a free one.
  for (let i = 0; i < 20; i++) {
    const candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`
    if (!used.has(candidate)) return candidate
  }
  const free = ADJECTIVES.flatMap((a) => NOUNS.map((n) => `${a}-${n}`)).filter((c) => !used.has(c))
  return free.length ? pick(free) : uniqueName(`${pick(ADJECTIVES)}-${pick(NOUNS)}`, taken)
}
