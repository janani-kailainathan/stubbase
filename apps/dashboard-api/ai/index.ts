/**
 * Provider selection + boot-time config validation.
 *
 * The rest of the app imports only from here and ai.interface.ts, so adding a
 * provider is a new file plus a case in createAIService().
 */
import type { IAIService } from "./ai.interface.ts";
import { GoogleAIService } from "./google-ai.service.ts";

export * from "./ai.interface.ts";
export { CO_PILOT_PERSONA, CO_PILOT_TOOLS } from "./prompts.ts";

/**
 * The Co-Pilot is an agent, so the default has to be a model that can actually
 * call functions — the Gemma family cannot, and would leave every tool request
 * answered with prose about the tool. Override with AI_MODEL_NAME.
 */
export const DEFAULT_AI_MODEL = "models/gemini-3.5-flash-lite";

/** Model strings become a URL path segment — keep them boring. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;

export interface AIEnv {
  GOOGLE_AI_API_KEY?: string;
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
 * when AI is intentionally disabled (no API key). Throws on *malformed*
 * config so a typo fails the boot rather than silently disabling the feature.
 */
export function createAIService(env: AIEnv = process.env as AIEnv): AIConfigResult {
  const apiKey = (env.GOOGLE_AI_API_KEY ?? "").trim();
  const model = (env.AI_MODEL_NAME ?? DEFAULT_AI_MODEL).trim();
  const baseUrl = (env.AI_BASE_URL ?? "").trim();
  const rawTimeout = (env.AI_TIMEOUT_MS ?? "").trim();

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
