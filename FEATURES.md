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
No database to set up and no schema to write — the file *is* your data 
and your
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

That goes for the dashboard's editor too: **Save** changes your live API at
once. If your API changed the resource after you opened it, the save is
refused rather than overwriting those records — reload, and make your edit on
top of the latest. For a few seconds after saving you can **Undo**, which puts
the resource back as it was before your edit.

Removing a resource works like adding one: it stays live, marked in the Files
list, until you Deploy — and you can **Restore** it before then.

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
read `/posts` and `/comments` without one, and a token lasts an hour before your
app has to renew it. Change a value, deploy again, and the new setting applies
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
POST   /<project>/auth/signup            { email, password }               → a code to confirm the email (see 1.4.3)
POST   /<project>/auth/login             { email, password }               → a token and a refresh token
POST   /<project>/auth/refresh           { refreshToken }                  → a new token and refresh token
POST   /<project>/auth/logout            your token, or { refreshToken }   → signed out
POST   /<project>/auth/change-password   { currentPassword, password }     → a new token and refresh token
```

Your app sends that token back on every request:

```
Authorization: Bearer <token>
```

With auth on, your whole API is private by default — every request needs a valid
token. You choose which resources stay readable by anyone.

**Staying signed in.** Every sign-in hands back two things: the `token` your app
sends on each request, and a `refreshToken` your app keeps to itself. When the
token runs out — `expiresIn` says after how many seconds — send the refresh
token to `/auth/refresh` and you get a new pair, with no password needed. Each
refresh token works once, so always keep the newest one. It travels in the
request body, never in a cookie, so store it wherever your app keeps secrets.

If a refresh token that was already used turns up again, somebody has a copy of
it, and that sign-in is ended on the spot — for them and for your user. So never
let your app send two refreshes at the same time with the same token.

**Signing out** ends one sign-in straight away: send `/auth/logout` your token —
or the refresh token, if the token has already run out — and both stop working
at once. Your user stays signed in on their other devices. Each account keeps up
to ten sign-ins; signing in on an eleventh ends the one used longest ago.

**Your users' accounts live in your project's `system` folder.** You can open it
in the dashboard to see who has signed up, but you cannot edit it there — the
accounts change only through these endpoints. Passwords are hashed and never
appear in a response or in the dashboard. A `users.json` you add to your data is
an ordinary resource like any other and has nothing to do with signing in.

Every account is a standard user until you add roles — see
[1.4.5 Roles and permissions](#145-roles-and-permissions).

**Changing a password** takes the user's token *and* their current password, so
a stolen token alone cannot lock anyone out. It signs the user out everywhere
else: every token and refresh token issued before the change stops working, and
the response carries a fresh pair so they stay signed in where they made it.

This section is the base every login builds on. Google and GitHub sign-in are
extra doors into the same feature, email verification checks who is signing up,
and password reset is a way back in — they all need everything here switched on
first, and they hand your users the same tokens.

##### To enable this feature, add to your `.env`:

```
AUTH_ENABLED=true
```

That one line is enough — you get signup, login, and an API that now requires a
token. It also switches on email verification (1.4.3) and password reset
(1.4.4), which work before you set up email: their codes show in your project's
**Logs** tab until you add a Resend key. Everything below is optional.

##### To keep some resources readable by anyone:

```
AUTH_PUBLIC_ROUTES=posts,comments
```

Anyone may `GET` these two without a token; writing to them still needs one.
Comma-separated, no spaces.

Leave this key out and *nothing* is public — the right default for a private
app, the wrong one for a public blog with a signed-in comment box.

Once roles are on (`RBAC_ENABLED=true` with an `rbac.json`), this key is
ignored: the `guest` role decides what visitors can do (see 1.4.5).

##### To control how long a token lasts:

```
AUTH_JWT_TTL_SECONDS=900
```

A token stays valid for this many seconds — here, fifteen minutes. When it
expires, your user's next request is rejected, and your app either trades its
refresh token for a new pair or sends them back to log in.

| Value | A token lasts | Good for |
|---|---|---|
| *(left out)* | 24 hours | the default — an app that never refreshes still keeps its users signed in for a day |
| `3600` | 1 hour | an app that refreshes and holds data you would not want left open on a shared laptop |
| `900` | 15 minutes | an app that refreshes, when a stolen token should be worth as little as possible |

The minimum is `60`. A shorter token is safer, and once your app refreshes it
costs your users nothing: they stay signed in for as long as the next setting
allows.

##### To control how long a user stays signed in:

```
AUTH_REFRESH_TTL_SECONDS=604800
```

A sign-in lasts this many seconds without a refresh — here, a week. Every
refresh starts the clock again, so someone who opens your app at least once a
week never has to log in again, and someone who stays away longer does.

| Value | Stays signed in | Good for |
|---|---|---|
| *(left out)* | 30 days after the last refresh | most apps — the default |
| `86400` | 1 day | admin tools and anything sensitive |
| `7776000` | 90 days | a mobile app people open now and then |

The minimum is `3600`, and it is never shorter than `AUTH_JWT_TTL_SECONDS`: a
sign-in that ended first would cut its token short.

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

Without it the tokens come back as JSON — fine when you are calling the endpoint
yourself, no use when a browser is doing the redirecting. Set it and we redirect
to your app with `#token=…&refreshToken=…&expiresIn=…` on the end for you to
read.

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

Without it the tokens come back as JSON — fine when you are calling the endpoint
yourself, no use when a browser is doing the redirecting. Set it and we redirect
to your app with `#token=…&refreshToken=…&expiresIn=…` on the end for you to
read.

This key is shared with Google login: set it once and it applies to both.

#### 1.4.3 Email verification

Make sure every account belongs to someone who can read its inbox. With auth on,
signing up no longer creates the account straight away: we send a six-digit code
to the address, and the account is created when your app sends that code back.

```
POST   /<project>/auth/signup          { email, password }          → { verificationId, … } and a code is sent
POST   /<project>/auth/signup/verify   { verificationId, code }     → a token and a refresh token
POST   /<project>/auth/signup/resend   { verificationId }           → a new code replaces the last
```

Keep the `verificationId` from the sign-up response and send it back with the
code. It ties the code to *this* sign-up: if somebody else signs up with the same
address, the code sent for theirs cannot finish yours.

**Where the code goes.** With a Resend key in your `.env`, it is emailed to the
address that signed up. Without one, nothing is emailed — the code appears in
your project's **Logs** tab, on the sign-up request, where only you can see it.
The sign-up response says which (`"delivery": "email"` or `"logs"`). That lets
you build and test the whole flow before you set up email; add the key before
real users sign up, or their codes will never reach them.

Until the code comes back, logging in with that email and password answers `403`
with `"verificationRequired": true` and the `verificationId`, so your app can show
its code screen again — and call `resend` if the code has run out. A code lasts
15 minutes, five wrong tries use it up, each address gets at most five codes an
hour, and a sign-up nobody finishes is dropped after a day. Sign-ups waiting for
their code show in the **system** folder as `signups.json`, without their
passwords or codes.

People who sign in with Google or GitHub skip this step: the provider has
already confirmed their email.

##### To enable this feature, add to your `.env`:

```
AUTH_ENABLED=true
```

Email verification is on whenever auth is — there is nothing else to switch on.

##### To email the codes to your users:

```
AUTH_ENABLED=true
RESEND_API_KEY=re_your_resend_key
```

The codes go out through your own [Resend](https://resend.com) account. This key
is shared with password reset and email notifications.

##### To send the email from your own address:

```
RESEND_FROM=Your App <no-reply@your-app.com>
```

Left out, the email comes from Resend's onboarding address. Shared with password
reset and email notifications.

##### To create accounts without a code:

```
AUTH_EMAIL_VERIFICATION=false
```

`signup` answers with a token and a refresh token straight away, and the
`verify` and `resend` routes go away — right for a prototype or an internal
tool. Only `false` turns it off; leave the key out and verification stays on.

#### 1.4.4 Password reset

Let your users back in when they forget their password. They ask for a code, we
email it to them, and they trade it for a new password:

```
POST   /<project>/auth/forgot-password   { email }                   → a code is emailed
POST   /<project>/auth/reset-password    { email, code, password }   → a token and a refresh token
```

The code is six digits, works once, and expires after 15 minutes.
`forgot-password` answers exactly the same whether or not the email has an
account, so nobody can use it to find out who has signed up. Resetting signs the
user out everywhere, like changing a password does, and the response carries a
fresh pair of tokens so they are signed straight back in.

Six digits stay safe because of the limits around them: five wrong tries use a
code up, asking again replaces the code sent before, and each account gets at
most five codes an hour. The codes are never shown in the dashboard.

People who signed up with Google or GitHub can use this too, to set a password
for the first time.

##### To enable this, add to your `.env`:

```
AUTH_ENABLED=true
```

Password reset is on whenever auth is. Until you add a Resend key nothing is
emailed: the code appears in your project's **Logs** tab on the
`forgot-password` request, where only you can see it — handy while you build, but
your users cannot reset a password on their own until the key is there.

##### To email the codes to your users:

```
AUTH_ENABLED=true
RESEND_API_KEY=re_your_resend_key
```

The codes go out through your own [Resend](https://resend.com) account. This key
is shared with email verification and email notifications.

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

#### 1.4.5 Roles and permissions

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
- **With roles off, nothing changes:** every signed-in user reads everything and
  changes only their own records, as described in 1.4.

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

##### To enable this, add to your `.env`:

```
AUTH_ENABLED=true
RBAC_ENABLED=true
```

Save the `.env` and **rbac.json** appears in your project's **system** folder.
Open it, click **Create** to start from the example above, make it yours, Save,
then Deploy. `AUTH_ENABLED=true` has to be there too: roles decide what
signed-in users may do, so they need sign-in.

Switch `RBAC_ENABLED` off and your roles stop applying — every signed-in user is
back to reading everything and changing only their own records — but
`rbac.json` stays in your project, ready for when you switch it back on.

If something in the file is wrong — a `defaultRole` that isn't one of the roles,
a misspelt action — Save tells you what and where, and nothing changes.

#### 1.4.6 Who may sign up

Anyone with a working email address can open an account on your API. If that
isn't what you want, you can say which addresses are accepted.

These rules apply to `POST /auth/signup` and to Google and GitHub login alike,
and **only where an account would be created**. Someone who already has one
keeps signing in whatever their address — a rule you add later never locks out
a user you have already accepted.

##### To accept only your own domain, add to your `.env`:

```env
AUTH_ENABLED=true
AUTH_EMAIL_DOMAINS_ONLY=your-company.com
```

Every other address is refused with a `403`. Useful for an internal tool or a
staging project. List several, comma-separated and no spaces, and a domain
covers its subdomains, so `your-company.com` also accepts
`ada@mail.your-company.com`.

##### To refuse particular domains:

```env
AUTH_ENABLED=true
AUTH_EMAIL_DOMAINS_BLOCKED=rival.com,spam-source.test
```

Everyone else is still welcome. Subdomains go with the domain, so `rival.com`
also refuses `mail.rival.com`.

##### To refuse throwaway addresses:

```env
AUTH_ENABLED=true
AUTH_BLOCK_DISPOSABLE_EMAIL=true
```

Refuses mailinator, guerrillamail, 10minutemail and around 75,000 other
throwaway providers. Off unless you switch it on — a demo API or a workshop
project is a perfectly good reason to let people use one.

##### To let a domain through whatever else says:

```env
AUTH_EMAIL_DOMAINS_ALLOWED=partner.com
```

An exception, not a gate: it beats both `AUTH_EMAIL_DOMAINS_BLOCKED` and
`AUTH_BLOCK_DISPOSABLE_EMAIL`, and it accepts nobody on its own. Use it when
the throwaway list catches a provider your users really use — the list is a
community one and occasionally sweeps in a real address.

| Set | And a sign-up from | Is |
|---|---|---|
| nothing | anywhere | accepted |
| `AUTH_EMAIL_DOMAINS_ONLY=acme.com` | `ada@acme.com` | accepted |
| `AUTH_EMAIL_DOMAINS_ONLY=acme.com` | `ada@gmail.com` | refused |
| `AUTH_BLOCK_DISPOSABLE_EMAIL=true` | `ada@mailinator.com` | refused |
| `AUTH_BLOCK_DISPOSABLE_EMAIL=true` + `AUTH_EMAIL_DOMAINS_ALLOWED=mailinator.com` | `ada@mailinator.com` | accepted |

See [3.1.6](#316-who-may-sign-up) for the full table of keys.

### 1.5 Atomic operations

_To be written — placeholder._

---

## 2. App-level features — the Stubbase platform

### 2.1 Email verification when you sign up

When you create a Stubbase account with an email address and a password, we
email you a 6-digit code first. Enter it on the sign-up page and your account is
created and you are signed straight in. Until then there is no account to log in
to — and nobody else can create one on your address, because they would need the
code from your inbox.

- The code lasts 15 minutes and works once. Didn't get it? **Send a new code**
  replaces the old one.
- Five wrong tries and that code stops working; send a new one.
- An address gets at most five codes an hour.
- Type the code on the page where you signed up. It only finishes *that*
  sign-up, so a code email you did not ask for is safe to ignore.
- Signing up with **Google** or **GitHub** needs no code: they have already
  verified your address.
- Throwaway addresses are not accepted. Sign-ups from disposable mail providers
  (mailinator, guerrillamail, 10minutemail and tens of thousands of others) are
  refused, through Google and GitHub as well as by password. Use a permanent
  address you can still read when you need a password reset. If a real provider
  of yours is refused by mistake, get in touch — it can be unblocked the same
  day. Already have an account? You keep signing in, whatever your address.

### 2.2 Password reset

Forgot your password? Choose **Forgot password?** on the login page, enter your
email, and we send you a 6-digit code. Enter it with a new password and you are
signed straight back in. The email also has a link that opens the reset page
with the code already filled in.

- The code lasts 15 minutes and works once. Asking again sends a new code, and
  the old one stops working.
- Five wrong tries and the code stops working; ask for a new one.
- An address gets at most five reset emails an hour.
- Resetting signs your account out everywhere else, so anyone who knew your old
  password loses access at once.
- Signed up with Google or GitHub? This is also how you add a password to your
  account.
- The page answers the same whether or not an address has an account.

### 2.3 Change your password

Signed in and want a new password? Open the account menu (your initial, top
right), choose **Settings**, and use the **Password** card. Enter your current
password and the new one, and you stay signed in on this device while every
other device is signed out.

- Your current password is always asked for, so someone at your unlocked
  computer cannot lock you out.
- Forgotten it? **Use an email code instead** sends you a 6-digit code, the
  same as on the login page.
- Signed up with Google or GitHub? You have no password yet, so the Password
  card offers **Set a password** and uses the emailed code.
- A reset code you asked for earlier stops working once you change your password.

### 2.4 Your account at a glance

The first card in **Settings** shows what your account is: the email address
you sign in with, your plan, when you joined, how many of your monthly requests
you have used and when that count starts again, how many projects you have, your
rate limit, any request packs and your AI credits. It is also where you switch the dashboard between
light and dark — the choice carries over to the Stubbase website.

- Requests are counted across all your projects together — projects you have
  since deleted included — because the allowance is one pool for the account.
- The count starts again on the first of each month (UTC).
- The figure catches up with new traffic about once a minute.
- Your rate limit is how many requests per second all your projects share, plus
  a burst of more at once. A request over it gets `429 Too Many Requests` with a
  `Retry-After` header saying how many seconds to wait, and it does not count
  toward your monthly requests.
- Request packs are extra requests for Pro, bought once. Your plan's monthly
  requests are used first; after that, your API keeps going on the pack, and
  whatever is left carries into next month until the pack expires, 12 months
  after you got it. You can hold more than one, and the one expiring soonest is
  used first. Your rate limit stays your plan's. On Free a pack is not used — a
  pack you bought on Pro waits until you are back on Pro. They are not on sale
  yet.
- AI credits are listed in the order they will be used, each with what is left
  and when it expires — see [2.7](#27-ai-credits-for-the-co-pilot).

### 2.5 Delete your account

The **Delete account** card at the bottom of **Settings** removes your Stubbase
account and signs you out on every device. It cannot be undone.

- Delete your projects first. The page lists them, each with its own Delete
  button, and a running project has to be stopped before it can be deleted —
  the same as anywhere else in the dashboard.
- You are asked for your password, so someone at your unlocked computer cannot
  delete your account. Signed up with Google or GitHub? Set a password first in the
  **Password** card above it.
- Your name, email address and password are removed. The address is free again
  straight away, and signing up with it starts a clean account: no projects, no
  name, and back on the Free plan whatever you were on before.
- One thing carries over. If you sign up again with the same address in the same
  calendar month, the requests you had already used that month still count
  against your allowance — deleting and re-registering is not a way to reset it.
  The allowance resets on the 1st, as it does for everyone.

### 2.6 Duplicate a project

Want a copy of a project to experiment on, or a staging copy of one that is
live? Open the project menu (the project name, top left) and choose the copy
icon beside the project. Name the copy, choose whether its `.env` comes too, and
choose **Duplicate** — the new project opens straight away.

- Your resources are copied as they are in the editor, including changes you
  have saved but not deployed yet.
- The copy starts stopped, like any new project. Nothing in it is public until
  you choose **Deploy**.
- Tick **Copy the .env too** to bring its settings across — keys, webhook URLs
  and your roles and permissions included. The Google and GitHub callback URLs
  it tells you to register now name the copy, so add those to your OAuth apps
  before anyone signs in to it. Left unticked, the copy starts from a fresh
  `.env` with everything switched off.
- The accounts that signed up to your API, their sessions, and your developer
  API keys are never copied: the copy starts with no users, and an MCP client
  needs a new key for it.

### 2.7 AI credits for the Co-Pilot

The AI Co-Pilot is on every plan. Each reply uses credits for the work it did:
one credit per 1,000 tokens the model read and wrote, counted across every step
of the reply and rounded up. A reply that designs a small table costs a few
credits; one that seeds hundreds of rows costs more. After each reply the
dashboard tells you what it used and what is left, and the number under the
chat box always shows your balance.

- **Every new account gets 100 gift credits**, valid for 3 months from sign-up.
  You get them once — deleting your account and signing up again does not give
  you more.
- **Pro adds 1,000 credits every month.** They are there from the 1st and do
  not carry over into the next month.
- **Credit packs** add 5,000, 20,000 or 60,000 credits on any plan and last 12
  months. They are not on sale yet.

Credits are used in the order they expire, so this month's Pro credits and your
gift go before a pack you paid for. A reply that fails still uses the credits
for the work the model did before it failed. When you have none left, the chat
box says so and stays disabled until you get more; your API itself is not
affected. The Co-Pilot answers one message at a time for your account.

### 2.8 What the Co-Pilot can do for your project

Ask the Co-Pilot in plain words and it works on the project you have open. It
knows every feature Stubbase has and the settings that switch them on, and it
tells you plainly when you ask for something Stubbase does not do.

- **Design tables.** Describe your data and it drafts the tables with realistic
  sample records.
- **Know your tables' shape.** It sees every table's fields, how many records
  carry each one and what types they hold — never the records themselves — so
  it extends a table consistently with what is already there.
- **Mark fields required.** Tell it a field is required, or no longer is, and
  it records that. Required fields are not enforced yet: a request that leaves
  one out still succeeds.
- **Start from a starter.** In an empty project, if one of the starter APIs
  fits what you describe — a blog, a storefront, a helpdesk and more — it
  offers that first.
- **Change settings.** Ask for sign-in, public tables, roles, QA headers or
  validation and it proposes the `.env` lines. It never fills in secrets or
  URLs — your Google, GitHub, Resend and Twilio keys, webhook addresses — and
  tells you which line to fill in yourself.
- **Add, change and delete records.** Ask it to add a book, mark every pending
  order shipped, or delete last year's test data, and it does — your request
  is the go-ahead. It never reads your records to do it: it picks them by a
  filter such as `price[gt]=20`, and all it sees back is how many changed. A
  change to more than 20 records waits for you to confirm in the chat first.
  Every change has an **Undo** on its card, which puts back what it changed
  and leaves alone anything written since.
- **Count records**, but not read them. For a question about what your records
  contain — "which book costs most?" — it gives you the query to run in the
  Live tab instead.
- **Debug.** It reads your recent requests (their paths and statuses, never
  their bodies), your settings and any file that does not parse. It sees which
  secrets are set, never their values.
- **Deploy, start and stop** your API, and **propose deleting or emptying**
  tables.

Anything that changes your settings, fills your project from a starter, or
removes or empties a whole table is a proposal: a card in the chat with a
button to confirm it. Nothing happens until you click. A confirmed settings
change, starter or table removal then waits for Deploy, like your own; emptying
a table happens at once. Changes to records happen when you ask for them.

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

Settings follow the same rule as adding or removing a resource: they are saved
as a draft and go live when you hit **Deploy**.

One table per feature, and it grows as features are added. For the exhaustive
reference — defaults, exact formats, and how each key is wired in dev, Docker
and production — see [ENVIRONMENT.md](ENVIRONMENT.md).

### 3.1 Auth

Feature: [1.4 Auth](#14-auth--sign-up-and-login-for-your-users)

| Key | Example | What it does |
|---|---|---|
| `AUTH_ENABLED` | `true` | **The switch.** Adds the signup, login, refresh, logout and change-password endpoints — with email verification and password reset on too — keeps your users' accounts and sessions in your project's read-only `system` folder, and makes every request need a token. Every key in this whole section does nothing without it — including the Google, GitHub, verification, password reset and roles ones. |
| `AUTH_PUBLIC_ROUTES` | `posts,comments` | Resources anyone may `GET` without a token. Writes to them still need one. Comma-separated, no spaces. Left out, nothing is public. |
| `AUTH_JWT_TTL_SECONDS` | `3600` | How long a token stays valid, in seconds. Defaults to `86400` (24 hours); the minimum is `60`. |
| `AUTH_REFRESH_TTL_SECONDS` | `604800` | How long a user stays signed in without using their refresh token, in seconds. Every refresh starts the clock again. Defaults to `2592000` (30 days); the minimum is `3600`, and it is never shorter than `AUTH_JWT_TTL_SECONDS`. |

#### 3.1.1 Google login

| Key | Example | What it does |
|---|---|---|
| `AUTH_GOOGLE_CLIENT_ID` | `1234-abc.apps.googleusercontent.com` | **The switch, first half.** Set this *and* the secret and `/<project>/auth/google` goes live. Needs `AUTH_ENABLED=true` as well. |
| `AUTH_GOOGLE_SECRET` | `GOCSPX-your-secret` | The other half. With only one of the pair set, the route stays off. |
| `AUTH_OAUTH_REDIRECT` | `https://your-app.com/login` | Send the user here with `#token=…&refreshToken=…&expiresIn=…` attached instead of returning them as JSON. Shared with the other provider — set it once, it applies to both. |

Register `<origin>/<project>/auth/google/callback` in the Google console.

#### 3.1.2 GitHub login

| Key | Example | What it does |
|---|---|---|
| `AUTH_GITHUB_CLIENT_ID` | `Iv1.a1b2c3d4e5f6` | **The switch, first half.** Set this *and* the secret and `/<project>/auth/github` goes live. Needs `AUTH_ENABLED=true` as well. |
| `AUTH_GITHUB_SECRET` | `your-github-secret` | The other half. With only one of the pair set, the route stays off. |
| `AUTH_OAUTH_REDIRECT` | `https://your-app.com/login` | Send the user here with `#token=…&refreshToken=…&expiresIn=…` attached instead of returning them as JSON. Shared with the other provider — set it once, it applies to both. |

Register `<origin>/<project>/auth/github/callback` in your GitHub OAuth app.

#### 3.1.3 Email verification

Feature: [1.4.3 Email verification](#143-email-verification)

| Key | Example | What it does |
|---|---|---|
| `AUTH_ENABLED` | `true` | **The switch.** Email verification is on whenever auth is. Shared with every auth feature. |
| `AUTH_EMAIL_VERIFICATION` | `false` | Set to `false` and signup creates the account at once, with no code, and `/<project>/auth/signup/verify` and `/signup/resend` go away. Left out, or any other value, verification stays on. |
| `RESEND_API_KEY` | `re_your_resend_key` | Emails the codes. Left out, each code appears in your project's **Logs** tab instead and nothing is emailed. Shared with password reset and email notifications. |
| `RESEND_FROM` | `Your App <no-reply@your-app.com>` | Who the email is from. Left out, Resend's onboarding address. Shared with password reset and email notifications. |

#### 3.1.4 Password reset

Feature: [1.4.4 Password reset](#144-password-reset)

| Key | Example | What it does |
|---|---|---|
| `AUTH_ENABLED` | `true` | **The switch.** Password reset is on whenever auth is. Shared with every auth feature. |
| `RESEND_API_KEY` | `re_your_resend_key` | Emails the codes. Left out, each code appears in your project's **Logs** tab instead and nothing is emailed. Shared with email verification and email notifications. |
| `RESEND_FROM` | `Your App <no-reply@your-app.com>` | Who the email is from. Left out, Resend's onboarding address. Shared with email verification and email notifications. |
| `AUTH_RESET_URL` | `https://your-app.com/reset-password` | Adds a link to this page below the code, with `#email=…&code=…` attached. Must start with `http://` or `https://`. Left out, the email carries the code alone. |

#### 3.1.5 Roles and permissions

Feature: [1.4.5 Roles and permissions](#145-roles-and-permissions)

| Key | Example | What it does |
|---|---|---|
| `RBAC_ENABLED` | `true` | **The switch.** Checks every request against the roles in your project's `rbac.json`, and lets you create that file in the **system** folder. Needs `AUTH_ENABLED=true` as well. Switched off, your roles are kept but not applied. |

#### 3.1.6 Who may sign up

Feature: [1.4.6 Who may sign up](#146-who-may-sign-up)

| Key | Example | What it does |
|---|---|---|
| `AUTH_EMAIL_DOMAINS_ONLY` | `your-company.com` | **A gate.** Only these domains may open an account; every other address is refused with a `403`. Comma-separated, no spaces; a domain covers its subdomains. Needs `AUTH_ENABLED=true`. |
| `AUTH_EMAIL_DOMAINS_BLOCKED` | `rival.com` | Domains always refused, subdomains included. Everyone else is still accepted. |
| `AUTH_BLOCK_DISPOSABLE_EMAIL` | `true` | Refuses around 75,000 throwaway providers. Off unless set. |
| `AUTH_EMAIL_DOMAINS_ALLOWED` | `partner.com` | **An exception**, not a gate: beats the two rows above and accepts nobody on its own. |
