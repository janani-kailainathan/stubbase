---
title: 'Make Your Stubbase API Read-Only with READ_ONLY — User Guide'
description: 'Publish data nobody can change: READ_ONLY=true makes every Stubbase table answer GET and refuse POST, PUT and DELETE with a 405, even for admins, while you keep editing in the dashboard.'
h1: 'Make your API read-only'
subheadline: 'Publish data nobody can change through the API. Reads work as before; every write is refused, whoever sends it.'
label: 'Read-only API'
chapter: 'settings'
order: 5
publishedAt: 2026-10-11
hero:
  src: /user-guide/read-only-api/hero.png
  alt: 'The APIs rail of a read-only project listing only GET routes for posts, authors and comments'
  caption: 'While READ_ONLY is deployed, the APIs rail lists only the read routes.'
---

## Switch it on

```bash
READ_ONLY=true
```

Save and deploy. Your tables still answer every `GET`, with filters, sorting,
paging and `_expand` all working, but a `POST`, `PUT` or `DELETE` is refused:

```http
DELETE /<project-id>/posts/1

405 Method Not Allowed
Allow: GET, HEAD
{ "error": "this API is read-only" }
```

## No token gets around it

Not even an account with the `admin` role can write through the API. The
refusal comes before sign-in is checked, because no token could make the write
allowed.

## You can still edit

- **The dashboard editor** saves records as usual.
- **The AI Co-Pilot** can still add, change and delete records for you.
- **Sign-up and login** follow your auth settings, unaffected.
- **`openapi.json`** lists only the read routes, so tools that read it never
  offer a write. The dashboard's APIs rail does the same, so the Live tab
  offers only reads while the setting is deployed.

## When to use it

Reference data, a public dataset, a demo whose records visitors shouldn't be
able to delete, or a frozen copy of a project. The free API on the Stubbase
site is a read-only project.

A refused write is an ordinary answer: it appears in the Logs tab and counts
toward your requests like any other. Remove the line, or set it to `false`, and
writes are accepted again on the next deploy.
