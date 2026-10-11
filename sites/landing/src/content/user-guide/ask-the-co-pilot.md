---
title: 'Use the Stubbase AI Co-Pilot to Design and Manage Your API — User Guide'
description: 'Open AI chat in a Stubbase project and ask in plain words: design tables with sample records, start from a starter, change settings and records, debug failing requests, and deploy. What it can and cannot see.'
h1: 'Ask the AI Co-Pilot'
subheadline: 'Describe what you want in plain words, and the Co-Pilot works on the project you have open: tables, records, settings, deploys and debugging.'
label: 'Ask the Co-Pilot'
chapter: 'copilot'
order: 1
publishedAt: 2026-10-11
hero:
  alt: 'The AI chat pane with a request to design a recipes API and the Co-Pilot''s reply proposing two tables'
  caption: 'Ask in plain words. Cards in the reply show what it did, or what it is waiting for you to confirm.'
---

## Open AI chat

Click **AI chat** in the top bar. Type into **Ask the AI Co-Pilot…** and press
Enter. A new chat shows a few example requests; click one to load it into the
box.

The Co-Pilot works on the project that is open, and only that one.

## What you can ask for

- **Design tables.** "I need an API for a recipe site with ingredients and
  reviews." It drafts the tables with realistic sample records, ready to deploy.
- **Start from a starter.** In an empty project, if a starter fits what you
  describe, it offers that first.
- **Add, change and delete records.** "Mark every pending order shipped."
- **Count records.** "How many orders are pending?"
- **Change settings.** "Require sign-in, but keep posts public."
- **Mark fields required.** It records that a field is required, though nothing
  enforces it yet: a request that leaves the field out still succeeds.
- **Debug.** "Why are my sign-ups failing?" It reads your recent requests and
  settings to find out.
- **Deploy, start and stop** your API, and **propose removing or emptying** a
  table.

It knows every Stubbase feature and setting, and when you ask for something
Stubbase doesn't do, it says so rather than pretending.

## What it can see, and what it can't

| It sees | It never sees |
|---|---|
| Your tables' shape: fields, how many records carry each one, their types | Your records' contents |
| Your recent requests: paths and statuses | Request and response bodies |
| Which settings are set, and the values of the ones it may change | Your keys and secrets' values |

Because it can't read your records, a question about what they contain, such as
"which book costs the most?", gets a query to run in the Live tab instead of an
answer.

## Some things wait for your click

The Co-Pilot does some things as soon as you ask and proposes others as a card
with a button, so a stray instruction can never open your API up. The next two
pages cover which is which, for records and for settings.

## Each reply costs credits

A reply uses AI credits for the work it did. After each one a toast says how
many it used and how many are left. A reply that fails costs nothing. See
[AI credits](/user-guide/ai-credits).
