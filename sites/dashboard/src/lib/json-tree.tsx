import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

type Line = {
  key: string
  content: ReactNode
  /** Set on the line that opens a non-empty object or array. */
  fold?: { path: string; open: boolean }
  /** A string value's line, laid out as a row so the value can clip to the width left. */
  inline?: boolean
}

interface TreeState {
  collapsed: Set<string>
  toggle: (path: string) => void
  /** String values the user opened to their full text. */
  openText: Set<string>
  toggleText: (path: string) => void
}

const isContainer = (value: unknown): value is object => typeof value === 'object' && value !== null

function entriesOf(value: object): [string | null, unknown][] {
  return Array.isArray(value) ? value.map((v) => [null, v]) : Object.entries(value)
}

/**
 * A node's identity across renders. Segments are JSON-encoded so an object key
 * containing "/" cannot collide with a nested path, and index 0 cannot collide
 * with the key "0".
 */
const childPath = (path: string, key: string | null, index: number) =>
  `${path}/${JSON.stringify(key ?? index)}`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const punct = (text: string) => <span className="text-syntax-punct">{text}</span>

/** Numbers, booleans and null — strings get StringValue. */
function scalar(value: unknown): ReactNode {
  if (typeof value === 'number') return <span className="text-syntax-num">{JSON.stringify(value)}</span>
  return <span className="text-syntax-bool">{String(value)}</span>
}

const overflows = (el: HTMLElement) => el.scrollWidth > el.clientWidth

/**
 * A string value, clipped with an ellipsis to the width its line has left; a
 * click shows all of it, wrapped under its key, and another click clips it
 * again. Clipped by CSS rather than cut at a character count, so how much shows
 * follows the pane's width — and the full text stays in the DOM, so selecting
 * and copying a clipped value copies all of it. Only a value that is actually
 * clipped responds to a click; whether it is gets measured on hover and on the
 * click itself, since a resize can change the answer at any time.
 */
function StringValue({
  text,
  tail,
  open,
  onToggle,
}: {
  text: string
  /** The trailing comma, kept inside the clipped box so it follows the last character. */
  tail: ReactNode
  open: boolean
  onToggle: () => void
}) {
  const [clipped, setClipped] = useState(false)
  return (
    <span
      onPointerEnter={(e) => setClipped(!open && overflows(e.currentTarget))}
      onClick={(e) => {
        // A drag that selects text ends in a click too; that is not a request to toggle.
        if (window.getSelection()?.toString()) return
        if (open || overflows(e.currentTarget)) onToggle()
      }}
      title={open ? 'Show less' : clipped ? 'Show full text' : undefined}
      className={`min-w-0 ${
        open
          ? 'cursor-pointer break-words whitespace-pre-wrap'
          : `overflow-hidden text-ellipsis whitespace-pre ${clipped ? 'cursor-pointer' : ''}`
      }`}
    >
      <span className="text-syntax-str">{text}</span>
      {tail}
    </span>
  )
}

/**
 * Flatten the document into display lines, skipping the insides of collapsed
 * nodes. Laid out exactly as `JSON.stringify(data, null, 2)` would be, so an
 * all-expanded tree reads the same as the edit mode it flips into.
 */
function buildLines(root: unknown, { collapsed, toggle, openText, toggleText }: TreeState): Line[] {
  const lines: Line[] = []

  const walk = (value: unknown, path: string, depth: number, label: string | null, last: boolean) => {
    // Real spaces, not padding, so copying a block keeps its indentation.
    const indent = '  '.repeat(depth)
    const prefix = label !== null && (
      <>
        <span className="text-syntax-key">{JSON.stringify(label)}</span>:{' '}
      </>
    )
    const comma = !last && punct(',')

    if (typeof value === 'string') {
      lines.push({
        key: path,
        inline: true,
        content: (
          <>
            {/* Wrapped, not bare: a flex row drops a whitespace-only text run,
                which would take the indentation with it. */}
            <span className="shrink-0 whitespace-pre">
              {indent}
              {prefix}
            </span>
            <StringValue
              text={JSON.stringify(value)}
              tail={comma}
              open={openText.has(path)}
              onToggle={() => toggleText(path)}
            />
          </>
        ),
      })
      return
    }

    if (!isContainer(value)) {
      lines.push({ key: path, content: <>{indent}{prefix}{scalar(value)}{comma}</> })
      return
    }

    const isArray = Array.isArray(value)
    const [openBracket, closeBracket] = isArray ? ['[', ']'] : ['{', '}']
    const entries = entriesOf(value)

    if (entries.length === 0) {
      lines.push({ key: path, content: <>{indent}{prefix}{punct(openBracket + closeBracket)}{comma}</> })
      return
    }

    const open = !collapsed.has(path)
    if (!open) {
      lines.push({
        key: path,
        fold: { path, open },
        content: (
          <>
            {indent}
            {prefix}
            {punct(openBracket)}
            <button
              onClick={() => toggle(path)}
              title="Expand"
              className="mx-0.5 cursor-pointer rounded border border-border bg-card px-1 text-subtle hover:text-heading"
            >
              …
            </button>
            {punct(closeBracket)}
            {comma}
            <span className="text-faint select-none">
              {' '}
              {plural(entries.length, isArray ? 'item' : 'key')}
            </span>
          </>
        ),
      })
      return
    }

    lines.push({ key: path, fold: { path, open }, content: <>{indent}{prefix}{punct(openBracket)}</> })
    entries.forEach(([key, child], i) =>
      walk(child, childPath(path, key, i), depth + 1, key, i === entries.length - 1),
    )
    lines.push({ key: `${path}#end`, content: <>{indent}{punct(closeBracket)}{comma}</> })
  }

  walk(root, '', 0, null, true)
  return lines
}

/** Paths of the root's non-empty children — for a resource file, one per record. */
function topLevelContainers(root: unknown): string[] {
  if (!isContainer(root)) return []
  return entriesOf(root).flatMap(([key, child], i) =>
    isContainer(child) && entriesOf(child).length > 0 ? [childPath('', key, i)] : [],
  )
}

/**
 * Paths of every non-empty container below the root's children, at any depth —
 * for a resource file, everything nested inside a record. All of them, not just
 * the nearest: opening one then shows its own children folded too.
 */
function nestedContainers(root: unknown): string[] {
  const paths: string[] = []
  const walk = (value: unknown, path: string, depth: number) => {
    if (!isContainer(value)) return
    const entries = entriesOf(value)
    if (depth >= 2 && entries.length > 0) paths.push(path)
    entries.forEach(([key, child], i) => walk(child, childPath(path, key, i), depth + 1))
  }
  walk(root, '', 0)
  return paths
}

/**
 * Read-only JSON with foldable objects and arrays: a chevron gutter like the
 * editor's fold gutter, a `…` placeholder that expands on click, and
 * expand/collapse-all. Colours are the same --syntax-* tokens as JsonHighlight
 * and the CodeMirror editor, so switching modes doesn't recolour the document.
 *
 * Everything starts expanded. The toolbar offers three depths, most open first:
 * "Expand all"; "Expand first level", which opens each record to its own
 * fields and folds every object and array inside it; and "Collapse all", which
 * folds to the top level only — one line per record — so opening a record from
 * there shows the whole of it rather than a second layer of folds.
 */
export function JsonTree({
  data,
  size = 'md',
  controls = true,
}: {
  data: unknown
  /** `sm` sets the 11px of a log row; `md` the editor's 13px. */
  size?: 'md' | 'sm'
  /** Expand/collapse-all. Off where many trees stack, or every one carries its own toolbar. */
  controls?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const toggle = useCallback(
    (path: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      }),
    [],
  )

  const [openText, setOpenText] = useState<Set<string>>(() => new Set())
  const toggleText = useCallback(
    (path: string) =>
      setOpenText((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      }),
    [],
  )

  const lines = useMemo(
    () => buildLines(data, { collapsed, toggle, openText, toggleText }),
    [data, collapsed, toggle, openText, toggleText],
  )
  const topLevel = useMemo(() => topLevelContainers(data), [data])
  const nested = useMemo(() => nestedContainers(data), [data])

  return (
    <div className={`font-mono leading-relaxed ${size === 'sm' ? 'text-[11px]' : 'text-[13px]'}`}>
      {controls && topLevel.length > 0 && (
        <div className="sticky top-0 z-10 float-right flex gap-0.5 rounded border border-border bg-card p-0.5">
          <button
            onClick={() => setCollapsed(new Set())}
            title="Expand all"
            aria-label="Expand all"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-subtle transition-colors hover:bg-background hover:text-heading"
          >
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setCollapsed(new Set(nested))}
            title="Expand first level"
            aria-label="Expand first level"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-subtle transition-colors hover:bg-background hover:text-heading"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setCollapsed(new Set(topLevel))}
            title="Collapse all"
            aria-label="Collapse all"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-subtle transition-colors hover:bg-background hover:text-heading"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {lines.map((line) => (
        <div key={line.key} className="flex">
          <span className="w-5 shrink-0 select-none">
            {line.fold && (
              <button
                onClick={() => toggle(line.fold!.path)}
                aria-expanded={line.fold.open}
                aria-label={line.fold.open ? 'Collapse' : 'Expand'}
                className="flex h-[1.625em] w-4 cursor-pointer items-center justify-center text-faintest transition-colors hover:text-heading"
              >
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${line.fold.open ? '' : '-rotate-90'}`}
                />
              </button>
            )}
          </span>
          <span
            className={line.inline ? 'flex min-w-0 flex-1' : 'min-w-0 break-words whitespace-pre-wrap'}
          >
            {line.content}
          </span>
        </div>
      ))}
    </div>
  )
}
