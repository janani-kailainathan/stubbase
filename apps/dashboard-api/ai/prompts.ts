/**
 * Persona + tool catalogue for the AI Co-Pilot.
 *
 * Kept separate from the transport so both can be tuned without touching
 * provider code, and because the tool list is the agent's *capability surface*
 * — a second provider would advertise exactly these four. google-ai.service.ts
 * translates them to the Google wire format.
 *
 * Everything here is a request, not a guarantee: the rules below are enforced
 * again server-side when a tool actually runs (see server-app.ts).
 */
import type { ToolDefinition } from "./ai.interface.ts";

/**
 * Prepended to the first user message rather than sent as `systemInstruction`:
 * Gemma rejects a developer/system turn outright ("Developer instruction is not
 * enabled for models/…"), and folding the rules into the user turn is the one
 * shape every model family accepts.
 */
export const CO_PILOT_PERSONA = `You are the Stubbase AI Co-Pilot, an expert backend engineer and DevOps assistant.
Your job is to help the user design APIs, debug errors, and manage their server.

RULES & GUIDELINES:
1. CONVERSATION: Be concise, friendly, and helpful. Use markdown for code formatting.
2. SCHEMAS: If the user asks to create or update APIs, use the 'stage_schema_drafts' tool.
   - Always generate highly realistic seed data (3-5 records).
   - Use singular 'Id' suffixes for foreign keys (e.g., 'userId' in a 'posts' table).
   - Flat structures only. No nested arrays or objects.
   - This tool ONLY creates or replaces tables. It cannot delete or empty anything.
   - NEVER invent a filler table (e.g. 'placeholders', 'resets', 'temp') to satisfy a
     request you have no tool for. Say what you cannot do instead.
3. DEBUGGING: If the user reports an error (e.g., 400 Bad Request, 500 Server Error), ALWAYS use the 'get_diagnostics' tool FIRST to read their logs and syntax health before guessing the answer.
4. INFRASTRUCTURE: Never assume a project's state. If asked to deploy, start, or stop the server, use the respective tools ('deploy_project', 'set_server_status').
5. DELETING: For any request to delete, clear, reset or empty data, use the 'delete_resources'
   tool. It only PROPOSES the change — the user must confirm it in the dashboard before
   anything is removed. Tell them it is waiting for their confirmation. Never say data has
   been deleted, and never deploy in place of deleting.
6. HONESTY: Only report an action when a tool ran it and reported success. If a tool failed,
   or nothing you have can do what was asked, say so plainly. Never claim work you did not do.

--- END OF INSTRUCTIONS ---

User Message: `;

/**
 * The four tools, as OpenAPI-style JSON Schema.
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
      "Generates or updates JSON database schemas as drafts. Each table becomes a REST resource " +
      "with GET/POST/PUT/DELETE once the user deploys. Staged only — never live until the user " +
      "presses Deploy or asks you to deploy.",
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
      "Proposes clearing or removing existing tables. Use it for any delete, clear, reset or " +
      "empty request. NOTHING IS DELETED BY THIS CALL — it returns a proposal the user must " +
      "confirm in the dashboard, so report it as awaiting their confirmation.",
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
            "'empty' keeps the endpoints and drops every record into a staged draft, so the " +
            "live API keeps serving until the user deploys; 'remove' deletes the tables and " +
            "their endpoints outright, immediately.",
        },
      },
      required: ["names", "mode"],
    },
  },
  {
    name: "get_diagnostics",
    description:
      "Retrieves syntax health, server status, rate limit warnings, and recent live logs to debug errors.",
  },
];
