/**
 * Example prompts for the AI pane, simplest first.
 *
 * These are only prompts — clicking one fills the composer rather than sending
 * it, so nobody spends a generation by brushing past a suggestion. What the
 * model returns is its own business; the pane already stages every table as a
 * `draft_*` file for review, so there is nothing here to verify up front.
 *
 * Deliberately different domains from the starter examples in starters.ts:
 * a starter is the same three APIs every time, whereas these show the AI being
 * asked for something it has to invent.
 */
export interface AiExample {
  /** Short label for the suggestion chip. */
  label: string
  /** What it demonstrates, one or two words. */
  hint: string
  prompt: string
}

export const AI_EXAMPLES: AiExample[] = [
  {
    label: 'Recipe box',
    hint: 'one table',
    prompt: 'A recipe box: recipes with a title, servings, prep time in minutes and a short method.',
  },
  {
    label: 'Gym log',
    hint: 'related tables',
    prompt:
      'A workout tracker: workouts with a date and notes, and exercises that each reference a workout with sets, reps and weight.',
  },
  {
    label: 'CRM',
    hint: 'several relations',
    prompt:
      'A small CRM: companies with an industry and size, contacts that each belong to a company, and deals that reference both a company and a contact with a stage, amount and close date.',
  },
]
