/**
 * Provider-agnostic model access shared by the intake service and the fixer.
 *
 * A model is written as "provider:model", e.g.
 *   anthropic:claude-sonnet-5     openai:gpt-6-luna      gemini:gemini-3.5-flash
 *   openrouter:qwen/qwen3-coder   ollama:qwen2.5-coder
 * Each provider reads its own key (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), so
 * tiers can mix providers. A name without a known prefix ("gpt-4o-mini",
 * "qwen/qwen3-coder:free") goes to any OpenAI-compatible endpoint set with
 * LLM_BASE_URL / LLM_API_KEY, which is how self-hosted and other vendors plug in.
 */

export type Env = Record<string, string | undefined>;
type Api = "openai" | "anthropic";

interface ProviderPreset {
  api: Api;
  baseUrl: string;
  /** Env vars checked in order for the API key. Empty = no key needed. */
  keys: string[];
  /** Env var that overrides baseUrl (proxies, Azure-style gateways, remote Ollama). */
  baseUrlEnv: string;
}

export const PROVIDERS = {
  anthropic: { api: "anthropic", baseUrl: "https://api.anthropic.com/v1", keys: ["ANTHROPIC_API_KEY"], baseUrlEnv: "ANTHROPIC_BASE_URL" },
  openai: { api: "openai", baseUrl: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY"], baseUrlEnv: "OPENAI_BASE_URL" },
  gemini: {
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    baseUrlEnv: "GEMINI_BASE_URL",
  },
  openrouter: { api: "openai", baseUrl: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY"], baseUrlEnv: "OPENROUTER_BASE_URL" },
  ollama: { api: "openai", baseUrl: "http://localhost:11434/v1", keys: [], baseUrlEnv: "OLLAMA_BASE_URL" },
} satisfies Record<string, ProviderPreset>;

export type ProviderName = keyof typeof PROVIDERS | "custom";

export interface ModelRef {
  /** As written by the user, used in logs and comments. */
  spec: string;
  provider: ProviderName;
  api: Api;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const trimSlash = (u: string) => u.replace(/\/+$/, "");

export function resolveModel(spec: string, env: Env): ModelRef {
  const s = spec.trim();
  if (!s) throw new Error("Model name is empty");
  const colon = s.indexOf(":");
  const prefix = colon > 0 ? s.slice(0, colon).toLowerCase() : "";

  if (prefix in PROVIDERS) {
    const provider = prefix as keyof typeof PROVIDERS;
    const preset: ProviderPreset = PROVIDERS[provider];
    const model = s.slice(colon + 1).trim();
    if (!model) throw new Error(`"${s}": model name is missing after "${prefix}:"`);
    const apiKey = preset.keys.map((k) => clean(env[k])).find(Boolean);
    if (preset.keys.length && !apiKey) {
      throw new Error(`"${s}" needs ${preset.keys.join(" or ")} to be set`);
    }
    return { spec: s, provider, api: preset.api, model, baseUrl: trimSlash(clean(env[preset.baseUrlEnv]) ?? preset.baseUrl), apiKey };
  }

  // No known prefix: the OpenAI-compatible endpoint in LLM_BASE_URL. There is no default host:
  // sending LLM_API_KEY to a service the user never named would leak it.
  const baseUrl = clean(env.LLM_BASE_URL);
  if (!baseUrl) {
    throw new Error(`"${s}" has no provider prefix, so it needs LLM_BASE_URL (or write it as openrouter:${s}, openai:${s}, ...)`);
  }
  return {
    spec: s,
    provider: "custom",
    api: "openai",
    model: s,
    baseUrl: trimSlash(baseUrl),
    apiKey: clean(env.LLM_API_KEY),
  };
}

export interface ChatRequest {
  system: string;
  user: string;
  /** Sent when given; dropped automatically if the model rejects it (e.g. reasoning models). */
  temperature?: number;
  /** Upper bound for the answer. Required by Anthropic; OpenAI-compatible APIs use their own default. */
  maxTokens: number;
  timeoutMs: number;
}

/** Parameters some models refuse. On a 400 that names one of them, it is removed and the call retried. */
const OPTIONAL_PARAMS = ["temperature", "response_format"] as const;

async function postWithFallback(ref: ModelRef, url: string, headers: Record<string, string>, body: Record<string, unknown>, timeoutMs: number) {
  const payload = { ...body };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as any;
    const unsupported =
      (res.status === 400 || res.status === 422) && attempt < OPTIONAL_PARAMS.length
        ? OPTIONAL_PARAMS.find((p) => p in payload && text.toLowerCase().includes(p))
        : undefined;
    if (!unsupported) throw new Error(`Model ${ref.spec} failed with ${res.status}: ${text.slice(0, 500)}`);
    delete payload[unsupported];
  }
}

async function callAnthropic(ref: ModelRef, req: ChatRequest): Promise<string> {
  const data = await postWithFallback(
    ref,
    `${ref.baseUrl}/messages`,
    { "x-api-key": ref.apiKey ?? "", "anthropic-version": "2023-06-01" },
    {
      model: ref.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    req.timeoutMs,
  );
  if (data.stop_reason === "max_tokens") throw new Error(`Model ${ref.spec} ran out of output tokens`);
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}

async function callOpenAiCompatible(ref: ModelRef, req: ChatRequest): Promise<string> {
  const data = await postWithFallback(
    ref,
    `${ref.baseUrl}/chat/completions`,
    ref.apiKey ? { Authorization: `Bearer ${ref.apiKey}` } : {},
    {
      model: ref.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_object" },
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    req.timeoutMs,
  );
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error(`Model ${ref.spec} ran out of output tokens`);
  const content = choice?.message?.content;
  if (Array.isArray(content)) return content.map((p: { text?: string }) => p.text ?? "").join("");
  return typeof content === "string" ? content : "";
}

/** Asks for a single JSON object and parses it, whatever the provider. */
export async function chatJson<T = Record<string, unknown>>(ref: ModelRef, req: ChatRequest): Promise<T> {
  const system = `${req.system}\nRespond with a single JSON object and nothing else.`;
  const text = ref.api === "anthropic" ? await callAnthropic(ref, { ...req, system }) : await callOpenAiCompatible(ref, { ...req, system });
  return parseJsonLoose(text) as T;
}

/** Accepts bare JSON, JSON in a ```json fence, or JSON surrounded by a sentence. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {}
  }
  throw new Error(`Model did not return valid JSON: ${t.slice(0, 200)}`);
}
