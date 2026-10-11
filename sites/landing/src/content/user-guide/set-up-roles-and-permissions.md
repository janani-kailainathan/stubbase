---
title: 'Set Up Roles and Permissions with rbac.json in Stubbase — User Guide'
description: 'Write roles and permissions for your Stubbase API in rbac.json: read, create, update and delete per table, scoped to own or all records, a guest role for visitors, and a default role for new accounts.'
h1: 'Set up roles and permissions'
subheadline: 'Describe who may do what in one file, rbac.json. Every request is then checked against the role of the user making it.'
label: 'Set up roles'
chapter: 'roles'
order: 2
publishedAt: 2026-10-11
hero:
  alt: 'rbac.json open in the system folder, showing guest, customer, staff and admin roles'
  caption: 'Turn roles on in the .env, Save, and rbac.json appears in the system folder.'
---

## Switch roles on

In the project's `.env`, alongside sign-in:

```bash
AUTH_ENABLED=true
RBAC_ENABLED=true
```

**Save** the `.env`, and **rbac.json** appears in the Files rail's **system**
folder. Open it and click **Create** to start from an example. Change it to
fit, **Save**, then **Deploy** to put the rules live.

## How a rules file reads

```json
{
  "defaultRole": "customer",
  "roles": {
    "guest":    { "products": ["read"] },
    "customer": { "products": ["read"],
                  "orders":   { "create": "own", "read": "own", "update": "own" } },
    "staff":    { "products": ["read", "create", "update"],
                  "orders":   { "read": "all", "update": "all" },
                  "_users":   ["read"] },
    "admin":    "*"
  }
}
```

A **permission** is an action on a table (`read`, `create`, `update` or
`delete`) and how far it reaches: `own`, the records that user created, or
`all`. A **role** is a set of permissions. There are three ways to write one:

| You write | It means |
|---|---|
| `"*"` | Everything, on every table |
| `"orders": ["read", "create"]` | Those actions on every record of the table |
| `"orders": { "read": "own", "update": "all" }` | Each action with its own reach |

## The same request, different answers

With the file above:

```bash
GET  /<project-id>/orders      # as a customer:      only their own orders
GET  /<project-id>/orders      # as staff:           every order
GET  /<project-id>/orders      # without a token:    401
POST /<project-id>/products    # as a customer:      403
```

## The rules

- **Anything a role doesn't mention is refused.** Add a new table and only a
  `"*"` role can touch it until you add it to the others.
- **`own` holds everywhere.** A customer's list shows only their records, and
  someone else's order by id reads as `404`, as if it didn't exist. A
  customer's new order is always theirs, whatever the body says.
- **`guest` is for requests without a token.** It can only use `all`, since a
  visitor owns nothing. While roles are on, `AUTH_PUBLIC_ROUTES` is ignored and
  `guest` decides what visitors can do.
- **`admin` is just a name.** Under roles it gets no special treatment; `"*"` is
  how a role gets everything.
- **`_users`** is a permission over your users' accounts, used to list them and
  change roles from your own app (see the next page).
- **`defaultRole`** is the role every new account gets.

## Mistakes are caught on Save

If something in the file is wrong, such as a `defaultRole` that isn't one of
the roles or a misspelt action, **Save** lists every problem and where it is,
and nothing changes. Every mistake is reported, none is skipped, so a file that
saves is a file that does what it says.

## Switch roles off

Set `RBAC_ENABLED=false`, or comment it out, and deploy. Your API goes back to
the ownership rule from the previous page, and `rbac.json` stays in the project,
ready for when you switch it back on.
