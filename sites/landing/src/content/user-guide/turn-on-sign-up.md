---
title: 'Add Sign-Up and Login to Your Stubbase API — User Guide'
description: 'Turn on AUTH_ENABLED to give your Stubbase API sign-up, login, refresh and logout. How tokens and refresh tokens work, which tables stay public, how long a sign-in lasts, and where your users are listed.'
h1: 'Turn on sign-up and login'
subheadline: 'One line in your .env gives your API accounts, sign-in and tokens. Every request then needs a token, except on the tables you leave public.'
label: 'Turn on sign-up and login'
chapter: 'auth'
order: 1
publishedAt: 2026-10-11
---

## Switch it on

Open the project's `.env` in the Files rail, click **Edit**, and remove the `#`
in front of this line, in section 1.1 of the file:

```bash
AUTH_ENABLED=true
```

**Save**, then **Deploy**. Your API now has these routes:

```bash
POST /<project-id>/auth/signup            # { email, password, name? }
POST /<project-id>/auth/login             # { email, password }
POST /<project-id>/auth/refresh           # { refreshToken }
POST /<project-id>/auth/logout            # your token, or { refreshToken }
POST /<project-id>/auth/change-password   # { currentPassword, password }, with your token
```

Passwords need at least 8 characters. Email verification and password reset are
switched on with it. Both have their own pages in this chapter.

## Send the token on every request

A successful sign-in answers with:

```json
{ "token": "eyJ…", "refreshToken": "…", "expiresIn": 86400, "user": { "id": "…", "email": "ada@example.com" } }
```

Your app sends the `token` back on every request to your API:

```bash
curl https://api.stubbase.dev/<project-id>/orders \
  -H 'Authorization: Bearer eyJ…'
```

With auth on, **every table needs a token by default**. A request without one
answers `401`.

## Keep some tables public

List the tables anyone may read without a token:

```bash
AUTH_PUBLIC_ROUTES=posts,comments
```

Comma-separated, no spaces. Anyone may `GET` those tables. Writing to them still
needs a token. Once roles are on, this line is ignored and the `guest` role
decides instead.

## Keep users signed in

The token expires after `expiresIn` seconds. Before it does, send the refresh
token to `/auth/refresh` and you get a new pair, with no password needed:

```bash
curl -X POST https://api.stubbase.dev/<project-id>/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{ "refreshToken": "…" }'
```

- **Each refresh token works once.** Always keep the newest one.
- **Never send two refreshes at once with the same token.** A refresh token
  used a second time means someone has a copy, so that sign-in is ended for
  everyone holding it.
- The refresh token travels in the body, never in a cookie. Store it where your
  app keeps secrets.

## Choose how long sign-ins last

| Line | What it sets | Default |
|---|---|---|
| `AUTH_JWT_TTL_SECONDS=900` | How long a token lasts. Minimum `60`. | 24 hours |
| `AUTH_REFRESH_TTL_SECONDS=604800` | How long a user stays signed in without refreshing. Every refresh restarts it. Minimum `3600`. | 30 days |

A short token is safer, and once your app refreshes it costs your users
nothing. If your app never refreshes, keep the 24-hour default.

## Sign out

`/auth/logout` with the token, or with the refresh token if the token has run
out, ends that one sign-in at once. The user stays signed in on their other
devices. Each account keeps up to ten sign-ins, and an eleventh ends the one
used longest ago.

Changing a password needs the current one as well as the token, and signs the
user out everywhere else.

## See who has signed up

Your users' accounts appear in the Files rail under **system**, in
`users.json`. You can read it there, but not edit it: accounts change only
through the auth routes, and passwords never appear. A `users.json` you create
as a table of your own is an ordinary table, unrelated to sign-in.
