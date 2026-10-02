import { test } from "node:test";
import assert from "node:assert/strict";
import { chatJson, parseJsonLoose, resolveModel } from "../src/schema/llm.ts";

const env = {
  ANTHROPIC_API_KEY: "sk-ant",
  OPENAI_API_KEY: "sk-oai",
  GEMINI_API_KEY: "g-key",
  OPENROUTER_API_KEY: "or-key",
  LLM_BASE_URL: "https://llm.example.com/v1/",
  LLM_API_KEY: "custom-key",
};

test("provider prefixes pick endpoint and their own key", () => {
  const a = resolveModel("anthropic:claude-sonnet-5", env);
  assert.deepEqual([a.api, a.baseUrl, a.model, a.apiKey], ["anthropic", "https://api.anthropic.com/v1", "claude-sonnet-5", "sk-ant"]);
  const g = resolveModel("gemini:gemini-3.5-flash", env);
  assert.deepEqual([g.api, g.baseUrl, g.apiKey], ["openai", "https://generativelanguage.googleapis.com/v1beta/openai", "g-key"]);
  const o = resolveModel("openai:gpt-6-luna", env);
  assert.equal(o.apiKey, "sk-oai");
  const r = resolveModel("openrouter:qwen/qwen3-coder:free", env);
  assert.deepEqual([r.model, r.apiKey], ["qwen/qwen3-coder:free", "or-key"]);
});

test("ollama needs no key and its address can be overridden", () => {
  const l = resolveModel("ollama:qwen2.5-coder", { OLLAMA_BASE_URL: "http://gpu-box:11434/v1" });
  assert.deepEqual([l.baseUrl, l.apiKey], ["http://gpu-box:11434/v1", undefined]);
});

test("names without a known prefix use the generic OpenAI-compatible settings", () => {
  const c = resolveModel("gpt-4o-mini", env);
  assert.deepEqual([c.provider, c.baseUrl, c.apiKey], ["custom", "https://llm.example.com/v1", "custom-key"]);
  const slashy = resolveModel("qwen/qwen3-coder:free", env);
  assert.equal(slashy.provider, "custom");
  assert.equal(slashy.model, "qwen/qwen3-coder:free");
});

test("a missing key is a clear error, and another provider's key is never borrowed", () => {
  assert.throws(() => resolveModel("anthropic:claude-sonnet-5", { LLM_API_KEY: "x", OPENAI_API_KEY: "y" }), /ANTHROPIC_API_KEY/);
  assert.throws(() => resolveModel("gemini:gemini-3.5-flash", { GEMINI_API_KEY: "  " }), /GEMINI_API_KEY or GOOGLE_API_KEY/);
});

test("parseJsonLoose accepts fences and surrounding prose", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":"```"}\n```'), { a: "```" });
  assert.deepEqual(parseJsonLoose('Here you go:\n{"a":2}\nThanks'), { a: 2 });
  assert.throws(() => parseJsonLoose("no json here"), /valid JSON/);
});

/** Replaces fetch for one test and records each request. */
function mockFetch(handler: (url: string, body: any, headers: Record<string, string>) => { status: number; json: unknown }) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    calls.push({ url, body, headers });
    const r = handler(url, body, headers);
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const req = { system: "sys", user: "usr", temperature: 0, maxTokens: 100, timeoutMs: 5000 };

test("anthropic uses the Messages API with its own headers", async () => {
  const m = mockFetch(() => ({ status: 200, json: { content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn" } }));
  try {
    const out = await chatJson(resolveModel("anthropic:claude-sonnet-5", env), req);
    assert.deepEqual(out, { ok: true });
    assert.equal(m.calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(m.calls[0].headers["x-api-key"], "sk-ant");
    assert.equal(m.calls[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(m.calls[0].body.max_tokens, 100);
    assert.match(m.calls[0].body.system, /^sys\n/);
  } finally {
    m.restore();
  }
});

test("a model that rejects temperature is retried without it", async () => {
  const m = mockFetch((_u, body) =>
    "temperature" in body
      ? { status: 400, json: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } }
      : { status: 200, json: { choices: [{ message: { content: '{"n":1}' }, finish_reason: "stop" }] } },
  );
  try {
    const out = await chatJson(resolveModel("openai:gpt-6-luna", env), req);
    assert.deepEqual(out, { n: 1 });
    assert.equal(m.calls.length, 2);
    assert.equal(m.calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(m.calls[0].headers.Authorization, "Bearer sk-oai");
    assert.ok(!("temperature" in m.calls[1].body));
  } finally {
    m.restore();
  }
});

test("other errors are not retried and name the model", async () => {
  const m = mockFetch(() => ({ status: 401, json: { error: "bad key" } }));
  try {
    await assert.rejects(chatJson(resolveModel("gemini:gemini-3.5-flash", env), req), /gemini:gemini-3.5-flash failed with 401/);
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("a cut-off answer is reported instead of parsed", async () => {
  const m = mockFetch(() => ({ status: 200, json: { choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] } }));
  try {
    await assert.rejects(chatJson(resolveModel("openrouter:x/y", env), req), /ran out of output tokens/);
  } finally {
    m.restore();
  }
});

test("a bare model name never sends LLM_API_KEY to a host the user did not name", () => {
  assert.throws(() => resolveModel("gpt-4o-mini", { LLM_API_KEY: "sk-mine" }), /LLM_BASE_URL/);
});
