import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectNext, type NextProject } from "./detect.ts";
import { ghCreateLabels, ghReady, ghSetSecret } from "./gh.ts";
import { allowedPaths, scanAppRoutes, sensitivePaths } from "./routes.ts";
import {
  PROVIDERS, componentFile, packageName, patchLayout, bugloopYml, routeFile, tokenUrl, workflowYml, type ProviderChoice,
} from "./templates.ts";
import {
  ask, bold, choose, confirm, cyan, dim, gitRemoteRepo, interactive, ok, openUrl, readEnvFiles, run, skip, upsertEnv, warn,
} from "./util.ts";
import { t } from "./i18n.ts";

export interface InitOptions {
  dir: string;
  yes: boolean;
  install: boolean;
  force: boolean;
  provider?: ProviderChoice;
  /** Use the GitHub CLI for labels and secrets when it is logged in (default true). */
  useGh?: boolean;
}

/** The folder of this package (…/bugloop), whether run from npm or from a local checkout. */
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
    // Not published yet / developing Bugloop itself: install this checkout as a real copy.
    tmp = mkdtempSync(join(tmpdir(), "bugloop-pack-"));
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
    console.log(`\n${detected.reason}\n`);
    console.log(t("Next.js dışındaki siteler için ayrı sunucu ve tek satırlık script:", "For sites that are not Next.js, run a separate server and add one script tag:"));
    console.log(dim(`  npx ${packageName()} serve           # ${t("raporları karşılar (BUGLOOP_ALLOWED_ORIGINS gerekir)", "receives reports (needs BUGLOOP_ALLOWED_ORIGINS)")}`));
    console.log(dim(`  <script src="https://unpkg.com/${packageName()}/dist/bugloop.global.js"></script>`));
    console.log(dim(`  <script>Bugloop.init({ endpoint: "${t("https://rapor-sunucunuz", "https://your-report-server")}" })</script>\n`));
    process.exitCode = 1;
    return;
  }
  const project = detected.project;
  const repo = gitRemoteRepo(root);
  const env = readEnvFiles(root);
  const ask2 = opts.yes ? async () => "" : ask;

  console.log(`\n${bold("Bugloop")} → ${project.root}`);
  console.log(dim(`Next.js ${project.nextVersion} · ${project.appDir}/ · ${project.packageManager}${repo ? ` · github.com/${repo}` : ""}\n`));

  // 1. Package
  if (opts.install) {
    if (install(project)) ok(t(`${packageName()} paketi kuruldu`, `${packageName()} installed`));
    else warn(`${t("Kurulum başarısız. Elle deneyin", "Install failed. Try it yourself")}: ${project.packageManager} ${project.packageManager === "npm" ? "install" : "add"} ${packageName()}`);
  } else skip(t("paket kurulumu atlandı (--no-install)", "package install skipped (--no-install)"));

  // 2. Code: endpoint, button, layout
  const routeRel = `${project.appDir}/api/bugloop/route.${project.typescript ? "ts" : "js"}`;
  report(routeRel, writeIfMissing(root, routeRel, routeFile(), opts.force));
  report(project.componentFile, writeIfMissing(root, project.componentFile, componentFile(project), opts.force));
  if (project.layoutFile) {
    const layoutAbs = join(root, project.layoutFile);
    const source = readFileSync(layoutAbs, "utf8");
    const patched = patchLayout(source, project.componentImport);
    if (patched === source) skip(t(`${project.layoutFile} zaten <Bugloop /> içeriyor`, `${project.layoutFile} already has <Bugloop />`));
    else if (patched) {
      writeFileSync(layoutAbs, patched);
      ok(t(`${project.layoutFile} → <Bugloop /> eklendi`, `${project.layoutFile} → <Bugloop /> added`));
    } else warn(t(`${project.layoutFile} otomatik düzenlenemedi. <body> içine ekleyin: <Bugloop />  (import { Bugloop } from "${project.componentImport}")`, `Could not edit ${project.layoutFile} automatically. Add <Bugloop /> inside <body>  (import { Bugloop } from "${project.componentImport}")`));
  } else warn(t(`${project.appDir}/layout bulunamadı; <Bugloop /> bileşenini kök layout'a ekleyin.`, `${project.appDir}/layout not found; add the <Bugloop /> component to your root layout.`));

  // 3. Keys
  console.log("");
  let jevKey = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || "";
  if (!jevKey && !opts.yes) {
    console.log(`${bold("Jev (TypeSafe)")} ${t("her raporu sınıflar: frontend/backend, ciddiyet, zorluk.", "triages every report: frontend/backend, severity, difficulty.")} ${dim("https://docs.typesafe.ai")}`);
    jevKey = await ask2(t("  TYPESAFE_API_KEY (Enter: şimdilik atla): ", "  TYPESAFE_API_KEY (Enter to skip for now): "), { secret: true });
  } else if (jevKey) skip(t("TYPESAFE_API_KEY zaten tanımlı", "TYPESAFE_API_KEY is already set"));

  let ghToken = process.env.BUGLOOP_GITHUB_TOKEN || env.BUGLOOP_GITHUB_TOKEN || "";
  if (!ghToken && !opts.yes && repo) {
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
    if (interactive()) openUrl(url);
    ghToken = await ask2(t("  Token (Enter: şimdilik atla, raporlar terminale yazılır): ", "  Token (Enter to skip; reports go to the terminal): "), { secret: true });
  } else if (ghToken) skip(t("BUGLOOP_GITHUB_TOKEN zaten tanımlı", "BUGLOOP_GITHUB_TOKEN is already set"));

  const knownProvider = (Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).find((p) => process.env[PROVIDERS[p].keyEnv] || env[PROVIDERS[p].keyEnv]);
  let provider: ProviderChoice = opts.provider ?? knownProvider ?? "none";
  if (!opts.provider && !knownProvider && !opts.yes) {
    console.log("");
    provider = (await choose(t(`${bold("Kod önerileri")} hangi modelle yazılsın?`, `Which model should write ${bold("code suggestions")}?`), [
      { key: "gemini", label: "Google Gemini" },
      { key: "anthropic", label: "Anthropic Claude" },
      { key: "openai", label: "OpenAI" },
      { key: "none", label: t("Şimdilik yok (sadece rapor toplansın)", "None for now (only collect reports)") },
    ])) as ProviderChoice;
  }
  let modelKey = "";
  if (provider !== "none") {
    const p = PROVIDERS[provider];
    modelKey = process.env[p.keyEnv] || env[p.keyEnv] || "";
    if (!modelKey && !opts.yes) {
      console.log(dim(`  ${t("Anahtar", "Key")}: ${p.keyUrl}`));
      modelKey = await ask2(`  ${p.keyEnv} (${t("Enter: atla", "Enter to skip")}): `, { secret: true });
    }
  }

  // 4. Files: env, repo config, workflow
  console.log("");
  const envValues: Record<string, string> = {};
  if (jevKey) envValues.TYPESAFE_API_KEY = jevKey;
  if (ghToken) envValues.BUGLOOP_GITHUB_TOKEN = ghToken;
  if (ghToken && repo) envValues.BUGLOOP_GITHUB_REPO = repo;
  if (provider !== "none" && modelKey) {
    envValues[PROVIDERS[provider].keyEnv] = modelKey;
    // Same key doubles as the triage fallback when Jev is unreachable.
    if (!process.env.TRIAGE_MODEL && !env.TRIAGE_MODEL) envValues.TRIAGE_MODEL = PROVIDERS[provider].models[1];
  }
  const changed = upsertEnv(join(root, ".env.local"), envValues);
  if (changed.length) ok(`.env.local → ${changed.join(", ")}`);
  else skip(t(".env.local değişmedi", ".env.local unchanged"));

  const yml = bugloopYml({
    allowed: allowedPaths(project),
    deny: sensitivePaths(project),
    routes: scanAppRoutes(project),
    provider,
  });
  report(".bugloop.yml", writeIfMissing(root, ".bugloop.yml", yml, opts.force));
  report(".github/workflows/bugloop.yml", writeIfMissing(root, ".github/workflows/bugloop.yml", workflowYml(), opts.force));

  const gitignore = join(root, ".gitignore");
  if (existsSync(gitignore) && !/^\.env(\*|\.local|\*\.local)?$/m.test(readFileSync(gitignore, "utf8"))) {
    writeFileSync(gitignore, `${readFileSync(gitignore, "utf8").replace(/\n?$/, "\n")}.env.local\n`);
    ok(".gitignore → .env.local");
  }

  // 5. GitHub: labels and the Actions secret, through the GitHub CLI when it is logged in
  if (repo) {
    if (opts.useGh !== false && ghReady()) {
      if (ghCreateLabels(repo)) ok(t(`GitHub etiketleri hazır (${repo})`, `GitHub labels ready (${repo})`));
      if (modelKey && provider !== "none") {
        const name = PROVIDERS[provider].keyEnv;
        if (opts.yes || (await confirm(t(`${name} anahtarını GitHub Actions secret'ı olarak kaydedeyim mi?`, `Save ${name} as a GitHub Actions secret?`)))) {
          if (ghSetSecret(repo, name, modelKey)) ok(t(`GitHub secret ${name} kaydedildi`, `GitHub secret ${name} saved`));
          else warn(t(`${name} secret'ı kaydedilemedi; Settings → Secrets and variables → Actions'tan ekleyin.`, `Could not save the ${name} secret; add it under Settings → Secrets and variables → Actions.`));
        }
      }
    } else if (provider !== "none") {
      warn(t(`GitHub Actions için repo ayarlarına ${PROVIDERS[provider].keyEnv} secret'ını ekleyin (ya da \`gh auth login\` sonrası init'i tekrar çalıştırın).`, `Add the ${PROVIDERS[provider].keyEnv} secret to your repo settings for GitHub Actions (or run init again after \`gh auth login\`).`));
    }
  } else warn(t("GitHub remote'u bulunamadı; issue ve öneriler için repoyu GitHub'a bağlayın.", "No GitHub remote found; connect the repo to GitHub for issues and suggestions."));

  // 6. Done
  const devCmd = project.packageManager === "npm" ? "npm run dev" : `${project.packageManager} dev`;
  console.log(t(
    `\n${bold("Hazır.")} ${cyan(devCmd)} ile açın; sağ altta "Sorun bildir" butonu çıkar.`,
    `\n${bold("Done.")} Start it with ${cyan(devCmd)}; the "Report a problem" button appears in the bottom right.`,
  ));
  if (!ghToken) console.log(dim(t("  GitHub token'ı olmadan raporlar geliştirme sunucusunun terminaline yazılır.", "  Without a GitHub token, reports are printed in the dev server's terminal.")));
  if (!jevKey) console.log(dim(t("  Jev anahtarı olmadan triyaj kurallarla yapılır; eklemek için init'i tekrar çalıştırın.", "  Without a Jev key, triage uses rules; run init again to add one.")));
  console.log(dim(t("  Canlıya alırken .env.local'deki BUGLOOP_* ve anahtar değişkenlerini hosting ayarlarına da ekleyin.", "  When you go live, add the BUGLOOP_* and key variables from .env.local to your hosting settings.")));
  console.log(dim(`  ${t("Öneriyi hemen denemek için", "To try a suggestion right away")}: npx ${packageName()} suggest <issue-no>\n`));
}
