---
title: 'Webhooks Before and After Writes in Stubbase — User Guide'
description: 'Call your own server when records change: HOOK_BEFORE_ webhooks can approve or refuse a write, HOOK_AFTER_ webhooks are told once it happened. Key format, the payload sent, and timeouts.'
h1: 'Run your own code on writes with webhooks'
subheadline: 'Point a create, update or delete on any table at a URL of yours. A before-hook can refuse the write; an after-hook is told it happened.'
label: 'Webhooks'
chapter: 'settings'
order: 3
publishedAt: 2026-10-11
hero:
  src: /user-guide/webhooks/hero.png
  alt: 'The .env''s webhooks section with two lines added: a before-insert hook on posts and an after-insert hook on comments'
  caption: 'One line per hook: phase, action and table in the key, your URL as the value.'
---

## Add a webhook

A webhook is one line in the `.env`:

```bash
HOOK_<BEFORE|AFTER>_<INSERT|UPDATE|DELETE>_<TABLE>=<url>
```

For example:

```bash
HOOK_BEFORE_INSERT_POSTS=https://your-app.com/hooks/check-post
HOOK_AFTER_UPDATE_ORDERS=https://your-app.com/hooks/order-changed
```

`INSERT` is a `POST`, `UPDATE` a `PUT`, `DELETE` a `DELETE`. The table name is in
capitals, with anything that isn't a letter or digit written as `_`. Save and
deploy, and the hook is live. Remove the line to remove it.

## What your server receives

Stubbase sends a `POST` with a JSON body:

```json
{
  "tenant": "<project-id>",
  "resource": "posts",
  "action": "INSERT",
  "id": null,
  "payload": { "title": "Hello, world" }
}
```

`id` is the record's id for updates and deletes, and `null` for a create.
`payload` is the body of the request, if it had one. An after-hook also gets
`result`: the record as it was stored.

## Before-hooks decide

A before-hook runs before the write and must answer `200` for it to go ahead.

| Your server answers | The caller gets |
|---|---|
| `200` | The write happens as normal |
| Any other status | `422`, and nothing is written |
| Nothing within 5 seconds, or can't be reached | `502`, and nothing is written |

Use it to check something Stubbase can't: a slug that must be unique, stock
that must be available, a word list.

## After-hooks are told

An after-hook runs once the write has succeeded, and your API answers without
waiting for it. If your server is slow or down, the write still stands and the
caller never knows. Use it to send an email, update a search index, or post to
a chat.

## Addresses that are refused

Hooks must point at a public address. A URL that resolves to a private or
internal network address is refused, and redirects are not followed.

## Order of events

Schema validation runs before the before-hook, so your server only sees bodies
that already passed. Sign-in, roles and rate limits run before that, so a
refused request never reaches your server at all.
