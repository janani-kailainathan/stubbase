---
title: 'QA Mode: Simulate Slow, Failing and Empty API Responses in Stubbase — User Guide'
description: 'Switch on QA_MODE and test how your app handles a slow API, a 500, random failures or an empty list, using four x-stubbase request headers. Sign-in and roles still apply.'
h1: 'Test failures with QA mode'
subheadline: 'Make your API slow, failing or empty on request, so you can see how your app copes before your users do.'
label: 'QA mode'
chapter: 'settings'
order: 4
publishedAt: 2026-10-11
---

## Switch it on

```bash
QA_MODE=true
```

Save and deploy. Requests to your tables can now ask for trouble with four
headers. Without the line, the headers are ignored, so they are harmless if a
test leaves them on in production.

## The four headers

| Header | Example | What happens |
|---|---|---|
| `x-stubbase-delay` | `2000` | The response waits this many milliseconds first, up to 10 seconds. |
| `x-stubbase-status` | `500` | The response is that status, with an empty body. Any code from 100 to 599. |
| `x-stubbase-error-rate` | `0.3` | That share of requests, from 0 to 1, fails with a `503`. |
| `x-stubbase-empty` | `true` | A list comes back as `[]`, a single record as `null`. Reads only. |

```bash
# A slow list
curl https://api.stubbase.dev/<project-id>/posts -H 'x-stubbase-delay: 3000'

# A server error
curl https://api.stubbase.dev/<project-id>/posts -H 'x-stubbase-status: 500'

# One request in three fails
curl https://api.stubbase.dev/<project-id>/posts -H 'x-stubbase-error-rate: 0.33'

# The empty state
curl https://api.stubbase.dev/<project-id>/posts -H 'x-stubbase-empty: true'
```

The headers work from a browser on another origin too, so your front end can
send them directly.

## In the Live tab

Once QA mode is deployed, the Live tab's **Headers** panel offers the four
headers, so you can try each one without writing a request.

## What QA mode never does

- **Bypass sign-in or roles.** These checks run first. A request that would be
  refused is refused, header or not.
- **Write anything.** A simulated response leaves your data untouched.

## Every request still counts

A simulated `500` or `503` is still a request your API answered, so it counts
toward your monthly requests and shows in the Logs tab.
