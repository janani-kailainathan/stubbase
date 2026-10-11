---
title: 'Add, Change and Delete Records with the Stubbase AI Co-Pilot — User Guide'
description: 'Ask the Stubbase Co-Pilot to create, update or delete records in plain words. It picks records by filter without reading them, asks before changing more than 20, and every change has an Undo.'
h1: 'Change records with the Co-Pilot'
subheadline: 'Ask for a change to your data and the Co-Pilot makes it, without ever reading your records, and with an Undo on every change.'
label: 'Change records'
chapter: 'copilot'
order: 2
publishedAt: 2026-10-11
hero:
  src: /user-guide/change-records-with-the-co-pilot/hero.png
  alt: 'AI chat after asking to publish every unpublished post: the reply, and cards for reading the data model, counting 2 matching posts and updating 2 records, with Undo'
  caption: 'The change card carries Undo; the count shows it picked records without reading them.'
---

## Ask, and it happens

"Add a book called Dune by Frank Herbert." "Mark every pending order shipped."
"Delete the test users from last week." Your message is the go-ahead, so the
change is made when you ask, and a card in the chat says what changed.

A change to a live table is live at once, exactly like a save in the editor.

## It picks records without reading them

The Co-Pilot never reads your records. It chooses which ones to change with a
filter, written in the same language your API uses:

```
status=pending
price[gt]=20
createdAt[lt]=2026-01-01
```

All it gets back is how many records matched and changed, and the ids of new
ones. Nothing in your data is sent to the AI model.

## Big changes wait for you

A change to **more than 20 records** isn't made straight away. The Co-Pilot
counts the matches, tells you how many there are, and asks. Confirm in your
next message and it goes ahead.

It can't confirm on your behalf: the confirmation has to come in a later
message from you, asking for exactly the same change.

## Undo any change

Every change card has **Undo**, which puts back what that change did:

- It works for 24 hours, once.
- It leaves alone any record written since. If your app updated one of those
  records afterwards, that record keeps the newer write, and the card tells you
  how many were skipped.

## Limits

- At most **1,000 records** per change.
- An update or delete needs a filter, or an explicit "all records". It never
  touches a whole table by accident.
- `id`, `createdAt` and `updatedAt` are set the same way your API sets them,
  and the Co-Pilot can't change them.
- These changes are yours, as the owner. They don't count toward your requests,
  don't appear in the Logs tab, aren't checked against roles, and don't call
  webhooks.

## Removing or emptying a whole table

That is different. The Co-Pilot only **proposes** removing or emptying a table,
as a card with a button, and nothing happens until you click it.
