---
title: 'Add Google and GitHub Login to Your Stubbase API — User Guide'
description: 'Turn on Google and GitHub sign-in for your Stubbase API: the two keys each provider needs, the callback URL to register, and AUTH_OAUTH_REDIRECT to send users back to your app with their tokens.'
h1: 'Add Google and GitHub login'
subheadline: 'Paste each provider''s client ID and secret into your .env, register one callback URL, and your users can sign in without a password.'
label: 'Google and GitHub login'
chapter: 'auth'
order: 4
publishedAt: 2026-10-11
hero:
  src: /user-guide/google-and-github-login/hero.png
  alt: 'The project''s .env at section 1.5, with the Google and GitHub callback URLs already filled in with the project id'
  caption: 'Section 1.5 of your .env names the exact callback URLs to register.'
---

## What you need

Each provider gives you two values, a **client ID** and a **client secret**,
from an OAuth app you register with them. Getting them takes a few minutes in
each console, and the walkthrough is its own guide:
[How to get Google and GitHub OAuth keys](/guides/google-github-oauth-keys).

Both providers ask for your project's callback URL:

```
https://api.stubbase.dev/<project-id>/auth/google/callback
https://api.stubbase.dev/<project-id>/auth/github/callback
```

Your project's `.env` lists both, with your project id already filled in, in
section 1.5.

## Turn them on

Fill in either pair, or both, alongside `AUTH_ENABLED`:

```bash
AUTH_ENABLED=true

AUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=GOCSPX-your-secret

AUTH_GITHUB_CLIENT_ID=Iv1.a1b2c3d4e5f6
AUTH_GITHUB_SECRET=your-github-secret
```

**Save**, then **Deploy**. A provider is on only when both its values are
filled in, and only with `AUTH_ENABLED=true`: these are extra ways into the same
accounts, not a replacement for them.

If you turn auth on with a starter, the Google and GitHub lines are already
uncommented for you, empty and ready to fill.

## Send users to sign in

Link your sign-in buttons to:

```
https://api.stubbase.dev/<project-id>/auth/google
https://api.stubbase.dev/<project-id>/auth/github
```

Stubbase handles the round trip to the provider and back.

## Bring them back to your app

Without anything else, the tokens come back as JSON, which is no use in a
browser. Tell Stubbase where your app's sign-in page is:

```bash
AUTH_OAUTH_REDIRECT=https://your-app.com/login
```

After signing in, the user lands there with the tokens after a `#`:

```
https://your-app.com/login#token=…&refreshToken=…&expiresIn=…
```

Read them in that page and keep them as you would after a password sign-in. One
line serves both providers.

## Accounts are joined by email

Signing in with Google or GitHub joins the account that already has the same
email address, so someone who signed up with a password can later use Google.
That is only safe with an address the provider has verified, so an unverified
one is refused with a `403` and no account is touched. For GitHub, Stubbase
reads the account's verified addresses, never the email on the profile.
