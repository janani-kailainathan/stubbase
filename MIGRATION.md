# stubbase — source snapshot

The full working tree (146 tracked files), with no .git directory, plus `.env`.
Run `git init` here on the new machine.

Not included: .git/ (history), node_modules/ (bun install), sites/*/dist/
(bun run scripts/build.ts), app.sqlite (dev accounts — sign up again),
.claude/, .idea/, and the 8 untracked dev tenant folders under tenants/.
`tenants/demo/todos.json` IS included — it is a tracked part of the repo.

## Setup

    cd stubbase
    git init && git add -A && git commit -m "Import stubbase"

    (cd sites/dashboard && bun install)
    (cd sites/landing   && bun install)

    bun run scripts/build.ts     # expect BUILD SUCCESS, 4 modules
    bun run scripts/dev.ts       # dashboard :5173, landing :4321, core :3000, app :3001
                                 # seeds the `public` demo tenant on first run

`.env` holds GOOGLE_AI_API_KEY, AI_MODEL_NAME and AI_TIMEOUT_MS — needed by the
AI Co-Pilot only; the rest of the stack runs without it.
