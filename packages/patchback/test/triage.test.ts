import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLlmScores, ruleHints, triage } from "../src/server/triage.ts";

const cfg = {
  jev: null,
  llm: null,
  thresholds: { area: 0.6, injection: 0.5, isBug: 0.5, tierLow: 0.34, tierMid: 0.67 },
} as any;

const report = (over: any = {}): any => ({
  schema_version: "1.0",
  project_key: "k",
  user_message: over.user_message ?? "something is broken",
  source: "user_report",
  context: {
    url: "https://app/checkout",
    console_errors: over.console_errors ?? [],
    failed_requests: over.failed_requests ?? [],
    breadcrumbs: [],
  },
});

test("a 5xx response is a backend hint", () => {
  const h = ruleHints(report({ failed_requests: [{ method: "GET", url: "/api/x", status: 503 }] }));
  assert.equal(h.backend, true);
  assert.equal(h.frontend, false);
});

test("a client-side TypeError is a frontend hint", () => {
  const h = ruleHints(report({ console_errors: ["TypeError: x is not a function"] }));
  assert.equal(h.frontend, true);
});

test("rules-only triage routes a 500 to backend even with no model", async () => {
  const r = await triage(report({ failed_requests: [{ method: "POST", url: "/api/pay", status: 500 }] }) as any, cfg);
  assert.equal(r.decided_by, "rules");
  assert.equal(r.area, "backend");
});

test("rules-only triage with no signal stays unclear for a human", async () => {
  const r = await triage(report() as any, cfg);
  assert.equal(r.area, "unclear");
});

test("difficulty maps to a model tier", async () => {
  const r = await triage(report() as any, cfg);
  assert.ok(["low", "mid", "high"].includes(r.tier));
});

test("a model answer of 0 stays 0 instead of becoming 0.5", () => {
  const s = parseLlmScores({ is_bug: 1, frontend: 0, backend: "0", injection_risk: 0, severity: 0.2, difficulty: 0 });
  assert.equal(s.injection_risk, 0);
  assert.equal(s.frontend, 0);
  assert.equal(s.backend, 0);
  assert.equal(s.difficulty, 0);
});

test("missing or garbage model values fall back to 0.5 and are clamped", () => {
  const s = parseLlmScores({ is_bug: "yes", frontend: null, backend: 7, severity: -1 });
  assert.equal(s.is_bug, 0.5);
  assert.equal(s.frontend, 0.5);
  assert.equal(s.backend, 1);
  assert.equal(s.severity, 0);
  assert.equal(s.injection_risk, 0.5);
});

test("any configured model provider is used through cfg.llm, and its 0 stays 0", async () => {
  let seen: any = null;
  const llm = {
    model: "anthropic:claude-haiku-4-5-20251001",
    ask: async (req: any) => {
      seen = req;
      return { is_bug: 0.9, frontend: 0.8, backend: 0.1, injection_risk: 0, severity: 0.7, difficulty: 0.1 };
    },
  };
  const r = await triage(report({ user_message: "button does nothing" }) as any, { ...cfg, llm });
  assert.equal(r.decided_by, "llm");
  assert.equal(r.area, "frontend");
  assert.equal(r.injection_risk, 0);
  assert.equal(r.tier, "low");
  assert.match(seen.user, /<report>/);
});

test("a failing model falls back to rules instead of losing the report", async () => {
  const llm = { model: "openai:x", ask: async () => { throw new Error("401"); } };
  const r = await triage(report({ failed_requests: [{ method: "GET", url: "/api/x", status: 502 }] }) as any, { ...cfg, llm });
  assert.equal(r.decided_by, "rules");
  assert.equal(r.area, "backend");
});

/** Stubs fetch for the Jev endpoint only. */
function stubJev(respond: () => { status: number; json?: unknown }) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "jev-latest");
    assert.equal(body.questions.frontend.type, "noul");
    assert.equal(body.questions.severity.criteria.length, 4);
    calls++;
    const r = respond();
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as typeof fetch;
  return { calls: () => calls, restore: () => (globalThis.fetch = original) };
}

const jevAnswers = {
  answers: {
    is_bug: { type: "noul", noul: 0.95 },
    frontend: { type: "noul", noul: 0.9 },
    backend: { type: "noul", noul: 0.05 },
    injection_risk: { type: "noul", noul: 0.01 },
    severity: { type: "score", score: 3 },
    difficulty: { type: "score", score: 0 },
  },
};
const jev = { apiKey: "jv_test", model: "jev-latest" };

test("Jev is the primary engine even when a fallback model is configured", async () => {
  const stub = stubJev(() => ({ status: 200, json: jevAnswers }));
  let llmAsked = false;
  const llm = { model: "gemini:gemini-3.5-flash", ask: async () => ((llmAsked = true), {}) };
  try {
    const r = await triage(report() as any, { ...cfg, jev, llm });
    assert.equal(r.decided_by, "jev");
    assert.equal(r.area, "frontend");
    assert.equal(r.severity, 1);
    assert.equal(r.tier, "low");
    assert.equal(llmAsked, false);
  } finally {
    stub.restore();
  }
});

test("when Jev is down, the fallback model triages instead of rules", async () => {
  const stub = stubJev(() => ({ status: 500 }));
  const llm = {
    model: "gemini:gemini-3.5-flash",
    ask: async () => ({ is_bug: 0.9, frontend: 0.1, backend: 0.9, injection_risk: 0, severity: 0.5, difficulty: 0.5 }),
  };
  try {
    const r = await triage(report() as any, { ...cfg, jev, llm });
    assert.equal(r.decided_by, "llm");
    assert.equal(r.area, "backend");
  } finally {
    stub.restore();
  }
});

test("Jev overload (529) is retried once before giving up", async () => {
  let n = 0;
  const stub = stubJev(() => (n++ === 0 ? { status: 529 } : { status: 200, json: jevAnswers }));
  try {
    const r = await triage(report() as any, { ...cfg, jev });
    assert.equal(r.decided_by, "jev");
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
  }
});
