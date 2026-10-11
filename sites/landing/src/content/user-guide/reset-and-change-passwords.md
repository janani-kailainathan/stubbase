---
title: 'Password Reset and Change Password for Your Stubbase API Users — User Guide'
description: 'Let your users reset a forgotten password with an emailed 6-digit code, and change a password while signed in. Codes, limits, the Logs-tab fallback, and the AUTH_RESET_URL link.'
h1: 'Reset and change passwords'
subheadline: 'Your users get a way back in when they forget a password, and a way to change it while signed in. Both are on whenever auth is.'
label: 'Reset and change passwords'
chapter: 'auth'
order: 3
publishedAt: 2026-10-11
---

## Reset a forgotten password

Two requests:

```bash
POST /<project-id>/auth/forgot-password   # { email }                    → 202, a code is sent
POST /<project-id>/auth/reset-password    # { email, code, password }    → the token and refresh token
```

**1. Ask for a code.** `forgot-password` answers the same `202` whether or not
the address has an account, so nobody can use it to find out who has signed up.

**2. Send the code with the new password.** The user is signed straight back
in, and **signed out everywhere else**: every token issued before the reset
stops working.

Users who signed in with Google or GitHub can use this too, to set a password
for the first time.

## Where the code goes

Like sign-up codes: emailed through your Resend account when `RESEND_API_KEY`
is in your `.env`, otherwise shown in your **Logs** tab on the
`forgot-password` request. Without the key your users can't reset a password on
their own, so add it before they need to.

## Put a link in the email

```bash
AUTH_RESET_URL=https://your-app.com/reset-password
```

The email still shows the code, and adds a link to your page with the email and
code after a `#`:

```
https://your-app.com/reset-password#email=…&code=…
```

Read the two values in your page and send them to `reset-password` with the new
password. Leave the line out for a mobile app, or anything without a page to
land on.

## The limits

- A code is 6 digits, lasts **15 minutes** and works once.
- **Five wrong guesses** use it up, and asking again replaces the code sent
  before.
- Each account gets at most **five codes an hour**.
- Every way a code can be wrong gets the same error.

## Change a password while signed in

```bash
POST /<project-id>/auth/change-password   # { currentPassword, password }, with the token
```

The current password is required as well as the token, so a stolen token alone
can't lock anyone out. The user stays signed in where they made the change, with
the fresh token pair in the response, and is signed out everywhere else.

New passwords need at least 8 characters.
