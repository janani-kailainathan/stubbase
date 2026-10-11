---
title: 'Add Tables and Edit Records in the Stubbase Editor — User Guide'
description: 'Create a resource, edit its records as JSON, and save. Learn which saves go live at once and which wait for Deploy, and how Undo and the stale-save check protect your data.'
h1: 'Add tables and edit records'
subheadline: 'Each table is a JSON file in the Files rail. Edit its records, save, and they are live straight away. A new table goes live on your next deploy.'
label: 'Add tables and edit records'
chapter: 'getting-started'
order: 3
publishedAt: 2026-10-11
hero:
  src: /user-guide/tables-and-records/hero.png
  alt: 'The Editor with posts.json open for editing, the Save button showing its keyboard shortcut'
  caption: 'Edit, change the JSON, Save. A live table changes on your API as soon as you save.'
---

## Add a table

**1. Click the + at the top of the Files rail.** Its tooltip reads **New
resource**.

**2. Type a name.** Use letters, digits, `-` and `_`, up to 64 characters. The
name becomes the path: a resource called `posts` is served at
`/<project-id>/posts`.

**3. Press Enter.** The new `posts.json` opens, empty, ready for records.

A few names are taken by Stubbase itself and can't be used, including `auth`,
`config` and `rbac`.

## Edit the records

**1. Select the table** in the Files rail, then click **Edit** above the
records.

**2. Change the JSON.** A table is always a JSON array of records:

```json
[
  { "id": "1", "title": "Hello, world", "published": true },
  { "id": "2", "title": "Second post", "published": false }
]
```

Records don't need the same fields. Any record without an `id` gets one when
it is created through your API.

**3. Click Save**, or press ⌘S on a Mac, Ctrl+S elsewhere. **Cancel** throws
the edit away.

<figure class="shot">
  <img src="/user-guide/tables-and-records/01-saved-live-now.png" alt="The toast after saving a live table, reading 'Saved posts.json (8 records) — live now.' with an Undo button." width="302" height="64" loading="lazy" decoding="async" />
  <figcaption>The toast tells you whether the save is live now or waits for Deploy.</figcaption>
</figure>

## Live now, or live on Deploy

What happens when you save depends on whether the table is already deployed:

| You saved… | What happens |
|---|---|
| Records in a table that is already live | Live at once. The toast says **live now**, and the next request to your API sees the change. |
| A table that has never been deployed | Kept until you deploy. The toast says **live when you Deploy**. |

The difference is deliberate. Records are data, and your API already writes
them all day, so a save simply joins in. A new table changes what your API
looks like, so it waits for a deliberate Deploy.

## Undo a save

For a few seconds after a save, the toast offers **Undo**. It puts the table
back exactly as it was before your edit.

Undo will not overwrite records your API wrote after your save. If someone
created a record in the meantime, Undo says it can't go ahead, and nothing is
lost.

## When the table changed while you were editing

Your API can write to a table while you have it open: a sign-up, a `POST` from
your app, a test run. If that happens before you save, the save is **refused**
rather than silently erasing those records, and the toast reads:

> posts.json changed since you opened it, so your edit was not saved.

Click **Reload** to open the latest records, then make your edit again. Reload
throws away the edit you had, so copy anything you want to keep first.

## Timestamps are added for you

Records created or replaced through your API get `createdAt` and `updatedAt`,
set by the server. Records you type into the editor keep exactly what you wrote,
so a record you add here has no timestamps unless you give it some.
