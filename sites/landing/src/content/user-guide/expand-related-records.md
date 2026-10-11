---
title: 'Fetch Related Records in One Request with _expand — Stubbase User Guide'
description: 'Use _expand to nest linked records inside a Stubbase response: posts with their authors, orders with their customers and products. Works on lists and single records, after filters, sorting and paging.'
h1: 'Fetch related records with _expand'
subheadline: 'Ask for a linked table with _expand and each record comes back with the record it points at nested inside, in one request.'
label: 'Expand related records'
chapter: 'querying'
order: 3
publishedAt: 2026-10-11
---

## Expand one link

With posts that carry an `authorId`:

```bash
GET /<project-id>/posts?_expand=authors
```

```json
[
  {
    "id": "1",
    "title": "Hello, world",
    "authorId": "7",
    "author": { "id": "7", "name": "Ada" }
  }
]
```

The linked record is nested under the singular name, `author`, next to the
`authorId` that pointed at it. How links are named is on
[Link tables with relations](/user-guide/link-tables-with-relations).

Name the table in `_expand`. The singular form also works when the table's name
is that word plus `s`, so `_expand=author` finds `authors`.

## Expand several at once

```bash
GET /<project-id>/orders?_expand=customers,products
```

Each order comes back with its `customer` and its `product`.

## A single record too

```bash
GET /<project-id>/posts/1?_expand=authors
```

## With filters, sorting and paging

Expansion happens last, after the list has been filtered, sorted and paged:

```bash
GET /<project-id>/posts?published=true&_sort=created&_page=1&_limit=10&_expand=authors
```

## What comes back when a link is missing

- A record whose link points at nothing gets the key with `null`: you get the
  record, not an error.
- A record with no link field at all is returned unchanged.
- A name in `_expand` that matches no table is ignored.

## Expanding respects roles

With roles on, a linked record is nested only if the caller could read it
directly. Without read access to the linked table, nothing is nested. With
access to their own records only, someone else's comes back as `null`.
