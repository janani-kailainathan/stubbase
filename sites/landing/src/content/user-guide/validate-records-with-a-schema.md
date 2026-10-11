---
title: 'Validate Records with a JSON Schema in Stubbase — User Guide'
description: 'Reject bad writes before they are stored: add a SCHEMA_<RESOURCE> line with a JSON Schema to your Stubbase project .env, and POST and PUT bodies that do not match get a 400 naming each problem.'
h1: 'Validate records with a schema'
subheadline: 'Add one line to your .env, and every create or replace on that table is checked against a JSON Schema before it is stored.'
label: 'Validate with a schema'
chapter: 'data'
order: 3
publishedAt: 2026-10-11
---

## Add a schema

Open the project's `.env` from the Files rail, click **Edit**, and add a line
named `SCHEMA_` plus the table's name in capitals, holding a JSON Schema on one
line:

```bash
SCHEMA_POSTS={"type":"object","required":["title"],"properties":{"title":{"type":"string","minLength":1},"published":{"type":"boolean"}}}
```

**Save**, then **Deploy**. From then on, a `POST` or `PUT` to `/posts` whose
body does not match is refused. The key is matched to the table by lowercasing
it, so `SCHEMA_BLOG_POSTS` validates a table called `blog_posts`: give a table
you want to validate a name in lowercase letters, digits and `_`.

Nothing else needs switching on. The line is the switch, and removing it
switches validation off again on the next deploy.

## What a refusal looks like

```json
{
  "error": "validation failed",
  "errors": [
    { "path": "title", "message": "is required" },
    { "path": "published", "message": "expected boolean, got string" }
  ]
}
```

The status is `400`, and every problem is listed, not just the first, so your
app can show them all at once.

## What a schema can check

The validator understands the parts of JSON Schema that describe a record:

| Keyword | Checks |
|---|---|
| `type` | `object`, `string`, `number`, `integer`, `boolean`, `array`, `null`, or a list of them |
| `required` | Fields that must be present |
| `properties` | A schema per field, nested as deep as you like |
| `additionalProperties` | Whether fields you didn't list are allowed |
| `enum`, `const` | A value from a fixed list, or exactly one value |
| `minimum`, `maximum` | Number ranges |
| `minLength`, `maxLength`, `pattern` | Text length, and a regular expression |
| `items`, `minItems`, `maxItems` | Arrays and what goes in them |

Keywords outside this list are ignored, not refused.

## What a schema does not check

- **Reads.** A schema checks what is written, never what is already stored.
  Records you saved before adding it stay as they were.
- **The editor.** Records you edit in the dashboard are not checked. The schema
  guards your API, not you.
- **Deletes.** There is no body to check.
