import { appendFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFixer, type IssueEvent } from "../fixer/run.ts";
import { ghReady, ghToken } from "./gh.ts";
import { bold, dim, gitRemoteRepo, ok, readEnvFiles, run } from "./util.ts";
import { t } from "./i18n.ts";

const MODEL_KEYS = [
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "LLM_BASE_URL", "LLM_API_KEY", "OLLAMA_BASE_URL",
];

async function gh<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}. ${t("Token'ın bu repoya erişimi var mı, issue numarası doğru mu?", "Does the token have access to this repo, and is the issue number right?")}`);
  return res.json() as Promise<T>;
}

/** git reads extra config from GIT_CONFIG_* (git 2.31+); child processes inherit it. */
function authEnv(token: string) {
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  process.env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  process.env.GIT_TERMINAL_PROMPT = "0";
}

/**
 * `glitchback suggest 12` / `glitchback fix 12` on your own machine.
 * Works on a temporary clone, so your working copy is never touched.
 */
export async function runLocalFixer(mode: "suggest" | "fix", issueNumber: number, dir: string) {
  const appDir = resolve(dir);
  const repo = gitRemoteRepo(appDir);
  if (!repo) throw new Error(t(`${appDir} için GitHub origin bulunamadı. Uygulamanın klasöründe çalıştırın.`, `No GitHub origin found for ${appDir}. Run this in your app's folder.`));

  const fileEnv = readEnvFiles(appDir);
  for (const k of MODEL_KEYS) if (!process.env[k] && fileEnv[k]) process.env[k] = fileEnv[k];

  // The GitHub CLI login can clone, comment and open PRs; the app's issue-only token cannot.
  const token = (ghReady() && ghToken()) || process.env.GLITCHBACK_GITHUB_TOKEN || fileEnv.GLITCHBACK_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error(t("GitHub'a erişim yok. `gh auth login` ile giriş yapın ya da GLITCHBACK_GITHUB_TOKEN verin.", "No GitHub access. Log in with `gh auth login` or set GLITCHBACK_GITHUB_TOKEN."));

  const issue = await gh<IssueEvent & { html_url: string }>(token, `/repos/${repo}/issues/${issueNumber}`);
  const me = await gh<{ login: string }>(token, "/user");
  console.log(`${bold(`${repo} #${issue.number}`)} ${issue.title}`);
  console.log(dim(t(`yorumlar ${me.login} adına yazılacak`, `comments will be posted as ${me.login}`)));

  const work = mkdtempSync(join(tmpdir(), "glitchback-"));
  const clone = join(work, "repo");
  const cwd = process.cwd();
  const saved: Record<string, string | undefined> = Object.fromEntries(
    ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GLITCHBACK_BOT_LOGIN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_TERMINAL_PROMPT"].map((k) => [k, process.env[k]]),
  );
  try {
    // The token travels in an environment header, never in a command line (visible in `ps`)
    // or in the clone's .git/config (left behind if the process is killed).
    authEnv(token);
    const cloned = run("git", ["clone", "--quiet", `https://github.com/${repo}.git`, clone], { quiet: true });
    if (!cloned.ok) throw new Error(`${t("Repo klonlanamadı", "Could not clone the repo")}: ${cloned.stderr.replace(token, "***")}`);

    const localCfg = join(appDir, ".glitchback.yml");
    if (existsSync(localCfg)) {
      copyFileSync(localCfg, join(clone, ".glitchback.yml"));
      // Keep the copied config out of every diff and commit the fixer makes.
      appendFileSync(join(clone, ".git/info/exclude"), "\n/.glitchback.yml\n");
    } else if (!existsSync(join(clone, ".glitchback.yml"))) {
      throw new Error(t(".glitchback.yml bulunamadı. Önce `npx glitchback init` çalıştırın.", ".glitchback.yml not found. Run `npx glitchback init` first."));
    }

    process.chdir(clone);
    process.env.GITHUB_TOKEN = token;
    process.env.GITHUB_REPOSITORY = repo;
    // Suggestions from a local run are authored by you; trust exactly that account.
    process.env.GLITCHBACK_BOT_LOGIN = me.login;
    await runFixer(mode, issue, { explicit: true });
    ok(`${t("Bitti", "Done")}: ${issue.html_url}`);
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(work, { recursive: true, force: true });
  }
}
