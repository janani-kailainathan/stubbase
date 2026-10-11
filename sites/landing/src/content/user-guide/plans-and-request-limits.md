---
title: 'Stubbase Plans, Monthly Requests and Rate Limits Explained — User Guide'
description: 'Stubbase plans differ only in requests: Free has 10,000 a month at 5 per second, Pro 250,000 at 50 per second. How requests are counted across projects, what happens at the limit, and the 429 Retry-After answer.'
h1: 'Plans, requests and rate limits'
subheadline: 'Every feature is on every plan. Plans differ only in how many requests your projects may answer, per month and per second.'
label: 'Plans and requests'
chapter: 'account'
order: 1
publishedAt: 2026-10-11
hero:
  src: /user-guide/plans-and-request-limits/hero.png
  alt: 'The Account card in Settings: plan, requests this month against the allowance, reset date, projects, rate limit, request packs and AI credits'
  caption: 'Settings → Account: the requests used are the number your API is limited on.'
---

## The plans

| | Free | Pro |
|---|---|---|
| Requests a month | 10,000 | 250,000 |
| Requests a second | 5, with bursts of 20 | 50, with bursts of 150 |
| AI credits | 1,000 gift credits, once | 5,000 a month, plus the gift |
| Every project feature | Yes | Yes |

Sign-in, roles, webhooks, QA mode, validation and the Co-Pilot are on both.
Prices are on the [pricing page](/pricing).

## How requests are counted

- **One allowance per account.** Every request any of your projects answers
  comes out of the same monthly pool, including projects you have since
  deleted.
- **What counts**: every answer from your public API, including errors and
  requests from the Live tab. Your own work in the dashboard (editing records,
  saving settings, deploying) does not count.
- **What doesn't count**: requests refused because you hit a limit, or because
  the project is stopped.
- **The count resets** on the 1st of each month, UTC.

Your usage is on the account card under Settings, and in the Usage panel at the
bottom of the APIs rail. It catches up with new traffic about once a minute.

## When you reach your monthly requests

Every project on the account answers `429` until the 1st. The dashboard keeps
working, so you can see why your API stopped.

## The rate limit

Your requests per second are shared by all your projects, with a burst on top
for short spikes. A request over the limit gets:

```http
429 Too Many Requests
Retry-After: 1
```

`Retry-After` says how many seconds to wait. Requests refused this way don't
count toward your monthly requests. If you see them in normal use, slow your
client down or batch its reads, using `_expand` instead of one request per row.

## Request packs

Request packs are extra requests for Pro, bought once. Your monthly allowance
is used first, then the pack, and what's left carries over month to month until
the pack expires, 12 months after you got it. They don't raise your rate limit,
and on Free a pack waits until you are back on Pro. Request packs aren't on
sale yet.
