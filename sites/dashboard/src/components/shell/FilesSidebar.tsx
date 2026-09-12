import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlignLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FilePlus,
  Folder,
  Lock,
  ShieldCheck,
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { NAME_RE } from '@/lib/api'
import { rbacEnabled } from '@/lib/rbac'
import { useTenantConfig } from '@/hooks/config'
import { useCurrentProject } from '@/hooks/projects'
import { useCreateResources } from '@/hooks/resources'
import { useSystemFiles } from '@/hooks/system'
import { useWorkspaceStore } from '@/stores/workspace'

function NewResourceDialog({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const select = useWorkspaceStore((s) => s.select)
  const createResource = useCreateResources(tenantId)

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || createResource.isPending) return
    if (!NAME_RE.test(trimmed)) {
      toast.error('Resource names: letters, digits, - and _ (max 64 chars).')
      return
    }
    createResource.mutate(
      { [trimmed]: [] },
      {
        onSuccess: () => {
          onOpenChange(false)
          setName('')
          select({ kind: 'resource', resource: trimmed })
          toast.success(`Created ${trimmed}.json`)
        },
        onError: (e) => toast.error(`Could not create resource: ${e.message}`),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-80 border-border bg-card p-4" showCloseButton={false}>
        <DialogTitle className="text-sm font-semibold text-foreground">New resource</DialogTitle>
        <input
          type="text"
          autoFocus
          placeholder="resource-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-heading placeholder-faint focus:border-primary focus:outline-none"
        />
        <p className="font-mono text-[10px] text-faint">
          Mounts CRUD routes at /{tenantId}/&lt;name&gt;
        </p>
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            className="rounded-md px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-heading"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
            disabled={createResource.isPending}
            onClick={submit}
          >
            {createResource.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function FilesSidebar() {
  const project = useCurrentProject()
  const selection = useWorkspaceStore((s) => s.selection)
  const dataExpanded = useWorkspaceStore((s) => s.dataExpanded)
  const systemExpanded = useWorkspaceStore((s) => s.systemExpanded)
  const select = useWorkspaceStore((s) => s.select)
  const toggleData = useWorkspaceStore((s) => s.toggleData)
  const toggleSystem = useWorkspaceStore((s) => s.toggleSystem)
  const collapsed = useWorkspaceStore((s) => s.filesCollapsed)
  const setCollapsed = useWorkspaceStore((s) => s.setFilesCollapsed)
  const [newOpen, setNewOpen] = useState(false)

  const resources = project?.resources ?? []
  const { data: systemFiles = [] } = useSystemFiles(project?.tenantId)
  // rbac.json is offered only while roles are switched on in the .env being
  // edited — the settings it will be deployed alongside.
  const { data: config } = useTenantConfig(project?.tenantId)
  const rbacOn = rbacEnabled(config)

  // Folded to a strip, like the playground's response pane: the editor takes
  // the width, and the way back stays exactly where the rail was.
  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-border pt-4">
        <button
          title="Expand files"
          aria-label="Expand files"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-subtle transition-colors hover:bg-card hover:text-heading"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <Folder aria-hidden className="h-3.5 w-3.5 text-primary-accent" />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 w-72 shrink-0 flex-col border-r border-border">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-4 pb-2">
        <Folder className="h-3.5 w-3.5 text-primary-accent" />
        <span className="flex-1 text-xs font-semibold tracking-wide text-subtle uppercase">
          Files
        </span>
        <button
          title="New resource"
          onClick={() => setNewOpen(true)}
          disabled={!project}
          className="flex h-6 w-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-card hover:text-heading disabled:opacity-40"
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
        {/* On the edge facing the editor, the side the rail folds toward. */}
        <button
          title="Collapse files"
          aria-label="Collapse files"
          aria-expanded
          onClick={() => setCollapsed(true)}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-subtle transition-colors hover:bg-card hover:text-heading"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>
      {project && (
        <NewResourceDialog
          key={`${project.tenantId}-${newOpen}`}
          tenantId={project.tenantId}
          open={newOpen}
          onOpenChange={setNewOpen}
        />
      )}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-3">
        <div
          className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-1.5 hover:bg-card"
          onClick={toggleData}
        >
          <ChevronDown
            className={`h-3.5 w-3.5 text-subtle transition-transform ${dataExpanded ? '' : '-rotate-90'}`}
          />
          <Database className="h-3.5 w-3.5 shrink-0 text-info-ink" />
          <span className="font-mono text-xs text-body">data</span>
        </div>
        {dataExpanded &&
          resources.map((resource) => {
            const isSelected = selection?.kind === 'resource' && selection.resource === resource
            return (
              <div
                key={resource}
                className={
                  isSelected
                    ? 'flex cursor-pointer items-center gap-2 rounded border border-primary-soft-border bg-primary-soft py-1.5 pr-2 pl-8'
                    : 'flex cursor-pointer items-center gap-2 rounded border border-transparent py-1.5 pr-2 pl-8 hover:bg-card'
                }
                onClick={() => select({ kind: 'resource', resource })}
              >
                <span className="shrink-0 font-mono text-xs text-danger-ink">{'{}'}</span>
                <span className="truncate font-mono text-xs text-body">{resource}.json</span>
              </div>
            )
          })}
        {dataExpanded && project && resources.length === 0 && (
          <p className="px-8 py-1.5 font-mono text-xs text-faint">No resources yet.</p>
        )}
        {/* What isn't a resource. rbac.json, while roles are switched on, is
            edited here like the .env. The files a feature writes itself are
            listed so an owner can see who has signed up, but locked: they
            change only through the feature's own endpoints. */}
        {project && (
          <div
            className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-1.5 hover:bg-card"
            onClick={toggleSystem}
          >
            <ChevronDown
              className={`h-3.5 w-3.5 text-subtle transition-transform ${systemExpanded ? '' : '-rotate-90'}`}
            />
            <Folder className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="font-mono text-xs text-body">system</span>
          </div>
        )}
        {project && systemExpanded && rbacOn && (
          <div
            className={
              selection?.kind === 'rbac'
                ? 'flex cursor-pointer items-center gap-2 rounded border border-primary-soft-border bg-primary-soft py-1.5 pr-2 pl-8'
                : 'flex cursor-pointer items-center gap-2 rounded border border-transparent py-1.5 pr-2 pl-8 hover:bg-card'
            }
            onClick={() => select({ kind: 'rbac' })}
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="truncate font-mono text-xs text-body">rbac.json</span>
          </div>
        )}
        {project &&
          systemExpanded &&
          systemFiles.map((file) => {
            const isSelected = selection?.kind === 'system' && selection.file === file
            return (
              <div
                key={file}
                className={
                  isSelected
                    ? 'flex cursor-pointer items-center gap-2 rounded border border-primary-soft-border bg-primary-soft py-1.5 pr-2 pl-8'
                    : 'flex cursor-pointer items-center gap-2 rounded border border-transparent py-1.5 pr-2 pl-8 hover:bg-card'
                }
                onClick={() => select({ kind: 'system', file })}
              >
                <span className="shrink-0 font-mono text-xs text-faint">{'{}'}</span>
                <span className="truncate font-mono text-xs text-body">{file}.json</span>
                <Lock aria-label="read-only" className="ml-auto h-3 w-3 shrink-0 text-faint" />
              </div>
            )
          })}
        {project && (
          <div
            className={
              selection?.kind === 'env'
                ? 'flex cursor-pointer items-center gap-2 rounded border border-primary-soft-border bg-primary-soft px-2 py-1.5'
                : 'flex cursor-pointer items-center gap-2 rounded border border-transparent px-2 py-1.5 hover:bg-card'
            }
            onClick={() => select({ kind: 'env' })}
          >
            <AlignLeft className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="font-mono text-xs text-body">.env</span>
          </div>
        )}
      </div>
    </div>
  )
}
