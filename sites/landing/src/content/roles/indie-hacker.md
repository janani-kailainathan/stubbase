---
title: 'Stubbase for Indie Hackers — Ship the MVP This Weekend'
description: 'A backend-in-a-box for solo founders: relational data, JWT auth, record ownership and secure webhook proxying, with no server to run and nothing billing while you sleep.'
h1: 'Ship it this weekend, not after the infrastructure'
subheadline: 'Data, auth, ownership and outbound calls behind one API — so the first weekend goes to your idea instead of to Postgres, connection pools and a staging environment nobody visits.'
promise: 'Projects sleep when idle and wake on the next request. Nothing runs while nobody is using it.'
order: 40
cta:
  label: 'Generate an API free'
  href: ''
proof:
  caption: 'Created while signed in — the owner is stamped for you'
  method: 'POST'
  path: '/<tenant>/orders'
  headers:
    - 'Authorization: Bearer eyJhbGciOiJIUzI1NiIs...'
    - 'content-type: application/json'
  response: |
    {
      "id": "o_7c21",
      "item": "Lifetime license",
      "amount": 4900,
      "userId": "u_38fa"
    }
spec:
  - label: 'Weekend one'
    value: 'Paste a JSON file or describe the schema in plain English. You have working CRUD endpoints before you have chosen a component library.'
  - label: 'Accounts'
    value: 'Signup, login and session endpoints mount when you enable auth. Signing keys derive from the server secret per project and are never written to disk.'
  - label: 'Multi-user'
    value: 'Writes stamp the owner automatically. Users can only mutate their own rows, cannot change their own role, and cannot reassign a record to someone else.'
  - label: 'Secrets'
    value: 'Your Resend and Twilio credentials live server-side. The project mounts a proxy that injects them, so your frontend can send email without shipping a key to the browser.'
  - label: 'Bills'
    value: 'Idle projects are evicted from memory and cost nothing to keep. There is no dormant staging environment quietly charging you every month.'
sections:
  - kind: statement
    body: |
      You have the idea on Friday. By Sunday night you have a Postgres instance, a migration
      tool, an ORM and an auth library you half-understand — and no product.

  - kind: steps
    title: 'What you actually needed'
    steps:
      - title: 'Somewhere to put data'
        body: 'That survives a refresh and has relationships, without a schema language or a migration step.'
      - title: 'Accounts'
        body: 'So two people who open your app see different things.'
      - title: 'Ownership'
        body: 'So one of them cannot read or edit the other one`s rows.'
      - title: 'A way to call out'
        body: 'Send the email, charge the card — without putting the key in the browser.'

  - kind: split
    title: 'Accounts, in one setting'
    body: |
      Turn auth on and the endpoints appear. Add a Google or GitHub client id to the project
      configuration and the OAuth endpoints mount beside them.

      Signing keys derive from the server secret and your project id, so there is no key
      material sitting on disk waiting to leak.
    code:
      lang: http
      caption: 'no library to install'
      content: |
        POST /<tenant>/auth/signup   { email, password } → { token, user }
        POST /<tenant>/auth/login    { email, password } → { token, user }
        GET  /<tenant>/auth/me       Authorization: Bearer <token>

  - kind: split
    title: 'Ownership you did not have to write'
    body: |
      This is the part that quietly takes a week and is quietly got wrong.

      Once auth is on, an authenticated POST stamps the creator's id onto the record, and the
      rules enforce themselves from there.
    bullets:
      - 'A user may only mutate rows they own.'
      - 'A user may edit their own profile, but not their own `role`.'
      - 'A user cannot hand a record to somebody else by rewriting `userId`.'
      - 'Admins bypass all of it.'
    code:
      lang: bash
      caption: 'the rule applies itself'
      content: |
        # signed in as u_38fa
        PUT /<tenant>/orders/o_7c21     → 200 OK

        # somebody else's row
        PUT /<tenant>/orders/o_9f04     → 403 Forbidden

  - kind: split
    title: 'And when you are asleep'
    body: |
      A project that nobody is using is evicted from memory after a few minutes idle, and
      lazy-loads again on the next request. There is no instance to keep warm and no
      per-project container humming.

      That is what makes the free tier possible — and it is why a side project that gets no
      traffic for a month costs the same as one that never launched.
---
