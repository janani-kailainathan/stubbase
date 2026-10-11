---
title: 'Watch Requests to Your Stubbase API in the Logs Tab — User Guide'
description: 'See every request to your Stubbase API as it happens: method, path, status and time, with the request and response bodies and each step the server took. Where sign-up codes appear before you set up email.'
h1: 'Watch requests in the Logs tab'
subheadline: 'The Logs tab streams every request your API answers, as it happens. Open one to see what was sent, what came back, and why.'
label: 'Watch requests in Logs'
chapter: 'getting-started'
order: 6
publishedAt: 2026-10-11
hero:
  src: /user-guide/watch-requests-in-logs/hero.png
  alt: 'The Logs tab streaming requests, one expanded to show its request body, response body and pipeline steps'
  caption: 'One line per request; click a line to open it.'
---

## Open the Logs tab

Click **Logs** in the top bar. The tab is greyed out while the project is
stopped, because a stopped API answers nothing worth logging. Deploy it first.

The log starts with the most recent requests the server still holds, then
streams new ones as they arrive. Next to the title it reads **streaming** while
it is connected and **reconnecting…** if the connection drops.

## What each line shows

Every request to your public API gets one line: the method, the path, the
status code and how long it took. Requests from the Live tab show up here too,
because they are real requests.

Click a line to open it:

- **The request and response bodies**, shortened if they are long.
- **Each step the server took** (rate limit, sign-in check, roles, validation,
  webhooks and so on), with the time each one took. When a request is refused,
  this is where you see which step refused it.

Every response also carries an `x-correlation-id` header, so a line here can be
matched to a request your app made.

## Sign-up and reset codes appear here

Until you add a Resend key to the project's `.env`, Stubbase has no way to email
your users, so the 6-digit codes for email verification and password reset are
shown here instead, on the request that created them. Only you can see them.

That lets you build and test sign-up before you set up email. Add the key before
real users sign up, or their codes will never reach them.

## Clearing and keeping the log

- **Clear** empties the log in this browser tab. The server keeps its own copy,
  so clearing hides nothing from anyone else.
- What you have seen is kept for this browser tab, so it survives a reload, a
  trip to the Editor, or a deploy.
- The server keeps a limited number of recent requests per project and never
  writes them to disk. The Logs tab is for watching what is happening now, not
  an archive.
- Sign-in requests are kept without their bodies or codes in that tab copy,
  because they carry your users' tokens.
