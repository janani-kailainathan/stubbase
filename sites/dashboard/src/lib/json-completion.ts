import {
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'

/**
 * Autocomplete for resource files, so property names and their quotes never
 * have to be typed by hand.
 *
 * Everything is derived from the records already in the document rather than
 * from a schema: these files are homogeneous arrays, so the sibling records are
 * the schema. Harvesting uses a regex rather than the syntax tree because
 * completions are requested while the document is *invalid* — halfway through
 * typing is exactly when the parse tree is least useful.
 */

/** `"name": <literal>` — the literal is optional, since it may not be typed yet. */
const FIELD_RE =
  /"([A-Za-z_][A-Za-z0-9_-]*)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)?/g

/** Cap the scan on large resource files — the first records show every field. */
const HARVEST_LIMIT = 20_000

interface Field {
  name: string
  /** First-seen index, so the record snippet keeps the file's own field order. */
  order: number
  /** Value literals seen for this field, with occurrence counts. */
  values: Map<string, number>
}

function harvest(text: string): Field[] {
  const fields = new Map<string, Field>()
  let order = 0
  for (const [, name, value] of text.slice(0, HARVEST_LIMIT).matchAll(FIELD_RE)) {
    let field = fields.get(name)
    if (!field) {
      field = { name, order: order++, values: new Map() }
      fields.set(name, field)
    }
    if (value) field.values.set(value, (field.values.get(value) ?? 0) + 1)
  }
  return [...fields.values()].sort((a, b) => a.order - b.order)
}

function byFrequency(values: Map<string, number>): string[] {
  return [...values.entries()].sort((a, b) => b[1] - a[1]).map(([literal]) => literal)
}

/** Snippet placeholders may not contain braces or newlines. */
function placeholder(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\s+/g, ' ').slice(0, 40)
}

/**
 * A tab-stop for this field's value, pre-filled with its most common existing
 * value — Tab accepts it, typing replaces it.
 */
function valueTemplate(field: Field): string {
  const [common] = byFrequency(field.values)
  if (!common) return '${}'
  if (common.startsWith('"')) return `"\${${placeholder(common.slice(1, -1))}}"`
  return `\${${placeholder(common)}}`
}

// ── Where in the document are we? ─────────────────────────────────

interface Scan {
  /** Innermost unclosed container at the offset. */
  container: '{' | '[' | null
  /** The offset falls inside a string literal. */
  inString: boolean
  /** Offset of that string's opening quote. */
  stringStart: number
  /** Offset of its closing quote, or -1 when unterminated. */
  stringEnd: number
  /** Last significant character before the offset, outside of strings. */
  prev: string
  /** When `prev` is ':', the property name being given a value. */
  key: string | null
}

/**
 * Walk forward to `pos` tracking container nesting. Forward is deliberate:
 * scanning backwards can't tell a quote that opens a string from one that
 * closes it, which is the exact case this has to get right.
 */
function scan(text: string, pos: number): Scan {
  const stack: ('{' | '[')[] = []
  let prev = ''
  let lastString = ''
  let key: string | null = null
  let i = 0

  while (i < pos) {
    const c = text[i]

    if (c === '"') {
      let j = i + 1
      let closed = false
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '"') {
          closed = true
          break
        }
        if (text[j] === '\n') break
        j++
      }
      // Unterminated, or it runs past the cursor: the cursor is inside it.
      if (!closed || j >= pos) {
        return {
          container: stack.at(-1) ?? null,
          inString: true,
          stringStart: i,
          stringEnd: closed ? j : -1,
          prev,
          key,
        }
      }
      lastString = text.slice(i + 1, j)
      prev = '"'
      i = j + 1
      continue
    }

    if (c === '{' || c === '[') {
      stack.push(c)
      prev = c
      key = null
    } else if (c === '}' || c === ']') {
      stack.pop()
      prev = c
      key = null
    } else if (c === ':') {
      key = lastString
      prev = c
    } else if (c === ',') {
      key = null
      prev = c
    } else if (!/\s/.test(c)) {
      prev = c
    }
    i++
  }

  return {
    container: stack.at(-1) ?? null,
    inString: false,
    stringStart: -1,
    stringEnd: -1,
    prev,
    key,
  }
}

type Where = { kind: 'key' } | { kind: 'value'; key: string | null } | { kind: 'element' } | null

function classify(s: Scan): Where {
  if (s.container === '{') {
    if (s.prev === '{' || s.prev === ',') return { kind: 'key' }
    if (s.prev === ':') return { kind: 'value', key: s.key }
  }
  if (s.container === '[' && (s.prev === '[' || s.prev === ',')) return { kind: 'element' }
  return null
}

// ── Completions ───────────────────────────────────────────────────

/**
 * How an insertion sits in the surrounding text. Resource files are always
 * re-serialized with `JSON.stringify(data, null, 2)`, so one property or record
 * per line is the canonical shape — insertions should match it rather than
 * trail off the end of whatever line the caret happens to be on.
 */
interface Layout {
  /** Start on a fresh line instead of appending to the current one. */
  newline: boolean
  /** Indent one level deeper — this is the first thing inside a new container. */
  deeper: boolean
  /** A closing bracket sits on this line too; push it down to its own line. */
  trailing: boolean
}

/**
 * Assemble template lines for CodeMirror's snippet parser, which indents every
 * line *after* the first by the caret line's indentation plus one indent unit
 * per leading tab. A leading newline therefore puts every real line through
 * that machinery, which is what makes the indentation come out right.
 */
function lay(lines: string[], { newline, deeper, trailing }: Layout): string {
  const tab = newline && deeper ? '\t' : ''
  const body = lines.map((line) => tab + line).join('\n')
  return `${newline ? '\n' : ''}${body}${trailing ? '\n' : ''}`
}

/** Where an insertion starting at `start` would land. */
function layoutAt(text: string, start: number, after: number): Layout {
  const before = text.slice(text.lastIndexOf('\n', start - 1) + 1, start)
  return {
    newline: /\S/.test(before),
    deeper: /[[{]$/.test(before.trimEnd()),
    // Only when the closer shares this line — a closer on a later line is
    // already where it belongs.
    trailing: /^[^\S\n]*[\]}]/.test(text.slice(after)),
  }
}

/** Next free id, so an inserted record doesn't collide with an existing one. */
function nextId(text: string): number {
  let max = 0
  for (const [, value] of text.slice(0, HARVEST_LIMIT).matchAll(/"id"\s*:\s*(\d+)/g)) {
    max = Math.max(max, Number(value))
  }
  return max + 1
}

/**
 * A whole record, tab-stopped field by field. Lines are indented with tabs
 * because CodeMirror rewrites each one to the editor's indent unit and adds the
 * current line's base indentation.
 */
function recordSnippet(
  text: string,
  fields: Field[],
  needsComma: boolean,
  layout: Layout,
): Completion {
  const body = fields.length
    ? fields.map((f) => `"${f.name}": ${f.name === 'id' ? nextId(text) : valueTemplate(f)}`)
    : ['"${field}": "${value}"']
  const template = lay(
    ['{', ...body.map((line, i) => `\t${line}${i < body.length - 1 ? ',' : ''}`), `}${needsComma ? ',' : ''}`],
    layout,
  )
  return {
    label: 'record',
    detail: fields.length ? fields.map((f) => f.name).join(', ') : 'new object',
    type: 'class',
    boost: 99,
    apply: snippet(template),
  }
}

interface KeyInsert {
  /** Emit an opening quote (false when reusing one the user already typed). */
  open: boolean
  /** A `:` already follows: rewrite only the name, leaving the value alone. */
  hasColon: boolean
  /** Replace an existing closing quote rather than leaving it as a duplicate. */
  consume: boolean
  /** Extend the replacement back over the user's opening quote, so that moving
   *  the property to a new line doesn't strand it on the old one. */
  absorbQuote: boolean
  layout: Layout
}

function keyCompletions(fields: Field[], insert: KeyInsert): Completion[] {
  const { open, hasColon, consume, absorbQuote, layout } = insert
  return fields.map((field) => {
    const line = `${open ? '"' : ''}${field.name}"${hasColon ? '' : `: ${valueTemplate(field)}`}`
    // An in-place rewrite must stay on its line; only fresh properties get laid out.
    const apply = snippet(hasColon ? line : lay([line], layout))
    return {
      label: field.name,
      type: 'property',
      detail: byFrequency(field.values)[0],
      // CodeMirror's from/to bracket the string *contents*, which is what it
      // filters on. The text actually replaced can be wider than that.
      apply: (view: Parameters<typeof apply>[0], c: Completion, from: number, to: number) =>
        apply(view, c, from - (absorbQuote ? 1 : 0), to + (consume ? 1 : 0)),
    }
  })
}

function valueCompletions(field: Field | undefined, quoted: boolean): Completion[] {
  const literals = field ? byFrequency(field.values).slice(0, 12) : []
  const seen = new Set(literals)
  for (const constant of ['true', 'false', 'null']) {
    if (!seen.has(constant)) literals.push(constant)
  }
  return literals
    .filter((literal) => quoted === literal.startsWith('"'))
    .map((literal) => ({
      label: literal.startsWith('"') ? literal.slice(1, -1) : literal,
      type: literal.startsWith('"') ? 'text' : 'keyword',
      apply: literal.startsWith('"') ? literal.slice(1, -1) : literal,
    }))
}

const WORD_RE = /[A-Za-z0-9_$.-]*$/

export function jsonRecordCompletions(context: CompletionContext): CompletionResult | null {
  const text = context.state.doc.toString()
  const atCursor = scan(text, context.pos)

  // The token being completed. Inside a string, the whole string content is
  // replaced — otherwise a half-typed `"act|ive"` would complete to "activeive".
  let from: number
  let to: number
  let quoted = false

  if (atCursor.inString) {
    quoted = true
    from = atCursor.stringStart + 1
    to = atCursor.stringEnd >= 0 ? atCursor.stringEnd : context.pos
    if (/[^A-Za-z0-9_$.\- ]/.test(text.slice(from, context.pos))) return null
  } else {
    const word = WORD_RE.exec(text.slice(0, context.pos))?.[0] ?? ''
    from = context.pos - word.length
    to = context.pos
  }

  const where = classify(quoted ? scan(text, atCursor.stringStart) : scan(text, from))
  if (!where) return null

  // Harvest with the token being replaced cut out, or the half-typed word is
  // picked up as a field of its own and offered back as the top suggestion.
  const fields = harvest(text.slice(0, from) + text.slice(to))
  let options: Completion[]

  if (where.kind === 'element') {
    if (quoted) return null
    const rest = text.slice(to, to + 64).trimStart()
    options = [recordSnippet(text, fields, rest.startsWith('{'), layoutAt(text, from, to))]
  } else if (where.kind === 'key') {
    const consume = quoted && atCursor.stringEnd >= 0
    const after = consume ? to + 1 : to
    const hasColon = /^\s*:/.test(text.slice(after, after + 8))
    // The insertion starts at the opening quote when the user typed one.
    const layout = hasColon
      ? { newline: false, deeper: false, trailing: false }
      : layoutAt(text, quoted ? atCursor.stringStart : from, after)
    const absorbQuote = quoted && layout.newline
    options = keyCompletions(fields, {
      open: !quoted || absorbQuote,
      hasColon,
      consume,
      absorbQuote,
      layout,
    })
  } else {
    // Values are noisier than keys — don't pop up until something is typed.
    if (from === context.pos && !context.explicit) return null
    options = valueCompletions(
      fields.find((f) => f.name === where.key),
      quoted,
    )
  }

  if (!options.length) return null
  return { from, to, options, validFor: /^[A-Za-z0-9_$.\- ]*$/ }
}
