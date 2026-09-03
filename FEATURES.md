# Features

Three groups.

- **[User-level features](#1-user-level-features--the-api-you-create)** — what a
  *project's* API can do. Per-tenant behaviours, configured through
  `config.json` and served by the Core Engine (`apps/core/server-core.ts`) to
  whoever calls the tenant's endpoints.
- **[App-level features](#2-app-level-features--the-stubbase-platform)** — what
  *Stubbase itself* does: accounts, the dashboard, the Co-Pilot, metering,
  keys, and the site around them.
- **[Env settings](#3-env-settings--the-central-reference)** — every key that
  switches a feature on or configures it, one table per feature.

Reference docs: [README.md](README.md) (architecture + API),
[ENVIRONMENT.md](ENVIRONMENT.md) (every knob), [PRODUCT.md](PRODUCT.md)
(positioning and what is deliberately not built yet).

---

## 1. User-level features — the API you create

### 1.1 JSON-to-CRUD

Add a JSON file to your project and the CRUD endpoints are created for you.
No database to set up and no schema to write — the file *is* your data and your
schema.

Drop in a `posts.json`, hit **Deploy**, and you have:

```
GET    /<project>/posts          list your posts
GET    /<project>/posts/<id>     read one
POST   /<project>/posts          create one (we fill in the id)
PUT    /<project>/posts/<id>     replace one
DELETE /<project>/posts/<id>     delete one
```

**A new resource needs a deploy.** Adding a JSON file, or removing one, only
reaches your live API when you hit Deploy — so a half-finished resource is
never served to whoever is calling your API. If your project is already
running, deploy again and the new resource joins it with no downtime.

**Adding, updating and deleting entries is immediate.** Once a resource is
live, the records inside it need no deploy: create, change or delete one and
the very next request sees it. Your changes are saved as you make them, so
they are still there when you come back tomorrow.

> **Known issue:** entry changes are not currently taking effect immediately —
> confirmed by testing on 2026-09-03. The behaviour described above is what is
> intended; we will fix this.

### 1.2 Env settings

Every feature below is off until you switch it on, and you do that yourself
from the **.env editor** in your project. It reads like any `.env` file you have
written before.

There are two kinds of key, and you normally write both:

1. **The switch** that turns a feature on.
2. **The settings** that configure it — they sit in the same file and do
   nothing until the switch is on.

Auth, for example:

```
# 1. switch it on
AUTH_ENABLED=true

# 2. configure it
AUTH_PUBLIC_ROUTES=posts,comments
AUTH_JWT_TTL_SECONDS=3600
```

Hit **Deploy** and that is live: your API now needs a token, anyone can still
read `/posts` and `/comments` without one, and a token lasts an hour before the
user signs in again. Change a value, deploy again, and the new setting applies
to the very next request.

Set `AUTH_ENABLED=false` and the feature is off — but the two settings stay in
the file, ready for when you switch it back on. You never have to delete your
configuration to pause a feature.

→ **[Section 3](#3-env-settings--the-central-reference) is the full reference**,
with one table per feature: every key, an example value, and what it does.

### 1.3 Auth — sign-up and login for your users

Give *your* users accounts, without building an auth service. Turn it on and a
`users.json` in your project becomes your user table, and two endpoints appear:

```
POST   /<project>/auth/signup    { email, password }  → a token
POST   /<project>/auth/login     { email, password }  → a token
```

Your app sends that token back on every request:

```
Authorization: Bearer <token>
```

With auth on, your whole API is private by default — every request needs a valid
token. You choose which resources stay readable by anyone.

Passwords are hashed, and no response from your API ever includes a password —
not even reading the users resource directly.

This section is the base every login builds on. Google and GitHub sign-in are
extra doors into the same feature — they need everything here switched on first,
and they hand your users the same token.

##### To enable this feature, add to your `.env`:

```
AUTH_ENABLED=true
```

That one line is enough — you get signup, login, and an API that now requires a
token. Everything below is optional.

##### To keep some resources readable by anyone:

```
AUTH_PUBLIC_ROUTES=posts,comments
```

Anyone may `GET` these two without a token; writing to them still needs one.
Comma-separated, no spaces.

Leave this key out and *nothing* is public — the right default for a private
app, the wrong one for a public blog with a signed-in comment box.

##### To control how long a login lasts:

```
AUTH_JWT_TTL_SECONDS=3600
```

A token stays valid for this many seconds — here, one hour. When it expires,
your user's next request is rejected and your app sends them back to log in.

| Value | A token lasts | Good for |
|---|---|---|
| *(left out)* | 24 hours | most apps — the default |
| `3600` | 1 hour | anything holding data you would not want left open on a shared laptop |
| `604800` | 7 days | a mobile app or a tool people keep open all week |

The minimum is `60`. Shorter is safer but means signing in more often, and
there is no refresh flow — so pick the longest span you are comfortable with
rather than the shortest one you can bear.

#### 1.3.1 Google login

Let your users sign in with their Google account instead of picking a password.
Register your own Google OAuth app, paste the two values in, and this route goes
live:

```
GET    /<project>/auth/google
```

Send your users there and we handle the round trip back from Google.

##### To enable this, add to your `.env`:

```
AUTH_ENABLED=true
AUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
AUTH_GOOGLE_SECRET=GOCSPX-your-secret
```

Both Google values are needed — with only one of them the route stays off. And
`AUTH_ENABLED=true` still has to be there: Google login is a second door into
the same auth feature, not a replacement for it.

In the Google console, register the callback as
`<origin>/<project>/auth/google/callback`.

##### To send users back to your own app after they sign in:

```
AUTH_OAUTH_REDIRECT=https://your-app.com/login
```

Without it the token comes back as JSON — fine when you are calling the endpoint
yourself, no use when a browser is doing the redirecting. Set it and we redirect
to your app with `#token=…` on the end for you to read.

This key is shared with GitHub login: set it once and it applies to both.

#### 1.3.2 GitHub login

The same, for GitHub:

```
GET    /<project>/auth/github
```

##### To enable this, add to your `.env`:

```
AUTH_ENABLED=true
AUTH_GITHUB_CLIENT_ID=Iv1.a1b2c3d4e5f6
AUTH_GITHUB_SECRET=your-github-secret
```

Both values together light up the route, and `AUTH_ENABLED=true` is required
here too. Register `<origin>/<project>/auth/github/callback` as the callback URL
in your GitHub OAuth app.

You can run Google and GitHub side by side — set both pairs and your users pick.

##### To send users back to your own app after they sign in:

```
AUTH_OAUTH_REDIRECT=https://your-app.com/login
```

Without it the token comes back as JSON — fine when you are calling the endpoint
yourself, no use when a browser is doing the redirecting. Set it and we redirect
to your app with `#token=…` on the end for you to read.

This key is shared with Google login: set it once and it applies to both.

### 1.4 Atomic operations

_To be written — placeholder._

---

## 2. App-level features — the Stubbase platform

_Nothing listed yet._

---

## 3. Env settings — the central reference

Everything your API does beyond plain CRUD is a setting you control yourself,
from the **.env editor** in your project. It reads like any `.env` file you have
written before.

**Every feature is off until you turn it on.** A fresh project is plain, open
CRUD and nothing else, so you switch on only what you actually want.

There are two kinds of key, and you normally write both:

1. **The switch** that turns the feature on — always the first row of each
   table below.
2. **The settings** for that feature — they sit in the same file and do nothing
   until the switch is on.

Flip the switch back to `false` and your settings stay in the file, just
inactive — you never have to delete your configuration to pause a feature, and
it is all still there when you turn it on again.

A few features have no separate switch, because the setting *is* the switch:
a `SCHEMA_<RESOURCE>` rule or a `HOOK_*` webhook URL is live from the moment
you write it, and you remove it by clearing the key. Those tables say so in
their first row.

Settings follow the same rule as your resources: they are saved as a draft and
go live when you hit **Deploy**.

One table per feature, and it grows as features are added. For the exhaustive
reference — defaults, exact formats, and how each key is wired in dev, Docker
and production — see [ENVIRONMENT.md](ENVIRONMENT.md).

### 3.1 Auth

Feature: [1.3 Auth](#13-auth--sign-up-and-login-for-your-users)

| Key | Example | What it does |
|---|---|---|
| `AUTH_ENABLED` | `true` | **The switch.** Turns `users.json` into your user table, adds the signup/login endpoints, and makes every request need a token. Every key in this whole section does nothing without it — including the Google and GitHub ones. |
| `AUTH_PUBLIC_ROUTES` | `posts,comments` | Resources anyone may `GET` without a token. Writes to them still need one. Comma-separated, no spaces. Left out, nothing is public. |
| `AUTH_JWT_TTL_SECONDS` | `3600` | How long a token stays valid, in seconds. Defaults to `86400` (24 hours); the minimum is `60`. |

#### 3.1.1 Google login

| Key | Example | What it does |
|---|---|---|
| `AUTH_GOOGLE_CLIENT_ID` | `1234-abc.apps.googleusercontent.com` | **The switch, first half.** Set this *and* the secret and `/<project>/auth/google` goes live. Needs `AUTH_ENABLED=true` as well. |
| `AUTH_GOOGLE_SECRET` | `GOCSPX-your-secret` | The other half. With only one of the pair set, the route stays off. |
| `AUTH_OAUTH_REDIRECT` | `https://your-app.com/login` | Send the user here with `#token=…` attached instead of returning the token as JSON. Shared with the other provider — set it once, it applies to both. |

Register `<origin>/<project>/auth/google/callback` in the Google console.

#### 3.1.2 GitHub login

| Key | Example | What it does |
|---|---|---|
| `AUTH_GITHUB_CLIENT_ID` | `Iv1.a1b2c3d4e5f6` | **The switch, first half.** Set this *and* the secret and `/<project>/auth/github` goes live. Needs `AUTH_ENABLED=true` as well. |
| `AUTH_GITHUB_SECRET` | `your-github-secret` | The other half. With only one of the pair set, the route stays off. |
| `AUTH_OAUTH_REDIRECT` | `https://your-app.com/login` | Send the user here with `#token=…` attached instead of returning the token as JSON. Shared with the other provider — set it once, it applies to both. |

Register `<origin>/<project>/auth/github/callback` in your GitHub OAuth app.
