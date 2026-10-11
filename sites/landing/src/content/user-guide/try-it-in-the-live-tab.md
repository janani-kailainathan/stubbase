---
title: 'Test Your Stubbase API in the Live Tab Playground — User Guide'
description: 'Send real requests to your deployed Stubbase API from the dashboard: pick an endpoint, set the id, query params, headers and body, and read the response. What counts toward your requests and why some routes are greyed out.'
h1: 'Try your API in the Live tab'
subheadline: 'Every endpoint in the APIs rail has a Live tab: a request builder that calls your deployed API exactly as your app would, with no code needed.'
label: 'Try it in the Live tab'
chapter: 'getting-started'
order: 5
publishedAt: 2026-10-11
hero:
  alt: 'The Live tab for GET /posts/{id}: Path Variables open with an id filled in, and a 200 response with the record below'
  caption: 'Pick a route on the right, fill in what it needs, Send.'
---

## Open the Live tab

**1. Pick an endpoint in the APIs rail**, on the right of the Editor. Each
resource lists its routes there: list, read one, create, replace and delete.

**2. Choose Live** at the top of the pane. **Docs** next to it describes the
same route: what it takes and what it returns.

The method and URL are fixed to the route you picked. You fill in the parts a
caller would fill in, and nothing else.

## Fill in the request

The request tabs depend on the route, so you only see the ones it uses:

| Tab | When it appears | What you set |
|---|---|---|
| **Path Variables** | Routes with `{id}` | The record's id. Send stays disabled until it is filled in. |
| **Query Params** | Lists and reads | Filters, `_sort`, `_page`, `_expand` and the rest. Names are suggested as you type. |
| **Authorization** | Once sign-up is deployed on the project | A bearer token. Sign in through the auth routes here and it is filled in for you. |
| **Headers** | Routes with a body, or with sign-up or QA mode deployed | `Content-Type`, and the four `x-stubbase-*` QA headers when QA mode is on. |
| **Body** | Create and replace | The JSON record to send. |

Then click **Send**.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: The Query Params tab with _sort=created and status=todo, and the list response beneath it."><span class="shot-file">/user-guide/try-it-in-the-live-tab/01-query-params.png</span></div>
  <figcaption>Query params go on reads only; the response shows the status, its headers and the body.</figcaption>
</figure>

## Read the response

Below the request you get the status code, the response **Body**, and its
**Headers**. Drag the bar between request and response to give either more room.

To see the request from the server's side, open the **Logs** tab in the top
bar. It shows each request to the project as it happens.

## These are real requests

The Live tab calls your public API exactly as any other client would, so:

- **A request changes real data.** A `DELETE` deletes the record, and nothing
  asks you to confirm first, just as nothing would ask your app.
- **It counts toward your monthly requests**, and shows up in the Usage panel
  as soon as it returns.
- **Your project's rules apply**: sign-in, roles, validation, rate limits and
  read-only all answer here exactly as they will for your users.

## Why Send is greyed out

The Live tab tests the **deployed** API. A table you have saved but not
deployed is listed in the APIs rail, but your live API has no route for it yet,
so the tab says so and keeps Send disabled. Click **Deploy** (or **Redeploy**),
and the route works.

A stopped project answers every request with `503`, so deploy it before testing.
