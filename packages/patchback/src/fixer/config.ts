import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const RepoConfig = z.object({
  /** Only files under these prefixes can be read as context or changed. */
  allowed_paths: z.array(z.string()).default(["src/"]),
  /** Never changed, even inside allowed_paths. */
  deny_paths: z
    .array(z.string())
    .default([
      ".github/", ".env", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
      ".npmrc", ".yarnrc.yml", ".husky/", ".git/", "vercel.json", "netlify.toml", "Dockerfile",
      "middleware.ts", "middleware.js", "next.config.js", "next.config.mjs", "next.config.ts",
    ]),
  /**
   * Model per difficulty tier, as "provider:model" (anthropic, openai, gemini, openrouter, ollama).
   * Tiers may use different providers. A bare name goes to the OpenAI-compatible LLM_BASE_URL.
   */
  models: z.object({ low: z.string(), mid: z.string(), high: z.string() }),
  /** Route pattern → git pathspecs to always include as context. */
  routes: z.record(z.array(z.string())).default({}),
  max_context_chars: z.number().default(120_000),
  max_changed_lines: z.number().default(300),
  /** Language of the analysis comments. */
  language: z.enum(["tr", "en"]).default("tr"),
  /** Login of the account that posts suggestions; only its suggestions are applied. */
  bot_login: z.string().default("github-actions[bot]"),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export function loadRepoConfig(path = ".patchback.yml"): RepoConfig {
  if (!existsSync(path)) throw new Error(`${path} not found in the repository root`);
  const cfg = RepoConfig.parse(parse(readFileSync(path, "utf8")));
  // Local runs post comments as the token owner, not github-actions[bot] (see scripts/fixer-local.mjs).
  const botLogin = process.env.PATCHBACK_BOT_LOGIN?.trim();
  return botLogin ? { ...cfg, bot_login: botLogin } : cfg;
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
