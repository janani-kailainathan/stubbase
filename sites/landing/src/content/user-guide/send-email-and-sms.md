---
title: 'Send Email and SMS from Your Stubbase API with Resend and Twilio — User Guide'
description: 'Add a Resend key or Twilio credentials to your Stubbase .env and your signed-in users can send email through POST /_notify/email and text messages through POST /_notify/sms.'
h1: 'Send email and SMS'
subheadline: 'Plug in your own Resend or Twilio account, and your app can send email and text messages through your API without a server of its own.'
label: 'Send email and SMS'
chapter: 'settings'
order: 2
publishedAt: 2026-10-11
---

## Email through Resend

Add your [Resend](https://resend.com) key to the project's `.env`, with sign-in
on:

```bash
AUTH_ENABLED=true
RESEND_API_KEY=re_your_resend_key
RESEND_FROM=Your App <no-reply@your-app.com>
```

Save and deploy. Your app can now send email:

```bash
curl -X POST https://api.stubbase.dev/<project-id>/_notify/email \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{ "to": "ada@example.com", "subject": "Your order shipped", "text": "It is on its way." }'
```

`to` and `subject` are required. Send the message as `text`, `html`, or both.
`RESEND_FROM` is optional; left out, mail comes from Resend's onboarding
address, which is fine for trying it but not for real users.

The same key also emails your users their sign-up and password reset codes.

## SMS through Twilio

All three Twilio values together turn SMS on:

```bash
AUTH_ENABLED=true
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_FROM=+15551234567
```

```bash
curl -X POST https://api.stubbase.dev/<project-id>/_notify/sms \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{ "to": "+15557654321", "body": "Your code is ready." }'
```

`to` and `body` are required.

## Why sign-in is required

Both routes need `AUTH_ENABLED=true` and a signed-in user's token. Without that,
anyone who found your project id could send mail and texts on your account.
Requests without a valid token get `401`, and a project without the keys
answers `404` for that route.

## Who pays

Messages go out through your own Resend and Twilio accounts, on their pricing.
Each call also counts as one request toward your Stubbase plan.
