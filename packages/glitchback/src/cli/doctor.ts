import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRepoConfig } from "../fixer/config.ts";
import { modelKeyProblem } from "../fixer/run.ts";
import { DEFAULT_MODELS, PROVIDERS as API_PROVIDERS, providerFromEnv, type DefaultProvider, type Env } from "../schema/llm.ts";
import { configFromEnv } from "../server/config.ts";
import { checkDevServer, checkGithubToken, checkModelKey, type CheckResult } from "./checks.ts";
import { detectNext } from "./detect.ts";
import { ghReady } from "./gh.ts";
import { PROVIDERS, packageName, packageVersion } from "./templates.ts";
import { bold, cyan, dim, gitRemoteRepo, green, readEnvFiles, red, run, yellow } from "./util.ts";
import { t } from "./i18n.ts";

/**
 * `npx glitchback doctor`: what works, what is missing, and the one step that fixes each.
 * Read-only, except that the GitHub check creates the `glitchback` label (setup does too)
 * and `--test` sends one sample report through the running dev server.
 */
export interface DoctorItem {
  group: string;
  /** ok: works · warn: works but something is off · fail: broken · off: not set up (optional). */
  state: "ok" | "warn" | "fail" | "off";
  name: string;
  note?: string;
  fix?: string;
}

export interface DoctorOptions {
  dir: string;
  /** Dev server port for the live checks (default 3000). */
  port?: number;
  /** Send a sample report through the running dev server. */
  test?: boolean;
  /** Use the GitHub CLI to look for the Actions secret and settings (default true). */
  useGh?: boolean;
  /** Runs `gh` (tests pass a fake; given, gh counts as logged in). */
  ghRun?: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
}

/** What the app would see: its .env files (as Next.js loads them in development) with the shell on top. */
function appEnv(root: string): Env {
  return { ...readEnvFiles(root, [".env", ".env.development", ".env.local", ".env.development.local"]), ...process.env };
}

export async function doctor(opts: DoctorOptions): Promise<{ items: DoctorItem[]; exitCode: number }> {
  const root = resolve(opts.dir);
  const port = opts.port ?? 3000;
  const items: DoctorItem[] = [];
  const add = (i: DoctorItem) => items.push(i);
  const env = appEnv(root);
  const init = `npx ${packageName()} init`;

  /* ---------------- Project ---------------- */
  const P = t("Proje", "Project");
  const detected = detectNext(root);
  if (!detected.ok) {
    add({ group: P, state: "fail", name: "Next.js", note: detected.reason, fix: t(`Next.js olmayan siteler için: ${init} --manual`, `For sites that are not Next.js: ${init} --manual`) });
  } else {
    const project = detected.project;
    add({ group: P, state: "ok", name: "Next.js", note: `${project.nextVersion ?? ""} · ${project.appDir}/` });

    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch {}
    const listed = pkg.dependencies?.[packageName()] ?? pkg.devDependencies?.[packageName()];
    const installCmd = `${project.packageManager} ${project.packageManager === "npm" ? "install" : "add"} ${packageName()}`;
    const pkgName = t(`${packageName()} paketi`, `${packageName()} package`);
    if (!listed) add({ group: P, state: "fail", name: pkgName, note: t("package.json'da yok", "not in package.json"), fix: installCmd });
    else if (!existsSync(join(root, "node_modules", packageName()))) add({ group: P, state: "warn", name: pkgName, note: t(`${listed}, ama kurulmamış`, `${listed}, but not installed`), fix: project.packageManager === "npm" ? "npm install" : `${project.packageManager} install` });
    else add({ group: P, state: "ok", name: pkgName, note: listed });

    const routeRel = ["ts", "js"].map((e) => `${project.appDir}/api/glitchback/route.${e}`).find((f) => existsSync(join(root, f)));
    add(routeRel
      ? { group: P, state: "ok", name: t("Rapor uç noktası", "Report endpoint"), note: routeRel }
      : { group: P, state: "fail", name: t("Rapor uç noktası", "Report endpoint"), note: t("yok", "missing"), fix: init });

    add(existsSync(join(root, project.componentFile))
      ? { group: P, state: "ok", name: t("Buton bileşeni", "Button component"), note: project.componentFile }
      : { group: P, state: "fail", name: t("Buton bileşeni", "Button component"), note: t("yok", "missing"), fix: init });

    const layout = project.layoutFile ? readFileSync(join(root, project.layoutFile), "utf8") : "";
    add(/<Glitchback\s*\/>/.test(layout)
      ? { group: P, state: "ok", name: t("Kök layout", "Root layout"), note: project.layoutFile ?? "" }
      : { group: P, state: "fail", name: t("Kök layout", "Root layout"), note: t("<Glitchback /> yok", "no <Glitchback />"), fix: init });
  }

  /* ---------------- Settings ---------------- */
  const S = t("Ayarlar", "Settings");
  let serverCfg: ReturnType<typeof configFromEnv> | null = null;
  const remote = gitRemoteRepo(root);
  try {
    serverCfg = configFromEnv(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fix = /GLITCHBACK_GITHUB_REPO/.test(msg) && remote ? t(`.env.local'e ekleyin: GLITCHBACK_GITHUB_REPO=${remote}`, `Add to .env.local: GLITCHBACK_GITHUB_REPO=${remote}`) : ".env.local";
    add({ group: S, state: "fail", name: t("Sunucu ayarları", "Server settings"), note: msg, fix });
  }

  const repo = env.GLITCHBACK_GITHUB_REPO?.trim() || remote;
  // Same order as the server (server/config.ts): a GITHUB_TOKEN exported in the shell counts too.
  const token = env.GLITCHBACK_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  const tokenFromShell = !env.GLITCHBACK_GITHUB_TOKEN?.trim() && !!token;
  const GH = t("GitHub issue'ları", "GitHub issues");
  if (!token) {
    add({ group: S, state: "off", name: GH, note: t("token yok; raporlar terminale yazılır", "no token; reports go to the terminal"), fix: init });
  } else if (!repo) {
    add({ group: S, state: "fail", name: GH, note: t("repo bilinmiyor", "repo unknown"), fix: "GLITCHBACK_GITHUB_REPO=owner/repo (.env.local)" });
  } else {
    const r = await checkGithubToken(token, repo);
    if (tokenFromShell) add({ group: S, state: "warn", name: "GITHUB_TOKEN", note: t("GLITCHBACK_GITHUB_TOKEN yok, sunucu kabuktaki GITHUB_TOKEN'ı kullanır", "no GLITCHBACK_GITHUB_TOKEN; the server uses GITHUB_TOKEN from your shell"), fix: t("Bilerek değilse .env.local'e Issues izinli kendi token'ınızı yazın: npx glitchback init", "If that is not on purpose, put an Issues-only token in .env.local: npx glitchback init") });
    add(r.ok
      ? { group: S, state: "ok", name: GH, note: r.detail }
      : { group: S, state: r.offline ? "warn" : "fail", name: GH, note: r.offline ? t(`${r.reason}; token kontrol edilemedi`, `${r.reason}; token not checked`) : r.reason, fix: r.fix });
  }

  const AI = t("Yapay zekâ", "AI");
  // The AI in use: the provider TRIAGE_MODEL names (after a switch, an old key may still be set),
  // else the first key found, the same way the server picks it.
  const named = env.TRIAGE_MODEL?.trim().split(":")[0] ?? "";
  const provider: DefaultProvider | null = named in DEFAULT_MODELS ? (named as DefaultProvider) : providerFromEnv(env);
  if (!provider) {
    add({ group: S, state: "off", name: AI, note: t("anahtar yok; triyaj kurallarla, kod önerisi yok", "no key; rule-based triage, no code suggestions"), fix: init });
  } else {
    const key = API_PROVIDERS[provider].keys.map((k) => env[k]?.trim()).find(Boolean);
    const r: CheckResult = key
      ? await checkModelKey(provider, key, env)
      : { ok: false as const, reason: t(`TRIAGE_MODEL ${provider} diyor ama ${DEFAULT_MODELS[provider].keyEnv} yok`, `TRIAGE_MODEL says ${provider} but ${DEFAULT_MODELS[provider].keyEnv} is not set`) };
    const triage = serverCfg?.llm?.model;
    const note = [DEFAULT_MODELS[provider].label, triage && t(`triyaj: ${triage}`, `triage: ${triage}`), r.ok ? r.detail : r.reason].filter(Boolean).join(" · ");
    add(r.ok
      ? { group: S, state: "ok", name: AI, note }
      : r.offline
        ? { group: S, state: "warn", name: AI, note: t(`${note}; anahtar kontrol edilemedi`, `${note}; key not checked`), fix: r.fix }
        : { group: S, state: "fail", name: AI, note, fix: t(`Yeni anahtar: ${PROVIDERS[provider].keyUrl}`, `New key: ${PROVIDERS[provider].keyUrl}`) });
  }
  if (env.TYPESAFE_API_KEY?.trim()) add({ group: S, state: "ok", name: "Jev", note: t("tanımlı; triyajı önce Jev yapar", "set; Jev triages first") });

  /* ---------------- Code suggestions ---------------- */
  const C = t("Kod önerileri", "Code suggestions");
  const ymlPath = join(root, ".glitchback.yml");
  let tierModels: string[] = [];
  if (!existsSync(ymlPath)) {
    add({ group: C, state: "off", name: ".glitchback.yml", note: t("yok", "missing"), fix: init });
  } else {
    try {
      const cfg = loadRepoConfig(ymlPath);
      tierModels = [...new Set([cfg.models.low, cfg.models.mid, cfg.models.high])];
      const missing = tierModels.filter((m) => modelKeyProblem(m, env));
      const needs = (m: string) => {
        const p = m.split(":")[0] as keyof typeof API_PROVIDERS;
        const keys: readonly string[] = API_PROVIDERS[p]?.keys ?? ["LLM_BASE_URL"];
        return t(`${m} için ${keys.join(" ya da ")} gerekli`, `${m} needs ${keys.join(" or ")}`);
      };
      add(!missing.length
        ? { group: C, state: "ok", name: ".glitchback.yml", note: cfg.models.mid }
        : !provider
          ? { group: C, state: "off", name: ".glitchback.yml", note: t("var; yapay zekâ anahtarı eklenince kullanılır", "present; used once an AI key is added") }
          : { group: C, state: "warn", name: ".glitchback.yml", note: needs(missing[0]), fix: t("models satırlarını anahtarınız olan sağlayıcıya göre düzenleyin ya da o anahtarı ekleyin.", "Point the models lines at the provider you have a key for, or add that key.") });
    } catch (err) {
      add({ group: C, state: "fail", name: ".glitchback.yml", note: (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 160), fix: t(`Dosyayı düzeltin ya da silip ${init} --force`, `Fix the file, or delete it and run ${init} --force`) });
    }
  }

  const wfPath = join(root, ".github/workflows/glitchback.yml");
  if (!existsSync(wfPath)) {
    add({ group: C, state: provider ? "warn" : "off", name: "GitHub workflow", note: t("yok", "missing"), fix: init });
  } else {
    const pinned = readFileSync(wfPath, "utf8").match(new RegExp(`${packageName()}@(\\d+\\.\\d+\\.\\d+)`))?.[1];
    add(pinned && pinned !== packageVersion()
      ? { group: C, state: "warn", name: "GitHub workflow", note: t(`${pinned} sürümüne sabit (güncel: ${packageVersion()})`, `pinned to ${pinned} (current: ${packageVersion()})`), fix: t(`Dosyayı gözden geçirip ${init} --force ile yenileyin`, `Review and refresh it with ${init} --force`) }
      : { group: C, state: "ok", name: "GitHub workflow", note: pinned });
  }

  // The secret the workflow needs: the key of each provider the tier models use.
  const gh = opts.ghRun ?? ((args: string[]) => run("gh", args, { quiet: true }));
  const canUseGh = !!opts.ghRun || (opts.useGh !== false && ghReady());

  // Issue and label events run the workflow file of the default branch, so a workflow that is only
  // local (or only on another branch) never runs. Checked against the last fetch of origin.
  if (existsSync(wfPath) && existsSync(ymlPath)) {
    const DEF = t("Varsayılan branch'te", "On the default branch");
    const head = run("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { quiet: true });
    const branch = head.ok ? head.stdout.trim() : "";
    if (!branch) {
      add({ group: C, state: "off", name: DEF, note: t("varsayılan branch bilinmiyor", "default branch unknown"), fix: "git remote set-head origin --auto" });
    } else {
      const tracked = run("git", ["-C", root, "ls-tree", "--name-only", branch, "--", ".github/workflows/glitchback.yml", ".glitchback.yml"], { quiet: true });
      const present = tracked.stdout.split("\n").filter(Boolean);
      const missingThere = [".github/workflows/glitchback.yml", ".glitchback.yml"].filter((f) => !present.includes(f));
      const short = branch.replace(/^origin\//, "");
      add(missingThere.length
        ? {
            group: C, state: "warn", name: DEF,
            note: t(`${missingThere.join(", ")} ${short} branch'inde yok; öneri ve autofix çalışmaz`, `${missingThere.join(", ")} not on ${short}; suggestions and autofix will not run`),
            fix: t(`git add .github/workflows/glitchback.yml .glitchback.yml && git commit -m "Glitchback" && git push, sonra ${short} branch'ine merge edin`, `git add .github/workflows/glitchback.yml .glitchback.yml && git commit -m "Glitchback" && git push, then merge into ${short}`),
          }
        : { group: C, state: "ok", name: DEF, note: short });
    }
  }

  // autofix opens a PR with the workflow's token; many repos do not allow that by default.
  if (repo && existsSync(wfPath)) {
    const PR = t("Actions PR izni", "Actions PR permission");
    const settings = `https://github.com/${repo}/settings/actions`;
    const setting = '"Allow GitHub Actions to create and approve pull requests"';
    const r = canUseGh ? gh(["api", `repos/${repo}/actions/permissions/workflow`]) : null;
    let allowed: boolean | null = null;
    try {
      if (r?.ok) allowed = JSON.parse(r.stdout).can_approve_pull_request_reviews === true;
    } catch {}
    add(allowed === true
      ? { group: C, state: "ok", name: PR, note: t("autofix PR açabilir", "autofix can open PRs") }
      : allowed === false
        ? { group: C, state: "warn", name: PR, note: t(`kapalı; autofix PR açamaz. Açın: ${setting}`, `off; autofix cannot open PRs. Turn on ${setting}`), fix: `${settings} → Workflow permissions` }
        : { group: C, state: "off", name: PR, note: t(`kontrol edilemedi; ${setting} açık olmalı`, `not checked; ${setting} must be on`), fix: `${settings} → Workflow permissions` });
  }

  const neededSecrets = [...new Set(tierModels.map((m) => m.split(":")[0]).filter((p): p is DefaultProvider => p in DEFAULT_MODELS).map((p) => DEFAULT_MODELS[p].keyEnv))];
  if (neededSecrets.length && repo && existsSync(wfPath)) {
    const SEC = t("Actions secret'ı", "Actions secret");
    const link = `https://github.com/${repo}/settings/secrets/actions`;
    if (canUseGh) {
      const list = gh(["secret", "list", "--repo", repo]);
      const names = new Set(list.stdout.split("\n").map((l) => l.split(/\s+/)[0]));
      const missing = neededSecrets.filter((s) => !names.has(s));
      add(!list.ok
        ? { group: C, state: "warn", name: SEC, note: t("listelenemedi", "could not list"), fix: link }
        : missing.length
          ? { group: C, state: "warn", name: SEC, note: t(`${missing.join(", ")} yok; öneriler yazılmaz`, `${missing.join(", ")} missing; no suggestions are written`), fix: `gh secret set ${missing[0]} --repo ${repo}` }
          : { group: C, state: "ok", name: SEC, note: neededSecrets.join(", ") });
    } else {
      add({ group: C, state: "off", name: SEC, note: t(`kontrol edilemedi (gh girişli değil); ${neededSecrets.join(", ")} gerekli`, `not checked (gh not logged in); needs ${neededSecrets.join(", ")}`), fix: link });
    }
  }

  /* ---------------- Live ---------------- */
  const L = t("Çalışırken", "Live");
  const DEV = t("Geliştirme sunucusu", "Dev server");
  const endpoint = `http://localhost:${port}/api/glitchback`;
  const dev = await checkDevServer(endpoint);
  if (!dev.ok) {
    add({ group: L, state: "off", name: DEV, note: `localhost:${port} ${dev.reason}`, fix: t(`Uygulamayı açıp tekrar deneyin (başka port için --port)`, `Start the app and try again (--port for another port)`) });
  } else {
    const info = dev.info;
    const tokenNotSeen = !!token && info.github === false;
    add(tokenNotSeen
      ? { group: L, state: "warn", name: DEV, note: t("çalışıyor ama GitHub token'ını görmüyor", "running, but it does not see the GitHub token"), fix: t(".env.local değişti: geliştirme sunucusunu yeniden başlatın", ".env.local changed: restart the dev server") }
      : { group: L, state: "ok", name: DEV, note: [endpoint, info.triage && t(`triyaj: ${info.triage}`, `triage: ${info.triage}`)].filter(Boolean).join(" · ") });

    if (opts.test) {
      const TEST = t("Test raporu", "Test report");
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: `http://localhost:${port}` },
          body: JSON.stringify({
            schema_version: "1.0",
            user_message: t("Glitchback doctor test raporu: kurulum çalışıyor mu? Bu issue'yu kapatabilirsiniz.", "Glitchback doctor test report: does the setup work? You can close this issue."),
            source: "user_report",
            context: { url: `http://localhost:${port}/`, route: "/", console_errors: [], failed_requests: [], breadcrumbs: [] },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json().catch(() => ({}))) as { issue_url?: string; delivered?: string; duplicate?: boolean; error?: string };
        if (!res.ok) add({ group: L, state: "fail", name: TEST, note: `HTTP ${res.status} ${body.error ?? ""}`.trim(), fix: t("Geliştirme sunucusunun terminalindeki hataya bakın.", "Look at the error in the dev server's terminal.") });
        else if (body.issue_url) add({ group: L, state: "ok", name: TEST, note: t(`issue ${body.duplicate ? "zaten vardı" : "açıldı"}: ${body.issue_url}`, `issue ${body.duplicate ? "already existed" : "opened"}: ${body.issue_url}`) });
        else if (body.delivered === "console") add({ group: L, state: "ok", name: TEST, note: t("geliştirme sunucusunun terminaline yazıldı", "printed in the dev server's terminal") });
        else add({ group: L, state: "ok", name: TEST, note: t("gönderildi", "sent") });
      } catch (err) {
        add({ group: L, state: "fail", name: TEST, note: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  print(items);
  const exitCode = items.some((i) => i.state === "fail") ? 1 : 0;
  return { items, exitCode };
}

function print(items: DoctorItem[]) {
  const width = Math.max(...items.map((i) => i.name.length));
  console.log(`\n${bold("Glitchback doctor")}`);
  let group = "";
  for (const i of items) {
    if (i.group !== group) {
      group = i.group;
      console.log(`\n${bold(group)}`);
    }
    const mark = i.state === "ok" ? green("✔") : i.state === "warn" ? yellow("!") : i.state === "fail" ? red("✖") : dim("○");
    console.log(`  ${mark} ${i.name.padEnd(width)}  ${i.note ? (i.state === "ok" || i.state === "off" ? dim(i.note) : i.note) : ""}`);
    if (i.fix && i.state !== "ok") console.log(`    ${" ".repeat(width)}  ${cyan("→")} ${i.fix}`);
  }
  const n = (s: DoctorItem["state"]) => items.filter((i) => i.state === s).length;
  console.log(
    `\n${t(
      `${n("ok")} hazır · ${n("warn")} uyarı · ${n("fail")} hata · ${n("off")} kurulmamış (isteğe bağlı)`,
      `${n("ok")} ready · ${n("warn")} warnings · ${n("fail")} errors · ${n("off")} not set up (optional)`,
    )}\n`,
  );
}
