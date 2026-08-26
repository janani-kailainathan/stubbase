/**
 * Minimal inline formatter for prose held in frontmatter.
 *
 * Section bodies live in YAML rather than in a Markdown body (see the `sections`
 * field in content.config.ts), which means Astro's Markdown pipeline never sees
 * them — but the prose still wants inline code and emphasis. Rather than take on
 * a Markdown dependency to render two constructs, this escapes the string and
 * then applies exactly those two.
 *
 * Escaping happens FIRST and unconditionally, so a stray `<` in an endpoint or a
 * JSON snippet renders as text instead of markup. The input is authored in this
 * repository, never user-supplied — this is about correctness, not sanitisation.
 */
const CODE_CLASS =
  'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-primary-ink';

export function inline(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .replace(/`([^`]+)`/g, `<code class="${CODE_CLASS}">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>');
}

/** Split a body string into paragraphs on blank lines, each inline-formatted. */
export function paragraphs(text: string): string[] {
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((p) => inline(p.replace(/\s*\n\s*/g, ' ')));
}
