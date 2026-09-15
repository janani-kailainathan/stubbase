import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronRight,
  Copy,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Rocket,
  Settings,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { deployProject, LANDING_URL, type ApiUser } from '@/lib/api'
import { useProjectStatus, useSetProjectStatus } from '@/hooks/config'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  useCurrentProject,
  useCurrentProjectId,
  useDeleteProject,
  useDuplicateProject,
  useOpenProject,
  useProjects,
  projectPath,
  usePaneMode,
  useRenameProject,
  useSetPaneMode,
  type PaneMode,
  type Project,
} from '@/hooks/projects'
import { NewProjectDialog } from '@/components/shell/NewProject'
import { ThemeToggle } from '@/components/shell/ThemeToggle'
import { useAuthStore } from '@/stores/auth'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Deleting deprovisions the tenant on the core and drops the row — there is no
 * undo, so unlike rename this one earns a dialog. It spells out what goes, and
 * Cancel takes focus so a stray Enter cannot confirm it.
 *
 * Exported for the settings page, where an account's projects have to go
 * before the account can.
 */
export function DeleteProjectDialog({
  tenantId,
  name,
  resourceCount,
  open,
  onOpenChange,
}: {
  tenantId: string
  name: string
  resourceCount: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const deleteProject = useDeleteProject()
  const status = useProjectStatus(tenantId)
  const setStatus = useSetProjectStatus(tenantId)
  const running = status === 'active'
  // Any row in the menu can be the target, so deleting is only a navigation
  // when it was the project the URL names — which would otherwise be left
  // pointing at a tenant that no longer exists.
  const openTenantId = useCurrentProjectId()
  const navigate = useNavigate()

  const stop = useMutation({
    mutationFn: () => setStatus.mutateAsync('stopped'),
    onSuccess: () => toast.success(`${name} stopped — you can delete it now.`),
    onError: (e: Error) => toast.error(`Could not stop ${name}: ${e.message}`),
  })

  const submit = () => {
    if (deleteProject.isPending || running) return
    deleteProject.mutate(tenantId, {
      onSuccess: () => {
        onOpenChange(false)
        if (tenantId === openTenantId) navigate('/', { replace: true })
        toast.success(`Deleted ${name}`)
      },
      onError: (e) => toast.error(`Could not delete ${name}: ${e.message}`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-96 border-border bg-card p-4" showCloseButton={false}>
        <DialogTitle className="text-sm font-semibold text-foreground">Delete {name}?</DialogTitle>

        {running ? (
          // The API is serving. Say so plainly and offer the way forward rather
          // than a disabled button with no explanation.
          <div className="flex gap-2.5 rounded-md border border-warning-soft-border bg-warning-soft-weak p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-ink" />
            <p className="font-mono text-[11px] leading-relaxed text-warning-emphasis">
              This project is running. Deleting it would take a live API down under whatever is
              calling it — stop it first.
            </p>
          </div>
        ) : (
          <p className="font-mono text-xs leading-relaxed text-muted-foreground">
            This deletes{' '}
            <span className="text-emphasis">
              {resourceCount} resource file{resourceCount === 1 ? '' : 's'}
            </span>{' '}
            and its settings, and takes <span className="text-emphasis">/{tenantId}</span> offline
            for good. It cannot be undone.
          </p>
        )}

        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            autoFocus
            className="rounded px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-heading"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          {running ? (
            <button
              className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 font-mono text-xs text-body transition-colors hover:border-danger-fill/40 hover:text-danger-emphasis disabled:opacity-60"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square className="h-3 w-3" />
              {stop.isPending ? 'Stopping…' : 'Stop API'}
            </button>
          ) : (
            <button
              className="flex items-center gap-1.5 rounded bg-danger-fill px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-danger-fill-hover disabled:opacity-60"
              disabled={deleteProject.isPending}
              onClick={submit}
            >
              <Trash2 className="h-3 w-3" />
              {deleteProject.isPending ? 'Deleting…' : 'Delete project'}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Copies a project into a new one. A dialog rather than a single click because
 * there is a choice in it: the .env holds credentials and webhook URLs, so
 * bringing it along is opt-in, and the dialog says what never comes with it.
 * The copy opens once it exists — stopped, like any new project.
 */
function DuplicateProjectDialog({
  project,
  onOpenChange,
}: {
  project: Project
  onOpenChange: (open: boolean) => void
}) {
  const duplicate = useDuplicateProject()
  const openProject = useOpenProject()
  const [name, setName] = useState(`${project.name} copy`)
  const [copyEnv, setCopyEnv] = useState(false)
  const resourceCount = project.resources.length

  const submit = () => {
    const trimmed = name.trim()
    if (duplicate.isPending || !trimmed) return
    duplicate.mutate(
      { tenantId: project.tenantId, name: trimmed, copyEnv },
      {
        onSuccess: (created) => {
          onOpenChange(false)
          openProject(created.tenantId)
          toast.success(`Duplicated ${project.name}`)
        },
        onError: (e) => toast.error(`Could not duplicate ${project.name}: ${e.message}`),
      },
    )
  }

  return (
    // Closing mid-copy would unmount the callbacks that open the new project.
    <Dialog open onOpenChange={(open) => !duplicate.isPending && onOpenChange(open)}>
      <DialogContent className="w-96 border-border bg-card p-4" showCloseButton={false}>
        <DialogTitle className="text-sm font-semibold text-foreground">
          Duplicate {project.name}
        </DialogTitle>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">
              New project name
            </span>
            <input
              type="text"
              autoFocus
              value={name}
              disabled={duplicate.isPending}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-heading placeholder-faint focus:border-primary focus:outline-none disabled:opacity-60"
            />
          </label>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={copyEnv}
              disabled={duplicate.isPending}
              onChange={(e) => setCopyEnv(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-xs text-heading">Copy the .env too</span>
              <span className="font-mono text-[11px] leading-relaxed text-subtle">
                Its settings, keys and webhook URLs, with rbac.json. Unticked, the copy starts
                from a fresh .env with everything switched off.
              </span>
            </span>
          </label>

          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            Copies{' '}
            <span className="text-emphasis">
              {resourceCount} resource file{resourceCount === 1 ? '' : 's'}
            </span>{' '}
            as they are in the editor. The copy starts stopped, and never gets this project&rsquo;s
            accounts, sessions or developer keys.
          </p>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-heading disabled:opacity-60"
              disabled={duplicate.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={duplicate.isPending || !name.trim()}
              className="flex cursor-pointer items-center gap-1.5 rounded bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
            >
              {duplicate.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Renames in place, where the name already is — a one-field dialog is more
 * ceremony than the edit deserves. Enter or clicking away commits, Escape
 * reverts, and the field sizes itself to the text so the bar does not jump.
 */
function InlineRename({
  tenantId,
  initialName,
  onDone,
}: {
  tenantId: string
  initialName: string
  onDone: () => void
}) {
  const [name, setName] = useState(initialName)
  const rename = useRenameProject()
  // Enter commits and then unmounts this field, which can also fire blur.
  // Without this guard that submits the rename twice.
  const settled = useRef(false)

  const commit = () => {
    if (settled.current) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === initialName) {
      settled.current = true
      return onDone()
    }
    settled.current = true
    rename.mutate(
      { tenantId, name: trimmed },
      {
        onSuccess: onDone,
        onError: (e) => {
          toast.error(`Rename failed: ${e.message}`)
          settled.current = false // let them fix it rather than losing the edit
        },
      },
    )
  }

  const cancel = () => {
    settled.current = true
    onDone()
  }

  // The field commits on blur, so a plain click on these buttons would blur
  // first and commit before the click ever landed — cancel could never cancel.
  // Suppressing mousedown keeps focus in the input so only onClick decides.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        autoFocus
        value={name}
        disabled={rename.isPending}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') cancel()
        }}
        onBlur={commit}
        // Sized to the text: a fixed width would make everything beside it jump
        // the moment you start editing.
        style={{ width: `${Math.max(6, name.length + 1)}ch` }}
        className="rounded-none border-b border-primary/60 bg-transparent text-sm font-medium text-foreground focus:outline-none disabled:opacity-60"
      />
      <button
        title="Save"
        aria-label="Save name"
        disabled={rename.isPending}
        onMouseDown={keepFocus}
        onClick={commit}
        className="cursor-pointer text-primary-accent transition-colors hover:text-primary-ink disabled:opacity-60"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        title="Cancel"
        aria-label="Cancel rename"
        onMouseDown={keepFocus}
        onClick={cancel}
        className="cursor-pointer text-subtle transition-colors hover:text-emphasis"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/** Switches the centre pane between the editor, AI chat, logs and diagnostics. */
function ModeToggle() {
  const current = useCurrentProject()
  const { data: projects } = useProjects()
  const location = useLocation()
  const navigate = useNavigate()
  const inWorkspace = location.pathname === '/' || location.pathname.startsWith('/p/')
  // Outside the workspace — the settings page — the tabs are the way back: they
  // lead into the project the account menu was opened from (router state
  // `from`), as long as it still exists. There is no separate back link.
  const fromTenant = (location.state as { from?: string } | null)?.from?.match(/^\/p\/([^/]+)/)?.[1]
  const target = current ?? (inWorkspace ? undefined : projects?.find((p) => p.tenantId === fromTenant))
  const status = useProjectStatus(target?.tenantId)
  const stopped = status !== 'active'
  const paneMode = usePaneMode()
  const setPaneMode = useSetPaneMode()

  const open = (mode: PaneMode) => {
    if (current) setPaneMode(mode)
    else if (target) navigate(projectPath(target.tenantId, mode))
    // Nothing to lead into: Editor still goes to the workspace, which opens the
    // first project or offers to create one.
    else if (!inWorkspace) navigate('/')
  }

  // A stopped API serves no traffic and answers 503 on every public route, so
  // these two panes have nothing to show. Stopping while one of them is open
  // would otherwise strand the user on a dead view — fall back to the editor,
  // replacing the dead view's URL rather than leaving it in history.
  useEffect(() => {
    if (stopped && (paneMode === 'logs' || paneMode === 'diagnostics'))
      setPaneMode('editor', { replace: true })
  }, [stopped, paneMode, setPaneMode])

  const modes: { mode: PaneMode; label: string; needsLive?: boolean }[] = [
    { mode: 'editor', label: 'Editor' },
    { mode: 'ai', label: 'AI chat' },
    { mode: 'logs', label: 'Logs', needsLive: true },
    // Hidden for now, not removed: the pane still renders, so restoring the
    // button is uncommenting this line.
    // { mode: 'diagnostics', label: 'Diagnostics', needsLive: true },
    // Not needsLive: you manage keys and set up an agent regardless of whether
    // the API is currently serving traffic. Labelled for what the keys are for.
    { mode: 'keys', label: 'MCP' },
  ]

  return (
    <div className="flex items-center gap-1">
      {modes.map(({ mode, label, needsLive }) => {
        // With no project to lead into there is no pane to go to but the editor:
        // every pane is a place inside a project, and its URL names one.
        const disabled = !target ? mode !== 'editor' : Boolean(needsLive) && stopped
        return (
          <button
            key={mode}
            onClick={() => open(mode)}
            disabled={disabled}
            title={
              disabled
                ? target
                  ? `Available once the API is live (currently ${status})`
                  : 'Open a project first'
                : undefined
            }
            className={
              disabled
                ? 'cursor-not-allowed rounded border border-transparent px-2.5 py-1.5 font-mono text-xs text-faintest'
                : // Settings is no pane, so nothing reads as selected there.
                  inWorkspace && paneMode === mode
                  ? 'cursor-pointer rounded border border-transparent bg-primary-soft px-2.5 py-1.5 font-mono text-xs text-primary-ink'
                  : 'cursor-pointer rounded border border-transparent px-2.5 py-1.5 font-mono text-xs text-subtle hover:text-emphasis'
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Holds a flag true for at least `ms` once it goes up.
 *
 * A deploy against a local core finishes in tens of milliseconds, so progress
 * feedback tied directly to isPending appears and disappears inside a frame or
 * two. That does not read as "it worked", it reads as a glitch.
 */
function useMinDuration(active: boolean, ms = 450): boolean {
  const [visible, setVisible] = useState(false)
  const startedAt = useRef(0)

  useEffect(() => {
    if (active) {
      startedAt.current = Date.now()
      setVisible(true)
      return
    }
    if (!visible) return
    const remaining = Math.max(0, ms - (Date.now() - startedAt.current))
    const timer = setTimeout(() => setVisible(false), remaining)
    return () => clearTimeout(timer)
  }, [active, visible, ms])

  return visible
}

/**
 * One control for going live, and Stop beside it while the API is.
 *
 * Deploy is the only way to bring an API up. It promotes staged drafts, and on
 * a stopped project it then starts the API, so what goes live is always what
 * was last saved. There is deliberately no separate Start: one beside Deploy
 * could bring a project up on its old settings with the staged ones still
 * waiting — a new starter project serving with its auth switched off — and two
 * buttons that both mean "make it live" was the confusion. Live, the label
 * reads Redeploy and the second segment is Stop; stopped, there is nothing to
 * stop, so Deploy stands alone.
 *
 * Stop asks first: it answers every public endpoint with 503 and breaks
 * whatever calls the API, and Cancel takes focus so a stray Enter cannot
 * confirm it.
 */
function DeployControls({ tenantId }: { tenantId: string | undefined }) {
  const status = useProjectStatus(tenantId)
  const setStatus = useSetProjectStatus(tenantId)
  // No project means nothing is serving. useProjectStatus reads as active until
  // a status loads, and with no tenant nothing ever loads — which put a Stop
  // icon on the first screen of an account with no projects.
  const stopped = !tenantId || status !== 'active'
  const queryClient = useQueryClient()
  const current = useCurrentProject()
  const [confirmingStop, setConfirmingStop] = useState(false)

  // Stopping is the only status change made here: starting is part of Deploy.
  const stop = useMutation({
    mutationFn: () => setStatus.mutateAsync('stopped'),
    onSuccess: () => {
      setConfirmingStop(false)
      toast.success('API stopped — requests now answer 503.')
    },
    onError: (e: Error) => toast.error(`Could not stop the API: ${e.message}`),
  })

  const deploy = useMutation({
    mutationFn: async () => {
      const res = await deployProject(tenantId!)
      // Deploying a stopped project brings it back up — one action, one click.
      if (stopped) await setStatus.mutateAsync('active')
      return res
    },
    onSuccess: (res) => {
      const files =
        res.promoted.length > 0
          ? `${res.promoted.length} file${res.promoted.length === 1 ? '' : 's'}: ${res.promoted.join(', ')}`
          : 'no draft changes'
      toast.success(stopped ? `API is live (${files})` : `Deployed ${files}`)
      // The project's staged set is empty now — this refetch is what takes the
      // StagedChanges strip down.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      // …and the promoted config is the live one now. The APIs rail reads the
      // deployed copy, so this refetch is what moves the auth routes in or out
      // of the list — the deploy is the only thing that should.
      queryClient.invalidateQueries({ queryKey: ['config', tenantId] })
      queryClient.invalidateQueries({ queryKey: ['rbac', tenantId] })
      // Promoted drafts are the deployed files now: the playground's "not
      // deployed yet" check and the editor's read order both change with them.
      queryClient.invalidateQueries({ queryKey: ['resource', tenantId] })
    },
    onError: (e) => toast.error(`Deploy failed: ${e.message}`),
  })

  // Held briefly so fast round-trips still register as a state, not a flicker.
  const deploying = useMinDuration(deploy.isPending)
  const busy = deploying || deploy.isPending || stop.isPending

  return (
    <div className="flex items-stretch">
      <button
        onClick={() => deploy.mutate()}
        disabled={!tenantId || busy}
        // Hover and pointer only while it can be pressed: a disabled button that
        // still lights up under the mouse reads as broken, not as unavailable.
        // Squared off on the right only while Stop sits against it.
        className={`flex items-center gap-1.5 ${stopped ? 'rounded' : 'rounded-l'} bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors enabled:cursor-pointer enabled:hover:bg-primary-hover disabled:opacity-60`}
      >
        {/* Progress lives on the icon, not the label. Swapping the word to
            "Deploying…" and back inside ~50ms stutters; the word only changes
            when the API's state actually changes, which is worth reading. */}
        {deploying ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Rocket className="h-3.5 w-3.5 shrink-0" />
        )}
        {/* Live already means published, so the action is a re-publish; while
            stopped the same button also brings the API back up, which reads as
            a plain Deploy.

            Fixed 8ch — the width of "Redeploy", exact because the font is
            monospace. Without it the button resizes with its label, and being
            in the right-aligned group it drags the mode toggle sideways. */}
        {/* With no project there is nothing deployed, so "Redeploy" would be a
            lie on the very first screen a new account sees — `stopped` covers it. */}
        <span className="w-[8ch] text-center">{stopped ? 'Deploy' : 'Redeploy'}</span>
      </button>
      {/* The second segment, only while live: Stop, one click from Redeploy.
          Red on hover, so what a click here does is plain before it happens. */}
      {!stopped && (
        <button
          title="Stop API"
          aria-label="Stop API"
          onClick={() => setConfirmingStop(true)}
          disabled={busy}
          className="flex items-center rounded-r border-l border-black/20 bg-primary px-2 text-primary-foreground transition-colors enabled:cursor-pointer enabled:hover:bg-danger-fill disabled:opacity-60"
        >
          {stop.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <Dialog
        open={confirmingStop}
        onOpenChange={(open) => !stop.isPending && setConfirmingStop(open)}
      >
        <DialogContent className="w-96 border-border bg-card p-4" showCloseButton={false}>
          <DialogTitle className="text-sm font-semibold text-foreground">
            Stop {current?.name ?? 'this project'}'s API?
          </DialogTitle>
          <p className="font-mono text-xs leading-relaxed text-muted-foreground">
            Every public endpoint of <span className="text-emphasis">/{tenantId}</span> will answer{' '}
            <span className="text-emphasis">503</span> until you deploy it again, so apps calling it
            will fail. Your data, drafts and settings stay as they are.
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              autoFocus
              className="rounded px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-heading"
              onClick={() => setConfirmingStop(false)}
            >
              Cancel
            </button>
            <button
              className="flex items-center gap-1.5 rounded bg-danger-fill px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground transition-colors hover:bg-danger-fill-hover disabled:opacity-60"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <Square className="h-3 w-3" />
              {stop.isPending ? 'Stopping…' : 'Stop API'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Whether this project's API is serving — shown beside its name. */
function StatusBadge({ tenantId }: { tenantId: string }) {
  const status = useProjectStatus(tenantId)
  const stopped = status !== 'active'
  return (
    <span
      title={stopped ? 'Public endpoints answer 503' : 'Public endpoints are serving'}
      className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-subtle"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${stopped ? 'bg-border-stronger' : 'bg-primary'}`} />
      {stopped ? status : 'live'}
    </span>
  )
}

/**
 * The account menu: who is signed in, on which plan, settings, and the way out.
 * Log out lives in here rather than as a bare icon beside the theme toggle — a
 * one-click exit sitting next to a control people click often is too easy to hit.
 */
function ProfileMenu({ user, onSignOut }: { user: ApiUser | null; onSignOut: () => void }) {
  const displayName = user?.name?.trim() || user?.email.split('@')[0] || 'Account'
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title={user ? user.email : 'Account'}
          aria-label="Account menu"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-border bg-card font-mono text-[11px] font-semibold text-heading uppercase transition-colors select-none hover:border-border-stronger"
        >
          {displayName[0]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 border-border bg-card p-1.5">
        {user && (
          <>
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium text-heading">{displayName}</p>
              <p className="truncate font-mono text-[11px] text-subtle">{user.email}</p>
              <p className="mt-1 font-mono text-[10px] text-faint">{user.planName} plan</p>
            </div>
            <DropdownMenuSeparator className="my-1 bg-muted" />
          </>
        )}
        {user && (
          <DropdownMenuItem
            // `from` is where the settings page's back link returns to: the
            // project you were in, which a plain "/" would swap for the first one.
            // Kept only from outside settings, so moving between sections and
            // back out of them still returns to that project.
            onSelect={() =>
              navigate('/settings/profile', {
                state: {
                  from: location.pathname.startsWith('/settings')
                    ? (location.state as { from?: string } | null)?.from
                    : location.pathname,
                },
              })
            }
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:text-heading"
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="font-mono text-xs">Settings</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={onSignOut}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:text-heading"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="font-mono text-xs">Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar() {
  const { data: projects, isLoading } = useProjects()
  const current = useCurrentProject()
  const openProject = useOpenProject()
  const setNewProjectOpen = useWorkspaceStore((s) => s.setNewProjectOpen)
  // With no project there is nothing to switch to, and the page below is
  // already the create form (NoProjects), so the project menu is not offered:
  // its one item would open that same form again, over itself.
  const hasProjects = (projects?.length ?? 0) > 0
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  // Signing out lands on the marketing site, not /login. Someone who clicked
  // "log out" chose to leave; the login form they'd otherwise be dropped on is
  // an invitation to come straight back, and reads as though the sign-out
  // failed. An *involuntary* logout — the 401 handler in the auth store — still
  // falls through to /login, where getting the session back is the whole point,
  // which is why this redirect lives at the click and not in the store.
  //
  // The hint cookie the landing nav reads is cleared synchronously inside
  // logout(), so the page we arrive at already renders its signed-out header.
  const signOut = () => {
    logout()
    window.location.href = LANDING_URL
  }
  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Which project the confirm dialog is about — any row in the list, not just
  // the one currently open.
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [duplicateTarget, setDuplicateTarget] = useState<Project | null>(null)

  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-background px-5">
      {/*
        Out to the marketing site, not to the SPA's own "/" — that is the only
        authenticated route there is, so a router link here would go nowhere.
        Same target and same markup as AuthLogo in auth-shared.tsx.
      */}
      <a href={LANDING_URL} className="inline-flex shrink-0 items-center">
        <img
          src="/stubbase-logo-text-light.svg"
          alt="Stubbase"
          className="h-5 w-auto dark:hidden"
        />
        <img
          src="/stubbase-logo-text-dark.svg"
          alt="Stubbase"
          className="hidden h-5 w-auto dark:block"
        />
      </a>
      <ChevronRight className="h-3.5 w-3.5 text-faintest" />
      {/* `group` so the rename pencil can reveal on hover of the whole block. */}
      <div className="group flex items-center gap-2">
        {current && renaming ? (
          <InlineRename
            tenantId={current.tenantId}
            initialName={current.name}
            onDone={() => setRenaming(false)}
          />
        ) : hasProjects ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button className="flex cursor-pointer items-center gap-1 text-sm font-medium text-foreground select-none">
              {current?.name ?? (isLoading ? 'Loading…' : 'No project')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 border-border bg-card p-1.5">
            <DropdownMenuLabel className="px-2 py-1 text-[10px] font-semibold tracking-wide text-faint uppercase">
              Projects
            </DropdownMenuLabel>
            {(projects ?? []).map((p) => (
              <DropdownMenuItem
                key={p.tenantId}
                onSelect={() => openProject(p.tenantId)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
                  p.tenantId === current?.tenantId ? 'bg-muted/80' : ''
                }`}
              >
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${p.color} text-[10px] font-bold text-primary-foreground`}
                >
                  {p.name[0]?.toUpperCase()}
                </div>
                <span
                  className={`flex-1 truncate font-mono text-xs ${
                    p.tenantId === current?.tenantId ? 'text-heading' : 'text-body'
                  }`}
                >
                  {p.name}
                </span>
                {p.tenantId === current?.tenantId && (
                  <Check className="h-3 w-3 shrink-0 text-primary-accent" />
                )}
                <button
                  title={`Duplicate ${p.name}`}
                  aria-label={`Duplicate ${p.name}`}
                  /* Same pointer handling as Delete beside it. */
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    setMenuOpen(false)
                    setDuplicateTarget(p)
                  }}
                  className="shrink-0 cursor-pointer text-faintest transition-colors hover:text-heading"
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  title={`Delete ${p.name}`}
                  aria-label={`Delete ${p.name}`}
                  /* The row selects on pointer-up, so a bare onClick here would
                     switch to the project as well as open the dialog. Swallow
                     the pointer events and drive it from onClick alone. */
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    setMenuOpen(false) // get the menu out of the dialog's way
                    setDeleteTarget(p)
                  }}
                  /* Always visible, unlike the rename pencil: the menu is an
                     explicit surface you had to open, so the action should be
                     findable without hunting for it by hovering. */
                  className="shrink-0 cursor-pointer text-faintest transition-colors hover:text-danger-ink"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="my-1 bg-muted" />
            <DropdownMenuItem
              onSelect={() => setNewProjectOpen(true)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:text-heading"
            >
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-border-stronger">
                <Plus className="h-3 w-3" />
              </div>
              <span className="font-mono text-xs">New project</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        ) : (
          <span className="text-sm font-medium text-foreground select-none">
            {isLoading ? 'Loading…' : 'No project'}
          </span>
        )}
        {current && !renaming && (
          <button
            title="Rename project"
            aria-label="Rename project"
            onClick={() => setRenaming(true)}
            /* Hidden until the name is hovered (or the button is keyboard
               focused). Opacity rather than display, so revealing it never
               shifts the status badge sitting next to it. */
            className="cursor-pointer text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-emphasis focus-visible:opacity-100"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {/* Hidden while renaming: the save/cancel pair is the only thing that
            should be competing for attention in that moment. */}
        {current && !renaming && <StatusBadge tenantId={current.tenantId} />}
      </div>

      <NewProjectDialog />
      {deleteTarget && (
        <DeleteProjectDialog
          key={deleteTarget.tenantId}
          tenantId={deleteTarget.tenantId}
          name={deleteTarget.name}
          resourceCount={deleteTarget.resources.length}
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
        />
      )}
      {duplicateTarget && (
        <DuplicateProjectDialog
          key={duplicateTarget.tenantId}
          project={duplicateTarget}
          onOpenChange={(open) => !open && setDuplicateTarget(null)}
        />
      )}

      <span className="flex-1" />
      <ModeToggle />
      <DeployControls tenantId={current?.tenantId} />
      <ThemeToggle />
      <ProfileMenu user={user} onSignOut={signOut} />
    </div>
  )
}
