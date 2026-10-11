---
title: 'Rename, Duplicate and Delete Stubbase Projects — User Guide'
description: 'Manage Stubbase projects from the project menu: rename a project, duplicate it with or without its .env for a staging copy, and delete it once its API is stopped.'
h1: 'Rename, duplicate and delete projects'
subheadline: 'Everything you do to a project as a whole lives in the project menu: click the project name in the top bar.'
label: 'Manage projects'
chapter: 'account'
order: 2
publishedAt: 2026-10-11
hero:
  src: /user-guide/manage-projects/hero.png
  alt: 'The project menu open from the top bar: each project with copy and bin icons, and New project at the bottom'
  caption: 'Click the project name to open the menu.'
---

## Switch projects

Click the project name in the top bar to open the project menu, and pick
another. The pane you were on comes with you, so if you were in Logs you land
in the other project's Logs.

Each project has its own address, `app.stubbase.dev/p/<project-id>/editor`, so
a reload or a bookmark brings you back to the same place.

## Rename a project

Click the pencil next to the project name, type the new name and press Enter.

Renaming changes what you see in the dashboard only. The project id in your API
URL stays the same, so nothing calling your API breaks.

## Duplicate a project

Use it for a staging copy, or to try a risky change somewhere safe.

**1. Open the project menu** and click the copy icon beside the project.

**2. Name the copy**, and choose whether to tick **Copy the .env too**.

**3. Click Duplicate.** The copy opens straight away.

What comes across:

- **Every table**, as it is in the editor, including changes you saved but
  haven't deployed.
- **The .env and rbac.json**, only if you ticked the box. Your keys and webhook
  URLs come with it, and the Google and GitHub callback URLs in it are changed to
  name the copy, so register those with your providers before anyone signs in.
- **Fields marked required** by the Co-Pilot.

What never comes across: **the accounts that signed up to your API**, their
sessions and pending sign-ups, and your **developer API keys**. The copy starts
with no users, and an MCP client needs a new key for it.

Like any new project, the copy starts **stopped**. Nothing in it is public until
you deploy.

## Delete a project

**1. Open the project menu** and click the bin icon beside the project.

**2. Stop it first, if it's live.** A project has to be stopped before it can be
deleted, so a live API never disappears by accident. The dialog offers **Stop
API** if it is still running.

**3. Confirm.** The tables, settings and accounts are deleted, and the project
id stops working. Any developer API keys for the project stop working too.

This can't be undone. If you might want it back, duplicate it first, or copy
the tables out of the editor.
