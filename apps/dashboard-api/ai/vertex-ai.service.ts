/**
 * Vertex AI (Gemini on Google Cloud) implementation of IAIService.
 *
 * The request body and reply envelope are the Gemini wire that
 * google-ai.service.ts already speaks, so this file is only what differs: the
 * URL, which names a Cloud project and location, and the credential, which is
 * a short-lived OAuth access token rather than an API key.
 *
 * The token comes from a service-account key file, the standard way to call
 * Google Cloud from outside it. No SDK, keeping this app at zero npm
 * dependencies: the key signs an RS256 JWT with crypto.subtle, the JWT is
 * exchanged for an access token at Google's token endpoint, and the token is
 * cached until a minute before it expires (they last an hour). Concurrent
 * turns share one in-flight exchange rather than each starting their own.
 *
 * Wire notes that bite on Vertex as they do on AI Studio: there is no
 * `role: "function"` (tool results ride a user turn — toWire handles it), and
 * model parts must be echoed back verbatim for thoughtSignature.
 */
import { AIError, type ChatReply, type ChatTurn, type IAIService, type ToolDefinition } from "./ai.interface.ts";
import { generateTurn } from "./google-ai.service.ts";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface VertexAIConfig {
  projectId: string;
  /** "global", or a region such as "us-central1". */
  location: string;
  /** Bare model id, e.g. "gemini-3.1-flash-lite". */
  model: string;
  key: ServiceAccountKey;
  /** Overrides for tests/mocks: the API root up to and including /v1, and the token endpoint. */
  baseUrl?: string;
  tokenUrl?: string;
  timeoutMs?: number;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Refresh this long before the provider's stated expiry, so a token never lapses mid-call. */
const TOKEN_MARGIN_MS = 60_000;

/**
 * The global endpoint has no region in its host; a regional one does. Gemini 3
 * models are served from `global`, which is therefore the default.
 */
export function vertexBaseUrl(location: string): string {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1`;
}

export class VertexAIService implements IAIService {
  readonly provider = "vertex-ai";
  readonly model: string;

  #url: string;
  #tokenUrl: string;
  #key: ServiceAccountKey;
  #timeoutMs: number;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;

  constructor(config: VertexAIConfig) {
    this.model = config.model;
    const base = (config.baseUrl ?? vertexBaseUrl(config.location)).replace(/\/$/, "");
    this.#url =
      `${base}/projects/${encodeURIComponent(config.projectId)}` +
      `/locations/${encodeURIComponent(config.location)}` +
      `/publishers/google/models/${encodeURIComponent(config.model)}:generateContent`;
    this.#tokenUrl = config.tokenUrl ?? TOKEN_URL;
    this.#key = config.key;
    this.#timeoutMs = config.timeoutMs ?? 60_000;
  }

  chat(messages: ChatTurn[], tools: ToolDefinition[]): Promise<ChatReply> {
    return generateTurn(messages, tools, async (body) =>
      fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await this.#accessToken()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      }),
    );
  }

  /** A cached access token, or one fresh exchange shared by every caller waiting on it. */
  #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt) return Promise.resolve(this.#token.value);
    this.#pending ??= this.#exchange().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #exchange(): Promise<string> {
    const assertion = await signServiceAccountJwt(this.#key, this.#tokenUrl);
    const res = await fetch(this.#tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const raw = await res.text();
    // The body of a refused exchange names the reason (a disabled key, a clock
    // skew) and never the key itself, so it is safe to carry into the log.
    if (!res.ok)
      throw new AIError("upstream", `Google token endpoint returned ${res.status}`, raw.slice(0, 300));
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AIError("upstream", "Google token endpoint returned a non-JSON body");
    }
    const value = parsed?.access_token;
    const lifetime = Number(parsed?.expires_in);
    if (typeof value !== "string" || !value)
      throw new AIError("upstream", "Google token endpoint returned no access token");
    const ttlMs = Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : 3_600_000;
    this.#token = { value, expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_MARGIN_MS) };
    return value;
  }
}

// ── Service-account JWT ──────────────────────────────────────────

const base64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The PKCS#8 DER inside a "-----BEGIN PRIVATE KEY-----" block. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(body, "base64"));
}

/**
 * The self-signed assertion Google's token endpoint trades for an access
 * token: issued by the service account, for the cloud-platform scope, addressed
 * to the endpoint it is sent to, valid an hour.
 */
export async function signServiceAccountJwt(key: ServiceAccountKey, audience: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: audience, iat: now, exp: now + 3600 }),
  );
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Reads and checks a service-account key file at boot. Throws on anything
 * unusable, so a wrong path or a pasted-over file fails the boot instead of
 * failing every Co-Pilot turn later.
 */
export async function loadServiceAccountKey(path: string): Promise<ServiceAccountKey> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`VERTEX_CREDENTIALS_FILE does not exist: ${path}`);
  let parsed: any;
  try {
    parsed = await file.json();
  } catch {
    throw new Error(`VERTEX_CREDENTIALS_FILE is not JSON: ${path}`);
  }
  if (typeof parsed?.client_email !== "string" || !parsed.client_email.includes("@"))
    throw new Error("VERTEX_CREDENTIALS_FILE has no client_email; is it a service-account key?");
  if (typeof parsed?.private_key !== "string" || !parsed.private_key.includes("BEGIN PRIVATE KEY"))
    throw new Error("VERTEX_CREDENTIALS_FILE has no private_key; is it a service-account key?");
  const key = { client_email: parsed.client_email, private_key: parsed.private_key };
  // Prove the key imports now rather than on the first turn.
  await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return key;
}
