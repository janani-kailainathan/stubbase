---
title: 'Deploy, Redeploy and Stop Your Stubbase API — User Guide'
description: 'Put a Stubbase project live with Deploy, publish new tables and settings with Redeploy, and take an API offline with Stop. What each button changes, and what it leaves alone.'
h1: 'Deploy, redeploy and stop your API'
subheadline: 'One button in the top bar puts your API live and keeps it current. The square beside it stops the API. Here is what each one changes.'
label: 'Deploy and stop'
chapter: 'getting-started'
order: 4
publishedAt: 2026-10-11
hero:
  alt: 'The top bar of a live project: its status reading live, the Redeploy button and the Stop square beside it'
  caption: 'Live: Redeploy and Stop. Stopped: Deploy on its own.'
---

## Deploy a stopped project

A new project starts **stopped**, and so does one you stopped yourself. To put
it live:

**1. Click Deploy** in the top right of the dashboard.

**2. Wait for the toast.** It reads **API is live**, followed by any staged
files it published. The status next to the project name changes from
**stopped** to **live**.

Your endpoints answer from that moment. Try one in a terminal:

```bash
curl https://api.stubbase.dev/<project-id>/posts
```

## What Deploy publishes

Deploy publishes everything that was waiting for it, and starts the API if it
was stopped:

- **New tables** you saved since the last deploy.
- **Settings**: changes to the project's `.env` and to `rbac.json`.

Records don't wait for Deploy. A save to a live table is already live, so
Deploy has nothing to do for it.

## Redeploy after a change

While the API is live the button reads **Redeploy**. When you have staged
something that isn't live yet, a notice appears above the editor:

> You have changes that aren't live yet — your API keeps serving the last
> deployed version until you Redeploy.

Click **Redeploy** to publish them. The API keeps serving throughout, so
callers see the old version and then the new one, with no gap between.

<figure class="shot shot--pending">
  <div class="shot-frame" role="img" aria-label="Screenshot to come: The yellow notice above the editor saying there are changes that aren't live yet."><span class="shot-file">/user-guide/deploy-and-stop/01-staged-changes.png</span></div>
  <figcaption>The notice stays until you Redeploy, and comes back if you hide it and change something else.</figcaption>
</figure>

## Stop the API

**1. Click the square** beside Redeploy. Its tooltip reads **Stop API**.

**2. Confirm with Stop API.** The dialog has Cancel selected, so pressing Enter
by accident won't stop anything.

Once stopped, every public endpoint of the project answers `503` until you
deploy again, so apps calling it will fail. **Your data, staged changes and
settings stay as they are.** To bring the API back, click **Deploy**. It
publishes anything you staged in the meantime, then starts the API.

While a project is stopped, the **Logs** tab is greyed out, because there is no
traffic to show.

## Deleting a project

A project has to be stopped before it can be deleted, so a live API is never
removed by accident. Open the project menu in the top bar and use the bin icon
beside the project's name.
