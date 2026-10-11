---
title: 'Create Your First Stubbase Project from a Starter — User Guide'
description: 'Sign up, create a Stubbase project from a starter example or an empty one, and find your API base URL. Step by step, with what each starter includes.'
h1: 'Create your first project'
subheadline: 'Sign up, name a project, and pick a starter or start empty. A minute from now you will have tables full of records, ready to deploy.'
label: 'Create your first project'
chapter: 'getting-started'
order: 2
publishedAt: 2026-10-11
hero:
  src: /user-guide/create-your-first-project/hero.png
  alt: 'The New project dialog, with a project name typed in and the starter examples below it'
  caption: 'Name the project, pick a starter (or Empty project), then Create project.'
---

## Sign up

Go to [app.stubbase.dev/signup](https://app.stubbase.dev/signup). You can sign
up two ways:

- **With your email and a password.** We email you a 6-digit code, and your
  account is created when you type it in.
- **With Continue with Google or Continue with GitHub.** No code is needed,
  because the provider has already checked your address.

Every new account starts on the Free plan, with no card needed.

## Create the project

**1. Open the New project form.** On a new account it is the first thing you
see. After that, click the project name in the top bar and choose **New
project** at the bottom of the menu.

**2. Name the project.** The name is for you, and you can rename it later. It
also becomes the start of your project id: `Recipe box` becomes something like
`recipe-box-3f9a1c2e`.

**3. Pick a starter, or Empty project.** A starter is a working API with real
records in it. Picking one fills in the name for you if you have not typed one.

**4. Click Create project.** The project opens in the Editor, with its tables
in the Files rail on the left.

<figure class="shot">
  <img src="/user-guide/create-your-first-project/01-new-project-stopped.png" alt="A new project in the Editor, its status reading stopped beside the project name." width="760" height="250" loading="lazy" decoding="async" />
  <figcaption>A new project starts stopped: nothing in it is public until you deploy.</figcaption>
</figure>

## Which starter to pick

| Starter | What it shows |
|---|---|
| **Issue tracker** | One resource. Filter, sort and paginate it. |
| **Sign-in basics** | Sign-up, email verification, login and password reset, and nothing else. |
| **Blog** | Posts reference authors, comments reference posts. |
| **Storefront** | Related orders, with sign-in required to write. |
| **Forkful recipes** | Browse recipes freely; sign in to review and save. |
| **Deskline helpdesk** | Customers see their own tickets; agents see them all. |
| **Signet accounts** | Every way to sign in, with orgs, members and invites. |

If you are new to Stubbase, start with **Issue tracker** or **Blog**. They need
no sign-in, so every endpoint answers straight away. Starters that switch on
sign-up also set the settings they need in the project's `.env`.

## Your project starts stopped

Next to the project name, the top bar shows its status. A new project reads
**stopped**, and every public endpoint answers `503` until you deploy it. That
gives you time to look at the data and the settings before anyone else can
call them.

Your API base URL is `https://api.stubbase.dev/<project-id>`. The project id is
in the dashboard's address bar, `app.stubbase.dev/p/<project-id>/editor`, and
in every endpoint the APIs rail lists.
