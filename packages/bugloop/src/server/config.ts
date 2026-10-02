import { chatJson, resolveModel, type ChatRequest, type Env } from "../schema/index.ts";

/**
 * Everything comes from environment variables and almost all of it is optional.
 *
 * Minimum to open GitHub issues: BUGLOOP_GITHUB_TOKEN (+ BUGLOOP_GITHUB_REPO,
 * which is detected on Vercel and in GitHub Actions). Without a token, reports
 * are printed to the server console, so the button works right after install.
 */
export interface Config {
  /** Only checked when set; same-origin installs do not need one. */
  projectKey: string | null;
  /** Origins allowed to post from another domain. null = same-origin only. */
  allowedOrigins: string[] | null;
  github: { token: string; repo: string } | null;
  jev: { apiKey: string; model: string } | null;
  llm: { model: string; ask: <T = Record<string, unknown>>(req: ChatRequest) => Promise<T> } | null;
  backend: { webhookUrl: string | null; webhookSecret: string | null; slackWebhookUrl: string | null };
  thresholds: { area: number; injection: number; isBug: number; tierLow: number; tierMid: number };
  rateLimitPer10Min: number;
  /**
   * GitHub writes (new issues + duplicate comments) per hour from typed reports, across all clients.
   * Client addresses can be forged; this cap cannot, so a flood never turns into thousands of issues.
   */
  maxGithubWritesPerHour: number;
  /** Jev / TRIAGE_MODEL calls per hour; beyond it the rules decide. Keeps a flood from becoming a bill. */
  maxModelTriagePerHour: number;
  /** Reports the widget sends by itself (failed requests, uncaught errors). */
  autoReports: {
    enabled: boolean;
    /** Per client, separate from rateLimitPer10Min so automatic reports never block a typed one. */
    perClientPer10Min: number;
    /** New issues per hour from automatic reports, across all clients. Duplicates do not count. */
    maxIssuesPerHour: number;
  };
  /** Reverse proxies in front of the app (Vercel, Nginx, Fly... = 1; exposed directly = 0). */
  trustedProxyHops: number;
}

const str = (env: Env, ...names: string[]) => {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return null;
};

export function configFromEnv(env: Env): Config {
  const num = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    const v = raw ? Number(raw) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };

  const token = str(env, "BUGLOOP_GITHUB_TOKEN", "GITHUB_TOKEN");
  const vercelRepo = env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
  const repo = str(env, "BUGLOOP_GITHUB_REPO", "GITHUB_REPO", "GITHUB_REPOSITORY") ?? vercelRepo;
  if (token && !repo) throw new Error("BUGLOOP_GITHUB_REPO is missing (owner/name)");
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`BUGLOOP_GITHUB_REPO must look like owner/name, got "${repo}"`);

  const jevKey = str(env, "TYPESAFE_API_KEY");
  const origins = str(env, "BUGLOOP_ALLOWED_ORIGINS", "ALLOWED_ORIGINS");

  return {
    projectKey: str(env, "BUGLOOP_PROJECT_KEY"),
    allowedOrigins: origins ? origins.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean) : null,
    github: token && repo ? { token, repo } : null,
    jev: jevKey ? { apiKey: jevKey, model: str(env, "JEV_MODEL") ?? "jev-latest" } : null,
    llm: triageModel(env),
    backend: {
      webhookUrl: str(env, "BACKEND_WEBHOOK_URL"),
      webhookSecret: str(env, "BACKEND_WEBHOOK_SECRET"),
      slackWebhookUrl: str(env, "SLACK_WEBHOOK_URL"),
    },
    thresholds: {
      area: num("AREA_THRESHOLD", 0.6),
      injection: num("INJECTION_THRESHOLD", 0.5),
      isBug: 0.5,
      tierLow: 0.34,
      tierMid: 0.67,
    },
    rateLimitPer10Min: num("RATE_LIMIT_PER_10_MIN", 5),
    maxGithubWritesPerHour: num("MAX_GITHUB_WRITES_PER_HOUR", 60),
    maxModelTriagePerHour: num("MAX_MODEL_TRIAGE_PER_HOUR", 300),
    autoReports: {
      enabled: !/^(0|off|false|no)$/i.test(env.BUGLOOP_AUTO_REPORTS?.trim() ?? ""),
      perClientPer10Min: num("AUTO_RATE_LIMIT_PER_10_MIN", 10),
      maxIssuesPerHour: num("AUTO_MAX_ISSUES_PER_HOUR", 20),
    },
    trustedProxyHops: Math.max(0, Math.floor(num("TRUSTED_PROXY_HOPS", 1))),
  };
}

/**
 * Fallback triage model, used only when Jev is not configured or fails.
 * TRIAGE_MODEL is "provider:model" (anthropic:…, openai:…, gemini:…, openrouter:…, ollama:…)
 * or a bare name for the OpenAI-compatible endpoint in LLM_BASE_URL.
 */
function triageModel(env: Env): Config["llm"] {
  const spec = env.TRIAGE_MODEL?.trim();
  if (!spec && !env.LLM_API_KEY?.trim()) return null;
  const ref = resolveModel(spec || "openai/gpt-4o-mini", env);
  if (ref.provider === "custom" && !ref.apiKey && !env.LLM_BASE_URL?.trim()) return null;
  return {
    model: ref.spec,
    ask: <T = Record<string, unknown>>(req: ChatRequest) => chatJson<T>(ref, req),
  };
}

/** "jev (jev-latest) → gemini:gemini-3.5-flash → rules" */
export function triageChain(cfg: Config): string {
  return [cfg.jev && `jev (${cfg.jev.model})`, cfg.llm?.model, "rules"].filter(Boolean).join(" → ");
}
