---
title: 'Google and GitHub Social Login for Your REST API — Stubbase'
description: 'Add Sign in with Google and Sign in with GitHub to a Stubbase API with two config keys per provider. Verified-email identity, signed JWTs, and per-record ownership, with no auth server to run.'
h1: 'Google and GitHub social login, without an auth server'
subheadline: 'Bring your own OAuth app, paste four values into your project, and every request arrives with a signed identity attached. Users, sessions and record ownership are already part of the engine.'
---

## Two config keys per provider

Social login is not a service you bolt on to a Stubbase project — it is part of
the request pipeline. A project turns it on by putting its own OAuth
credentials into its environment:

```bash
AUTH_ENABLED=true
AUTH_GOOGLE_CLIENT_ID=...
AUTH_GOOGLE_SECRET=...
AUTH_GITHUB_CLIENT_ID=...
AUTH_GITHUB_SECRET=...
```

Both halves of a pair have to be present before that provider's routes mount,
which is also how you ship Google-only login and add GitHub later. The
credentials belong to your OAuth app, not to Stubbase: you keep control of the
consent screen, the branding and the revocation.

Getting those four values out of the two consoles is its own small ordeal, so
there is a step-by-step guide for it: [how to get Google and GitHub OAuth
keys](/guides/google-github-oauth-keys).

## The endpoints you get

Turning it on mounts four routes on your project:

```bash
GET /<project-id>/auth/google            # → the provider's consent screen
GET /<project-id>/auth/google/callback   # → back here with a signed token
GET /<project-id>/auth/github
GET /<project-id>/auth/github/callback
```

Send a browser to the first one and the rest happens without your code. When
the provider confirms the identity, Stubbase either returns
`{ "token": "…", "user": { … } }` as JSON, or — if you set
`AUTH_OAUTH_REDIRECT` — sends the browser to your own front end with the token
in the URL fragment, ready to read and store.

Email and password sign-up (`POST /auth/signup`, `POST /auth/login`) work
alongside it on the same user table, so offering both costs nothing extra.

## One identity, however they signed in

The first social login writes a record into your project's `users` resource,
with the provider that created it and the role it starts in. Every later login
with the same **verified** email address matches that record rather than making
a second one, so a person who signed up with a password in March and clicks
"Sign in with Google" in June is still one user with one id.

Verification is the rule that makes that safe. An address the provider has not
confirmed is refused rather than matched, because an unverified email that
links to an existing account is an account takeover waiting to happen.

## Signed tokens your API already understands

Every successful login returns a JWT carrying the user's id, email and role,
signed with a key derived for your project alone and never stored on disk.
Send it as a bearer token and the engine does the rest:

```bash
curl https://api.stubbase.dev/<project-id>/orders \
  -H "Authorization: Bearer <token>"
```

- **Ownership is enforced, not suggested.** An authenticated `POST` stamps the
  record with its author. A non-admin can then read and change their own
  records, and gets a `403` on everyone else's — without you writing a rule.
- **Roles bypass it deliberately.** A user with `"role": "admin"` in the users
  table sees and edits everything, which is what makes an admin screen possible.
- **Public reads stay public when you want them.** `AUTH_PUBLIC_ROUTES` lists
  the resources anonymous visitors may `GET`, so a catalogue can be open while
  writes still require a token.
- **Sessions expire on your terms.** `AUTH_JWT_TTL_SECONDS` sets the lifetime;
  the default is twenty-four hours.

## What you do not have to run

No auth server, no session store, no password reset infrastructure, no user
database to provision, no library to keep patched. Passwords, where you use
them, are hashed with argon2id by the engine. Your project's OAuth secrets live
in its server-side configuration, which the public API never serves and the
dashboard masks — they are never shipped to a browser, and never visible in
your front-end bundle.
