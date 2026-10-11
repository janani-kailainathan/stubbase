---
title: 'What Is Stubbase? How JSON Files Become a REST API — User Guide'
description: 'Stubbase turns JSON files into a hosted REST API with CRUD endpoints, filtering, relations and sign-up. Learn the four ideas the rest of the user guide builds on: projects, resources, deploys and your API base URL.'
h1: 'What is Stubbase?'
subheadline: 'Stubbase turns JSON files into a REST API that is hosted for you. This page covers the four ideas the rest of the guide builds on.'
label: 'What is Stubbase?'
chapter: 'getting-started'
order: 1
publishedAt: 2026-10-11
hero:
  alt: 'A Stubbase project open in the dashboard: the Files rail, a JSON table in the editor, and the APIs rail listing its endpoints'
  caption: 'One project: its tables on the left, the records in the middle, and the endpoints they became on the right.'
---

## A JSON file is an API

Each table in your API is one JSON file: an array of records. Add a `posts.json`
to a project, deploy it, and these endpoints exist:

```bash
GET    https://api.stubbase.dev/<project-id>/posts          # list your posts
GET    https://api.stubbase.dev/<project-id>/posts/<id>     # read one
POST   https://api.stubbase.dev/<project-id>/posts          # create one
PUT    https://api.stubbase.dev/<project-id>/posts/<id>     # replace one
DELETE https://api.stubbase.dev/<project-id>/posts/<id>     # delete one
```

You don't set up a database or write a schema. The records you put in the file
are the data, and the API serves them to anyone who calls it, from a browser, a
mobile app, a test suite or `curl`.

## The four ideas

**Project.** A project is one API. It has its own tables, its own settings and
its own address. You can make as many as you like, and they share your
account's monthly request allowance.

**Resource.** A resource is one table: one JSON file, one set of endpoints.
Stubbase calls them resources and the editor shows them as `.json` files in
the Files rail.

**Deploy.** Records are live the moment you save them. Anything that changes
the *shape* of your API waits for **Deploy**: a new table, or a change to your
settings. A new project starts **stopped**, and nothing in it is public until
you deploy it once.

**API base URL.** Every project's endpoints live under
`https://api.stubbase.dev/<project-id>`. The project id is your project's name
in lowercase with dashes, plus a short random suffix, for example
`recipe-box-3f9a1c2e`.

## What you can switch on

Beyond plain create, read, update and delete, every project can use any of
these. None of them depends on your plan:

- **Querying**: filter, sort and page lists, and pull related records into one
  response with `_expand`.
- **Sign-up and login** for your own users, with email verification, password
  reset, and Google and GitHub sign-in.
- **Roles and permissions**: who may read or change each table.
- **Validation, webhooks, QA mode and read-only APIs**: one line each in the
  project's `.env`.
- **The AI Co-Pilot**, which designs tables, changes records and suggests
  settings when you ask.

Plans differ only in how many requests your projects may serve. The Free plan
gives you 10,000 requests a month.

## Where to go next

Create your first project. The quickest start is a starter example: real
records, already shaped like an app, that you can call within a minute.
