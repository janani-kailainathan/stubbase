---
title: 'Persistent Relational Mock APIs for Frontend Developers — Stubbase'
description: 'Bypass backend dependencies. Turn a single JSON file into a fully relational REST API with instant pagination, filtering, and OAuth integration.'
h1: 'Persistent Relational Mock APIs for Frontend Developers'
subheadline: 'Bypass backend dependencies. Turn a single JSON file into a fully relational REST API with instant pagination, filtering, and OAuth integration.'
---

## Unblock UI Development

Frontend teams are frequently bottlenecked waiting for backend services to be deployed. Managing local databases or relying on transient mock scripts slows down state management and UI iteration.

## Instant Relational Routing

Stubbase converts flat JSON structures into connected APIs automatically. By appending `Id` to your JSON keys, the engine infers relationships and mounts instant `?_expand=` routing.

**Input (`schema.json`):**

```json
{
  "users": [{ "id": 1, "name": "Alice" }],
  "posts": [{ "id": 100, "title": "React State", "userId": 1 }]
}
```

**Execution:**

```bash
GET https://api.stubbase.dev/<tenant>/posts?_expand=user
```

**Response:**

```json
[
  {
    "id": 100,
    "title": "React State",
    "userId": 1,
    "user": { "id": 1, "name": "Alice" }
  }
]
```
