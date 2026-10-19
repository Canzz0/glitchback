import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectNext, type NextProject } from "./detect.ts";
import { ghCreateLabels, ghReady, ghSetSecret } from "./gh.ts";
import { allowedPaths, scanAppRoutes, sensitivePaths } from "./routes.ts";
import {
  PROVIDERS, componentFile, packageName, patchLayout, glitchbackYml, providerMenu, routeFile, setYmlModels, tokenUrl, workflowYml, ymlProvider, type ProviderChoice,
} from "./templates.ts";
import {
  ask, bold, choose, confirm, cyan, dim, gitRemoteRepo, green, interactive, ok, openUrl, readEnvFiles, run, skip, upsertEnv, warn, yellow,
} from "./util.ts";
import { t } from "./i18n.ts";
import { providerFromEnv } from "../schema/llm.ts";
import { buildNextGuide, buildPlainGuide, showGuide } from "./manual.ts";
import { checkGithubToken, checkModelKey, type CheckResult } from "./checks.ts";

export interface InitOptions {
  dir: string;
  /** No questions: use what is already in the environment (implies the automatic setup). */
  yes: boolean;
  /**
   * "auto" writes the files and asks for keys; "manual" changes nothing and shows a guide.
   * Left out, a terminal gets a menu and anything else gets "auto".
   */
  mode?: "auto" | "manual";
  install: boolean;
  force: boolean;
  provider?: ProviderChoice;
  /** Use the GitHub CLI for labels and secrets when it is logged in (default true). */
  useGh?: boolean;
}

/** The folder of this package (…/glitchback), whether run from npm or from a local checkout. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runningFromCheckout = !packageRoot.split(sep).includes("node_modules");

function writeIfMissing(root: string, rel: string, content: string, force: boolean): "created" | "exists" | "updated" {
  const abs = join(root, rel);
  if (existsSync(abs)) {
    if (!force || readFileSync(abs, "utf8") === content) return "exists";
    writeFileSync(abs, content);
    return "updated";
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return "created";
}

function report(rel: string, state: "created" | "exists" | "updated") {
  if (state === "exists") skip(t(`${rel} zaten var, dokunulmadı`, `${rel} already exists, left as is`));
  else ok(`${rel} ${state === "created" ? t("oluşturuldu", "created") : t("güncellendi", "updated")}`);
}

function install(project: NextProject): boolean {
  const pm = project.packageManager;
  const add = pm === "npm" ? ["install"] : ["add"];
  let spec = `${packageName()}@latest`;
  let tmp: string | null = null;
  if (runningFromCheckout) {
    // Not published yet / developing Glitchback itself: install this checkout as a real copy.
    tmp = mkdtempSync(join(tmpdir(), "glitchback-pack-"));
    const packed = run("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: packageRoot, quiet: true });
    if (!packed.ok) {
      warn(`${t("Yerel paket hazırlanamadı", "Could not pack the local package")}: ${packed.stderr}`);
      return false;
    }
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      warn(t("Yerel paket hazırlanamadı.", "Could not pack the local package."));
      return false;
    }
    spec = join(tmp, tgz);
  }
  console.log(dim(`$ ${pm} ${add.join(" ")} ${runningFromCheckout ? `${packageName()} (${t("yerel", "local")})` : spec}`));
  const r = run(pm, [...add, spec], { cwd: project.root });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  return r.ok;
}

export async function init(opts: InitOptions) {
  const root = resolve(opts.dir);
  const detected = detectNext(root);
  if (!detected.ok) {
    // Nothing can be set up automatically here: show the separate-server guide instead.
    console.log(`\n${detected.reason}`);
    showGuide(buildPlainGuide(), root, { open: opts.mode === "manual" && interactive() });
    // A guide was what manual mode asked for; an automatic install did not happen.
    if (opts.mode !== "manual") process.exitCode = 1;
    return;
  }
  const project = detected.project;
  const repo = gitRemoteRepo(root);

  console.log(`\n${bold("Glitchback")} → ${project.root}`);
  console.log(dim(`Next.js ${project.nextVersion} · ${project.appDir}/ · ${project.packageManager}${repo ? ` · github.com/${repo}` : ""}\n`));

  const mode = opts.mode ?? (opts.yes || !interactive() ? "auto" : await chooseMode());
  if (mode === "manual") {
    showGuide(buildNextGuide(project, repo), root, { open: interactive() });
    return;
  }
  await autoSetup(opts, project, repo);
}

async function chooseMode(): Promise<"auto" | "manual"> {
  const picked = await choose(t(bold("Nasıl kuralım?"), bold("How should we set it up?")), [
    { key: "auto", label: t("Otomatik: dosyaları ben eklerim, gerekenleri sorarım (önerilen)", "Automatic: I add the files and ask for what is needed (recommended)") },
    { key: "manual", label: t("Manuel: hiçbir dosyaya dokunmam, adım adım rehber gösteririm", "Manual: I change nothing and show a step-by-step guide") },
  ]);
  console.log("");
  return picked === "manual" ? "manual" : "auto";
}

async function autoSetup(opts: InitOptions, project: NextProject, repo: string | null) {
  const root = project.root;
  const env = readEnvFiles(root);

  // 1. Package
  if (opts.install) {
    if (install(project)) ok(t(`${packageName()} paketi kuruldu`, `${packageName()} installed`));
    else warn(`${t("Kurulum başarısız. Elle deneyin", "Install failed. Try it yourself")}: ${project.packageManager} ${project.packageManager === "npm" ? "install" : "add"} ${packageName()}`);
  } else skip(t("paket kurulumu atlandı (--no-install)", "package install skipped (--no-install)"));

  // 2. Code: endpoint, button, layout
  const routeRel = `${project.appDir}/api/glitchback/route.${project.typescript ? "ts" : "js"}`;
  report(routeRel, writeIfMissing(root, routeRel, routeFile(), opts.force));
  report(project.componentFile, writeIfMissing(root, project.componentFile, componentFile(project), opts.force));
  if (project.layoutFile) {
    const layoutAbs = join(root, project.layoutFile);
    const source = readFileSync(layoutAbs, "utf8");
    const patched = patchLayout(source, project.componentImport);
    if (patched === source) skip(t(`${project.layoutFile} zaten <Glitchback /> içeriyor`, `${project.layoutFile} already has <Glitchback />`));
    else if (patched) {
      writeFileSync(layoutAbs, patched);
      ok(t(`${project.layoutFile} → <Glitchback /> eklendi`, `${project.layoutFile} → <Glitchback /> added`));
    } else warn(t(`${project.layoutFile} otomatik düzenlenemedi. <body> içine ekleyin: <Glitchback />  (import { Glitchback } from "${project.componentImport}")`, `Could not edit ${project.layoutFile} automatically. Add <Glitchback /> inside <body>  (import { Glitchback } from "${project.componentImport}")`));
  } else warn(t(`${project.appDir}/layout bulunamadı; <Glitchback /> bileşenini kök layout'a ekleyin.`, `${project.appDir}/layout not found; add the <Glitchback /> component to your root layout.`));

  // 3. AI: one provider triages reports and writes code suggestions. (Jev is optional and never
  // asked here: it is used only when TYPESAFE_API_KEY is set by hand.)
  console.log("");
  const knownProvider = providerFromEnv({ ...env, ...process.env });
  let provider: ProviderChoice = opts.provider ?? knownProvider ?? "none";
  // Asked whenever someone can answer, even with a key already there (that one is the default).
  // Without a terminal: the --provider flag, else the key that is there, else none.
  if (!opts.provider && !opts.yes && interactive()) {
    const menu = providerMenu(knownProvider);
    provider = (await choose(
      t(
        `${bold("Yapay zekâ")}: raporları sınıflar (frontend/backend, ciddiyet) ve frontend hataları için düzeltme önerir. Hangisi?`,
        `${bold("AI")}: triages reports (frontend/backend, severity) and suggests fixes for frontend bugs. Which one?`,
      ),
      menu.options,
      menu.fallback,
    )) as ProviderChoice;
  }
  let modelKey = "";
  if (provider !== "none") {
    const p = PROVIDERS[provider];
    modelKey = process.env[p.keyEnv] || env[p.keyEnv] || "";
    if (modelKey) skip(t(`${p.keyEnv} bulundu: ${p.label}`, `${p.keyEnv} found: ${p.label}`));
    else if (!opts.yes && interactive()) {
      console.log(dim(`  ${t("Anahtar sayfası", "Key page")}: ${p.keyUrl}`));
      openUrl(p.keyUrl);
      const chosen = provider;
      modelKey = await askChecked(`  ${p.keyEnv} (${t("Enter: atla", "Enter to skip")}): `, (v) => checkModelKey(chosen, v, { ...env, ...process.env }));
    }
  }

  // 4. GitHub issues
  let ghToken = process.env.GLITCHBACK_GITHUB_TOKEN || env.GLITCHBACK_GITHUB_TOKEN || "";
  if (!ghToken && !opts.yes && repo && interactive()) {
    console.log(t(
      `\n${bold("GitHub issue'ları")} için sadece Issues izni olan bir token gerekiyor. Sayfayı açıyorum;`,
      `\n${bold("GitHub issues")} need a token with only the Issues permission. Opening the page;`,
    ));
    console.log(t(
      `  "Repository access" kısmında ${cyan(repo)} reposunu seçip "Generate token"a basın.`,
      `  under "Repository access" pick ${cyan(repo)}, then press "Generate token".`,
    ));
    const url = tokenUrl(repo);
    console.log(dim(`  ${url}`));
    openUrl(url);
    const r = repo;
    ghToken = await askChecked(t("  Token (Enter: şimdilik atla, raporlar terminale yazılır): ", "  Token (Enter to skip; reports go to the terminal): "), (v) => checkGithubToken(v, r));
  } else if (ghToken) skip(t("GLITCHBACK_GITHUB_TOKEN zaten tanımlı", "GLITCHBACK_GITHUB_TOKEN is already set"));

  // 5. Files: env, repo config, workflow
  console.log("");
  const envValues: Record<string, string> = {};
  if (ghToken) envValues.GLITCHBACK_GITHUB_TOKEN = ghToken;
  if (ghToken && repo) envValues.GLITCHBACK_GITHUB_REPO = repo;
  if (provider !== "none" && modelKey) {
    envValues[PROVIDERS[provider].keyEnv] = modelKey;
    // Written out so it is clear (and easy to change) which model triages. A TRIAGE_MODEL of
    // another provider is replaced (the AI was switched); one of this provider is the user's pick.
    const currentTriage = process.env.TRIAGE_MODEL || env.TRIAGE_MODEL || "";
    if (!currentTriage || currentTriage.split(":")[0] !== provider) envValues.TRIAGE_MODEL = PROVIDERS[provider].models[1];
  }
  const changed = upsertEnv(join(root, ".env.local"), envValues);
  if (changed.length) ok(`.env.local → ${changed.join(", ")}`);
  else skip(t(".env.local değişmedi", ".env.local unchanged"));

  const ymlAbs = join(root, ".glitchback.yml");
  const existingYml = existsSync(ymlAbs) && !opts.force ? readFileSync(ymlAbs, "utf8") : null;
  // Switched only with a key for the new AI: skipping the key leaves the old setup working as it was.
  if (existingYml !== null && provider !== "none" && modelKey && ymlProvider(existingYml) !== provider) {
    // The AI was switched: point the code-suggestion models at it, keep routes and edits.
    writeFileSync(ymlAbs, setYmlModels(existingYml, provider));
    ok(t(`.glitchback.yml → modeller ${PROVIDERS[provider].label} oldu`, `.glitchback.yml → models now use ${PROVIDERS[provider].label}`));
  } else {
    const yml = glitchbackYml({
      allowed: allowedPaths(project),
      deny: sensitivePaths(project),
      routes: scanAppRoutes(project),
      provider,
    });
    report(".glitchback.yml", writeIfMissing(root, ".glitchback.yml", yml, opts.force));
  }
  // The workflow only does something with a model; without one it would be a file that never runs.
  if (provider !== "none") report(".github/workflows/glitchback.yml", writeIfMissing(root, ".github/workflows/glitchback.yml", workflowYml(), opts.force));
  else skip(t("GitHub workflow yazılmadı (yapay zekâ seçilmedi)", "GitHub workflow not written (no AI chosen)"));

  const gitignore = join(root, ".gitignore");
  if (existsSync(gitignore) && !/^\.env(\*|\.local|\*\.local)?$/m.test(readFileSync(gitignore, "utf8"))) {
    writeFileSync(gitignore, `${readFileSync(gitignore, "utf8").replace(/\n?$/, "\n")}.env.local\n`);
    ok(".gitignore → .env.local");
  }

  // 5. GitHub: labels and the Actions secret, through the GitHub CLI when it is logged in
  let secretSaved = false;
  if (repo && opts.useGh !== false && ghReady()) {
    if (ghCreateLabels(repo)) ok(t(`GitHub etiketleri hazır (${repo})`, `GitHub labels ready (${repo})`));
    if (modelKey && provider !== "none") {
      const name = PROVIDERS[provider].keyEnv;
      if (opts.yes || (await confirm(t(`${name} anahtarını GitHub Actions secret'ı olarak kaydedeyim mi?`, `Save ${name} as a GitHub Actions secret?`)))) {
        secretSaved = ghSetSecret(repo, name, modelKey);
        if (secretSaved) ok(t(`GitHub secret ${name} kaydedildi`, `GitHub secret ${name} saved`));
        else warn(t(`${name} secret'ı kaydedilemedi.`, `Could not save the ${name} secret.`));
      }
    }
  }

  // 6. Done: one line per feature, so it is clear what works and what is one step away.
  const devCmd = project.packageManager === "npm" ? "npm run dev" : `${project.packageManager} dev`;
  console.log(t(
    `\n${bold("Hazır.")} ${cyan(devCmd)} ile açın; sağ altta "Sorun bildir" butonu çıkar.\n`,
    `\n${bold("Done.")} Start it with ${cyan(devCmd)}; the "Report a problem" button appears in the bottom right.\n`,
  ));
  const providerLabel = provider === "none" ? "" : PROVIDERS[provider].label;
  const keyEnv = provider === "none" ? "" : PROVIDERS[provider].keyEnv;
  const rows: StatusRow[] = [
    ["ok", t("Buton ve rapor uç noktası", "Button and report endpoint"), ""],
    ghToken
      ? ["ok", t("GitHub issue'ları", "GitHub issues"), repo ?? ""]
      : ["off", t("GitHub issue'ları", "GitHub issues"), repo ? t("token yok; raporlar terminale yazılır", "no token; reports go to the terminal") : t("repo GitHub'a bağlı değil", "repo not connected to GitHub")],
    provider === "none"
      ? ["off", t("Yapay zekâ", "AI"), t("seçilmedi; triyaj kurallarla, kod önerisi yok", "none; rule-based triage, no code suggestions")]
      : modelKey
        ? ["ok", t("Yapay zekâ", "AI"), t(`${providerLabel} (triyaj + kod önerileri)`, `${providerLabel} (triage + code suggestions)`)]
        : ["warn", t("Yapay zekâ", "AI"), t(`${providerLabel} seçildi ama ${keyEnv} girilmedi; ayarlar değiştirilmedi`, `${providerLabel} picked but no ${keyEnv}; settings left unchanged`)],
  ];
  if (provider !== "none" && repo) {
    rows.push(
      secretSaved
        ? ["ok", t("GitHub Actions secret'ı", "GitHub Actions secret"), keyEnv]
        : ["warn", t("GitHub Actions secret'ı", "GitHub Actions secret"), t(`${keyEnv} ekleyin: https://github.com/${repo}/settings/secrets/actions/new`, `add ${keyEnv}: https://github.com/${repo}/settings/secrets/actions/new`)],
    );
  }
  printStatus(rows);
  if (provider !== "none" && repo) {
    // What auto-fix still needs after setup; each one is a place people get stuck.
    const files = [".github/workflows/glitchback.yml", ".glitchback.yml", `${project.appDir}/api/glitchback`, project.componentFile, project.layoutFile, "package.json"].filter(Boolean).join(" ");
    console.log(bold(t("  Auto-fix için sonraki adımlar", "  Next steps for auto-fix")));
    console.log(`  1. ${t("Dosyaları gönderin; öneri ve autofix workflow'u yalnızca varsayılan branch'ten (main) çalışır:", "Push the files; the suggestion and autofix workflow only runs from the default branch (main):")}`);
    console.log(dim(`     git add ${files} && git commit -m "Glitchback" && git push`));
    console.log(`  2. ${t("Actions'ın PR açmasına izin verin:", "Let Actions open pull requests:")} https://github.com/${repo}/settings/actions`);
    console.log(dim(`     Workflow permissions → "Allow GitHub Actions to create and approve pull requests"`));
    console.log(`  3. ${t("Frontend issue'sundaki öneriyi beğenince issue'ya `autofix` etiketini ekleyin (yorum değil, etiket). Öneri gelmediyse `glitchback:suggest` etiketi.", "When you like the suggestion on a frontend issue, add the `autofix` label (a label, not a comment). No suggestion yet? Add `glitchback:suggest`.")}\n`);
  }
  if (provider === "none" || !ghToken) console.log(dim(t("  Eksikleri sonra eklemek için init'i tekrar çalıştırın; var olan dosyalara dokunulmaz.", "  To add what is missing later, run init again; existing files are left alone.")));
  console.log(dim(t("  Canlıya alırken .env.local'deki GLITCHBACK_* ve anahtar değişkenlerini hosting ayarlarına da ekleyin.", "  When you go live, add the GLITCHBACK_* and key variables from .env.local to your hosting settings.")));
  console.log(`  ${t("Kontrol etmek için", "To check the setup")}: ${cyan(`npx ${packageName()} doctor`)}\n`);
}

/**
 * Asks for a key or token and checks it right away, so a wrong paste shows up now and not
 * at the first report. A rejected value is asked once more, then dropped (nothing invalid is
 * written). If the check cannot reach the service, the value is kept with a warning.
 */
async function askChecked(question: string, check: (value: string) => Promise<CheckResult>): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = await ask(question, { secret: true });
    if (!value) return "";
    process.stdout.write(dim(t("  kontrol ediliyor…", "  checking…")));
    const r = await check(value);
    process.stdout.write("\r\x1b[2K");
    if (r.ok) {
      ok(r.detail ? t(`geçerli: ${r.detail}`, `valid: ${r.detail}`) : t("geçerli", "valid"));
      return value;
    }
    if (r.offline) {
      warn(t(`${r.reason}; kontrol edilemedi, yine de kaydediliyor.`, `${r.reason}; could not check it, saving it anyway.`));
      return value;
    }
    warn(`${r.reason}${r.fix ? `. ${r.fix}` : ""}`);
    if (attempt === 0) console.log(dim(t("  Tekrar yapıştırın ya da Enter ile atlayın.", "  Paste it again, or press Enter to skip.")));
  }
  warn(t("Kaydedilmedi; sonra init'i tekrar çalıştırabilirsiniz.", "Not saved; you can run init again later."));
  return "";
}

type StatusRow = ["ok" | "warn" | "off", string, string];

function printStatus(rows: StatusRow[]) {
  const width = Math.max(...rows.map((r) => r[1].length));
  for (const [state, name, note] of rows) {
    const mark = state === "ok" ? green("✔") : state === "warn" ? yellow("!") : dim("○");
    console.log(`  ${mark} ${name.padEnd(width)}  ${dim(note)}`);
  }
  console.log("");
}
