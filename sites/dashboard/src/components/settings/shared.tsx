import type { FormEvent, ReactNode } from 'react'

// The settings page's vocabulary, shared by its cards so they read as one page:
// sans throughout, a card per concern with its actions in a footer strip.
export const labelClass = 'text-sm text-muted-foreground'
export const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-heading placeholder:text-faint focus:border-primary focus:outline-none read-only:text-body'
export const copyClass = 'text-sm leading-relaxed text-subtle'

const buttonBase =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
export const primaryClass = `${buttonBase} bg-primary text-primary-foreground enabled:hover:bg-primary-hover`
export const secondaryClass = `${buttonBase} border border-border bg-background text-heading enabled:hover:border-border-stronger`
/** Fills red, for the one action that cannot be taken back. */
export const dangerClass = `${buttonBase} bg-danger-fill text-primary-foreground enabled:hover:bg-danger-fill-hover`
/** Small and outlined, red only on hover: a step towards a deletion. */
export const smallDangerClass =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors enabled:cursor-pointer enabled:hover:border-danger-fill/40 enabled:hover:text-danger-emphasis disabled:opacity-60'
export const linkClass =
  'cursor-pointer text-sm text-primary-accent transition-colors hover:text-primary-ink disabled:opacity-60'
export const quietClass =
  'cursor-pointer text-sm text-muted-foreground transition-colors hover:text-heading disabled:opacity-60'

/**
 * One concern of the page: a title, what it is for, its content, and — when it
 * has any — its actions in a strip along the bottom. With `onSubmit` the whole
 * card is the form, so a footer button can submit what the body holds.
 */
export function Card({
  id,
  title,
  description,
  tone,
  footer,
  onSubmit,
  children,
}: {
  id?: string
  title: string
  description?: ReactNode
  tone?: 'danger'
  footer?: ReactNode
  onSubmit?: (e: FormEvent) => void
  children?: ReactNode
}) {
  const border = tone === 'danger' ? 'border-danger-soft-border' : 'border-border'
  const inner = (
    <>
      <div className="px-6 pt-5 pb-6">
        <h2 className={`text-base font-semibold ${tone === 'danger' ? 'text-danger-ink' : 'text-heading'}`}>
          {title}
        </h2>
        {description && <p className={`mt-1.5 ${copyClass}`}>{description}</p>}
        {children && <div className="mt-5">{children}</div>}
      </div>
      {footer && (
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3 ${border}`}>{footer}</div>
      )}
    </>
  )
  // Outlined, never filled: the card is its border on the page ground.
  // `relative` keeps the visually hidden inputs inside (the password manager's
  // username field, the theme radios): absolutely positioned with no positioned
  // ancestor, they escape the page's scroll area and give the document a second
  // scrollbar.
  const className = `relative w-full scroll-mt-6 rounded-xl border ${border}`
  return onSubmit ? (
    <form id={id} className={className} onSubmit={onSubmit}>
      {inner}
    </form>
  ) : (
    <section id={id} className={className}>
      {inner}
    </section>
  )
}

/** A labelled field, kept to a readable width however wide the card is. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex max-w-md flex-col gap-2">
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
    </div>
  )
}

/** A list row: something to recognise it by, a name and a detail line, then its action. */
export function Row({
  leading,
  title,
  detail,
  action,
}: {
  leading: ReactNode
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      {leading}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-heading">{title}</p>
        {detail && <p className="truncate text-xs text-subtle">{detail}</p>}
      </div>
      {action}
    </div>
  )
}

/** Lets a password manager tie a password field to this account. */
export function UsernameField({ email }: { email: string }) {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={email}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
    />
  )
}
