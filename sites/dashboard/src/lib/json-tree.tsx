import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

type Line = {
  key: string
  content: ReactNode
  /** Set on the line that opens a non-empty object or array. */
  fold?: { path: string; open: boolean }
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

function scalar(value: unknown): ReactNode {
  if (typeof value === 'string') return <span className="text-syntax-str">{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className="text-syntax-num">{JSON.stringify(value)}</span>
  return <span className="text-syntax-bool">{String(value)}</span>
}

/**
 * Flatten the document into display lines, skipping the insides of collapsed
 * nodes. Laid out exactly as `JSON.stringify(data, null, 2)` would be, so an
 * all-expanded tree reads the same as the edit mode it flips into.
 */
function buildLines(root: unknown, collapsed: Set<string>, toggle: (path: string) => void): Line[] {
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
 * Read-only JSON with foldable objects and arrays: a chevron gutter like the
 * editor's fold gutter, a `…` placeholder that expands on click, and
 * expand/collapse-all. Colours are the same --syntax-* tokens as JsonHighlight
 * and the CodeMirror editor, so switching modes doesn't recolour the document.
 *
 * Everything starts expanded. "Collapse all" folds to the top level only — one
 * line per record — so opening a record shows the whole of it rather than a
 * second layer of folds.
 */
export function JsonTree({ data }: { data: unknown }) {
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

  const lines = useMemo(() => buildLines(data, collapsed, toggle), [data, collapsed, toggle])
  const topLevel = useMemo(() => topLevelContainers(data), [data])

  return (
    <div className="font-mono text-[13px] leading-relaxed">
      {topLevel.length > 0 && (
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
          <span className="min-w-0 break-words whitespace-pre-wrap">{line.content}</span>
        </div>
      ))}
    </div>
  )
}
