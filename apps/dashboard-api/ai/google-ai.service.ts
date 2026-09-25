/**
 * Google AI Studio (Gemini / Gemma) implementation of IAIService.
 *
 * Uses Bun's native fetch — no SDK, keeping this app at zero npm dependencies.
 * One call = one model turn; the agent loop that executes tools and calls back
 * lives in server-app.ts, which is the only place that knows about tenants.
 *
 * Wire-format notes (verified against the live v1beta API):
 *  - There is no `role: "function"`. The API answers 400 with the list of legal
 *    roles, so tool results ride a `user` turn carrying a functionResponse part.
 *  - Model parts are echoed back verbatim on the next turn. Gemini 3 attaches a
 *    `thoughtSignature` to the part that requested a tool and rejects a history
 *    where it was dropped, so parts are never rebuilt field by field.
 *  - No `responseMimeType`/`responseJsonSchema` anywhere: the Co-Pilot answers
 *    in prose and asks for tools, and JSON mode is mutually exclusive with
 *    function calling on this API.
 */
import {
  addUsage,
  AIError,
  NO_USAGE,
  type ChatPart,
  type ChatReply,
  type ChatTurn,
  type FunctionCall,
  type IAIService,
  type TokenUsage,
  type ToolDefinition,
} from "./ai.interface.ts";
import { CO_PILOT_PERSONA } from "./prompts.ts";

export interface GoogleAIConfig {
  apiKey: string;
  /** With or without the "models/" prefix; normalized internally. */
  model: string;
  /** Override for tests/mocks. Defaults to the public v1beta endpoint. */
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface WireTurn {
  role: "user" | "model";
  parts: ChatPart[];
}

export class GoogleAIService implements IAIService {
  readonly provider = "google-ai";
  readonly model: string;

  #apiKey: string;
  #baseUrl: string;
  #timeoutMs: number;

  constructor(config: GoogleAIConfig) {
    this.model = normalizeModel(config.model);
    this.#apiKey = config.apiKey;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#timeoutMs = config.timeoutMs ?? 60_000;
  }

  chat(messages: ChatTurn[], tools: ToolDefinition[]): Promise<ChatReply> {
    return generateTurn(messages, tools, (body) =>
      fetch(`${this.#baseUrl}/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header rather than ?key= so the secret stays out of URLs and logs.
          "x-goog-api-key": this.#apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      }),
    );
  }
}

// ── The Gemini wire, shared with vertex-ai.service.ts ─────────────
//
// Google AI Studio and Vertex AI speak the same generateContent body and
// envelope; only the URL and the credential differ. So a provider supplies
// `post` — one HTTP call with its own auth — and everything else lives here.

/**
 * One model turn over the Gemini wire: builds the body, retries a turn that
 * comes back empty once, and adds up the tokens of every attempt, since an
 * empty attempt is billed like any other.
 */
export async function generateTurn(
  messages: ChatTurn[],
  tools: ToolDefinition[],
  post: (body: unknown) => Promise<Response>,
): Promise<ChatReply> {
  if (messages.length === 0) throw new AIError("upstream", "no messages to send");

  const body = {
    contents: toWire(messages),
    // A tool-less request is legal and means "just talk" — but an empty
    // `tools` array is not, so the field is omitted rather than sent bare.
    ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
    generationConfig: {
      // Conversational, not creative: high enough to write readable prose,
      // low enough that it doesn't invent tool names.
      temperature: 0.7,
      topP: 0.95,
      // Seed data for several tables is a big function call; 4k truncated it.
      maxOutputTokens: 8192,
    },
  };

  // Generation is stochastic: a turn can come back empty (safety block, a
  // malformed function call the API drops). One retry, then give up.
  let usage = NO_USAGE;
  let lastError: AIError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let parts: ChatPart[];
    try {
      const result = await callRetryingBusy(post, body);
      usage = addUsage(usage, result.usage);
      parts = result.parts;
    } catch (e) {
      const error =
        e instanceof AIError
          ? e
          : (() => {
              const timedOut =
                e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
              return new AIError(
                timedOut ? "timeout" : "upstream",
                timedOut ? "the AI provider timed out" : "could not reach the AI provider",
                String(e),
              );
            })();
      error.usage = addUsage(usage, error.usage);
      throw error;
    }

    const reply = toReply(parts, usage);
    if (reply.text || reply.calls.length > 0) return reply;
    lastError = new AIError("upstream", "the model returned an empty turn");
    console.warn(`[ai] attempt ${attempt} produced an empty turn`);
  }
  lastError!.usage = usage;
  throw lastError!;
}

/**
 * Waits before each retry of a busy provider. Google answers 503 "currently
 * experiencing high demand" in bursts, and 429 when a quota is momentarily
 * spent; both usually clear within seconds, so a turn waits a little rather
 * than failing. AI_BUSY_RETRY_MS scales the waits (tests make them short).
 */
const BUSY_RETRY_BASE_MS = (() => {
  const n = Number(process.env.AI_BUSY_RETRY_MS ?? 1000);
  return Number.isFinite(n) && n >= 0 && n <= 30_000 ? n : 1000;
})();
const BUSY_RETRY_DELAYS_MS = [BUSY_RETRY_BASE_MS, 3 * BUSY_RETRY_BASE_MS];

async function callRetryingBusy(
  post: (body: unknown) => Promise<Response>,
  body: unknown,
): Promise<{ parts: ChatPart[]; usage: TokenUsage }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(post, body);
    } catch (e) {
      if (!(e instanceof AIError) || e.kind !== "busy" || attempt >= BUSY_RETRY_DELAYS_MS.length) throw e;
      console.warn(`[ai] provider busy, retrying in ${BUSY_RETRY_DELAYS_MS[attempt]}ms`);
      await Bun.sleep(BUSY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function callOnce(
  post: (body: unknown) => Promise<Response>,
  body: unknown,
): Promise<{ parts: ChatPart[]; usage: TokenUsage }> {
  const res = await post(body);
  const raw = await res.text();
  if (res.status === 503 || res.status === 429)
    throw new AIError("busy", `AI provider is busy (${res.status})`, raw.slice(0, 500));
  if (!res.ok)
    throw new AIError("upstream", `AI provider returned ${res.status}`, raw.slice(0, 500));

  let envelope: any;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new AIError("upstream", "AI provider returned a non-JSON envelope", raw.slice(0, 200));
  }

  const usage = usageOf(envelope?.usageMetadata);
  const candidate = envelope?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) {
    // Safety blocks and token exhaustion both land here with no parts — and
    // the prompt was still read, so its tokens still count.
    const reason = candidate?.finishReason ?? envelope?.promptFeedback?.blockReason ?? "unknown";
    const error = new AIError("upstream", `AI provider returned no content (${reason})`);
    error.usage = usage;
    throw error;
  }
  return { parts: parts as ChatPart[], usage };
}

/**
 * `usageMetadata` → TokenUsage. `totalTokenCount` already includes thinking
 * and tool-use prompt tokens; the sum of the parts is the fallback for an
 * envelope that leaves it out. Anything missing or malformed counts as 0.
 */
export function usageOf(meta: any): TokenUsage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const promptTokens = n(meta?.promptTokenCount) + n(meta?.toolUsePromptTokenCount);
  const outputTokens = n(meta?.candidatesTokenCount) + n(meta?.thoughtsTokenCount);
  const totalTokens = n(meta?.totalTokenCount) || promptTokens + outputTokens;
  return { promptTokens, outputTokens, totalTokens };
}

// ── helpers ───────────────────────────────────────────────────────

/** "gemma-4" and "models/gemma-4" both address models/gemma-4. */
function normalizeModel(model: string): string {
  const trimmed = model.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.startsWith("models/") ? trimmed : `models/${trimmed}`;
}

/**
 * Neutral history → Google `contents`.
 *
 * The persona is prepended to the first user turn on every request, on a copy:
 * the caller's history stays clean (so the browser never sees the system rules,
 * and can never edit them) and the instructions stay in context for turn 20 of
 * a conversation instead of decaying out of a single opening message.
 */
export function toWire(messages: ChatTurn[]): WireTurn[] {
  let personaApplied = false;
  return messages.map((turn) => {
    // Tool results have no role of their own on this API — they are a user turn
    // whose part happens to be a functionResponse.
    const role: "user" | "model" = turn.role === "model" ? "model" : "user";
    if (personaApplied || turn.role !== "user") return { role, parts: turn.parts };

    const first = turn.parts.findIndex((p) => typeof p.text === "string");
    if (first === -1) return { role, parts: turn.parts };
    personaApplied = true;
    const parts = turn.parts.map((p, i) =>
      i === first ? { ...p, text: `${CO_PILOT_PERSONA}${p.text}` } : p,
    );
    return { role, parts };
  });
}

/** Google reply parts → the two things the agent loop acts on. */
export function toReply(parts: ChatPart[], usage: TokenUsage = NO_USAGE): ChatReply {
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  const calls: FunctionCall[] = [];
  for (const part of parts) {
    const call = part.functionCall as FunctionCall | undefined;
    if (!call || typeof call.name !== "string" || !call.name) continue;
    calls.push({
      name: call.name,
      args: call.args && typeof call.args === "object" ? call.args : {},
      ...(typeof call.id === "string" ? { id: call.id } : {}),
    });
  }

  return { turn: { role: "model", parts }, text, calls, usage };
}
