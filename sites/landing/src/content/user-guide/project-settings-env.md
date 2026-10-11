---
title: 'Project Settings: How the .env File Works in Stubbase — User Guide'
description: 'Every Stubbase project setting lives in its .env file, listed and commented out from the start. How to switch a feature on, save, deploy, and turn it off again without losing your values.'
h1: 'How project settings work'
subheadline: 'Everything your API does beyond plain CRUD is a line in the project''s .env. A new project lists every setting, all switched off.'
label: 'How settings work'
chapter: 'settings'
order: 1
publishedAt: 2026-10-11
hero:
  src: /user-guide/project-settings-env/hero.png
  alt: 'The .env editor open on a new project, sections numbered down the left with every line commented out'
  caption: 'Every setting is already in the file. Remove the # to switch one on.'
---

## Open the .env

Click **.env** in the Files rail. A new project's file lists every setting
Stubbase has, grouped by feature and numbered, with a comment on what each line
does, and all of it commented out. A new project is plain CRUD, open to anyone,
with nothing else switched on.

The sections, in order:

| Section | Covers |
|---|---|
| 1. Auth | Sign-up and login, email verification, password reset, roles, Google and GitHub, who may sign up |
| 2. Email and SMS | Resend and Twilio |
| 3. QA | Slow, failing and empty responses on request |
| 4. Validation | A JSON Schema per table |
| 5. Webhooks | Calls to your server before and after writes |
| 6. Read-only | Refuse every write |

## Switch a setting on

**1. Click Edit.**

**2. Remove the `# ` in front of the line** and put in your own value:

```bash
# AUTH_ENABLED=true      ← off
AUTH_ENABLED=true        ← on
```

**3. Click Save.** The toast confirms how many settings the file now holds.

**4. Click Deploy**, or **Redeploy** if the project is live. Settings are kept
as a draft until you do, so your live API keeps its old settings while you edit.

## Switch it off again

Put the `#` back, Save and Deploy. Your value stays in the file, ready for next
time, so pausing a feature never means losing its configuration.

Most features have a switch and some settings that do nothing until the switch
is on. `AUTH_ENABLED=true` is a switch; `AUTH_PUBLIC_ROUTES=posts` configures
it. A few have no separate switch, because the line is the switch: a
`SCHEMA_<TABLE>` line or a `HOOK_…` URL is on as soon as it is deployed.

## Typos are pointed out

A line that isn't `KEY=value` is refused when you save, with the line number.
A key Stubbase doesn't know is saved, but the toast names it:

> Saved, but Stubbase doesn't act on: AUTH_ENABLE

That is usually a misspelling, worth fixing before you deploy.

## What isn't in the .env

**Starting and stopping your API** is not a setting. **Deploy** starts it and
**Stop** takes it offline, straight away. The roles for your users live in
`rbac.json`, which is edited and deployed the same way as the `.env`.

## Keep secrets in the .env, not your tables

API keys for Google, GitHub, Resend and Twilio go in the `.env`, which is never
served by your API. The AI Co-Pilot can see which keys are set but never their
values.
