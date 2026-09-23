/**
 * Provider selection + boot-time config validation.
 *
 * The rest of the app imports only from here and ai.interface.ts, so adding a
 * provider is a new file plus a case in createAIService().
 */
import type { IAIService } from "./ai.interface.ts";
import { GoogleAIService } from "./google-ai.service.ts";
import { loadServiceAccountKey, VertexAIService } from "./vertex-ai.service.ts";

export * from "./ai.interface.ts";
export { CO_PILOT_PERSONA, CO_PILOT_TOOLS, STARTER_CATALOGUE } from "./prompts.ts";

/**
 * The Co-Pilot is an agent, so the default has to be a model that can actually
 * call functions — the Gemma family cannot, and would leave every tool request
 * answered with prose about the tool. Override with AI_MODEL_NAME.
 *
 * Production runs Gemini 3.1 Flash-Lite on Vertex AI: the cheapest Gemini that
 * calls functions, which matters because every turn is paid for.
 */
export const DEFAULT_VERTEX_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_AI_MODEL = "models/gemini-3.5-flash-lite";

/** Model strings become a URL path segment — keep them boring. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;
/** A GCP project id, or a location such as "global" or "us-central1". */
const GCP_NAME_RE = /^[a-z][a-z0-9-]{1,62}$/;

export interface AIEnv {
  AI_PROVIDER?: string;
  GOOGLE_AI_API_KEY?: string;
  VERTEX_PROJECT_ID?: string;
  VERTEX_LOCATION?: string;
  VERTEX_CREDENTIALS_FILE?: string;
  VERTEX_TOKEN_URL?: string;
  AI_MODEL_NAME?: string;
  AI_BASE_URL?: string;
  AI_TIMEOUT_MS?: string;
}

export interface AIConfigResult {
  service: IAIService | null;
  /** Why AI is off, when it is off — surfaced in the boot log. */
  reason?: string;
}

/**
 * Validates AI env vars strictly and returns a configured service, or null
 * when AI is intentionally disabled (no credential). Throws on *malformed*
 * config — including a Vertex key file that is missing or unusable — so a typo
 * fails the boot rather than silently disabling the feature.
 *
 * AI_PROVIDER picks the provider; left unset it is `vertex` when
 * VERTEX_PROJECT_ID is set and `google` otherwise, so an existing AI Studio
 * setup keeps working and a Vertex one needs no extra switch.
 */
export async function createAIService(env: AIEnv = process.env as AIEnv): Promise<AIConfigResult> {
  const vertexProject = (env.VERTEX_PROJECT_ID ?? "").trim();
  const provider = (env.AI_PROVIDER ?? "").trim() || (vertexProject ? "vertex" : "google");
  if (provider !== "vertex" && provider !== "google")
    throw new Error(`AI_PROVIDER must be "vertex" or "google", not ${JSON.stringify(provider)}`);

  const baseUrl = (env.AI_BASE_URL ?? "").trim();
  const rawTimeout = (env.AI_TIMEOUT_MS ?? "").trim();
  const model = (env.AI_MODEL_NAME ?? (provider === "vertex" ? DEFAULT_VERTEX_MODEL : DEFAULT_AI_MODEL)).trim();

  if (!MODEL_RE.test(model))
    throw new Error(`AI_MODEL_NAME is not a valid model string: ${JSON.stringify(model)}`);

  let timeoutMs = 60_000;
  if (rawTimeout) {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n < 1_000 || n > 300_000)
      throw new Error("AI_TIMEOUT_MS must be a number between 1000 and 300000");
    timeoutMs = n;
  }

  if (baseUrl && !/^https?:\/\//.test(baseUrl))
    throw new Error("AI_BASE_URL must be an http(s) URL");

  if (provider === "vertex") {
    const location = (env.VERTEX_LOCATION ?? "global").trim();
    const credentials = (env.VERTEX_CREDENTIALS_FILE ?? "").trim();
    const tokenUrl = (env.VERTEX_TOKEN_URL ?? "").trim();
    if (!vertexProject) return { service: null, reason: "VERTEX_PROJECT_ID is not set" };
    if (!GCP_NAME_RE.test(vertexProject))
      throw new Error(`VERTEX_PROJECT_ID is not a valid project id: ${JSON.stringify(vertexProject)}`);
    if (!GCP_NAME_RE.test(location))
      throw new Error(`VERTEX_LOCATION is not a valid location: ${JSON.stringify(location)}`);
    if (!credentials) throw new Error("VERTEX_CREDENTIALS_FILE must be set when VERTEX_PROJECT_ID is");
    if (tokenUrl && !/^https?:\/\//.test(tokenUrl))
      throw new Error("VERTEX_TOKEN_URL must be an http(s) URL");
    // Vertex addresses a publisher model by its bare id.
    const bare = model.replace(/^models\//, "");
    return {
      service: new VertexAIService({
        projectId: vertexProject,
        location,
        model: bare,
        key: await loadServiceAccountKey(credentials),
        baseUrl: baseUrl || undefined,
        tokenUrl: tokenUrl || undefined,
        timeoutMs,
      }),
    };
  }

  const apiKey = (env.GOOGLE_AI_API_KEY ?? "").trim();
  if (!apiKey) return { service: null, reason: "GOOGLE_AI_API_KEY is not set" };

  return {
    service: new GoogleAIService({
      apiKey,
      model,
      baseUrl: baseUrl || undefined,
      timeoutMs,
    }),
  };
}
