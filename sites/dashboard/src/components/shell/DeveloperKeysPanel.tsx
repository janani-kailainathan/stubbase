import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import {
  useCreateDeveloperKey,
  useDeveloperKeys,
  useRevokeDeveloperKey,
} from '@/hooks/keys'
import { mcpUrl, type CreatedDeveloperKey } from '@/lib/api'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold tracking-wide text-subtle uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** Copy-to-clipboard that confirms in place, so the click has visible feedback. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground hover:border-border-strong hover:text-emphasis"
    >
      {copied ? <Check className="h-3 w-3 text-primary-ink" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-panel-strong p-3 font-mono text-[11px] leading-relaxed text-body">
        {children}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={children} />
      </div>
    </div>
  )
}

/**
 * The one and only sighting of a raw key. The server stores a hash, so this
 * cannot be re-shown — say so plainly rather than letting someone close it and
 * discover that later.
 */
function NewKeyBanner({ created }: { created: CreatedDeveloperKey }) {
  return (
    <div className="space-y-2 rounded-md border border-primary-soft-border bg-primary-soft-weak p-3">
      <div className="flex gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary-ink" />
        <p className="font-mono text-xs text-primary-ink-hover">
          Copy this key now — it is stored hashed and cannot be shown again.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[11px] text-emphasis">
          {created.key}
        </code>
        <CopyButton text={created.key} />
      </div>
    </div>
  )
}

/**
 * Claude Desktop speaks stdio, so it reaches a remote SSE server through the
 * `mcp-remote` bridge. `--transport sse-only` matters: this server implements
 * the HTTP+SSE transport, and without the flag the bridge probes for
 * Streamable HTTP first.
 */
function claudeConfig(tenantId: string, key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [`stubbase_${tenantId.replace(/-/g, '_')}`]: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            mcpUrl(tenantId),
            '--transport',
            'sse-only',
            '--header',
            'Authorization: Bearer ${STUBBASE_API_KEY}',
          ],
          env: { STUBBASE_API_KEY: key },
        },
      },
    },
    null,
    2,
  )
}

function KeyList({ tenantId }: { tenantId: string }) {
  const { data: keys, isLoading } = useDeveloperKeys(tenantId)
  const revoke = useRevokeDeveloperKey(tenantId)
  const [confirming, setConfirming] = useState<number | null>(null)

  if (isLoading) return <p className="font-mono text-[11px] text-faint">Loading keys…</p>
  if (!keys?.length)
    return (
      <p className="font-mono text-[11px] text-faint">
        No keys yet. Generate one to connect an external agent.
      </p>
    )

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {keys.map((k) => (
        <li key={k.id} className="flex items-center gap-3 px-3 py-2">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-faint" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-body">{k.name || 'Unnamed key'}</p>
            <p className="truncate font-mono text-[10px] text-faint">
              {k.prefix}… · created {k.createdAt}
            </p>
          </div>
          {confirming === k.id ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  revoke.mutate(k.id)
                  setConfirming(null)
                }}
                className="cursor-pointer rounded-md border border-danger-fill/40 bg-danger-soft px-2 py-1 font-mono text-[11px] text-danger-emphasis hover:bg-danger-fill/20"
              >
                Revoke
              </button>
              <button
                onClick={() => setConfirming(null)}
                className="cursor-pointer rounded-md border border-transparent px-2 py-1 font-mono text-[11px] text-subtle hover:text-body"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(k.id)}
              title="Revoke this key"
              className="cursor-pointer rounded-md border border-transparent p-1 text-faint hover:text-danger-ink"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function DeveloperKeysPanel({ tenantId }: { tenantId: string | undefined }) {
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedDeveloperKey | null>(null)
  const create = useCreateDeveloperKey(tenantId)

  if (!tenantId)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="font-mono text-xs text-faint">Create a project to issue API keys.</p>
      </div>
    )

  const submit = () => {
    if (create.isPending) return
    create.mutate(name.trim() || 'Untitled key', {
      onSuccess: (key) => {
        setCreated(key)
        setName('')
      },
    })
  }

  // Before a key exists there is nothing to paste, so the snippet shows a
  // placeholder rather than a config that would silently fail to authenticate.
  const snippet = claudeConfig(tenantId, created?.key ?? 'sk_stub_…')

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-5">
        <Section title="Generate a key">
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Claude Desktop"
              maxLength={64}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-emphasis placeholder:text-faint focus:border-border-strong focus:outline-none"
            />
            <button
              onClick={submit}
              disabled={create.isPending}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-xs text-primary-foreground hover:bg-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {create.isPending ? 'Generating…' : 'Generate'}
            </button>
          </div>
          {create.isError && (
            <p className="font-mono text-[11px] text-danger-ink">{create.error.message}</p>
          )}
          {created && <NewKeyBanner created={created} />}
        </Section>

        <Section title="Active keys">
          <KeyList tenantId={tenantId} />
        </Section>

        <Section title="Connect to Claude Desktop">
          <p className="font-mono text-[11px] leading-relaxed text-subtle">
            Paste this into <code className="text-muted-foreground">claude_desktop_config.json</code>, then
            restart Claude Desktop. The agent can then query this project's data with SQL.
          </p>
          <CodeBlock>{snippet}</CodeBlock>
          {!created && (
            <p className="font-mono text-[11px] text-warning-ink/80">
              Generate a key above and this snippet will include it.
            </p>
          )}
        </Section>

        <Section title="MCP endpoint">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-panel-strong px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
              {mcpUrl(tenantId)}
            </code>
            <CopyButton text={mcpUrl(tenantId)} />
          </div>
          <p className="font-mono text-[11px] leading-relaxed text-faint">
            Any MCP client speaking the HTTP+SSE transport can connect here with{' '}
            <code className="text-subtle">Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </Section>
      </div>
    </div>
  )
}
