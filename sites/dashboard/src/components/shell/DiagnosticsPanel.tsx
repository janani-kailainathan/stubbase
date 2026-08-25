import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useDiagnostics, useEdgeProbe } from '@/hooks/diagnostics'
import { useTenantConfig } from '@/hooks/config'
import { useCurrentProject } from '@/hooks/projects'

type Tone = 'error' | 'warn' | 'ok'

const TONE: Record<Tone, { wrap: string; icon: string }> = {
  error: { wrap: 'border-danger-soft-border bg-danger-soft-weak', icon: 'text-danger-ink' },
  warn: { wrap: 'border-warning-soft-border bg-warning-soft-weak', icon: 'text-warning-ink' },
  ok: { wrap: 'border-border bg-panel', icon: 'text-primary-accent' },
}

function Alert({
  tone,
  title,
  children,
}: {
  tone: Tone
  title: string
  children?: ReactNode
}) {
  const Icon = tone === 'error' ? XCircle : tone === 'warn' ? AlertTriangle : CheckCircle2
  return (
    <div className={`flex gap-2.5 rounded-md border p-3 ${TONE[tone].wrap}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE[tone].icon}`} />
      <div className="min-w-0">
        <p
          className={`font-mono text-xs ${
            tone === 'error' ? 'text-danger-emphasis' : tone === 'warn' ? 'text-warning-emphasis' : 'text-body'
          }`}
        >
          {title}
        </p>
        {children && <div className="mt-1 font-mono text-[11px] text-subtle">{children}</div>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold tracking-wide text-subtle uppercase">{title}</h3>
      {children}
    </section>
  )
}

export function DiagnosticsPanel({ tenantId }: { tenantId: string | undefined }) {
  const project = useCurrentProject()
  const probeResource = project?.resources[0]

  const diagnostics = useDiagnostics(tenantId)
  const { data: config } = useTenantConfig(tenantId)
  const edge = useEdgeProbe(tenantId, probeResource)

  const syntaxErrors = diagnostics.data?.syntaxErrors ?? []
  const qaMode = String(config?.QA_MODE ?? '').toLowerCase() === 'true'
  const status = config?.PROJECT_STATUS
  const stopped = status === 'stopped' || status === 'maintenance'

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-5">
        {/* The pane header already names this view — just offer the action. */}
        <div className="flex items-center justify-end">
          <button
            onClick={() => {
              void diagnostics.refetch()
              // Only re-run the public probe if the user already opted into it
              // once — Re-check must not be a way to start generating traffic.
              if (edge.data) edge.mutate()
            }}
            disabled={diagnostics.isFetching || edge.isPending}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-heading disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${diagnostics.isFetching ? 'animate-spin' : ''}`} />
            Re-check
          </button>
        </div>

        <Section title="JSON syntax">
          {diagnostics.isLoading ? (
            <p className="font-mono text-xs text-faint">Checking files…</p>
          ) : diagnostics.error ? (
            <Alert tone="error" title="Could not run the syntax check">
              {diagnostics.error.message}
            </Alert>
          ) : syntaxErrors.length === 0 ? (
            <Alert
              tone="ok"
              title={`All ${diagnostics.data?.checked ?? 0} file(s) parse cleanly.`}
            />
          ) : (
            syntaxErrors.map((e) => (
              <Alert key={e.file} tone="error" title={`${e.file} is not valid JSON`}>
                {e.message} — the engine skips unreadable files, so this resource is currently
                serving nothing.
              </Alert>
            ))
          )}
        </Section>

        <Section title="Configuration">
          {stopped && (
            <Alert tone="warn" title={`PROJECT_STATUS=${status}`}>
              Every public endpoint answers 503 until you deploy or start the API again.
            </Alert>
          )}
          {qaMode && (
            <Alert tone="warn" title="QA_MODE=true">
              Simulation headers (<code>x-stubbase-delay</code>, <code>-status</code>,{' '}
              <code>-error-rate</code>, <code>-empty</code>) are live for anyone who calls this API.
              Turn it off before sharing the URL widely.
            </Alert>
          )}
          {!stopped && !qaMode && <Alert tone="ok" title="No risky settings enabled." />}
        </Section>

        <Section title="Edge checks">
          {!probeResource ? (
            <p className="font-mono text-xs text-faint">
              No resources yet — nothing to probe.
            </p>
          ) : edge.isPending ? (
            <p className="font-mono text-xs text-faint">Probing /{probeResource}…</p>
          ) : !edge.data ? (
            // Opt-in: this is the only check that calls the tenant's public
            // API, so it counts as their traffic. Say so, and let them choose.
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel p-3">
              <p className="font-mono text-[11px] text-subtle">
                Sends one real <span className="text-body">GET /{probeResource}</span> to your
                public API — it counts toward your usage and appears in your logs.
              </p>
              <button
                onClick={() => edge.mutate()}
                className="shrink-0 cursor-pointer rounded-md border border-border px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-heading"
              >
                Run check
              </button>
            </div>
          ) : edge.data?.unreachable ? (
            <Alert tone="error" title="The public API is unreachable">
              The request failed before a response came back — the engine may be down, or CORS is
              blocking this origin.
            </Alert>
          ) : edge.data?.status === 429 ? (
            <Alert tone="error" title="429 Too Many Requests — rate limited">
              Callers are being throttled. Back off the request rate, or raise the limit in .env.
            </Alert>
          ) : edge.data?.status === 413 ? (
            <Alert tone="error" title="413 Payload Too Large">
              A response exceeded the body cap. Trim the records in this resource or page the
              endpoint with <code>_limit</code>.
            </Alert>
          ) : stopped && edge.data?.status === 503 ? (
            // Expected, not a fault: statusGuard 503s the whole public plane.
            <Alert tone="warn" title={`GET /${probeResource} returned 503`}>
              Expected while PROJECT_STATUS={status} — deploy to bring the API back up.
            </Alert>
          ) : edge.data && edge.data.status >= 500 ? (
            <Alert tone="error" title={`GET /${probeResource} returned ${edge.data.status}`}>
              The engine failed to serve this resource.
            </Alert>
          ) : edge.data && edge.data.status >= 400 ? (
            <Alert tone="warn" title={`GET /${probeResource} returned ${edge.data.status}`}>
              The endpoint rejected an unauthenticated read — check AUTH_ENABLED.
            </Alert>
          ) : (
            <Alert tone="ok" title={`GET /${probeResource} responded ${edge.data?.status}.`} />
          )}
        </Section>
      </div>
    </div>
  )
}
