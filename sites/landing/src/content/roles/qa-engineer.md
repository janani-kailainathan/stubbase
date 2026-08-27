---
title: 'Stubbase for QA Engineers — Deterministic API Failure Injection'
description: 'Deterministic control over backend failure states. Inject 503 responses, latency spikes and fractional error rates into Cypress or Playwright pipelines with a request header.'
h1: 'Make the API fail the same way every run'
subheadline: 'Inject latency, HTTP errors and fractional flakiness from your test runner with a request header — no proxy to maintain, no live traffic to intercept.'
promise: 'The failure is requested per-request, so two tests can hit the same endpoint and get different weather.'
order: 20
cta:
  label: 'Generate an API free'
  href: ''
proof:
  caption: 'Asked for a 503 after 800ms — and got exactly that'
  method: 'GET'
  path: '/<tenant>/transactions'
  status: '503 Service Unavailable'
  headers:
    - 'x-stubbase-delay: 800'
    - 'x-stubbase-status: 503'
    - 'x-stubbase-error-rate: 1.0'
  response: |
    {
      "error": "Service Unavailable",
      "simulated": true
    }
spec:
  - label: 'Per-request'
    value: 'Chaos is requested with headers, not configured globally. One spec can demand a 503 while another hits the same route successfully, in parallel, with no shared state to reset.'
  - label: 'Flakiness'
    value: '`x-stubbase-error-rate: 0.3` fails roughly three requests in ten — the shape you need to prove exponential backoff and retry logic actually work.'
  - label: 'Latency'
    value: '`x-stubbase-delay` holds the response for a fixed number of milliseconds, capped server-side, so a timeout test asserts against a number you chose.'
  - label: 'Gated'
    value: 'The chaos headers only do anything when the project has QA mode switched on, and the check runs after authentication — a simulation header can never be used to walk past auth.'
  - label: 'Observable'
    value: 'Every request through the public API gets a correlation id and an entry in the project`s live log, so a failing pipeline run has something to read afterwards.'
sections:
  - kind: statement
    body: |
      A chaos switch that lives in project configuration has to be turned on, used, and
      turned off again — which means your suite cannot run in parallel.

  - kind: split
    title: 'Header-driven failure injection'
    body: |
      When QA mode is enabled, the API intercepts specific `x-stubbase-*` headers. That lets
      you inject network faults directly from your test runner, without altering the
      underlying data and without standing up a proxy that will drift out of sync.
    bullets:
      - '`x-stubbase-status` returns the status code you name, instead of the real one.'
      - '`x-stubbase-delay` holds the response for a fixed number of milliseconds.'
      - '`x-stubbase-error-rate` fails a fraction of calls, for the flaky case.'
      - '`x-stubbase-empty` returns a successful response with nothing in it — the case UIs forget.'
    code:
      lang: bash
      caption: '503 after 800ms, every time'
      content: |
        curl -X GET https://api.stubbase.dev/<tenant>/transactions \
          -H "x-stubbase-delay: 800" \
          -H "x-stubbase-status: 503" \
          -H "x-stubbase-error-rate: 1.0"

  - kind: split
    title: 'Why per-request beats a global switch'
    body: |
      Because Stubbase reads the simulation from the request, the blast radius is one call.
      A Playwright spec can route a single interception through a failing header while every
      other request in the same browser context succeeds normally.

      Nothing is left in a broken state for the next test, so the suite parallelises.
    code:
      lang: ts
      caption: 'one route fails, the rest do not'
      content: |
        await page.route('**/transactions', (route) =>
          route.continue({
            headers: {
              ...route.request().headers(),
              'x-stubbase-status': '503',
            },
          }),
        );

  - kind: split
    title: 'Flakiness you can actually assert on'
    body: |
      A client that always fails and a client that always succeeds both look fine. Retry and
      backoff logic only reveals itself somewhere in between.

      `error-rate: 0.3` fails roughly three calls in ten, which is the shape that exercises
      the code path you are trying to prove.
    code:
      lang: bash
      caption: 'intermittent, on purpose'
      content: |
        # guaranteed failure
        -H "x-stubbase-error-rate: 1.0"

        # ~30% of requests fail — exercises retry + backoff
        -H "x-stubbase-error-rate: 0.3"

  - kind: split
    title: 'It cannot be used to get in'
    body: |
      Two properties are worth knowing before you put this in a shared environment.

      The headers do nothing at all unless the project has QA mode explicitly enabled. And
      the simulation stage runs **after** authentication — so no combination of chaos headers
      will ever return data to a caller who was not already allowed to have it.
---
