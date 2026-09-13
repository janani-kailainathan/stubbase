import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useIsMutating } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { StarterGrid } from '@/components/shell/StarterGrid'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { CREATE_PROJECT_KEY, useCreateProject, useOpenProject } from '@/hooks/projects'
import { useCreateProjectFromStarter } from '@/hooks/starters'
import type { Starter } from '@/lib/starters'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Creating a project: pick a starter (or an empty project), name it, Create.
 *
 * A card only *selects* — nothing is provisioned until Create, so browsing the
 * starters costs nothing and a stray click cannot make a project. Selecting a
 * starter fills the name in with its title; a name you typed yourself is
 * yours, and switching cards leaves it alone.
 *
 * Shared by the New project dialog and the no-projects screen, so a project is
 * created the same way from either.
 */
export function NewProjectForm({
  autoFocus,
  onCreated,
  onCancel,
}: {
  autoFocus?: boolean
  onCreated?: () => void
  /** Renders a Cancel button beside Create when given. */
  onCancel?: () => void
}) {
  const openProject = useOpenProject()
  const createBlank = useCreateProject()
  const createFromStarter = useCreateProjectFromStarter()
  // null is the empty project, which is where the form starts.
  const [selected, setSelected] = useState<Starter | null>(null)
  const [name, setName] = useState('')
  const [needsName, setNeedsName] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const busy = createBlank.isPending || createFromStarter.isPending

  const choose = (starter: Starter | null) => {
    // Still blank, or still exactly what the last card filled in: the card
    // owns the name. Anything else was typed, and is kept.
    if (!name.trim() || name === selected?.title) {
      setName(starter?.title ?? '')
      setNeedsName(false)
    }
    setSelected(starter)
  }

  const created = (tenantId: string) => {
    openProject(tenantId)
    onCreated?.()
  }

  const submit = () => {
    if (busy) return
    const trimmed = name.trim()
    if (!trimmed) {
      // Say what is missing where it is missing, rather than a toast about a
      // field the user can already see.
      setNeedsName(true)
      inputRef.current?.focus()
      return
    }
    if (selected) {
      const starter = selected
      createFromStarter.mutate(
        { starter, name: trimmed },
        {
          onSuccess: (project) => {
            created(project.tenantId)
            toast.success(`Created ${project.tenantId} — Deploy, then try ${starter.example}`, {
              description: starter.nextStep,
            })
          },
          onError: (e) => toast.error(`Could not create the ${starter.title} example: ${e.message}`),
        },
      )
    } else {
      createBlank.mutate(
        { name: trimmed },
        {
          onSuccess: (project) => {
            created(project.tenantId)
            toast.success(`Provisioned ${project.tenantId}`)
          },
          onError: (e) => toast.error(`Could not create project: ${e.message}`),
        },
      )
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="flex min-h-0 w-full max-w-3xl flex-col gap-4"
    >
      {/* The body scrolls on its own so Create stays in view in a short
          window. The 1px gutter keeps the scroll edge off the cards' borders. */}
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">
            Project name
          </span>
          <input
            ref={inputRef}
            type="text"
            autoFocus={autoFocus}
            placeholder="project-name"
            value={name}
            disabled={busy}
            aria-invalid={needsName}
            onChange={(e) => {
              setName(e.target.value)
              setNeedsName(false)
            }}
            className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-heading placeholder-faint focus:border-primary focus:outline-none disabled:opacity-60 aria-invalid:border-danger-fill"
          />
          <span
            className={`font-mono text-[10px] ${needsName ? 'text-danger-ink' : 'text-subtle'}`}
          >
            {needsName ? 'Give the project a name.' : 'Picking a starter fills this in.'}
          </span>
        </label>

        <StarterGrid
          busy={busy}
          selectedId={selected?.id ?? 'blank'}
          onPick={choose}
          onBlank={() => choose(null)}
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        {busy && (
          <span className="mr-auto font-mono text-[11px] text-subtle">Provisioning&hellip;</span>
        )}
        {onCancel && (
          <button
            type="button"
            className="rounded px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-heading disabled:opacity-60"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={busy}
          className="flex cursor-pointer items-center gap-1.5 rounded bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5 shrink-0" />
          )}
          Create project
        </button>
      </div>
    </form>
  )
}

export function NewProjectDialog() {
  const open = useWorkspaceStore((s) => s.newProjectOpen)
  const setOpen = useWorkspaceStore((s) => s.setNewProjectOpen)
  // Closing mid-create would unmount the form, and with it the callbacks that
  // open the new project — it would be created and then never shown.
  const busy = useIsMutating({ mutationKey: CREATE_PROJECT_KEY }) > 0

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogContent
        className="flex max-h-[calc(100vh-4rem)] flex-col gap-4 border-border bg-card p-5 sm:max-w-3xl"
        showCloseButton={false}
      >
        <div>
          <DialogTitle className="text-sm font-semibold text-foreground">New project</DialogTitle>
          <DialogDescription className="mt-1.5 font-mono text-xs text-subtle">
            Start from an API that already works, or from nothing.
          </DialogDescription>
        </div>

        <NewProjectForm
          autoFocus
          onCreated={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
