---
title: 'Sort and Paginate a Stubbase List: _sort, _direction, _page, _limit — User Guide'
description: 'Sort Stubbase list endpoints with _sort and _direction, newest first by created or updated, and paginate with _page and _limit or _offset. X-Total-Count gives the total for your page controls.'
h1: 'Sort and page through a list'
subheadline: 'Choose the order with _sort, the way with _direction, and how much comes back with _page and _limit.'
label: 'Sort and page'
chapter: 'querying'
order: 2
publishedAt: 2026-10-11
---

## Sort

```bash
GET /<project-id>/posts?_sort=created                       # newest first
GET /<project-id>/posts?_sort=updated&_direction=asc        # least recently changed first
GET /<project-id>/products?_sort=price                      # cheapest first
```

`_sort` takes any field name. Two names are special: `created` and `updated`
sort by the `createdAt` and `updatedAt` timestamps the server sets.

`_direction` is `asc` or `desc`. Left out, `created` and `updated` sort newest
first, and every other field sorts ascending.

## Sort by more than one field

Separate the fields with commas, and give one direction per field, or one for
all of them:

```bash
GET /<project-id>/products?_sort=category,price&_direction=asc,desc
```

That groups products by category, most expensive first within each. Records
missing a field you sort by always come last, whichever way you sort.

## Page through a list

```bash
GET /<project-id>/posts?_page=1&_limit=20     # records 1–20
GET /<project-id>/posts?_page=2&_limit=20     # records 21–40
```

`_page` starts at 1. With `_page` and no `_limit`, a page is 10 records. With
neither, you get every record.

If you would rather count records than pages, use `_offset` instead of `_page`:

```bash
GET /<project-id>/posts?_offset=40&_limit=20  # skip 40, take 20
```

## Build page controls with X-Total-Count

Every list response carries an `X-Total-Count` header: how many records matched
your filters, before paging. Divide it by your page size for the number of
pages.

```js
const res = await fetch(`${base}/posts?_page=1&_limit=20`);
const total = Number(res.headers.get('X-Total-Count'));
const pages = Math.ceil(total / 20);
```

The header can be read from a browser on another origin, so this works from
your front end as written.

## In order

Filters run first, then sorting, then paging, then `_expand`, so a page is
always a page of the filtered, sorted list.
