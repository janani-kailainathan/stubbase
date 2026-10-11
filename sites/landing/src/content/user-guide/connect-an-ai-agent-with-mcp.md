---
title: 'Connect Claude Desktop and AI Agents to a Stubbase Project with MCP — User Guide'
description: 'Generate a developer API key in a Stubbase project''s MCP tab and connect Claude Desktop or another MCP client. The agent queries the project''s tables with read-only SQL: joins, counts and aggregates.'
h1: 'Connect an AI agent with MCP'
subheadline: 'Give Claude Desktop, or any MCP client, read-only SQL over your project''s tables with one key and one config snippet.'
label: 'Connect an agent with MCP'
chapter: 'account'
order: 3
publishedAt: 2026-10-11
hero:
  src: /user-guide/connect-an-ai-agent-with-mcp/hero.png
  alt: 'The MCP tab: a key name field with Generate, the active keys list, and the Claude Desktop config snippet'
  caption: 'Generate a key, copy the snippet, restart Claude Desktop.'
---

## What the agent gets

One tool that runs SQL against your project's tables. Each table is mounted as
a read-only database table, so an agent can join, count and aggregate in one
query instead of paging through your REST API:

```sql
SELECT a.name, COUNT(*) AS posts
FROM posts p JOIN authors a ON a.id = p.authorId
GROUP BY a.name ORDER BY posts DESC;
```

The agent is told every table and column when it connects, so it doesn't have
to guess them.

- **Read-only.** Only `SELECT` and `WITH` queries are allowed. Every write goes
  through your API, with its validation, roles and webhooks.
- **Only your tables.** Your users' accounts, sign-ups, settings and keys are
  never mounted, so no query can reach them.
- **Columns are every field any record has.** Fields only some records carry
  are still there. Nested objects and lists are JSON text; read them with
  `json_extract()`.

## Generate a key

**1. Click MCP** in the top bar.

**2. Name the key**, for example `Claude Desktop`, and click **Generate**.

**3. Copy the key now.** It is stored hashed and can't be shown again. If you
lose it, generate another.

Each key opens this project only. Generate one per agent or machine, so you can
revoke one without breaking the others.

## Connect Claude Desktop

Under **Connect to Claude Desktop**, the MCP tab shows a config snippet with
your new key filled in. Paste it into `claude_desktop_config.json` and restart
Claude Desktop. The agent can then query the project's data.

The snippet uses the `mcp-remote` bridge, because Claude Desktop talks to local
programs and your project is on the web. Other MCP clients can use the address
under **MCP endpoint**, sending the key as:

```
Authorization: Bearer <key>
```

## Revoke a key

Under **Active keys**, click **Revoke** beside it. It stops working at once.
Deleting the project revokes all of its keys.
