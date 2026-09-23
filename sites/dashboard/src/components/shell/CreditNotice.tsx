import { Lock } from 'lucide-react'
import { LANDING_URL } from '@/lib/api'

/**
 * The one-line explanation shown above the Co-Pilot composer when the account
 * has no AI credits left.
 *
 * The composer stays on screen, disabled — a control that disappears teaches
 * nobody it exists — so it needs to say why it will not respond, and where to
 * go. Without this the disabled state reads as a bug. Nothing here decides
 * anything: the server answers 402 on its own count, and this only mirrors it.
 */
export function OutOfCreditsNotice({ monthly }: { monthly: number }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-panel px-2.5 py-1.5">
      <Lock className="h-3 w-3 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 font-mono text-[10px] text-subtle">
        {monthly > 0
          ? "You have used this month's AI credits. They refill on the 1st, or add a credit pack."
          : 'You have no AI credits left. Add a credit pack, or move to Pro for credits every month.'}
      </span>
      <a
        href={`${LANDING_URL}/pricing#ai-credits`}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-mono text-[10px] text-primary-accent hover:text-primary-ink"
      >
        See packs
      </a>
    </div>
  )
}
