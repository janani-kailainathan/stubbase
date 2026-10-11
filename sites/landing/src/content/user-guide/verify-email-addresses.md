---
title: 'Verify Email Addresses at Sign-Up in Stubbase — User Guide'
description: 'Stubbase sign-up sends a 6-digit code and creates the account only when the code comes back. How verificationId works, where codes go before you add a Resend key, the limits, and how to turn verification off.'
h1: 'Verify email addresses at sign-up'
subheadline: 'With auth on, signing up sends a 6-digit code. The account is created only when your app sends that code back.'
label: 'Verify email addresses'
chapter: 'auth'
order: 2
publishedAt: 2026-10-11
hero:
  src: /user-guide/verify-email-addresses/hero.png
  alt: 'The Logs tab showing a sign-up request with a note: the 6-digit verification code, shown because the project has no Resend key'
  caption: 'Without a Resend key, the code is a note on the sign-up request in your Logs tab.'
---

## How the flow works

Email verification is on whenever `AUTH_ENABLED=true`, with nothing else to
switch on. Signing up takes two requests:

```bash
POST /<project-id>/auth/signup          # { email, password }       → 202 { verificationId, … }
POST /<project-id>/auth/signup/verify   # { verificationId, code }  → the token and refresh token
```

**1. Sign up.** The answer is `202` with a `verificationId`, and a code is sent.
No account exists yet.

**2. Ask your user for the code** and send it back to `/auth/signup/verify` with
the `verificationId`. The account is created and signed in.

Keep the `verificationId` in your app between the two steps. It ties the code to
this sign-up, so a code sent for somebody else's sign-up with the same address
can't finish this one.

## Where the code goes

| Your `.env` has | The code is |
|---|---|
| `RESEND_API_KEY` | Emailed to the address that signed up, through your own Resend account. |
| No Resend key | Not emailed. It appears in your **Logs** tab on the sign-up request, where only you can see it. |

The sign-up response says which, as `"delivery": "email"` or `"logs"`. Without a
key you can build and test the whole flow, but add the key before real users
sign up, or their codes never reach them:

```bash
RESEND_API_KEY=re_your_resend_key
RESEND_FROM=Your App <no-reply@your-app.com>
```

`RESEND_FROM` is optional. Left out, mail comes from Resend's onboarding
address.

## Resend a code

```bash
POST /<project-id>/auth/signup/resend   # { verificationId }
```

A new code replaces the old one.

## If they try to log in first

Logging in with the email and password of a sign-up that hasn't been verified
answers `403` with `"verificationRequired": true` and the `verificationId`, so
your app can show its code screen again.

## The limits

- A code lasts **15 minutes**.
- **Five wrong guesses** use a code up.
- An address gets at most **five codes an hour**, sign-ups and resends together.
- A sign-up nobody finishes is dropped after **a day**.

Sign-ups waiting for their code are listed under **system** in
`signups.json`, without their passwords or codes.

## Google and GitHub sign-ins skip it

The provider has already checked the address, so there is no code.

## Turn verification off

For a prototype or an internal tool:

```bash
AUTH_EMAIL_VERIFICATION=false
```

Sign-up then answers with a token straight away, and the verify and resend
routes go away. Only `false` turns it off.
