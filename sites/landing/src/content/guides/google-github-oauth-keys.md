---
title: 'How to Get Google and GitHub OAuth Keys (Client ID and Secret) — Stubbase'
description: 'Step by step: create a Google OAuth client and a GitHub OAuth app, find the client ID and client secret, register the right callback URL, and add Google and GitHub login to a Stubbase API.'
h1: 'How to get Google and GitHub OAuth keys'
subheadline: 'Both providers hand you a client ID and a client secret, and both hide them in a different corner of a different console. Here is the whole path for each, ending with Google and GitHub login working on your own API.'
summary: 'Create the OAuth client, find the client ID and secret, register the callback URL that matches your project, and turn on Google and GitHub login.'
publishedAt: 2026-08-27
author: 'Stubbase'
tags: ['oauth', 'auth']
hero:
  alt: 'The Google Cloud Console credentials screen beside a Stubbase project environment editor'
  caption: 'Two consoles, four values. Everything below is how to get them and where they go.'
aiSummary: 'This article explains how to configure Google and GitHub OAuth for a Stubbase project. Readers will learn to generate the required client ID and client secret pairs, set the authorized redirect URI, and update the .env configuration to enable functional user logins.'
aiSummaryModel: 'gemini-3.1-flash-lite'
aiSummaryHash: '93fcf8a64703'
---

Adding "Sign in with Google" to an API is ten minutes of work and about forty
minutes of hunting for four values. Google calls them a **client ID** and a
**client secret** and files them under a console section that has been renamed
twice. GitHub calls them the same thing and puts them somewhere else entirely,
with one rule that catches everyone the first time.

This guide gets both pairs, and finishes with a working login on a Stubbase
project. If you only need one provider, the two sections are independent —
Google is first because its console asks more of you.

## What you need before you start

- A Google account, for the Google client. Any account works; it does not have
  to be a Workspace one.
- A GitHub account, for the GitHub app. A personal account is fine; an
  organisation can own the app instead if you would rather it outlive you.
- **Your project's callback URL.** Both consoles ask for it, and both refuse to
  save without it. The next section is how to work yours out.

You do not need a domain, a company, or a privacy policy URL to get keys that
work in development. You will need them before Google lets an app out of testing
mode — more on that in the Google section.

## The callback URL your project uses

The callback URL — Google says *authorized redirect URI*, GitHub says
*authorization callback URL* — is where the provider sends the person back once
they have approved your app. It is the one value both consoles insist on, and
it is where almost every first attempt goes wrong, because the provider matches
it **exactly**: every character, including the scheme and any trailing path.

For a Stubbase project the shape is fixed:

```bash
https://api.stubbase.dev/<project-id>/auth/google/callback
https://api.stubbase.dev/<project-id>/auth/github/callback
```

`<project-id>` is the id in your API's base URL — the same segment you already
call for your data, as in `https://api.stubbase.dev/<project-id>/posts`. A
project called "Recipe box" might be `recipe-box`, making its Google callback
`https://api.stubbase.dev/recipe-box/auth/google/callback`.

Write both URLs down before you open either console. You will paste them
verbatim, twice.

## Create a Google OAuth client

Google splits this into two jobs: describing your app once (the consent screen
everyone sees), then minting credentials for it.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: Google Cloud Console → APIs & Services → Credentials, with the 'Create credentials' menu open."><span class="shot-file">/guides/google-github-oauth-keys/01-google-credentials.png</span></div>
  <figcaption>Google Cloud Console → APIs &amp; Services → Credentials, with the "Create credentials" menu open.</figcaption>
</figure>

**1. Open the console and pick a project.** Go to
[console.cloud.google.com](https://console.cloud.google.com) and select a
project from the picker at the top, or create one. The project is just a
container for the credentials; its name never reaches your users.

**2. Fill in the consent screen.** In the sidebar, **APIs & Services → OAuth
consent screen** — newer consoles present the same thing as **Google Auth
Platform**, with the fields split across *Branding* and *Audience*. Choose
**External** as the user type unless every one of your users is inside your own
Workspace organisation. You need an app name, a support email, and a developer
contact email; the logo and the homepage links can wait.

**3. Add the scopes.** Three, and no more: `openid`,
`.../auth/userinfo.email` and `.../auth/userinfo.profile`. That is exactly what
a login needs — who this is, and what to call them. Every additional scope makes
the consent screen longer and your review slower.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: The scope picker, with openid, userinfo.email and userinfo.profile selected."><span class="shot-file">/guides/google-github-oauth-keys/02-google-consent-scopes.png</span></div>
  <figcaption>The scope picker, with openid, userinfo.email and userinfo.profile selected.</figcaption>
</figure>

**4. Create the client.** **Credentials → Create credentials → OAuth client
ID**, and choose **Web application** as the type. Not "Desktop", not "Single
page app": your callback is handled by a server, which is what "Web application"
means here.

**5. Add the redirect URI.** Under *Authorized redirect URIs*, click **Add URI**
and paste your Google callback URL from above. One client can hold several, so
add your production and local URLs now rather than coming back later. Google
accepts `http://` only for `localhost` and `127.0.0.1`; everything else must be
`https://`.

**6. Copy the two values.** Save, and Google shows the **Client ID** (it ends in
`.apps.googleusercontent.com`) and the **Client secret**. The secret can be
re-read from this screen later, unlike GitHub's, but treat it as write-once
anyway and put it somewhere safe now.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: The dialog showing the new client ID and client secret."><span class="shot-file">/guides/google-github-oauth-keys/03-google-client-created.png</span></div>
  <figcaption>The dialog showing the new client ID and client secret.</figcaption>
</figure>

**7. Decide who can sign in.** A new app starts in **Testing**, where only
accounts you add to the test-user list may log in — up to 100 of them, each
added by hand. That is fine while you build. Before real users arrive, publish
the app; publishing with only those three scopes does not require Google's
verification review, but it does require the privacy policy and terms links you
skipped in step 2.

## Create a GitHub OAuth app

GitHub is the shorter road, with one trap in it.

**1. Open the OAuth app list.** Go to **Settings → Developer settings → OAuth
Apps** ([github.com/settings/developers](https://github.com/settings/developers))
and click **New OAuth App**. For an app owned by an organisation, start from
that organisation's settings instead — ownership cannot be changed casually
afterwards.

Take care to pick **OAuth Apps**, not **GitHub Apps**. They sit next to each
other in the same sidebar and are not interchangeable: a GitHub App is built to
act on repositories with its own installed identity, and its credentials will
not drive a plain sign-in flow.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: GitHub's Developer settings, OAuth Apps tab, with the New OAuth App button."><span class="shot-file">/guides/google-github-oauth-keys/04-github-new-oauth-app.png</span></div>
  <figcaption>GitHub's Developer settings, OAuth Apps tab, with the New OAuth App button.</figcaption>
</figure>

**2. Fill in three fields.** *Application name* is what users see on the
authorisation screen. *Homepage URL* is a link on that same screen and plays no
part in the flow — your marketing site, or `http://localhost:5173` for a
development app. *Authorization callback URL* is the one that matters: paste
your GitHub callback URL exactly.

**3. Note the one-callback rule.** A GitHub OAuth app holds exactly **one**
callback URL, where Google's client holds a list. So a development app and a
production app are two separate GitHub apps with two separate key pairs. Name
them accordingly now — "Recipe box (dev)" and "Recipe box" — because in six
months the only difference you will see is the callback URL.

**4. Copy the client ID, then generate the secret.** The **Client ID** is on the
app's page from the moment it exists. The secret is not: click **Generate a new
client secret**, and copy it immediately. GitHub shows it once and will only
ever offer you a fresh one after that.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: The app settings page, client ID visible and a newly generated client secret."><span class="shot-file">/guides/google-github-oauth-keys/05-github-client-secret.png</span></div>
  <figcaption>The app settings page, client ID visible and a newly generated client secret.</figcaption>
</figure>

## Add the keys to your Stubbase project

Four values, one screen. In the dashboard, open your project and go to its
**.env** editor:

```bash
AUTH_ENABLED=true
AUTH_GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
AUTH_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
AUTH_GITHUB_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AUTH_OAUTH_REDIRECT=https://your-app.com/login
```

`AUTH_ENABLED=true` is the master switch: without it the auth routes answer
`404` no matter how good your keys are. Each provider then needs **both** halves
of its pair — an id without a secret leaves that provider switched off, which is
also how you ship Google-only login and add GitHub later.

`AUTH_OAUTH_REDIRECT` is where your own front end takes over. Set it, and a
finished login sends the browser to that URL with the session token in the
fragment — `https://your-app.com/login#token=eyJhbGciOi…` — for your code to
read and store. Leave it out and the callback returns plain JSON instead
(`{ "token": "…", "user": { … } }`), which is the easier shape while you are
testing with curl.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: The project's .env editor with the auth keys entered, secrets masked."><span class="shot-file">/guides/google-github-oauth-keys/06-stubbase-env-editor.png</span></div>
  <figcaption>The project's .env editor with the auth keys entered, secrets masked.</figcaption>
</figure>

Two things to do before it works. **Save, then press Deploy** — edits are staged
as a draft and the running API keeps its old configuration until you promote
them. And check the project is **running**: a project that has been stopped
answers `503 {"error":"service unavailable"}` on every public route, auth
included.

Your secrets stay on the server. They live in the project's configuration,
which the public API never serves, and the editor masks them when you are not
editing — the same way it treats every other value whose name ends in `SECRET`,
`TOKEN` or `KEY`.

## Test the login flow

Open this in a browser — not curl, since the point is the redirect chain:

```bash
https://api.stubbase.dev/<project-id>/auth/google
```

You should land on Google's account chooser, approve the app, and come back to
whatever you set as `AUTH_OAUTH_REDIRECT` with a token in the URL fragment. Swap
`google` for `github` and repeat.

The token is a JWT carrying `sub`, `email` and `role`, signed for your project
alone. Send it as a bearer token on any request that needs a signed-in user:

```bash
curl https://api.stubbase.dev/<project-id>/posts \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
```

On a first login the provider's verified email address becomes a record in your
project's `users` resource, with `role: "user"` and the provider that created
it. A second login with the same address matches that record rather than making
another, so someone who signed up with a password and later clicks "Sign in with
Google" stays one user.

## Common errors and what they mean

**`redirect_uri_mismatch` (Google), or GitHub's "The redirect_uri MUST match the
registered callback URL"** — the URL your project sent does not match the one in
the console, character for character. Compare them side by side: a missing
`/callback`, `http` against `https`, and a stray trailing slash all look
identical at a glance.

**`404 {"error":"auth is not enabled for this tenant"}`** — `AUTH_ENABLED=true`
is missing, or it is still sitting in an undeployed draft. Press Deploy.

**`404 {"error":"google oauth is not configured"}`** — that provider has one
half of its pair. Both the id and the secret must be present before the route
mounts.

**`400 {"error":"missing or invalid oauth code/state"}`** — the sign-in took
longer than ten minutes, or the callback was opened directly rather than
reached from the provider. Start again from `/auth/google`.

**`502 {"error":"oauth profile has no usable email"}`** — GitHub only. The
account has no verified email address for us to identify it by; the fix belongs
to the person signing in, under GitHub's own email settings.

**`503 {"error":"service unavailable"}`** — the project is stopped or in
maintenance. Start it from the dashboard.

**`401` on your first authenticated request** — the token is fine but the header
is not. It is `Authorization: Bearer <token>`, one space, no quotes.
