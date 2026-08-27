---
title: 'The Zero-Config Headless Backend for MVPs — Stubbase'
description: 'Ship your MVP faster. A complete backend-in-a-box offering relational data, secure webhook proxying, and JWT auth without managing servers.'
h1: 'A whole backend, without the infrastructure phase'
subheadline: 'Relational data, JWT auth, record ownership and secure webhook proxying — without a database, a server, or a devops afternoon.'
promise: 'The parts of a backend you would otherwise rebuild for the fourth time, already built.'
order: 20
cta:
  label: 'Generate an API free'
  href: ''
proof:
  caption: 'A real session token, signed per project'
  method: 'POST'
  path: '/<tenant>/auth/login'
  headers:
    - 'content-type: application/json'
  response: |
    {
      "token": "eyJhbGciOiJIUzI1NiIs...",
      "user": {
        "id": "u_38fa",
        "email": "ada@example.com",
        "role": "user"
      }
    }
spec:
  - label: 'Auth'
    value: 'Turn on `AUTH_ENABLED` and the project mounts signup, login and session endpoints. Signing keys are derived per project from the server secret and never stored on disk.'
  - label: 'Ownership'
    value: 'Authenticated writes stamp `userId` on the record. Non-admins can only mutate what they own, and cannot promote themselves by editing their own `role`.'
  - label: 'Webhooks'
    value: 'Fire a server-side call before or after any mutation. Tenant-supplied URLs are DNS-resolved and refused if they point at private or reserved addresses.'
  - label: 'Notifications'
    value: 'Add your Resend or Twilio credentials in the dashboard and the project mounts a proxy that injects them server-side — so your frontend can send email without shipping a secret.'
  - label: 'Cost'
    value: 'Projects sleep when idle and wake on the next request. Nothing runs, and nothing bills, while nobody is using your MVP.'
sections:
  - kind: statement
    body: |
      The first week of a project goes to work that has nothing to do with the idea —
      connection pools, migrations, a dormant staging environment nobody visits.

  - kind: split
    title: 'Turnkey authentication'
    body: |
      Enable auth on the project and the standard endpoints appear. Tokens are signed with
      a key derived from the server secret and your project id, so no signing key is ever
      written to disk.

      Add a Google or GitHub client id to the project configuration and the matching OAuth
      endpoints mount alongside them.
    code:
      lang: http
      caption: 'mounted automatically'
      content: |
        POST /<tenant>/auth/signup   { email, password } → { token, user }
        POST /<tenant>/auth/login    { email, password } → { token, user }
        GET  /<tenant>/auth/me       Authorization: Bearer <token>

  - kind: split
    title: 'Records that know who owns them'
    body: |
      This is the layer most MVPs write by hand in week two, and get subtly wrong. Once auth
      is on, a POST from a signed-in user stamps that user's id onto the record — and from
      then on the rules apply themselves.
    bullets:
      - 'A user may read the collection, but only mutate rows they own.'
      - 'A user may edit their own profile, but not their own `role`.'
      - 'A user cannot reassign a record to somebody else by editing `userId`.'
      - 'An admin bypasses all of it.'
    code:
      lang: bash
      caption: 'the owner is stamped for you'
      content: |
        POST /<tenant>/orders
        Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

        201 Created
        {
          "id": "o_7c21",
          "item": "Lifetime license",
          "userId": "u_38fa"
        }

  - kind: split
    title: 'Secure webhook proxying'
    body: |
      Execute server-side logic from your frontend without exposing credentials. Add your
      third-party API keys — Resend, Twilio — in the dashboard, and Stubbase mounts proxy
      endpoints that inject your bearer tokens on the server side.

      Outbound webhook URLs are resolved before the request is made and refused if they land
      on a private or reserved address, so a mistyped hook cannot be turned into a probe of
      your own network.
    code:
      lang: bash
      caption: 'the credential never reaches the browser'
      content: |
        POST /<tenant>/_notify/email
        content-type: application/json

        { "to": "ada@example.com", "subject": "Welcome" }

  - kind: split
    title: 'And when nobody is using it'
    body: |
      A project that nobody has touched for a few minutes is evicted from memory, and
      lazy-loads again on the next request. There is no instance to keep warm and no
      per-project container humming in the background.

      That is what makes the free tier possible — and why a side project that gets no traffic
      for a month costs exactly what one that never launched costs.
---
