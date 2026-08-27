---
title: 'Stubbase for Students — Learn REST Against a Real API'
description: 'Practise real REST — verbs, status codes, pagination, auth — against a live API you created, with nothing to install and no database to configure.'
h1: 'Learn REST against an API you actually made'
subheadline: 'Real verbs, real status codes, real auth — with nothing to install, no database to configure and no credit card to hand over first.'
promise: 'Everything here is the real protocol. Nothing is a teaching simulation.'
order: 50
cta:
  label: 'Create your first API free'
  href: ''
proof:
  caption: 'A filter, on a project you made a minute ago'
  method: 'GET'
  path: '/<tenant>/todos?completed=false&_limit=2'
  response: |
    [
      { "id": 1, "title": "Read the OpenAPI spec", "completed": false },
      { "id": 2, "title": "Try a POST", "completed": false }
    ]
spec:
  - label: 'Nothing to install'
    value: 'No database, no Docker, no local server. If you can open a browser and run `curl`, your machine is already set up.'
  - label: 'Real protocol'
    value: 'GET, POST, PUT and DELETE with the status codes they are supposed to return. What you learn here transfers directly, because it is not a simplified teaching model.'
  - label: 'Coursework-ready'
    value: 'Your endpoints are public URLs. A React assignment, an Android app or a Postman collection can all point at the same project.'
  - label: 'Read the spec'
    value: 'Every project generates its own `openapi.json`. Reading the spec for an API you designed yourself is the fastest way to understand what a spec is for.'
  - label: 'Go further'
    value: 'When you are ready, switch on auth and watch the same routes start returning 401 — then learn what a bearer token actually does.'
sections:
  - kind: statement
    body: |
      Most people learning to build software do not get stuck on REST. They get stuck three
      steps earlier, installing a database, and never reach the part they wanted to learn.

  - kind: split
    title: 'Start with the shape of your data'
    body: |
      Give it a JSON file — a list of objects, one per thing. That is the whole setup, and
      you now have five endpoints.

      No install step, no connection string, no seed script that fails on your machine for a
      reason nobody in the tutorial mentions.
    code:
      lang: json
      caption: 'todos.json'
      content: |
        {
          "todos": [
            { "id": 1, "title": "Read the OpenAPI spec", "completed": false },
            { "id": 2, "title": "Try a POST", "completed": false }
          ]
        }

  - kind: split
    title: 'Every verb does what the textbook says'
    body: |
      Run them with `curl`, with Postman, or from the app you are building. The responses
      carry real status codes: `201` when you create, `404` when you ask for something that
      is not there.

      Nothing here is pretending.
    code:
      lang: bash
      caption: 'the five you will use forever'
      content: |
        GET    /<tenant>/todos          # list them
        GET    /<tenant>/todos/1        # read one
        POST   /<tenant>/todos          # create, id generated for you
        PUT    /<tenant>/todos/1        # replace one
        DELETE /<tenant>/todos/1        # delete one

  - kind: split
    title: 'Then the parts nobody teaches first'
    body: |
      Once the basics are boring, the same project teaches you the things that actually come
      up in a job.
    bullets:
      - '**Query parameters compose.** Filter, then sort, then paginate — all in one URL.'
      - '**Headers carry data too.** The list returns a page; `X-Total-Count` says how many exist. Plenty of developers meet that idea for the first time at work.'
      - '**Relationships.** Name a field `userId`, ask for `?_expand=user`, and you have just learned what an N+1 query is and why people care.'
      - '**Authentication.** Turn auth on and the same routes start refusing you. Get a token, send it, watch them work again.'
    code:
      lang: bash
      caption: 'four ideas, one request'
      content: |
        GET /<tenant>/todos
          ?completed=false
          &_sort=title&_order=asc
          &_page=1&_limit=10

        200 OK
        X-Total-Count: 24

  - kind: split
    title: 'Something to show for it'
    body: |
      Because the project is a real hosted API, it works as coursework. Point a React
      assignment at it, hand a classmate the URL, or put the endpoint in a portfolio README.

      It is not a screenshot of a working thing. It is the working thing.
---
