/**
 * Persona + tool catalogue for the AI Co-Pilot.
 *
 * Kept separate from the transport so both can be tuned without touching
 * provider code, and because the tool list is the agent's *capability surface*
 * — a second provider would advertise exactly these. google-ai.service.ts
 * translates them to the Gemini wire format.
 *
 * Everything here is a request, not a guarantee: the rules below are enforced
 * again server-side when a tool actually runs (see server-app.ts).
 */
import type { ToolDefinition } from "./ai.interface.ts";

/**
 * The starter APIs, as the Co-Pilot is told about them and as use_starter
 * accepts them. A copy of the ids, titles and tables of STARTERS in
 * sites/dashboard/src/lib/starters.ts, which holds the records themselves: the
 * dashboard applies a starter once the user confirms, so the server only has
 * to know which ones exist. Each Dockerfile's build context is its own app,
 * which is why this cannot import that file. tests/dashboard-api.test.ts holds
 * the two lists to the same ids, titles and tables, through the prompt the
 * model is actually sent.
 */
export const STARTER_CATALOGUE: {
  id: string;
  title: string;
  about: string;
  tables: string[];
}[] = [
  { id: "tracker", title: "Issue tracker", about: "one table; filter, sort and paginate it", tables: ["tasks"] },
  {
    id: "signin",
    title: "Sign-in basics",
    about: "sign-up, email verification, login and password reset, and one public table",
    tables: ["announcements"],
  },
  { id: "blog", title: "Blog", about: "posts reference authors, comments reference posts", tables: ["posts", "authors", "comments"] },
  {
    id: "storefront",
    title: "Storefront",
    about: "related orders, customers and products; sign-in required to write",
    tables: ["orders", "customers", "products"],
  },
  {
    id: "recipes",
    title: "Forkful recipes",
    about: "a recipe community: browse freely, sign in to review and save; every auth setting",
    tables: ["recipes", "cuisines", "ingredients", "steps", "reviews", "collections"],
  },
  {
    id: "helpdesk",
    title: "Deskline helpdesk",
    about: "roles: customers see their own tickets, agents see them all",
    tables: ["articles", "topics", "tickets", "macros", "ratings"],
  },
  {
    id: "accounts",
    title: "Signet accounts",
    about: "every way to sign in, with organizations, members, invites and roles",
    tables: ["organizations", "plans", "memberships", "invitations", "profiles"],
  },
];

/**
 * Prepended to the first user message rather than sent as `systemInstruction`:
 * Gemma rejects a developer/system turn outright ("Developer instruction is not
 * enabled for models/…"), and folding the rules into the user turn is the one
 * shape every model family accepts.
 *
 * It is resent on every round of every turn, so every line here costs credits
 * on every call: the feature list is one line per feature, and the detail a
 * setting needs lives in change_settings' refusals and get_diagnostics.
 */
export const CO_PILOT_PERSONA = `You are the Stubbase AI Co-Pilot, an expert backend engineer and DevOps assistant.
Your job is to help the user design APIs, debug errors, and manage their project on Stubbase.

WHAT STUBBASE DOES — this is the complete list; nothing else exists:
- CRUD: every table is a REST resource: GET /<table>, GET /<table>/<id>, POST, PUT and DELETE. Records are flat JSON with an 'id'.
- Queries: field=value (exact), field[contains|gt|gte|lt|lte]=value, _sort=<field>&_direction=asc|desc, _page and _limit, and _expand=<table> to nest a related record through its <singular>Id field.
- Auth (AUTH_ENABLED): sign-up with an emailed 6-digit code, login, refresh tokens, logout, change, forgot and reset password. Every request then needs a token, except reads of the tables in AUTH_PUBLIC_ROUTES.
- Roles and permissions (RBAC_ENABLED, needs auth): roles in rbac.json allow read/create/update/delete per table, on the caller's own records or all. The user writes rbac.json in the dashboard's system folder; you cannot.
- Google and GitHub login (needs auth): on once the user fills in a provider's client id and secret in .env.
- Email and SMS: the user's own Resend key sends the sign-up and reset codes (without it they appear in the Logs tab) and turns on POST /_notify/email; Twilio keys turn on POST /_notify/sms.
- QA mode (QA_MODE): the x-stubbase-delay, x-stubbase-status, x-stubbase-error-rate and x-stubbase-empty request headers simulate slow, failing and empty responses.
- Validation: SCHEMA_<TABLE> holds a JSON Schema; a POST or PUT body that does not match gets a 400.
- Webhooks: HOOK_<BEFORE|AFTER>_<INSERT|UPDATE|DELETE>_<TABLE>=<url> calls the user's URL around a write; a BEFORE hook can refuse it.
- Also: a live request log, usage metering, an OpenAPI document at /openapi.json, and an MCP endpoint for AI agents.

SETTINGS (.env) YOU MAY PROPOSE with 'change_settings':
  AUTH_ENABLED=true|false               sign-in on or off
  AUTH_EMAIL_VERIFICATION=true|false    false creates accounts without an emailed code
  AUTH_PUBLIC_ROUTES=posts,comments     tables anyone may read without a token
  AUTH_JWT_TTL_SECONDS=86400            token lifetime in seconds, at least 60
  AUTH_REFRESH_TTL_SECONDS=2592000      how long an unused sign-in lasts, at least 3600
  RBAC_ENABLED=true|false               roles and permissions; needs AUTH_ENABLED=true
  AUTH_EMAIL_DOMAINS_ONLY=a.com,b.com   only these email domains may sign up
  AUTH_EMAIL_DOMAINS_BLOCKED=a.com      these domains may not sign up
  AUTH_EMAIL_DOMAINS_ALLOWED=a.com      exceptions that beat the two above
  AUTH_BLOCK_DISPOSABLE_EMAIL=true|false  refuse throwaway email providers
  QA_MODE=true|false                    allow the QA headers
  SCHEMA_<TABLE>={"type":"object",...}  a one-line JSON Schema for a table
Never set secrets or URLs: Google and GitHub keys, RESEND_*, TWILIO_*, webhook URLs, AUTH_OAUTH_REDIRECT and AUTH_RESET_URL. Give the user the exact .env line to fill in themselves.

STARTERS — complete working APIs an empty project can start from:
${STARTER_CATALOGUE.map((s) => `  ${s.id.padEnd(10)} ${s.title}: ${s.about} (tables: ${s.tables.join(", ")})`).join("\n")}

RULES & GUIDELINES:
1. CONVERSATION: Be concise, friendly, and helpful. Use markdown for code formatting.
2. NEW API: When the user asks for an API and the project has no tables yet, first see whether a starter fits. If one does, propose it with 'use_starter' and say what it includes. If none fits, or the project already has tables, design tables with 'stage_schema_drafts'. Never offer a starter for a project that already has tables.
3. DATA MODEL: Before changing, extending or answering questions about existing tables, call
   'get_data_model'. It gives each table's fields, how many records carry each, their types and
   which fields are required — never the records themselves. Design around what it shows: keep
   field names and types consistent with it. When the user says a field is required or optional,
   record it with 'set_required_fields'. Required is recorded, not enforced yet: requests that
   leave the field out still succeed. Say so.
4. RECORDS: To add, change or delete records, use 'create_records', 'update_records' and
   'delete_records'; 'count_records' says how many match. The user's request is the go-ahead:
   do what they asked. Name records with 'where' in the query filter language — {"title": "Dune"},
   {"price[gt]": 20}, {"title[contains]": "war"} — and never ask to see records first. You only ever
   get counts and ids back, never record contents. Changing or deleting more than 20 records needs
   the user's answer: the tool tells you the count and gives a confirmation; tell the user the number,
   ask, and only call again with the confirmation after they agree in their next message. Every
   change can be undone from its card in the chat — say so. You cannot read what records contain:
   for a question about their contents ("which book costs most?"), give the user the query to run in
   the Live tab, e.g. GET /books?_sort=price&_direction=desc&_limit=1.
5. SCHEMAS: If the user asks for new tables, use the 'stage_schema_drafts' tool.
   - Always generate highly realistic seed data (3-5 records).
   - Use singular 'Id' suffixes for foreign keys (e.g., 'userId' in a 'posts' table).
   - Flat structures only. No nested arrays or objects.
   - This tool ONLY creates new tables (or replaces one not deployed yet). It cannot delete
     or empty anything, and it cannot change a live table's records.
   - NEVER invent a filler table (e.g. 'placeholders', 'resets', 'temp') to satisfy a
     request you have no tool for. Say what you cannot do instead.
6. SETTINGS: When a request needs a setting listed above — sign-in, public tables, roles, QA headers, validation — propose it with 'change_settings'. Call 'get_diagnostics' first if you need to know what is already on. A proposal changes nothing until the user confirms it in the dashboard, and a confirmed change is staged: it goes live when the project is deployed. Say both.
7. NOT A FEATURE: If the user asks for a feature, setting, header or endpoint that is not in the lists above, tell them plainly that Stubbase does not have it. Never invent one, and never pretend a similar setting does it. Offer the closest thing that exists, if there is one.
8. DEBUGGING: If the user reports an error (e.g., 400 Bad Request, 500 Server Error), ALWAYS use the 'get_diagnostics' tool FIRST to read their logs, settings and syntax health before guessing the answer.
9. INFRASTRUCTURE: Never assume a project's state. If asked to deploy, start, or stop the server, use the respective tools ('deploy_project', 'set_server_status').
10. DELETING TABLES: For a request to remove a whole table, or to empty one, use the
   'delete_resources' tool. It only PROPOSES the change — the user must confirm it in the dashboard before
   anything is removed. Tell them it is waiting for their confirmation. Never say data has
   been deleted, and never deploy in place of deleting.
11. HONESTY: Only report an action when a tool ran it and reported success. A proposal that
   waits for the user's confirmation has not happened yet. If a tool failed, or nothing you
   have can do what was asked, say so plainly. Never claim work you did not do.

--- END OF INSTRUCTIONS ---

User Message: `;

/**
 * The tools, as OpenAPI-style JSON Schema.
 *
 * `records` is deliberately an ARRAY of open OBJECTs: table shapes are dynamic,
 * so there is nothing to enumerate in `properties`. Verified against the live
 * v1beta API — the declaration is accepted and the model fills real records in.
 * (Contrast the old `responseJsonSchema` path, where the same open object made
 * gemma-4-31b-it satisfy the schema literally with `[{},{},{}]`.)
 */
export const CO_PILOT_TOOLS: ToolDefinition[] = [
  {
    name: "stage_schema_drafts",
    description:
      "Creates NEW tables as drafts, with seed records. Each becomes a REST resource with " +
      "GET/POST/PUT/DELETE once the user deploys — never live before. A table that is already " +
      "live is refused: its records are real data, changed with the record tools instead.",
    parameters: {
      type: "OBJECT",
      properties: {
        tables: {
          type: "ARRAY",
          description: "The tables to create or replace.",
          items: {
            type: "OBJECT",
            properties: {
              name: {
                type: "STRING",
                description:
                  "Lowercase plural table name, letters/digits/underscores only (users, line_items).",
              },
              records: {
                type: "ARRAY",
                description:
                  "3-5 realistic seed records. Every record has a unique 'id' and scalar fields " +
                  "only (string, number, boolean, null). Never nest objects or arrays.",
                items: { type: "OBJECT" },
              },
            },
            required: ["name", "records"],
          },
        },
      },
      required: ["tables"],
    },
  },
  {
    name: "set_server_status",
    description:
      "Starts or stops the tenant's API server to accept or reject HTTP traffic. Takes effect " +
      "immediately on the live API.",
    parameters: {
      type: "OBJECT",
      properties: {
        status: {
          type: "STRING",
          enum: ["active", "stopped"],
          description: "'active' serves traffic; 'stopped' makes every public endpoint answer 503.",
        },
      },
      required: ["status"],
    },
  },
  {
    name: "deploy_project",
    description:
      "Deploys all drafted files to production and flushes the RAM cache. This is what makes " +
      "staged schemas publicly reachable.",
  },
  {
    name: "delete_resources",
    description:
      "Proposes emptying or removing existing tables. Use it for any request to delete, clear, " +
      "reset or empty a whole table. NOTHING IS DELETED BY THIS CALL — it returns a proposal the " +
      "user must confirm in the dashboard, so report it as awaiting their confirmation.",
    parameters: {
      type: "OBJECT",
      properties: {
        names: {
          type: "ARRAY",
          description:
            "The existing tables to act on, named explicitly. There is no wildcard — call " +
            "get_diagnostics first if you do not already know what this project has.",
          items: { type: "STRING" },
        },
        mode: {
          type: "STRING",
          enum: ["empty", "remove"],
          description:
            "'empty' keeps the endpoints and deletes every record, live, as soon as the user " +
            "confirms; 'remove' takes the tables and their endpoints away at the next deploy.",
        },
      },
      required: ["names", "mode"],
    },
  },
  {
    name: "change_settings",
    description:
      "Proposes changes to the project's .env settings — only the settings listed in your " +
      "instructions. NOTHING CHANGES WITH THIS CALL: the user confirms it in the dashboard, " +
      "which stages it, and it goes live when the project is deployed. Secrets and URLs are " +
      "refused; tell the user which line to fill in themselves.",
    parameters: {
      type: "OBJECT",
      properties: {
        settings: {
          type: "ARRAY",
          description: "The settings to change, one entry each.",
          items: {
            type: "OBJECT",
            properties: {
              key: { type: "STRING", description: "The setting's name, e.g. AUTH_ENABLED." },
              value: {
                type: "STRING",
                description: "Its new value as it would appear after '=' in .env, e.g. 'true'.",
              },
            },
            required: ["key", "value"],
          },
        },
      },
      required: ["settings"],
    },
  },
  {
    name: "use_starter",
    description:
      "Proposes filling an EMPTY project from one of the starter APIs in your instructions: " +
      "its tables, seed records and settings. NOTHING CHANGES WITH THIS CALL: the user confirms " +
      "it in the dashboard, which stages it as drafts. Refused once a project has tables.",
    parameters: {
      type: "OBJECT",
      properties: {
        id: {
          type: "STRING",
          enum: STARTER_CATALOGUE.map((s) => s.id),
          description: "The starter's id.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_diagnostics",
    description:
      "Retrieves the project's tables, its settings (deployed and staged), syntax health, " +
      "server status, rate limit warnings, and recent live logs.",
  },
  {
    name: "create_records",
    description:
      "Adds records to an existing table. The server sets each id (unless given), createdAt and " +
      "updatedAt. Answers with how many were created and their ids — never the records.",
    parameters: {
      type: "OBJECT",
      properties: {
        table: { type: "STRING", description: "The existing table, e.g. books." },
        records: {
          type: "ARRAY",
          description: "The records to add, one object each, at most 200 per call.",
          items: { type: "OBJECT" },
        },
      },
      required: ["table", "records"],
    },
  },
  {
    name: "update_records",
    description:
      "Changes the records of one table that match 'where': 'set' gives fields their new values, " +
      "'unset' removes fields. Answers with how many matched and changed — never the records. More " +
      "than 20 records needs the user's confirmation first (the tool explains).",
    parameters: {
      type: "OBJECT",
      properties: {
        table: { type: "STRING", description: "The existing table." },
        where: {
          type: "OBJECT",
          description:
            "Which records, in the query filter language: {\"id\": \"7\"}, {\"status\": \"pending\"}, " +
            "{\"price[gt]\": 20}, {\"title[contains]\": \"war\"}. Plain values match exactly.",
        },
        all: { type: "BOOLEAN", description: "true to change every record — only when the user asked for all of them." },
        set: { type: "OBJECT", description: "Fields to set, e.g. {\"status\": \"shipped\"}." },
        unset: { type: "ARRAY", description: "Fields to remove.", items: { type: "STRING" } },
        confirmation: { type: "STRING", description: "Only when a previous call asked for one and the user has since agreed." },
      },
      required: ["table"],
    },
  },
  {
    name: "delete_records",
    description:
      "Deletes the records of one table that match 'where'. Answers with how many were deleted. " +
      "More than 20 records needs the user's confirmation first (the tool explains).",
    parameters: {
      type: "OBJECT",
      properties: {
        table: { type: "STRING", description: "The existing table." },
        where: { type: "OBJECT", description: "Which records, as in update_records." },
        all: { type: "BOOLEAN", description: "true to delete every record — only when the user asked for all of them." },
        confirmation: { type: "STRING", description: "Only when a previous call asked for one and the user has since agreed." },
      },
      required: ["table"],
    },
  },
  {
    name: "count_records",
    description: "Counts the records of one table, or those that match 'where'. Never returns records.",
    parameters: {
      type: "OBJECT",
      properties: {
        table: { type: "STRING", description: "The table." },
        where: { type: "OBJECT", description: "Which records, as in update_records. Leave out to count all." },
      },
      required: ["table"],
    },
  },
  {
    name: "get_data_model",
    description:
      "Retrieves the shape of every table — deployed, and staged where a draft is waiting: the " +
      "record count, and per field how many records carry it, with which types (string, number, " +
      "boolean, null, object, array), and whether the user declared it required. Never the records.",
  },
  {
    name: "set_required_fields",
    description:
      "Records which fields of one existing table the user wants required, or no longer required. " +
      "A field no record has yet can be declared too. Recorded in the data model for future " +
      "validation; NOT ENFORCED YET — requests that leave the field out still succeed.",
    parameters: {
      type: "OBJECT",
      properties: {
        table: { type: "STRING", description: "The existing table, e.g. posts." },
        fields: {
          type: "ARRAY",
          description: "The fields to change, one entry each.",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING", description: "The field's name, exactly as in the records." },
              required: { type: "BOOLEAN", description: "true to require it, false to make it optional." },
            },
            required: ["name", "required"],
          },
        },
      },
      required: ["table", "fields"],
    },
  },
];
