---
title: 'Persistent Relational Mock APIs for Frontend Developers — Stubbase'
description: 'Bypass backend dependencies. Turn a single JSON file into a fully relational REST API with instant pagination, filtering, and nested routing.'
h1: 'Mock APIs that behave like the real thing'
subheadline: 'Turn a single JSON file into a fully relational REST API with pagination, filtering and nested routing — and keep every write you make.'
promise: 'No database to configure, no mock server to babysit, no fixtures to reset between runs.'
order: 10
cta:
  label: 'Generate an API free'
  href: ''
proof:
  caption: 'Every post, with its author already attached'
  method: 'GET'
  path: '/<tenant>/posts?_expand=user&_limit=1'
  response: |
    [
      {
        "id": 100,
        "title": "React State",
        "userId": 1,
        "user": { "id": 1, "name": "Alice" }
      }
    ]
spec:
  - label: 'Relations'
    value: 'Name a key `<name>Id` and the engine infers the relationship. `?_expand=user` nests the referenced record instead of making you fetch it twice.'
  - label: 'Query'
    value: 'Exact-match filtering on any field, `_sort`/`_order` across multiple keys, and `_page`/`_limit` or `_offset`/`_limit` pagination. The unpaginated total comes back in `X-Total-Count`.'
  - label: 'Persistence'
    value: 'A POST is still there tomorrow. Mutations write through to disk immediately, so the data your UI created survives a refresh, a redeploy and a colleague.'
  - label: 'Contract'
    value: 'Every project serves a generated `openapi.json`, so client generators, Postman and API clients can read the shape without you writing a spec.'
  - label: 'Staging'
    value: 'Dashboard edits land as drafts. The live API keeps serving the old data until you press Deploy, so a half-finished schema never reaches the app you are building.'
related:
  - '/roles/frontend-developer'
  - '/roles/qa-engineer'
sections:
  - kind: statement
    body: |
      The moment a mock resets, so does whatever state your UI had built up — and the code
      you wrote against it gets thrown away with it.

  - kind: split
    title: 'Two files in, a connected API out'
    body: |
      Stubbase converts flat JSON structures into connected APIs automatically. Append `Id`
      to a key and the engine infers the relationship, then mounts `?_expand=` routing on
      top of it.

      No schema language, no migration step, no join to configure. The shape of your file
      is the shape of your API.
    code:
      lang: json
      caption: 'schema.json'
      content: |
        {
          "users": [{ "id": 1, "name": "Alice" }],
          "posts": [{ "id": 100, "title": "React State", "userId": 1 }]
        }

  - kind: split
    title: 'The three requests a real list screen makes'
    body: |
      A table with a sort header, a filter chip and a pager needs three things a static
      fixture cannot give you. They compose into one request, in a fixed order — filter,
      then sort, then paginate, then expand.

      The body carries the page. `X-Total-Count` carries the unpaginated total, which is
      the number your pager actually needs and the one a fixture never has.
    code:
      lang: bash
      caption: 'one request, four operations'
      content: |
        GET /<tenant>/posts
          ?status=published
          &_sort=createdAt&_order=desc
          &_page=2&_limit=20

        200 OK
        X-Total-Count: 128

  - kind: split
    title: 'Writes that stick'
    body: |
      Every mutation updates the in-memory copy **and** persists to disk before the response
      returns. That has a consequence worth stating plainly: the record your form just
      created is still there after a hard refresh, on another machine, in another browser,
      and in your teammate's session.

      Nothing resets between test runs unless you ask it to.
    code:
      lang: bash
      caption: 'create a record'
      content: |
        curl -X POST https://api.stubbase.dev/<tenant>/posts \
          -H 'content-type: application/json' \
          -d '{"title":"Written from the UI","userId":1}'

  - kind: steps
    title: 'From file to endpoint'
    steps:
      - title: 'Drop in JSON'
        body: 'Paste a file, upload one, or describe the schema in plain English and let the AI Co-Pilot draft it.'
      - title: 'Review the draft'
        body: 'Dashboard edits stage as drafts. The live API keeps serving the old data until you are ready.'
      - title: 'Deploy'
        body: 'One click promotes the draft. The next request serves the new shape, with the endpoint URL unchanged.'
---
