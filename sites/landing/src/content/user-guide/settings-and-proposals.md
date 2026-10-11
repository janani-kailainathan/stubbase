---
title: 'How the Stubbase AI Co-Pilot Changes Settings: Applied vs Proposed — User Guide'
description: 'The Stubbase Co-Pilot applies a settings change itself only when it makes your API stricter. Anything that could open access is a proposal card you confirm. It never fills in keys, secrets or URLs.'
h1: 'Settings: applied or proposed'
subheadline: 'The Co-Pilot changes a setting on its own only when that makes your API stricter. Anything that could open it up waits for your click.'
label: 'Applied or proposed'
chapter: 'copilot'
order: 3
publishedAt: 2026-10-11
hero:
  src: /user-guide/settings-and-proposals/hero.png
  alt: 'A Co-Pilot proposal card titled Change 1 setting? with AUTH_ENABLED=false, and Yes, change it and Cancel buttons'
  caption: 'Turning sign-in off could open your API up, so it waits for your click.'
---

## Why there are two kinds

The Co-Pilot reads text that strangers wrote: request paths in your log, field
names in your data. A setting it could freely change would be one crafted
request away from switching your sign-in off. So it may only make your API
**stricter** by itself. Anything that could make it more open needs you.

## Applied at once

When every setting you asked for narrows access, the Co-Pilot saves them
straight away, as a draft, and the card says **Setting changed**. For example:

- Turning sign-in, email verification or blocking throwaway addresses **on**
- Turning QA mode **off**
- A **shorter** token or sign-in lifetime
- **Fewer** public tables, or a **shorter** list of allowed domains
- **More** blocked domains
- A table's **first** validation schema

## Proposed for your click

Everything else is a card with a confirm button and **Cancel**, and nothing
changes until you click:

- Turning sign-in **off**, or making a table **public**
- Turning QA mode or roles **on**, or roles off
- Replacing an existing validation schema
- Filling a project from a starter
- Removing or emptying a table

If you ask for several settings at once and any one of them needs a click, the
whole request becomes a proposal. A harmless setting can't carry a risky one
past you.

## Either way, it waits for Deploy

A settings change, applied or confirmed, is saved like one you made yourself:
as a draft that goes live on your next **Deploy**. Emptying a table is the
exception, and happens as soon as you confirm it.

## Keys, secrets and URLs are yours to fill in

The Co-Pilot never writes your Google, GitHub, Resend or Twilio keys, webhook
URLs or redirect URLs. When a feature needs one, it tells you which line to fill
in, and you paste it into the `.env` yourself. A webhook URL is somewhere your
data gets sent, so only you should choose it.
