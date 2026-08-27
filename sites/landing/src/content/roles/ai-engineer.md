---
title: 'Stubbase for AI Engineers — Give an Agent a Real Datastore over MCP'
description: 'Connect Claude, ChatGPT or your IDE to a live project over the Model Context Protocol and query it with read-only SQL — real joins and aggregates, not paged REST calls.'
h1: 'Give your agent a datastore it can actually query'
subheadline: 'Connect over the Model Context Protocol and let the model run real SQL — joins, aggregates, CTEs — against live project data, without ever being able to write to it.'
promise: 'The JSON files stay the source of truth. SQL is a read-only projection, rebuilt on demand.'
order: 30
cta:
  label: 'Generate an API free'
  href: ''
proof:
  caption: 'One join and a group-by, instead of two hundred REST calls'
  method: 'POST'
  path: '/projects/<id>/mcp/message'
  headers:
    - 'Authorization: Bearer sk_stub_...'
  response: |
    [
      { "author": "Alice", "posts": 42, "avg_views": 1180 },
      { "author": "Marco", "posts": 17, "avg_views": 2306 },
      { "author": "Priya", "posts": 9,  "avg_views": 640 }
    ]
spec:
  - label: 'Protocol'
    value: 'Standard MCP over HTTP+SSE. Claude Desktop reaches it through the `mcp-remote` bridge, and the dashboard generates the config block with your key already filled in.'
  - label: 'SQL'
    value: 'One tool, `execute_sql_query`, over an in-memory SQLite projection of your resources. Real joins, aggregates and CTEs — not a paging loop over REST.'
  - label: 'Schema'
    value: '`tools/list` injects the live table and column list into the tool description, so the model reads your schema instead of guessing at it.'
  - label: 'Read-only'
    value: 'Two independent layers: the connection runs under `PRAGMA query_only`, and statements must begin with SELECT or WITH. The second is what stops `ATTACH` reaching anything else on the box.'
  - label: 'Credentials'
    value: 'Per-project developer keys, stored hashed and shown once. A key is scoped to the project that issued it; revoking it, or deleting the project, invalidates it immediately.'
sections:
  - kind: statement
    body: |
      Give a model a REST API and ask it an analytical question, and it does the only thing
      it can: it pages. Two hundred calls later it has spent its budget and still has to do
      the join itself — badly.

  - kind: split
    title: 'The question was one line of SQL'
    body: |
      So give the agent that line. One tool, `execute_sql_query`, over a real SQLite surface
      built from your resources.

      `tools/list` injects the live table and column list straight into the tool description,
      so the model reads your schema instead of guessing at it.
    code:
      lang: sql
      caption: 'what the agent runs instead'
      content: |
        SELECT u.name AS author,
               COUNT(*) AS posts,
               AVG(p.views) AS avg_views
        FROM posts p
        JOIN users u ON u.id = p.userId
        GROUP BY u.name
        ORDER BY posts DESC;

  - kind: split
    title: 'The projection is not the store'
    body: |
      Your resources stay what they always were: JSON arrays on disk, authoritative, written
      through on every mutation. The first time an agent runs a query, the engine derives a
      read-only in-memory database from those arrays — and drops it the moment the data
      changes, rebuilding on the next query in about a millisecond.
    bullets:
      - '**SQL always reads current data.** There is no sync step to fall behind.'
      - '**Writes never route through SQL.** Every mutation keeps going through the REST pipeline, with its validation, ownership and webhook rules intact.'
      - '**Columns union across every record**, so a field only some rows carry is still queryable. Nested values are JSON text — reach in with `json_extract()`.'

  - kind: split
    title: 'Read-only, in two layers'
    body: |
      Both layers are load-bearing, and neither is decorative.

      `PRAGMA query_only` stops writes, including the ones a text check would miss — a
      statement beginning `WITH x AS (…) DELETE FROM …` starts with the word `WITH`.
      Separately, statements must start with `SELECT` or `WITH`, and that is what stops
      `ATTACH`, which `query_only` does not block.

      `passwordHash` is not filtered out at read time; it is never mounted as a column at all.
      `SELECT *` is a response path like any other, and a column that was never created
      cannot leak.
    code:
      lang: sql
      caption: 'refused, both of them'
      content: |
        -- blocked by PRAGMA query_only
        WITH doomed AS (SELECT id FROM users)
        DELETE FROM users;

        -- blocked by the leading-keyword check
        ATTACH DATABASE '/var/lib/stubbase/app.sqlite' AS other;

  - kind: split
    title: 'Connecting Claude Desktop'
    body: |
      The core's MCP routes sit behind a server secret that never leaves the machine.
      External agents connect through the dashboard API with a per-project developer key
      instead.

      `--transport sse-only` matters: this server implements the HTTP+SSE transport, and
      without the flag the bridge probes for Streamable HTTP first.
    code:
      lang: json
      caption: 'generated for you in the dashboard'
      content: |
        {
          "mcpServers": {
            "stubbase_my_project": {
              "command": "npx",
              "args": [
                "-y", "mcp-remote",
                "https://api.app.stubbase.dev/projects/my-project/mcp/sse",
                "--transport", "sse-only",
                "--header", "Authorization: Bearer ${STUBBASE_API_KEY}"
              ],
              "env": { "STUBBASE_API_KEY": "sk_stub_…" }
            }
          }
        }

  - kind: statement
    body: |
      The session's project is pinned when the stream opens, from the URL. Nothing inside a
      message can select a different one — which is what keeps a multiplexed agent session
      from ever crossing between projects.
---
