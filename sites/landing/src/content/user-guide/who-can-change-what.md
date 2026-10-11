---
title: 'Record Ownership in Stubbase: Who Can Change What Without Roles — User Guide'
description: 'With sign-in on and no roles, every Stubbase record created through the API belongs to the user who created it. Signed-in users read everything and change only their own records; the admin role changes anything.'
h1: 'Who can change what, before roles'
subheadline: 'Turn sign-in on and your API already knows whose records are whose. This is the rule you get until you write roles of your own.'
label: 'Ownership before roles'
chapter: 'roles'
order: 1
publishedAt: 2026-10-11
---

## Records belong to whoever created them

With `AUTH_ENABLED=true`, a record created through your API by a signed-in user
is stamped with that user's id in a `userId` field. The server sets it, and
anything the body says for `userId` is replaced.

## The rule

| Who | Can read | Can change and delete |
|---|---|---|
| A signed-in user | Every record | Records they own, and records with no owner |
| A user with the `admin` role | Every record | Every record |
| A request without a token | Only tables in `AUTH_PUBLIC_ROUTES` | Nothing |

Two more details:

- **Nobody but an admin can move a record** to another owner by changing its
  `userId`.
- **Every table is treated alike**, including a table you named `users`.

That fits a lot of apps as it is: a notes app, a blog where people edit only
their own posts, a to-do list. When you need more, such as staff who see every
order while customers see only theirs, you need roles.

## Make someone an admin

Every new account has the role `user`. To make one an `admin`:

**1. Open system → users.json** in the Files rail.

**2. Pick admin** in the role list beside the account.

The new role applies from that account's next request, with no need to sign in
again.

## When to move to roles

Roles replace this rule entirely, so it's worth moving once you need any of:

- Users who can see **only their own** records, not everyone's.
- More than two kinds of account, such as customer, staff and admin.
- Tables that visitors without a token may write to, or that some signed-in
  users may not read.
