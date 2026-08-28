import { Lock } from 'lucide-react'
import { usePlanName } from '@/hooks/plan'
import { LANDING_URL, type PlanFeature } from '@/lib/api'

/**
 * The one-line explanation shown beside a control that is present but disabled.
 *
 * Controls stay on screen off-plan — a control that disappears teaches nobody
 * it exists — so each one needs to say why it will not respond, and where to
 * go. Without this the disabled state reads as a bug.
 *
 * The plan names here are marketing copy, not an entitlement decision: nothing
 * is unlocked by what this file says. The authority is PLANS in
 * apps/dashboard-api/server-app.ts, which is also what refuses the request.
 * Keep the labels in step with it and with the pricing page.
 */
const SELLS: Record<PlanFeature, string> = {
  chaos: 'Pro QA',
  auth: 'Pro QA',
  webhooks: 'Pro + AI',
  ai: 'Pro + AI',
}

export function PlanNotice({ feature, label }: { feature: PlanFeature; label: string }) {
  const current = usePlanName()

  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-panel px-2.5 py-1.5">
      <Lock className="h-3 w-3 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 font-mono text-[10px] text-subtle">
        {label} is part of {SELLS[feature]}. You are on {current}.
      </span>
      <a
        href={`${LANDING_URL}/pricing`}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-mono text-[10px] text-primary-accent hover:text-primary-ink"
      >
        See plans
      </a>
    </div>
  )
}
