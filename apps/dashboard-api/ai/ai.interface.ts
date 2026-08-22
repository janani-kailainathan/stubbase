/**
 * Provider-agnostic contract for the AI Co-Pilot.
 *
 * The Co-Pilot is conversational and *agentic*: the model may answer with text
 * or ask to run one of the tools the caller advertised. Routes depend on this
 * interface only — swapping or adding a provider means adding a file next to
 * google-ai.service.ts and wiring it in ./index.ts, with no route changes.
 *
 * The turn shape below mirrors the "role + parts" convention every current
 * tool-calling API converges on (Google's `contents`, OpenAI's messages with
 * tool_calls). A provider adapter translates it to its own wire format; the
 * agent loop in server-app.ts never sees provider JSON.
 */

/** The model asked to run a tool. `args` is untrusted — validate before use. */
export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  /** Provider correlation id, echoed back on the response when present. */
  id?: string;
}

/** What a tool returned, fed back so the model can talk about the result. */
export interface FunctionResponse {
  name: string;
  response: Record<string, unknown>;
  id?: string;
}

/**
 * Exactly one of the three fields is meaningful per part. The index signature
 * is not laziness: providers attach opaque per-part metadata that must be
 * echoed back verbatim on the next turn (Gemini 3 signs its reasoning with
 * `thoughtSignature` and rejects a history where it went missing), so parts
 * travel as-is rather than being reconstructed field by field.
 */
export interface ChatPart {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  [key: string]: unknown;
}

/**
 * One turn of the conversation. `function` turns carry tool results and are
 * authored by *us*, never by the browser — see validateHistory in server-app.ts.
 */
export interface ChatTurn {
  role: "user" | "model" | "function";
  parts: ChatPart[];
}

/** OpenAPI-style declaration of a callable tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object; omit for a no-argument tool. */
  parameters?: Record<string, unknown>;
}

/** One model turn, split into the two things the agent loop cares about. */
export interface ChatReply {
  /** The raw model turn, appended to the history verbatim. */
  turn: ChatTurn;
  /** Concatenated text parts — empty when the model only asked for tools. */
  text: string;
  /** Tool calls to execute, in the order the model asked for them. */
  calls: FunctionCall[];
}

export type AIErrorKind =
  | "unconfigured" // no API key / provider disabled
  | "upstream" // provider returned a non-2xx or unusable envelope
  | "timeout" // provider took too long
  | "invalid_json"; // model produced something we could not parse

/** Carries the kind so routes can map failures to HTTP statuses without string matching. */
export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly detail?: string;

  constructor(kind: AIErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface IAIService {
  /** Short provider id, e.g. "google-ai" — surfaced in responses and logs. */
  readonly provider: string;
  /** Resolved model string, e.g. "models/gemma-4". */
  readonly model: string;
  /**
   * One round-trip: send the conversation so far plus the tool catalogue, get
   * back a single model turn. Executing tools and looping is the caller's job
   * (it owns the tenant); this stays a pure transport.
   *
   * Throws AIError on any failure; never returns a partially-parsed result.
   */
  chat(messages: ChatTurn[], tools: ToolDefinition[]): Promise<ChatReply>;
}
