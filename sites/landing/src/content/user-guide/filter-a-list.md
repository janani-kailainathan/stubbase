---
title: 'Filter a List in Your Stubbase API: Exact Match, contains, gt, lt — User Guide'
description: 'Filter Stubbase list endpoints by any field: field=value for an exact match, and field[contains], [gt], [gte], [lt], [lte] for text search and ranges over numbers and ISO dates. Unknown operators return a 400.'
h1: 'Filter a list'
subheadline: 'Add a field to the query string to keep only the records that match. Plain values match exactly; an operator in brackets does the rest.'
label: 'Filter a list'
chapter: 'querying'
order: 1
publishedAt: 2026-10-11
---

## Exact match

`field=value` keeps the records whose field is exactly that value:

```bash
GET /<project-id>/products?category=phone
GET /<project-id>/orders?status=shipped&customerId=3
```

An exact match is case-sensitive: `phone` does not match `Phone`. Every
condition you add has to match, so the second request returns shipped orders
of customer 3.

## Operators

Put an operator in brackets after the field for anything looser:

| Operator | Keeps records whose field… | Example |
|---|---|---|
| `[contains]` | contains the text, ignoring case and accents | `?brand[contains]=sams` |
| `[gt]` | is greater than the value | `?price[gt]=100` |
| `[gte]` | is greater than or equal to it | `?price[gte]=100` |
| `[lt]` | is less than it | `?price[lt]=800` |
| `[lte]` | is less than or equal to it | `?stock[lte]=5` |

```bash
GET /<project-id>/products?price[gte]=100&price[lt]=800    # from 100, up to but not including 800
GET /<project-id>/posts?title[contains]=cafe               # matches "Café" too
```

On a field holding a list of text, `[contains]` matches when any item in the
list does, so `?tags[contains]=urgent` finds every record tagged `urgent`.

## Numbers, text and dates

The comparisons understand what they compare. Numbers are compared as numbers,
so `9` is less than `10`. Text is compared in natural order, which is what
makes ISO dates work as ranges:

```bash
GET /<project-id>/posts?createdAt[gte]=2026-01-01                       # created this year or later
GET /<project-id>/orders?placedAt[gte]=2026-03-01&placedAt[lt]=2026-04-01   # placed in March
```

`createdAt` and `updatedAt`, which the server sets on every record written
through your API, are ISO dates, so they range-filter this way out of the box.

## Mistakes are errors, not empty filters

An operator Stubbase doesn't have, or one with nothing after it, answers `400`
and names the problem:

```bash
GET /<project-id>/products?price[gtee]=100     # 400, not the whole table
```

That is deliberate. Quietly ignoring a misspelt condition would return every
record and look like it worked.

## Filters and the rest

Filters run first, then sorting, then paging, then `_expand`. The total in
`X-Total-Count` counts the records that matched the filters, before paging.
