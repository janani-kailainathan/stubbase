import { NewProjectForm } from '@/components/shell/NewProject'

/**
 * The first thing a new account sees: start blank, or from an API that already
 * works. The form is the New project dialog's, so a project is created the same
 * way here as from the project menu.
 */
export function NoProjects() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-auto p-6">
      <div className="text-center">
        <p className="text-sm font-medium text-emphasis">No projects yet</p>
        <p className="mt-1.5 font-mono text-xs text-subtle">
          Start blank, or from an API that already works.
        </p>
      </div>

      <NewProjectForm />
    </div>
  )
}
