---
title: 'Give a User a Role in Your Stubbase API — User Guide'
description: 'Change a user''s role from the Stubbase dashboard in system/users.json, or from your own app with PUT /auth/users/<id>/role. New accounts get defaultRole, and a new role applies from the next request.'
h1: 'Give a user a role'
subheadline: 'New accounts get your default role. Promote someone from the dashboard, or let your own staff do it from your app.'
label: 'Give a user a role'
chapter: 'roles'
order: 3
publishedAt: 2026-10-11
---

## From the dashboard

**1. Open system → users.json** in the Files rail. Above the accounts is a list
of every account, each with a role picker.

**2. Pick the role.** The choices are the roles in your *deployed* rules,
except `guest`, because those are the only ones your API will accept. Without
roles, the choices are `user` and `admin`.

This is how you make your first admin, before anyone can do it from your app.

## From your own app

A role that holds `_users` permissions can manage accounts through your API:

```bash
GET /<project-id>/auth/users                 # needs _users: read
PUT /<project-id>/auth/users/<id>/role       # needs _users: update, body { "role": "staff" }
```

Give it to the roles that should manage people, for example:

```json
"staff": { "_users": ["read", "update"] }
```

The role you set must exist in the rules in force. A role that isn't one of
them is refused.

## When a new role applies

At once. A user's role is read from their account on every request, not from
their token, so the change applies from their next request with no need to sign
in again.

## New accounts

Every new account gets `defaultRole` from `rbac.json`, or `user` if you have no
roles. Set `defaultRole` to the least powerful role that makes sense, and
promote from there.
