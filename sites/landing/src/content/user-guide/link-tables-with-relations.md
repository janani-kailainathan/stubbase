---
title: 'Link Tables with Relations in Stubbase — User Guide'
description: 'Relate records across Stubbase tables by naming a field after the table it points at: authorId links to authors.json. No foreign keys or configuration, and _expand nests the linked record.'
h1: 'Link tables with relations'
subheadline: 'Name a field after the table it points at, and Stubbase treats it as a link. There is nothing to configure.'
label: 'Link tables with relations'
chapter: 'data'
order: 2
publishedAt: 2026-10-11
---

## The field name is the whole setup

The link field is the table's name made singular, plus `Id`. Singular here means
the table name with its final `s` dropped, or `ies` turned into `y`:

| Table | Link field | Nested under |
|---|---|---|
| `users.json` | `userId` | `user` |
| `authors.json` | `authorId` | `author` |
| `categories.json` | `categoryId` | `category` |

That rule is all Stubbase uses, so name tables you want to link to as regular
plurals. A table called `people` would need a field called `peopleId`, which
reads oddly: call it `persons`, or `members`, and the link field is
`personId` or `memberId`.

So a post that belongs to an author looks like this:

```json
{ "id": "1", "title": "Hello, world", "authorId": "7" }
```

and author `7` is a record in `authors.json`. There are no foreign keys, join
tables or settings. If the field and the table are named this way, the link
works.

## One table, many links

A record can link to as many tables as you like. An order might carry both:

```json
{ "id": "1", "customerId": "3", "productId": "12", "quantity": 2 }
```

The **Blog** and **Storefront** starters are built this way, if you want a
working example to look at.

## What happens to broken links

Links are not checked when a record is written. Deleting author `7` leaves the
post's `authorId` as it was. When you ask for the linked record, a link that
points at nothing comes back as `null`, never as an error.

## Fetch the linked records

Links pay off with `_expand`, which nests each linked record inside the one
that points at it, in a single request. See the next page in Querying.

```bash
GET /<project-id>/posts?_expand=authors
```
