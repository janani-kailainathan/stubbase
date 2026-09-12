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

**Every entry knows when it was created and last changed.** When you create an
entry through your API we add `createdAt` and `updatedAt`, and every update
refreshes `updatedAt`. You never set them yourself — anything you send for them
is replaced. Entries you write straight into a JSON file in the dashboard keep
exactly what you wrote.

**Filter a list** by any field. `field=value` keeps the entries whose field is
exactly that value; put an operator in brackets for anything looser:

```
GET /<project>/products?category=phone                 category is exactly "phone"
GET /<project>/products?brand[contains]=sams           brand contains "sams", any case or accents
GET /<project>/products?price[gte]=100&price[lt]=800   price from 100 up to, not including, 800
GET /<project>/posts?createdAt[gte]=2026-01-01         created this year or later
```

`contains` works on text, and on a list of text it matches when any item does.
`gt`, `gte`, `lt` and `lte` compare numbers as numbers and dates in time order.
Every condition you add has to match, and filters combine with sorting and
pages. A plain `field=value` is case-sensitive; `contains` is not. If you use an
operator we don't have — say `price[gtee]` — you get a 400 that names it, rather
than every entry back.

**Sort a list** with `_sort`, and choose the way with `_direction`:

```
GET /<project>/posts?_sort=created                        newest first
GET /<project>/posts?_sort=updated&_direction=asc         least recently changed first
GET /<project>/posts?_sort=price,title&_direction=desc,asc
```

`_sort` takes any field, and `created` and `updated` sort by those two
timestamps. `_direction` is `asc` or `desc` — one per field, or one for all of
them — and when you leave it out, `created` and `updated` come back newest first
and every other field ascending. Entries without the field you sort by come
last either way.

### 1.2 Relations — pull linked records in one request

Name a field `userId` and we treat it as a link to your `users.json`. Ask for it
with `_expand` and the whole linked record comes back nested inside, so your UI
does not have to fire a second request per row.

```
GET /<project>/posts?_expand=users
```

```json
[
  {
    "id": "1",
    "title": "Hello world",
    "userId": "7",
    "user": { "id": "7", "name": "Ada", "email": "ada@example.com" }
  }
]
```

**The field name is the whole setup.** No join tables, no foreign-key
declarations, nothing to configure — name the field after the resource it points
at and we do the rest:

| Your field | We look in | It arrives under |
|---|---|---|
| `userId` | `users.json` | `user` |
| `authorId` | `authors.json` | `author` |
| `categoryId` | `categories.json` | `category` |

Ask for it either way — `_expand=users` and `_expand=user` both work.

**Expand more than one**, comma-separated:

```
GET /<project>/orders?_expand=customers,products
```

**Expand a single record too**, not just a list:

```
GET /<project>/posts/1?_expand=users
```

**Combine it with everything else.** Expansion happens last, so you can filter
and sort first and still get the linked records back:

```
GET /<project>/posts?_expand=authors&_sort=publishedAt&_direction=desc
```

If a record's `userId` points at something that no longer exists, `user` comes
back as `null` — you get the row, not an error. If the record has no `userId` at
all, nothing is added to it.

Nothing to switch on: relations work on every project.

### 1.3 Env settings

Every feature below is off until you switch it on, and you do that yourself
from the **.env editor** in your project. It reads like any `.env` file you have
written before.

**Your `.env` already lists every setting.** A new project's file has them all,
grouped by feature with a note on what each one does, and every one of them
commented out — so nothing is on until you say so. To switch a feature on,
delete the `#` in front of its lines, put in your own values, Save and Deploy.
Put the `#` back to switch it off again.

Starting and stopping your API is not in the `.env` — that is the **Start /
Stop** button, and it takes effect straight away, with no deploy.

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

### 1.4 Auth — sign-up and login for your users

Give *your* users accounts, without building an auth service. Turn it on and
these endpoints appear:

```
POST   /<project>/auth/signup            { email, password }             → a token
POST   /<project>/auth/login             { email, password }             → a token
POST   /<project>/auth/change-password   { currentPassword, password }   → a new token
```

Your app sends that token back on every request:

```
Authorization: Bearer <token>
```

With auth on, your whole API is private by default — every request needs a valid
token. You choose which resources stay readable by anyone.

**Your users' accounts live in your project's `system` folder.** You can open it
in the dashboard to see who has signed up, but you cannot edit it there — the
accounts change only through these endpoints. Passwords are hashed and never
appear in a response or in the dashboard. A `users.json` you add to your data is
an ordinary resource like any other and has nothing to do with signing in.

Every account is a standard user until you add roles — see
[1.4.4 Roles and permissions](#144-roles-and-permissions).

**Changing a password** takes the user's token *and* their current password, so
a stolen token alone cannot lock anyone out. It signs the user out everywhere
else: every token issued before the change stops working, and the response
carries a fresh one so they stay signed in where they made it.

This section is the base every login builds on. Google and GitHub sign-in are
extra doors into the same feature, and password reset is a way back in — they
all need everything here switched on first, and they hand your users the same
token.

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

Once your project has an `rbac.json`, this key is ignored: the `guest` role
decides what visitors can do (see 1.4.4).

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

#### 1.4.1 Google login

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

#### 1.4.2 GitHub login

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

#### 1.4.3 Password reset

Let your users back in when they forget their password. They ask for a code, we
email it to them, and they trade it for a new password:

```
POST   /<project>/auth/forgot-password   { email }                   → a code is emailed
POST   /<project>/auth/reset-password    { email, code, password }   → a token
```

The code is six digits, works once, and expires after 15 minutes.
`forgot-password` answers exactly the same whether or not the email has an
account, so nobody can use it to find out who has signed up. Resetting signs the
user out everywhere, like changing a password does, and the response carries a
fresh token so they are signed straight back in.

Six digits stay safe because of the limits around them: five wrong tries use a
code up, asking again replaces the code sent before, and each account gets at
most five codes an hour. The codes are never shown in the dashboard.

People who signed up with Google or GitHub can use this too, to set a password
for the first time.

##### To enable this, add to your `.env`:

```
AUTH_ENABLED=true
RESEND_API_KEY=re_your_resend_key
```

The codes go out through your own [Resend](https://resend.com) account. Without
a Resend key there is nothing to send with, so `forgot-password` answers `404`.
And `AUTH_ENABLED=true` still has to be there: password reset is part of auth,
not a separate service.

This key is shared with email notifications.

##### To send the email from your own address:

```
RESEND_FROM=Your App <no-reply@your-app.com>
```

Left out, the email comes from Resend's onboarding address — fine while you try
it, but use an address on a domain you have verified with Resend before real
users see it.

##### To put a one-click link in the email:

```
AUTH_RESET_URL=https://your-app.com/reset-password
```

The email still shows the code, and adds a link to your page with the email and
code attached after a `#`:
`https://your-app.com/reset-password#email=…&code=…`. Read the two values in
your page and send them to `reset-password` with the new password.

Leave it out and the email carries the code alone — the right choice for a
mobile app, or anything without a web page to land on.

#### 1.4.4 Roles and permissions

Decide who may do what with your API — say, customers place orders and see only
their own, while staff see every order and edit the products. You describe
roles in an `rbac.json` file in your project, and every request is checked
against the role of the user making it.

A **permission** is an action on a resource — `read`, `create`, `update` or
`delete` — and whose records it reaches: `own` (records that user created) or
`all`. A **role** is a set of permissions, and every account has one.

```json
{
  "defaultRole": "customer",
  "roles": {
    "guest":    { "products": ["read"] },
    "customer": { "products": ["read"],
                  "orders":   { "create": "own", "read": "own", "update": "own" } },
    "staff":    { "products": ["read", "create", "update"],
                  "orders":   { "read": "all", "update": "all" },
                  "_users":   ["read"] },
    "admin":    "*"
  }
}
```

With these rules, the same request gets a different answer depending on who
sends it:

```
GET  /<project>/orders      as a customer     → only their own orders
GET  /<project>/orders      as staff          → every order
GET  /<project>/orders      without a token   → 401
POST /<project>/products    as a customer     → 403
```

- **`own` holds everywhere.** A customer's list shows only their records, and
  asking for someone else's order by id gets a 404, as if it didn't exist. A
  customer's new order is always theirs, whatever the body says.
- **`"*"` is everything**, and a list like `["read", "create"]` means those
  actions on every record.
- **Anything a role doesn't mention is refused.** Add a resource and only a role
  with `"*"` can touch it until you grant it to the others.
- **`guest` is for requests without a token.** It can only use `all`, since a
  visitor has no records of their own.
- **Without an `rbac.json`, nothing changes:** every signed-in user reads
  everything and changes only their own records, as described in 1.4.

**Giving someone a role.** New accounts get `defaultRole`. You change an
account's role in the dashboard — open **system → users.json** and pick one —
which is how you make your first admin. A role with `"_users": ["read",
"update"]`, or `"*"`, can do the same from your own app:

```
GET  /<project>/auth/users              list accounts
PUT  /<project>/auth/users/<id>/role    { "role": "staff" }
```

A new role applies from that user's very next request — they don't need to sign
in again.

##### To enable this, add an `rbac.json` to your project:

In the dashboard, open **rbac.json** in your project's files, click **Create** to
start from the example above, make it yours, Save, then Deploy. Roles only apply
to an API that has auth switched on:

```
AUTH_ENABLED=true
```

If something in the file is wrong — a `defaultRole` that isn't one of the roles,
a misspelt action — Save tells you what and where, and nothing changes.

### 1.5 Atomic operations

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

Feature: [1.4 Auth](#14-auth--sign-up-and-login-for-your-users)

| Key | Example | What it does |
|---|---|---|
| `AUTH_ENABLED` | `true` | **The switch.** Adds the signup, login and change-password endpoints, keeps your users' accounts in your project's read-only `system` folder, and makes every request need a token. Every key in this whole section does nothing without it — including the Google, GitHub and password reset ones. |
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

#### 3.1.3 Password reset

Feature: [1.4.3 Password reset](#143-password-reset)

| Key | Example | What it does |
|---|---|---|
| `RESEND_API_KEY` | `re_your_resend_key` | **The switch.** Your Resend key — with it, `/<project>/auth/forgot-password` can email codes. Needs `AUTH_ENABLED=true` as well. Shared with email notifications. |
| `RESEND_FROM` | `Your App <no-reply@your-app.com>` | Who the email is from. Left out, Resend's onboarding address. Shared with email notifications. |
| `AUTH_RESET_URL` | `https://your-app.com/reset-password` | Adds a link to this page below the code, with `#email=…&code=…` attached. Must start with `http://` or `https://`. Left out, the email carries the code alone. |
