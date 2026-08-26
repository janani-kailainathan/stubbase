---
title: 'Stubbase for Frontend Developers — Build the Real UI Today'
description: 'Stop waiting on the backend. Get a persistent, relational REST API with pagination, filtering and real error states, so the UI code you write now is the code you keep.'
h1: 'Build the real UI before the backend exists'
subheadline: 'A persistent, relational API with the pagination, filtering and failure states your components actually have to handle — in the time it takes to paste a JSON file.'
promise: 'Write the fetch layer once, against something that behaves like production.'
order: 10
cta:
  label: 'Generate an API free'
  href: ''
proof:
  caption: 'Page 2, newest first — and the total your pager needs'
  method: 'GET'
  path: '/<tenant>/posts?_sort=createdAt&_order=desc&_page=2&_limit=3'
  headers:
    - 'X-Total-Count: 128'
  response: |
    [
      { "id": 118, "title": "Suspense boundaries", "userId": 4 },
      { "id": 117, "title": "Optimistic updates", "userId": 2 },
      { "id": 116, "title": "Route-level data", "userId": 4 }
    ]
spec:
  - label: 'Unblocked'
    value: 'You do not need the backend team to have finished, or even started. A JSON file is the whole dependency.'
  - label: 'List screens'
    value: 'Filter, multi-key sort and pagination compose in one request, and `X-Total-Count` returns the unpaginated total — the number a pager needs and a fixture never has.'
  - label: 'Error states'
    value: 'Ask the API for a 503 or an 800ms delay with a request header, so your loading skeletons and error boundaries get exercised on demand instead of on incident day.'
  - label: 'Real writes'
    value: 'The record your form creates persists. Optimistic updates, cache invalidation and refetch logic all behave the way they will in production.'
  - label: 'Typed contract'
    value: 'Point your client generator at the project`s `openapi.json` and get types without hand-writing a spec.'
related:
  - '/use-cases/mock-apis'
  - '/roles/qa-engineer'
sections:
  - kind: statement
    body: |
      Everything you build before the API exists is guesswork against a fixture file —
      and guesswork gets thrown away.

  - kind: split
    title: 'The dependency you can delete'
    body: |
      The usual order of work is: the API gets designed, then built, then deployed, and only
      then can the UI be written against something real.

      Stubbase inverts it. You describe the shape you need, you get working endpoints, and
      the data layer you write today is the one you ship — because it is talking to a real
      HTTP API with real status codes, real pagination headers and real persistence.
    code:
      lang: ts
      caption: 'the fetch layer you keep'
      content: |
        const res = await fetch(
          `${API}/posts?_sort=createdAt&_order=desc&_page=${page}&_limit=20`,
        );

        const rows = await res.json();
        const total = Number(res.headers.get('X-Total-Count'));

  - kind: split
    title: 'Nested data without the waterfall'
    body: |
      Name a foreign key `userId` and the relationship is inferred. One request then returns
      the row and its author together, instead of a list request followed by N detail
      requests.

      Your component gets the shape it actually renders, in one round trip.
    code:
      lang: bash
      caption: 'one request, not N+1'
      content: |
        GET /<tenant>/posts?_expand=user

        [
          {
            "id": 100,
            "title": "React State",
            "user": { "id": 1, "name": "Alice" }
          }
        ]

  - kind: split
    title: 'Make it fail, deliberately'
    body: |
      Error boundaries and retry logic are the hardest parts of a UI to test, because the
      backend refuses to cooperate. With QA mode enabled on the project, you ask for the
      failure you want.

      Your skeleton renders for exactly 800ms. Your error boundary catches an actual 503.
      Neither is a mock — it is the same pipeline serving the same route, told to behave badly.
    code:
      lang: bash
      caption: 'request the failure you need'
      content: |
        curl https://api.stubbase.dev/<tenant>/posts \
          -H "x-stubbase-delay: 800" \
          -H "x-stubbase-status: 503"

  - kind: steps
    title: 'What a first afternoon looks like'
    steps:
      - title: 'Paste the shape'
        body: 'A JSON file with the collections your screens need. Relationships come from `<name>Id` keys.'
      - title: 'Wire the fetch layer'
        body: 'Real URLs, real status codes, real `X-Total-Count`. Nothing about it is throwaway.'
      - title: 'Break it on purpose'
        body: 'Add a chaos header and watch your skeletons, retries and error boundaries actually run.'
---
