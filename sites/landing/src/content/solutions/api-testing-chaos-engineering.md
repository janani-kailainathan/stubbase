---
title: 'Simulate API Latency and HTTP Errors with ChaosGuard — Stubbase'
description: 'Deterministic control over backend failure states. Inject 503 Service Unavailable responses, timeout spikes, and randomized error rates into Cypress or Playwright pipelines.'
h1: 'Simulate API Latency and HTTP Errors with ChaosGuard'
subheadline: 'Deterministic control over backend failure states. Inject 503 Service Unavailable responses, timeout spikes, and randomized error rates directly into Cypress or Playwright pipelines.'
---

## Testing Frontend Error Boundaries

QA teams must validate UI resilience against network degradation. Intercepting live backend traffic or writing custom proxy scripts is brittle and difficult to maintain within CI/CD environments.

## Header-Driven Failure Injection (ChaosGuard)

When QA Mode is enabled, the Stubbase API intercepts specific `x-stubbase-*` HTTP headers. This allows you to dynamically inject network faults directly from your test runner without altering the underlying database.

**Simulating a 503 Status Code with 800ms Latency:**

```bash
curl -X GET https://api.stubbase.dev/<tenant>/transactions \
  -H "x-stubbase-delay: 800" \
  -H "x-stubbase-status: 503" \
  -H "x-stubbase-error-rate: 1.0"
```

**Configuring Flakiness (`error-rate`):**

- `x-stubbase-error-rate: 1.0`: Guarantees failure (100% execution).
- `x-stubbase-error-rate: 0.3`: Simulates intermittent flakiness, causing the endpoint to fail 30% of the time. Ideal for testing exponential backoff and retry logic in frontend clients.
