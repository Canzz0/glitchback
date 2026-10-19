import { PROVIDERS as API_PROVIDERS, type DefaultProvider, type Env } from "../schema/llm.ts";
import { LABELS } from "../server/github.ts";
import { tokenUrl } from "./templates.ts";
import { t } from "./i18n.ts";

/**
 * Live checks shared by `init` (right after a key or token is pasted) and `doctor`.
 * Each one makes at most two small requests, never costs model tokens, and gives up after 5 s.
 */
export type CheckResult = { ok: true; detail?: string } | { ok: false; reason: string; fix?: string; offline?: boolean };

const TIMEOUT = 5000;
const signal = () => AbortSignal.timeout(TIMEOUT);

async function request(url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: signal() });
  } catch {
    return null; // offline, DNS, timeout
  }
}

/**
 * Can this token open issues in this repo? GET /repos proves access; creating the base
 * `glitchback` label proves the Issues write permission (422 = it already exists, which
 * also needs write access). Setup creates that label anyway, so the check changes nothing.
 */
export async function checkGithubToken(token: string, repo: string): Promise<CheckResult> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const fix = t(`Yeni token: ${tokenUrl(repo)}`, `New token: ${tokenUrl(repo)}`);
  const res = await request(`https://api.github.com/repos/${repo}`, { headers });
  if (!res) return { ok: false, offline: true, reason: t("GitHub'a ulaşılamadı", "Could not reach GitHub"), fix: t("İnternet bağlantınızı kontrol edin.", "Check your internet connection.") };
  if (res.status === 401) return { ok: false, reason: t("Token geçersiz ya da süresi dolmuş", "The token is invalid or expired"), fix };
  if (res.status === 403 || res.status === 404) {
    return { ok: false, reason: t(`Token ${repo} reposunu göremiyor`, `The token cannot see ${repo}`), fix: t(`Token'da "Repository access" kısmında ${repo} seçili olmalı. ${fix}`, `The token's "Repository access" must include ${repo}. ${fix}`) };
  }
  if (!res.ok) return { ok: false, reason: `GitHub ${res.status}` };

  const l = LABELS.base;
  const label = await request(`https://api.github.com/repos/${repo}/labels`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: l.name, color: l.color, description: l.description }),
  });
  if (!label) return { ok: false, offline: true, reason: t("GitHub'a ulaşılamadı", "Could not reach GitHub") };
  if (label.status === 201 || label.status === 422) return { ok: true, detail: t(`${repo} reposuna issue açabiliyor`, `can open issues in ${repo}`) };
  if (label.status === 403 || label.status === 404) {
    return { ok: false, reason: t("Token'ın Issues: write izni yok", "The token lacks the Issues: write permission"), fix };
  }
  return { ok: false, reason: `GitHub ${label.status}` };
}

/**
 * Is this AI key accepted? Lists models, which is free. Uses the same base URL the app would
 * (GEMINI_BASE_URL, OPENAI_BASE_URL... in `env`), so proxies are checked too.
 */
export async function checkModelKey(provider: DefaultProvider, key: string, env: Env): Promise<CheckResult> {
  const preset = API_PROVIDERS[provider];
  const base = (env[preset.baseUrlEnv]?.trim() || preset.baseUrl).replace(/\/+$/, "");
  const headers: Record<string, string> =
    preset.api === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
  const res = await request(`${base}/models`, { headers });
  if (!res) return { ok: false, offline: true, reason: t("Sağlayıcıya ulaşılamadı", "Could not reach the provider"), fix: t("İnternet bağlantınızı kontrol edin.", "Check your internet connection.") };
  if (res.ok) return { ok: true };
  if (res.status === 429) return { ok: true, detail: t("anahtar geçerli (şu an hız sınırında)", "key accepted (rate limited right now)") };
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, reason: t("Anahtar reddedildi", "The key was rejected") };
  return { ok: false, reason: `HTTP ${res.status}` };
}

export interface DevServerInfo {
  github?: boolean;
  triage?: string;
  auto_reports?: boolean;
}

/** The app's own endpoint; in development it says what the server sees (GitHub on/off, triage chain). */
export async function checkDevServer(url: string): Promise<{ ok: true; info: DevServerInfo } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, info: (await res.json().catch(() => ({}))) as DevServerInfo };
  } catch {
    return { ok: false, reason: t("çalışmıyor", "not running") };
  }
}
