import { useState } from 'react'
import { ChevronDown, Route } from 'lucide-react'
import { useEndpointGroups } from '@/hooks/endpoints'
import { useCurrentProject } from '@/hooks/projects'
import type { Endpoint } from '@/lib/endpoints'
import { useWorkspaceStore, type Method } from '@/stores/workspace'
import { UsagePanel } from './UsagePanel'

/**
 * Colour carries the method, the way every REST client does it. Without it the
 * rail is one undifferentiated column of chips and the verb is the slowest
 * thing on screen to read.
 */
const METHOD_BADGE: Record<Method, string> = {
  GET: 'border-primary-soft-border bg-primary-soft text-primary-ink',
  POST: 'border-info-soft-border bg-info-soft text-info-ink',
  PUT: 'border-warning-soft-border bg-warning-soft text-warning-emphasis',
  DELETE: 'border-danger-soft-border bg-danger-soft text-danger-ink',
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const selection = useWorkspaceStore((s) => s.selection)
  const select = useWorkspaceStore((s) => s.select)

  // Path, not just resource + method: the auth group holds two POSTs.
  const isSelected =
    selection?.kind === 'api' &&
    selection.method === endpoint.method &&
    selection.path === endpoint.path

  return (
    <div
      onClick={() =>
        select({
          kind: 'api',
          resource: endpoint.resource,
          method: endpoint.method,
          path: endpoint.path,
        })
      }
      className={
        isSelected
          ? 'flex cursor-pointer items-center gap-2 rounded-md border border-primary-soft-border bg-primary-soft py-1.5 pr-2 pl-7'
          : 'flex cursor-pointer items-center gap-2 rounded-md border border-transparent py-1.5 pr-2 pl-7 hover:bg-card'
      }
    >
      <span
        className={`w-14 shrink-0 rounded border px-1 py-0.5 text-center font-mono text-[10px] ${METHOD_BADGE[endpoint.method]}`}
      >
        {endpoint.method}
      </span>
      <span className="truncate font-mono text-xs text-body" title={endpoint.path}>
        {endpoint.path}
      </span>
    </div>
  )
}

export function ApisRail() {
  const project = useCurrentProject()
  const grouped = useEndpointGroups()
  // Collapsed groups, by resource name — everything starts expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (resource: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(resource)) next.delete(resource)
      else next.add(resource)
      return next
    })

  return (
    <div className="flex min-h-0 w-72 shrink-0 flex-col border-l border-border">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        {/* Route, not Database: this rail lists REST endpoints. The database
            icon belongs to the Files tree, which is where the data lives. */}
        <Route className="h-3.5 w-3.5 text-primary-accent" />
        <span className="text-xs font-semibold tracking-wide text-subtle uppercase">APIs</span>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-3">
        {grouped.map(({ resource, endpoints }) => {
          const isOpen = !collapsed.has(resource)
          return (
            <div key={resource}>
              <div
                onClick={() => toggle(resource)}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-1.5 hover:bg-card"
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 text-subtle transition-transform ${isOpen ? '' : '-rotate-90'}`}
                />
                <span className="truncate font-mono text-xs text-body">{resource}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                  {endpoints.length}
                </span>
              </div>
              {isOpen &&
                endpoints.map((endpoint) => (
                  <EndpointRow key={`${endpoint.method}:${endpoint.path}`} endpoint={endpoint} />
                ))}
            </div>
          )
        })}
        {project && grouped.length === 0 && (
          <p className="px-3 py-1.5 font-mono text-xs text-faint">No endpoints yet.</p>
        )}
      </div>

      {project && <UsagePanel tenantId={project.tenantId} />}
    </div>
  )
}
