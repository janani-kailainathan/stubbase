import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Activity,
  CircleStop,
  Info,
  Play,
  Rocket,
  Sparkles,
  Table2,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { useCoPilotChat, useIsCoPilotThinking } from '@/hooks/ai'
import { useHasFeature } from '@/hooks/plan'
import { PlanNotice } from '@/components/shell/PlanNotice'
import { useCurrentProject } from '@/hooks/projects'
import { useApplyDeletion } from '@/hooks/resources'
import { AI_EXAMPLES } from '@/lib/ai-examples'
import { Markdown } from '@/lib/markdown'
import type { ChatPart, ChatTurn } from '@/lib/api'
import { useWorkspaceStore, type ChatEntry } from '@/stores/workspace'

// ── Tool results ──────────────────────────────────────────────────
// The Co-Pilot's tools run server-side; these cards are how the user sees what
// it did to their project. Everything here is untrusted model-adjacent data,
// so each field is read defensively rather than trusted to be present.

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function ToolCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Wrench
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border bg-panel p-2.5">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary-accent" />
        <span className="font-mono text-[11px] text-body">{title}</span>
      </div>
      {children && <div className="mt-2 space-y-1.5">{children}</div>}
    </div>
  )
}

function Warnings({ warnings }: { warnings: unknown }) {
  const items = list(warnings).filter((w): w is string => typeof w === 'string')
  if (items.length === 0) return null
  return (
    <ul className="space-y-0.5">
      {items.map((w) => (
        <li key={w} className="font-mono text-[10px] text-warning-ink/80">
          {w}
        </li>
      ))}
    </ul>
  )
}

function StagedTables({ result }: { result: Record<string, unknown> }) {
  const staged = list(result.staged) as { name: string; records: number; fields: string[] }[]
  return (
    <ToolCard icon={Table2} title="Staged schema drafts">
      {staged.map((t) => (
        <div key={t.name} className="rounded-md border border-border bg-code-bg px-3 py-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-primary-ink">{t.name}.json</span>
            <span className="font-mono text-[10px] text-subtle">
              {t.records} record{t.records === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-faint">
            {list(t.fields).join(' · ')}
          </div>
        </div>
      ))}
      <Warnings warnings={result.warnings} />
      <p className="font-mono text-[10px] text-faint">
        Staged as drafts — press Deploy to publish them to your live API.
      </p>
    </ToolCard>
  )
}

function Deployed({ result }: { result: Record<string, unknown> }) {
  const promoted = list(result.promoted).filter((p): p is string => typeof p === 'string')
  return (
    <ToolCard icon={Rocket} title="Deployed to production">
      {promoted.length > 0 ? (
        <p className="font-mono text-[10px] text-subtle">{promoted.join(' · ')} are now live.</p>
      ) : (
        <p className="font-mono text-[10px] text-faint">Nothing was staged, so nothing changed.</p>
      )}
    </ToolCard>
  )
}

function StatusChanged({ result }: { result: Record<string, unknown> }) {
  const status = str(result.status)
  const active = status === 'active'
  return (
    <ToolCard
      icon={active ? Play : CircleStop}
      title={active ? 'API started' : 'API stopped'}
    >
      <p className="font-mono text-[10px] text-subtle">{str(result.note)}</p>
    </ToolCard>
  )
}

function Diagnostics({ result }: { result: Record<string, unknown> }) {
  const syntaxErrors = list(result.syntaxErrors) as { file: string; message: string }[]
  const recent = list(result.recentRequests)
  return (
    <ToolCard icon={Activity} title="Read diagnostics">
      <p className="font-mono text-[10px] text-subtle">
        Status {str(result.status) ?? 'unknown'} · {String(result.filesChecked ?? 0)} file(s) checked
        {recent.length > 0 ? ` · ${recent.length} recent request(s)` : ' · no recent traffic'}
      </p>
      {syntaxErrors.map((e) => (
        <p key={e.file} className="font-mono text-[10px] text-danger-ink/90">
          {e.file}: {e.message}
        </p>
      ))}
      <Warnings warnings={result.warnings} />
    </ToolCard>
  )
}

/**
 * A deletion the Co-Pilot proposed. Nothing has happened yet: the server's tool
 * only returns the proposal, and this card is where a human either carries it
 * out or throws it away. Destructive actions stay one click away from the model.
 */
function ConfirmDeletion({
  tenantId,
  names,
  mode,
}: {
  tenantId: string | undefined
  names: string[]
  mode: 'empty' | 'remove'
}) {
  const [settled, setSettled] = useState<'done' | 'cancelled' | null>(null)
  const addChatEntry = useWorkspaceStore((s) => s.addChatEntry)
  const apply = useApplyDeletion(tenantId)

  const removing = mode === 'remove'
  // Emptying goes through the files proxy, so it lands as a draft like every
  // other edit — the live API keeps serving until Deploy. Removing takes the
  // file out from under the live plane immediately. Say which, precisely:
  // "this cannot be undone" on a staged change would be a lie.
  const copy = removing
    ? {
        title: `Delete ${names.length} table${names.length === 1 ? '' : 's'}?`,
        detail: 'The files and their endpoints are deleted immediately. This cannot be undone.',
        confirm: 'Yes, delete',
        busy: 'Deleting…',
        done: 'Deleted',
        doneDetail: `${names.join(' · ')} — removed.`,
        notice: `Deleted ${names.join(', ')}.`,
      }
    : {
        title: `Empty ${names.length} table${names.length === 1 ? '' : 's'}?`,
        detail:
          'Every record is dropped into a staged draft. The endpoints stay, and your live API keeps serving until you press Deploy.',
        confirm: 'Yes, empty',
        busy: 'Emptying…',
        done: 'Emptied',
        doneDetail: `${names.join(' · ')} — emptied in the draft. Deploy to clear the live API.`,
        notice: `Emptied ${names.join(', ')} in the draft — Deploy to clear the live API.`,
      }

  const notice = (text: string, tone: 'done' | 'cancelled') => {
    if (tenantId) addChatEntry(tenantId, { id: crypto.randomUUID(), kind: 'notice', text, tone })
  }

  if (settled)
    return (
      <ToolCard icon={Trash2} title={settled === 'done' ? copy.done : 'Cancelled'}>
        <p className="font-mono text-[10px] text-subtle">
          {settled === 'done' ? copy.doneDetail : 'Nothing was changed.'}
        </p>
      </ToolCard>
    )

  return (
    <div className="rounded-md border border-danger-soft-border bg-danger-soft-weak p-2.5">
      <div className="flex items-center gap-2">
        <Trash2 className="h-3.5 w-3.5 shrink-0 text-danger-ink" />
        <span className="font-mono text-[11px] text-danger-emphasis">{copy.title}</span>
      </div>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground">{names.join(' · ')}</p>
      <p className="mt-1 font-mono text-[10px] text-subtle">{copy.detail}</p>
      {apply.isError && (
        <p className="mt-1 font-mono text-[10px] text-danger-ink">{apply.error.message}</p>
      )}
      <div className="mt-2.5 flex gap-2">
        <button
          onClick={() =>
            apply.mutate(
              { names, mode },
              {
                onSuccess: () => {
                  setSettled('done')
                  notice(copy.notice, 'done')
                },
              },
            )
          }
          disabled={apply.isPending}
          className="cursor-pointer rounded-md bg-danger-fill px-2.5 py-1 font-mono text-[11px] text-primary-foreground transition-colors hover:bg-danger-fill-hover disabled:opacity-50"
        >
          {apply.isPending ? copy.busy : copy.confirm}
        </button>
        <button
          onClick={() => {
            setSettled('cancelled')
            notice('Cancelled — nothing was deleted.', 'cancelled')
          }}
          disabled={apply.isPending}
          className="cursor-pointer rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-heading disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ToolResult({
  name,
  result,
  tenantId,
}: {
  name: string
  result: Record<string, unknown>
  tenantId: string | undefined
}) {
  // A proposal, not an outcome — render the confirmation rather than a summary.
  const pending = result.pendingConfirmation as
    | { names?: unknown; mode?: unknown }
    | undefined
  if (pending) {
    const names = list(pending.names).filter((n): n is string => typeof n === 'string')
    const mode = pending.mode === 'remove' ? 'remove' : 'empty'
    if (names.length > 0)
      return <ConfirmDeletion tenantId={tenantId} names={names} mode={mode} />
  }

  // A tool that failed says so plainly — the model will have explained it in
  // the reply underneath, but the card must not claim success.
  const failure = str(result.error)
  if (failure)
    return (
      <ToolCard icon={TriangleAlert} title={`${name} failed`}>
        <p className="font-mono text-[10px] text-danger-ink/90">{failure}</p>
        <Warnings warnings={result.warnings} />
      </ToolCard>
    )

  switch (name) {
    case 'stage_schema_drafts':
      return <StagedTables result={result} />
    case 'deploy_project':
      return <Deployed result={result} />
    case 'set_server_status':
      return <StatusChanged result={result} />
    case 'get_diagnostics':
      return <Diagnostics result={result} />
    default:
      return <ToolCard icon={Wrench} title={name} />
  }
}

// ── Turns ─────────────────────────────────────────────────────────

const textOf = (parts: ChatPart[]) =>
  parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()

function Turn({ turn, tenantId }: { turn: ChatTurn; tenantId: string | undefined }) {
  if (turn.role === 'user') {
    const text = textOf(turn.parts)
    if (!text) return null
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary px-4 py-2 font-mono text-xs break-words whitespace-pre-wrap text-primary-foreground">
          {text}
        </div>
      </div>
    )
  }

  // Tool turns are authored by the server, one part per tool that ran.
  if (turn.role === 'function') {
    const responses = turn.parts
      .map((p) => p.functionResponse)
      .filter((r): r is NonNullable<typeof r> => Boolean(r?.name))
    if (responses.length === 0) return null
    return (
      <div className="w-full max-w-[85%] space-y-1.5">
        {responses.map((r, i) => (
          <ToolResult
            key={`${r.name}-${i}`}
            name={r.name}
            result={r.response?.result ?? {}}
            tenantId={tenantId}
          />
        ))}
      </div>
    )
  }

  // A model turn that only asked for tools has no prose of its own — the tool
  // cards that follow it are the visible outcome, so render nothing here.
  const text = textOf(turn.parts)
  if (!text) return null
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg border border-border bg-card px-4 py-2.5 font-mono text-xs leading-relaxed break-words text-emphasis">
        <Markdown text={text} />
      </div>
    </div>
  )
}

function Entry({ entry, tenantId }: { entry: ChatEntry; tenantId: string | undefined }) {
  if (entry.kind === 'error')
    return (
      <div className="flex justify-start">
        <div className="flex max-w-[80%] items-start gap-2 rounded-lg border border-danger-soft-border bg-danger-soft px-4 py-2">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-ink" />
          <span className="font-mono text-xs text-danger-emphasis">{entry.text}</span>
        </div>
      </div>
    )

  // What the user did, not what the model said — deliberately plain.
  if (entry.kind === 'notice')
    return (
      <div className="flex items-center gap-2 px-1">
        <Info
          className={`h-3 w-3 shrink-0 ${entry.tone === 'done' ? 'text-subtle' : 'text-faint'}`}
        />
        <span className="font-mono text-[10px] text-subtle">{entry.text}</span>
      </div>
    )

  return <Turn turn={entry.turn} tenantId={tenantId} />
}

/**
 * Example prompts, simplest first. Clicking one loads it into the composer
 * rather than sending it: a turn costs a real provider call, so the send stays
 * an explicit second act.
 */
function ExamplePrompts() {
  const setInput = useWorkspaceStore((s) => s.setChatInput)

  return (
    <div className="w-full max-w-xl">
      <p className="mb-2 text-center font-mono text-[10px] tracking-wide text-faintest uppercase">
        Try one
      </p>
      <div className="flex flex-col gap-2">
        {AI_EXAMPLES.map((example) => (
          <button
            key={example.label}
            onClick={() => setInput(example.prompt)}
            className="group flex cursor-pointer flex-col gap-1 rounded-md border border-border bg-panel p-2.5 text-left transition-colors hover:border-primary-soft-border-strong hover:bg-card"
          >
            <span className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-emphasis">{example.label}</span>
              <span className="font-mono text-[10px] text-faint">{example.hint}</span>
            </span>
            <span className="font-mono text-[10px] text-subtle">{example.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────

/** Stable reference: a fresh [] from the selector would re-render forever. */
const NO_ENTRIES: ChatEntry[] = []

export function AiChat({ tenantId }: { tenantId: string | undefined }) {
  const entries = useWorkspaceStore((s) =>
    tenantId ? (s.chat[tenantId] ?? NO_ENTRIES) : NO_ENTRIES,
  )
  const isThinking = useIsCoPilotThinking(tenantId)
  const project = useCurrentProject()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length, isThinking])

  if (entries.length === 0 && !isThinking) {
    // Suggestions are for a blank slate. Once the project holds a resource the
    // prompts stop being a starting point and start being noise — worse, acting
    // on one would generate tables alongside data that is already there.
    const isBlankProject = project !== undefined && project.resources.length === 0
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-auto bg-code-bg p-6">
        <div className="flex flex-col items-center gap-3">
          <Sparkles className="h-7 w-7 text-faintest" />
          <span className="max-w-sm text-center font-mono text-xs text-faint">
            Ask for an API, a fix, or a deploy — the Co-Pilot can read your logs and change your
            project.
          </span>
        </div>
        {isBlankProject && <ExamplePrompts />}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto bg-code-bg p-4">
      {entries.map((e) => (
        <Entry key={e.id} entry={e} tenantId={tenantId} />
      ))}
      {isThinking && (
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary-accent" />
          <span className="font-mono text-xs text-subtle">
            Working&hellip; this can take a few seconds.
          </span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

// ── Composer (bottom bar, present in both pane modes) ─────────────

export function AiComposer({ tenantId }: { tenantId: string | undefined }) {
  const input = useWorkspaceStore((s) => s.chatInput)
  const setInput = useWorkspaceStore((s) => s.setChatInput)
  const addChatEntry = useWorkspaceStore((s) => s.addChatEntry)
  const setChatTurns = useWorkspaceStore((s) => s.setChatTurns)
  const setPaneMode = useWorkspaceStore((s) => s.setPaneMode)
  const chat = useCoPilotChat(tenantId)
  const entitled = useHasFeature('ai')

  const send = () => {
    const text = input.trim()
    if (!text || !tenantId || chat.isPending || !entitled) return
    setInput('')
    setPaneMode('ai') // sending from the editor should show you the answer

    // The transcript is the request body: take the conversation so far, append
    // this turn, and send the lot. Error entries are local and never go up.
    const store = useWorkspaceStore.getState()
    const history: ChatTurn[] = (store.chat[tenantId] ?? [])
      .filter((e) => e.kind === 'turn')
      .map((e) => e.turn)
    const turn: ChatTurn = { role: 'user', parts: [{ text }] }

    addChatEntry(tenantId, { id: crypto.randomUUID(), kind: 'turn', turn })
    chat.mutate([...history, turn], {
      onSuccess: (res) => setChatTurns(tenantId, res.messages),
      onError: (e) =>
        addChatEntry(tenantId, { id: crypto.randomUUID(), kind: 'error', text: e.message }),
    })
  }

  // Off-plan renders the composer disabled rather than removing it: a control
  // that vanishes teaches nobody it exists, and the point of showing it is that
  // the reader learns the Co-Pilot is there and what it would take to use it.
  // The button keeps its shape so the bar does not reflow between plans.
  return (
    <div className="shrink-0 border-t border-border p-3">
      {!entitled && <PlanNotice feature="ai" label="The AI Co-Pilot" />}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          disabled={!tenantId || chat.isPending || !entitled}
          placeholder={
            !entitled ? 'Upgrade to ask the AI Co-Pilot' : chat.isPending ? 'Working…' : 'Ask the AI Co-Pilot…'
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-code-bg px-3 py-2 font-mono text-xs text-emphasis placeholder-faint focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          onClick={send}
          disabled={!tenantId || chat.isPending || !input.trim() || !entitled}
          title={entitled ? undefined : 'Available on Pro + AI'}
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
