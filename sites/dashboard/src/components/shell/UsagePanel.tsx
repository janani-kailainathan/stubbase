import { Activity } from 'lucide-react'
import { useUsage } from '@/hooks/usage'
import type { UsageDay } from '@/lib/api'

const DAYS = 14

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return String(n)
}

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`
  return `${n} B`
}

/** Last DAYS calendar days, oldest first, with gaps filled as zero. */
function toSeries(daily: UsageDay[]): { date: string; requests: number; bytes: number }[] {
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const out: { date: string; requests: number; bytes: number }[] = []
  const today = new Date()
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i))
    const key = d.toISOString().slice(0, 10)
    const row = byDate.get(key)
    out.push({ date: key, requests: row?.request_count ?? 0, bytes: row?.bandwidth_bytes ?? 0 })
  }
  return out
}

const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 rounded-md border border-border bg-code-bg px-3 py-2">
      <div className="font-mono text-sm text-heading">{value}</div>
      <div className="mt-0.5 text-[10px] tracking-wide text-faint uppercase">{label}</div>
    </div>
  )
}

/**
 * Requests per day. One series, so one hue and no legend — the heading names
 * it. Values live in the hover tooltip rather than on every bar; only the
 * range ends are labeled.
 */
function RequestsChart({ series }: { series: { date: string; requests: number }[] }) {
  const peak = Math.max(...series.map((d) => d.requests), 1)

  return (
    <div>
      <div className="flex h-14 items-end gap-[2px] border-b border-border">
        {series.map((d) => (
          <div
            key={d.date}
            title={`${d.date} — ${d.requests.toLocaleString()} request${d.requests === 1 ? '' : 's'}`}
            className="group flex h-full flex-1 items-end"
          >
            <div
              className={
                d.requests > 0
                  ? 'w-full rounded-t-[3px] bg-primary transition-colors group-hover:bg-primary-ink'
                  : 'w-full rounded-t-[3px] bg-muted/60'
              }
              style={{ height: d.requests > 0 ? `${Math.max(8, (d.requests / peak) * 100)}%` : '2px' }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
        <span>{shortDay(series[0].date)}</span>
        <span>peak {formatCount(peak)}/day</span>
        <span>{shortDay(series[series.length - 1].date)}</span>
      </div>
    </div>
  )
}

/**
 * How much of the monthly allowance is gone.
 *
 * The bar exists because the quota is now enforced: at 100% the core answers
 * 429 on the whole public plane, and someone whose API just stopped needs to
 * find the reason here rather than in a status code. Colour turns at 80% and
 * again at the cap, so the warning arrives before the outage does.
 */
function QuotaBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const spent = limit > 0 && used >= limit
  const near = !spent && pct >= 80
  const fill = spent ? 'bg-danger-fill' : near ? 'bg-warning-fill' : 'bg-primary'
  const ink = spent ? 'text-danger-ink' : near ? 'text-warning-ink' : 'text-faint'

  return (
    <div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(pct, 1)}%` }} />
      </div>
      {/* Both labels stay short so the row never wraps in the sidebar; the
          consequence gets its own line, and only when there is one. */}
      <div className={`mt-1 flex justify-between gap-2 font-mono text-[10px] ${ink}`}>
        <span className="truncate">
          {formatCount(used)} of {formatCount(limit)}
        </span>
        <span className="shrink-0">{spent ? 'over' : `${Math.round(pct)}%`}</span>
      </div>
      {spent && (
        <p className="mt-0.5 font-mono text-[10px] text-danger-ink">
          Quota spent — the API is answering 429.
        </p>
      )}
    </div>
  )
}

export function UsagePanel({ tenantId }: { tenantId: string | undefined }) {
  const { data, isLoading, error } = useUsage(tenantId)
  const series = toSeries(data?.daily ?? [])
  const hasTraffic = series.some((d) => d.requests > 0)

  return (
    <div className="shrink-0 border-t border-border px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-primary-accent" />
        <span className="flex-1 text-xs font-semibold tracking-wide text-subtle uppercase">
          Usage
        </span>
        <span className="font-mono text-[10px] text-faint">this month</span>
      </div>

      {isLoading && <p className="font-mono text-xs text-faint">Loading…</p>}
      {error && <p className="font-mono text-xs text-danger-ink">Unavailable</p>}

      {data && (
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <StatTile label="Requests" value={formatCount(data.month.requests)} />
            <StatTile label="Bandwidth" value={formatBytes(data.month.bytes)} />
          </div>
          {data.limit > 0 && <QuotaBar used={data.month.requests} limit={data.limit} />}
          {hasTraffic ? (
            <RequestsChart series={series} />
          ) : (
            <p className="font-mono text-[10px] text-faint">
              No traffic yet — call your API to see it here.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
