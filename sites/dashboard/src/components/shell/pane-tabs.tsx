/**
 * The pane header's tab control, shared so every pane's sub-tabs are literally
 * the same widget: the editor's Request/Response/Live and the log viewer's
 * Raw/Pretty/Lifecycle. Lives in its own module because EditorPane imports
 * LiveLogViewer, so the two panes cannot import from each other.
 */
export function PaneTab({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'cursor-pointer rounded-md border border-primary-soft-border bg-primary-soft px-2.5 py-1 font-mono text-xs text-primary-ink'
          : 'cursor-pointer rounded-md border border-transparent px-2.5 py-1 font-mono text-xs text-subtle hover:text-emphasis'
      }
    >
      {label}
    </button>
  )
}

/** Groups a row of PaneTabs in the pane header. */
export function PaneTabs({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1">{children}</div>
}
