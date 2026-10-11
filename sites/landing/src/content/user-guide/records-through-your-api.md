---
title: 'Create, Read, Update and Delete Records Through Your Stubbase API — User Guide'
description: 'The five CRUD endpoints every Stubbase resource gets: list, read one, create, replace and delete. How ids and timestamps are set, what PUT replaces, and where the OpenAPI spec lives.'
h1: 'Create, read, update and delete records'
subheadline: 'Every resource gets the same five endpoints. Here is what each one takes, what it returns, and what the server fills in for you.'
label: 'Records through your API'
chapter: 'data'
order: 1
publishedAt: 2026-10-11
hero:
  src: /user-guide/records-through-your-api/hero.png
  alt: 'The Live tab sending POST /comments with a JSON body, and the 201 response with the server-set id, createdAt and updatedAt'
  caption: 'A create answers 201 with the record as stored: the id and both timestamps are filled in for you.'
---

## The five endpoints

For a resource called `posts`:

```bash
GET    /<project-id>/posts          # list records
GET    /<project-id>/posts/<id>     # read one
POST   /<project-id>/posts          # create one
PUT    /<project-id>/posts/<id>     # replace one
DELETE /<project-id>/posts/<id>     # delete one
```

Every path starts with `https://api.stubbase.dev`. Send bodies as JSON with
`Content-Type: application/json`.

## Create a record

```bash
curl -X POST https://api.stubbase.dev/<project-id>/posts \
  -H 'Content-Type: application/json' \
  -d '{ "title": "Hello, world", "published": true }'
```

The response is the record as it was stored. Leave `id` out and the server
gives the record one. The server also sets `createdAt` and `updatedAt`, and
anything you send for those two is replaced.

## Read records

`GET /<project-id>/posts` returns every record as an array. To narrow it down,
sort it or take one page at a time, see the Querying chapter.

`GET /<project-id>/posts/<id>` returns one record, or `404` if there is no
record with that id.

## Replace a record

`PUT` replaces the whole record with the body you send. It is not a patch:
fields you leave out are gone afterwards. The record keeps its `id` and its
`createdAt`, and `updatedAt` is set to now.

To change one field, read the record, change the field, and send the whole
record back.

## Delete a record

`DELETE /<project-id>/posts/<id>` removes it. There is no undo through the API,
so make sure your app means it.

## Writes are live at once

A write through the API is saved before the response is sent, and the very next
request sees it. Nothing needs deploying. The dashboard's editor shows the same
data, so a record your app creates is there the next time you open the table.

## The OpenAPI spec

Every project publishes a description of its own API:

```bash
GET /<project-id>/openapi.json
```

It is an OpenAPI 3.0 document listing each resource's routes and query
parameters. Point a client generator, Postman or an AI agent at it to get your
routes without writing them down.
