import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import type { Method } from '@/stores/workspace'

/** Method colour, matching the APIs rail's badges so a route reads the same in both places. */
const METHOD_INK: Record<Method, string> = {
  GET: 'text-primary-ink',
  POST: 'text-info-ink',
  PUT: 'text-warning-emphasis',
  DELETE: 'text-danger-ink',
}

/**
 * The request widgets the endpoint pane's two tabs share — Live sends with
 * them, Docs describes with them — so a route looks the same on either tab.
 * Its own module for the same reason as pane-tabs: EditorPane imports
 * Playground, so the Docs view cannot import from it the other way round.
 */

/**
 * The method + URL bar, with a copy button. `url` is what gets copied and shown
 * on hover; `children` is the URL as displayed, so each tab marks up its own
 * parts — an `{id}` placeholder, a filled-in id, a query string.
 */
export function RequestUrlBar({
  method,
  url,
  children,
}: {
  method: Method
  url: string
  children: React.ReactNode
}) {
  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => toast.success('URL copied'),
      () => toast.error('Could not copy the URL'),
    )

  return (
    <div className="flex h-9 min-w-0 flex-1 items-stretch overflow-hidden rounded border border-border bg-panel">
      <span
        className={`flex w-20 shrink-0 items-center border-r border-border px-3 font-mono text-xs font-semibold ${METHOD_INK[method]}`}
      >
        {method}
      </span>
      <div
        title={url}
        aria-label="Request URL"
        className="flex min-w-0 flex-1 items-center truncate px-3 font-mono text-[13px] text-emphasis select-text"
      >
        <span className="truncate">{children}</span>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy URL"
        title="Copy URL"
        className="flex w-9 shrink-0 cursor-pointer items-center justify-center text-subtle transition-colors hover:text-emphasis focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function PanelHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold text-body">{children}</h3>
}

/**
 * Key / Value grid with a narrow state column on the left (checkbox or lock)
 * and a narrow action column on the right, like every API client's params and
 * headers tables. `description` adds a wrapping third column for reference
 * tables, where each row needs a sentence of explanation.
 */
export function KeyValueTable({
  label,
  edges = true,
  description = false,
  children,
}: {
  label: string
  /** The state and action columns. A read-only table has neither, so it drops them. */
  edges?: boolean
  /** A Description column after Value. Rows must then pass `description`. */
  description?: boolean
  children: React.ReactNode
}) {
  const head = 'border-l border-border px-2.5 py-2 text-xs font-semibold text-subtle'
  return (
    <div className="overflow-hidden rounded border border-border">
      <table aria-label={label} className="w-full table-fixed border-collapse">
        <colgroup>
          {edges && <col className="w-9" />}
          <col className={description ? 'w-[28%]' : 'w-[36%]'} />
          <col className={description ? 'w-[24%]' : undefined} />
          {description && <col />}
          {edges && <col className="w-9" />}
        </colgroup>
        <thead>
          <tr className="border-b border-border bg-panel text-left">
            {edges && (
              <th scope="col">
                <span className="sr-only">State</span>
              </th>
            )}
            <th
              scope="col"
              className={`px-2.5 py-2 text-xs font-semibold text-subtle ${edges ? 'border-l border-border' : ''}`}
            >
              Key
            </th>
            <th scope="col" className={head}>
              Value
            </th>
            {description && (
              <th scope="col" className={head}>
                Description
              </th>
            )}
            {edges && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function KeyValueRow({
  lead,
  name,
  value,
  description,
  trail,
  edges = true,
}: {
  lead?: React.ReactNode
  name: React.ReactNode
  value: React.ReactNode
  /** Must be given exactly when the table has `description`. */
  description?: React.ReactNode
  trail?: React.ReactNode
  /** Must match the table's `edges`. */
  edges?: boolean
}) {
  return (
    <tr className="group border-b border-border last:border-b-0">
      {edges && <td className="text-center align-middle">{lead}</td>}
      <td className={`p-0 align-middle ${edges ? 'border-l border-border' : ''}`}>{name}</td>
      <td className="border-l border-border p-0 align-middle">{value}</td>
      {description !== undefined && (
        <td className="border-l border-border p-0 align-middle">{description}</td>
      )}
      {edges && <td className="text-center align-middle">{trail}</td>}
    </tr>
  )
}

/**
 * A cell that shows a value rather than editing it. Truncates to one line by
 * default; `wrap` lets a longer sentence run onto more lines instead.
 */
export function CellText({
  children,
  tone = 'text-body',
  title,
  wrap = false,
}: {
  children: React.ReactNode
  tone?: string
  title?: string
  wrap?: boolean
}) {
  if (wrap)
    return (
      <div title={title} className={`px-2.5 py-2 font-mono text-xs leading-relaxed ${tone}`}>
        {children}
      </div>
    )
  return (
    <div title={title} className={`flex h-8 items-center truncate px-2.5 font-mono text-xs ${tone}`}>
      <span className="truncate">{children}</span>
    </div>
  )
}
