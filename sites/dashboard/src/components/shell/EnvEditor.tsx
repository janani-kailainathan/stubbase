import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Check, X } from 'lucide-react'
import { useTenantConfig, useSaveTenantConfig } from '@/hooks/config'
import { SAVE_HINT, useSaveShortcut } from '@/hooks/save-shortcut'
import { CORE_PUBLIC_URL, LANDING_URL } from '@/lib/api'
import { authEnabled } from '@/lib/endpoints'
import {
  configToEnvText,
  envTextToConfig,
  isKnownKey,
  maskValue,
  parseEnvText,
  socialLoginConfigured,
} from '@/lib/env'
import { useWorkspaceStore } from '@/stores/workspace'

// ── Highlighting ──────────────────────────────────────────────────
// Comments dim, keys bright, numbers amber inside values — matching the
// JSON view's palette.

function highlightValue(value: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of value.matchAll(/\d+/g)) {
    if (m.index! > last) nodes.push(value.slice(last, m.index))
    nodes.push(
      <span key={key++} className="text-syntax-num">
        {m[0]}
      </span>,
    )
    last = m.index! + m[0].length
  }
  nodes.push(value.slice(last))
  return nodes
}

function EnvHighlight({ text, mask }: { text: string; mask: boolean }) {
  const lines = text.split('\n')
  return (
    <pre className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
      {lines.map((line, i) => {
        const nl = i < lines.length - 1 ? '\n' : ''
        if (line.trim().startsWith('#'))
          return (
            <span key={i} className="text-faint">
              {line}
              {nl}
            </span>
          )
        const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/)
        if (!m)
          return (
            <span key={i} className="text-body">
              {line}
              {nl}
            </span>
          )
        const value = mask ? maskValue(m[2], m[4]) : m[4]
        return (
          <span key={i}>
            {m[1]}
            <span className="text-heading">{m[2]}</span>
            <span className="text-subtle">{m[3]}</span>
            <span className="text-body">{highlightValue(value)}</span>
            {nl}
          </span>
        )
      })}
    </pre>
  )
}

// ── Edit / Save / Cancel (mirrors ResourceActions) ────────────────

export function EnvActions({ tenantId }: { tenantId: string }) {
  const editing = useWorkspaceStore((s) => s.editing)
  const draft = useWorkspaceStore((s) => s.draft)
  const startEdit = useWorkspaceStore((s) => s.startEdit)
  const stopEdit = useWorkspaceStore((s) => s.stopEdit)
  const { data } = useTenantConfig(tenantId)
  const save = useSaveTenantConfig(tenantId)

  const onSave = () => {
    const { env, errors } = parseEnvText(draft)
    if (errors.length > 0) {
      toast.error(`Line ${errors[0].line} is not KEY=value: “${errors[0].text}”`)
      return
    }
    const unknown = Object.keys(env).filter((k) => !isKnownKey(k))
    if (unknown.length > 0)
      toast.info(`Saved, but Stubbase doesn't act on: ${unknown.join(', ')}`)
    save.mutate(envTextToConfig(draft), {
      onSuccess: () => {
        stopEdit()
        toast.success(`Saved .env (${Object.keys(env).length} variable${Object.keys(env).length === 1 ? '' : 's'})`)
      },
      onError: (e) => toast.error(`Save failed: ${e.message}`),
    })
  }

  useSaveShortcut(editing && !save.isPending, onSave)

  if (!editing) {
    return (
      <button
        onClick={() => startEdit(configToEnvText(data ?? {}))}
        disabled={data === undefined}
        className="cursor-pointer px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-primary-accent disabled:opacity-50"
      >
        Edit
      </button>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={stopEdit}
        className="flex cursor-pointer items-center gap-1 px-2 py-1 font-mono text-xs text-subtle transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={save.isPending}
        title={`Save (${SAVE_HINT})`}
        className="flex cursor-pointer items-center gap-1 rounded bg-primary px-2 py-1 font-mono text-xs text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        <Check className="h-3.5 w-3.5" />
        {save.isPending ? 'Saving…' : 'Save'}
        <span className="text-primary-foreground/50">{SAVE_HINT}</span>
      </button>
    </div>
  )
}

// ── Social login hint ─────────────────────────────────────────────

/**
 * Shown while auth is on but neither Google nor GitHub has both its keys. The
 * lines are already in the .env, commented; what nobody can do for the owner is
 * register an OAuth app, and that needs this project's own callback URLs.
 * Hiding it lasts until the view remounts — it is a pointer, not a setting.
 */
function SocialLoginHint({ tenantId }: { tenantId: string }) {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  const callback = (provider: string) => `${CORE_PUBLIC_URL}/${tenantId}/auth/${provider}/callback`

  return (
    <div className="mb-4 space-y-1.5 rounded-md border border-border bg-panel px-3 py-2.5 font-mono text-[11px] leading-relaxed text-subtle">
      <div className="flex items-start gap-3">
        <p className="flex-1 text-body">
          Google and GitHub sign-in are off. Fill in a client ID and secret for either one below, Save,
          then Deploy.
        </p>
        <button
          onClick={() => setHidden(true)}
          className="shrink-0 cursor-pointer text-faint transition-colors hover:text-heading"
        >
          Hide
        </button>
      </div>
      <p>Register this callback URL in the provider&rsquo;s OAuth app:</p>
      <p className="break-all text-heading">{callback('google')}</p>
      <p className="break-all text-heading">{callback('github')}</p>
      <a
        href={`${LANDING_URL}/features/google-github-social-login`}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-primary-accent hover:text-primary-ink"
      >
        How to get the keys
      </a>
    </div>
  )
}

// ── View ──────────────────────────────────────────────────────────

export function EnvView({ tenantId }: { tenantId: string }) {
  const editing = useWorkspaceStore((s) => s.editing)
  const draft = useWorkspaceStore((s) => s.draft)
  const changeDraft = useWorkspaceStore((s) => s.changeDraft)
  const { data, isLoading, error } = useTenantConfig(tenantId)

  if (editing) {
    return (
      <textarea
        value={draft}
        onChange={(e) => changeDraft(e.target.value)}
        spellCheck={false}
        placeholder={'AUTH_ENABLED=true\nAUTH_PUBLIC_ROUTES=posts,comments'}
        className="min-h-0 w-full flex-1 resize-none bg-code-bg p-4 font-mono text-[13px] text-heading placeholder-faintest focus:outline-none"
      />
    )
  }

  const text = data ? configToEnvText(data) : ''
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-code-bg p-4">
      {isLoading && <p className="font-mono text-xs text-faint">Loading…</p>}
      {error && <p className="font-mono text-xs text-danger-ink">Could not load: {error.message}</p>}
      {data !== undefined && authEnabled(data) && !socialLoginConfigured(data) && (
        <SocialLoginHint tenantId={tenantId} />
      )}
      {data !== undefined &&
        (text.trim() ? (
          <EnvHighlight text={text} mask />
        ) : (
          <div className="space-y-1 font-mono text-[13px] leading-relaxed">
            <p className="text-faint"># No environment variables yet.</p>
            <p className="text-faint"># Click Edit and try e.g.</p>
            <p className="text-faintest">AUTH_ENABLED=true</p>
            <p className="text-faintest">AUTH_PUBLIC_ROUTES=posts</p>
          </div>
        ))}
    </div>
  )
}
