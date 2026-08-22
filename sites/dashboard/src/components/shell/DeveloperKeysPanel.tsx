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
      <h3 className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">{title}</h3>
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
      className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
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
    <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <p className="font-mono text-xs text-emerald-300">
          Copy this key now — it is stored hashed and cannot be shown again.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200">
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

  if (isLoading) return <p className="font-mono text-[11px] text-zinc-600">Loading keys…</p>
  if (!keys?.length)
    return (
      <p className="font-mono text-[11px] text-zinc-600">
        No keys yet. Generate one to connect an external agent.
      </p>
    )

  return (
    <ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
      {keys.map((k) => (
        <li key={k.id} className="flex items-center gap-3 px-3 py-2">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-zinc-300">{k.name || 'Unnamed key'}</p>
            <p className="truncate font-mono text-[10px] text-zinc-600">
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
                className="cursor-pointer rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 font-mono text-[11px] text-rose-300 hover:bg-rose-500/20"
              >
                Revoke
              </button>
              <button
                onClick={() => setConfirming(null)}
                className="cursor-pointer rounded-md border border-transparent px-2 py-1 font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(k.id)}
              title="Revoke this key"
              className="cursor-pointer rounded-md border border-transparent p-1 text-zinc-600 hover:text-rose-400"
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
        <p className="font-mono text-xs text-zinc-600">Create a project to issue API keys.</p>
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
              className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none"
            />
            <button
              onClick={submit}
              disabled={create.isPending}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 font-mono text-xs text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {create.isPending ? 'Generating…' : 'Generate'}
            </button>
          </div>
          {create.isError && (
            <p className="font-mono text-[11px] text-rose-400">{create.error.message}</p>
          )}
          {created && <NewKeyBanner created={created} />}
        </Section>

        <Section title="Active keys">
          <KeyList tenantId={tenantId} />
        </Section>

        <Section title="Connect to Claude Desktop">
          <p className="font-mono text-[11px] leading-relaxed text-zinc-500">
            Paste this into <code className="text-zinc-400">claude_desktop_config.json</code>, then
            restart Claude Desktop. The agent can then query this project's data with SQL.
          </p>
          <CodeBlock>{snippet}</CodeBlock>
          {!created && (
            <p className="font-mono text-[11px] text-amber-400/80">
              Generate a key above and this snippet will include it.
            </p>
          )}
        </Section>

        <Section title="MCP endpoint">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
              {mcpUrl(tenantId)}
            </code>
            <CopyButton text={mcpUrl(tenantId)} />
          </div>
          <p className="font-mono text-[11px] leading-relaxed text-zinc-600">
            Any MCP client speaking the HTTP+SSE transport can connect here with{' '}
            <code className="text-zinc-500">Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </Section>
      </div>
    </div>
  )
}
