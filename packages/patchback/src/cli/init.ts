import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectNext, type NextProject } from "./detect.ts";
import { ghCreateLabels, ghReady, ghSetSecret } from "./gh.ts";
import { allowedPaths, scanAppRoutes, sensitivePaths } from "./routes.ts";
import {
  PROVIDERS, componentFile, patchLayout, patchbackYml, routeFile, tokenUrl, workflowYml, type ProviderChoice,
} from "./templates.ts";
import {
  ask, bold, choose, confirm, cyan, dim, gitRemoteRepo, interactive, ok, openUrl, readEnvFiles, run, skip, upsertEnv, warn,
} from "./util.ts";

export interface InitOptions {
  dir: string;
  yes: boolean;
  install: boolean;
  force: boolean;
  provider?: ProviderChoice;
  /** Use the GitHub CLI for labels and secrets when it is logged in (default true). */
  useGh?: boolean;
}

/** The folder of this package (…/patchback), whether run from npm or from a local checkout. */
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
  if (state === "exists") skip(`${rel} zaten var, dokunulmadı`);
  else ok(`${rel} ${state === "created" ? "oluşturuldu" : "güncellendi"}`);
}

function install(project: NextProject): boolean {
  const pm = project.packageManager;
  const add = pm === "npm" ? ["install"] : ["add"];
  let spec = "patchback@latest";
  let tmp: string | null = null;
  if (runningFromCheckout) {
    // Not published yet / developing Patchback itself: install this checkout as a real copy.
    tmp = mkdtempSync(join(tmpdir(), "patchback-pack-"));
    const packed = run("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: packageRoot, quiet: true });
    if (!packed.ok) {
      warn(`Yerel paket hazırlanamadı: ${packed.stderr}`);
      return false;
    }
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      warn("Yerel paket hazırlanamadı.");
      return false;
    }
    spec = join(tmp, tgz);
  }
  console.log(dim(`$ ${pm} ${add.join(" ")} ${runningFromCheckout ? "patchback (yerel)" : spec}`));
  const r = run(pm, [...add, spec], { cwd: project.root });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  return r.ok;
}

export async function init(opts: InitOptions) {
  const root = resolve(opts.dir);
  const detected = detectNext(root);
  if (!detected.ok) {
    console.log(`\n${detected.reason}\n`);
    console.log("Next.js dışındaki siteler için ayrı sunucu ve tek satırlık script:");
    console.log(dim("  npx patchback serve                 # raporları karşılar (PATCHBACK_ALLOWED_ORIGINS gerekir)"));
    console.log(dim('  <script src="https://unpkg.com/patchback/dist/patchback.global.js"></script>'));
    console.log(dim('  <script>Patchback.init({ endpoint: "https://rapor-sunucunuz" })</script>\n'));
    process.exitCode = 1;
    return;
  }
  const project = detected.project;
  const repo = gitRemoteRepo(root);
  const env = readEnvFiles(root);
  const ask2 = opts.yes ? async () => "" : ask;

  console.log(`\n${bold("Patchback")} → ${project.root}`);
  console.log(dim(`Next.js ${project.nextVersion} · ${project.appDir}/ · ${project.packageManager}${repo ? ` · github.com/${repo}` : ""}\n`));

  // 1. Package
  if (opts.install) {
    if (install(project)) ok("patchback paketi kuruldu");
    else warn(`Kurulum başarısız. Elle deneyin: ${project.packageManager} ${project.packageManager === "npm" ? "install" : "add"} patchback`);
  } else skip("paket kurulumu atlandı (--no-install)");

  // 2. Code: endpoint, button, layout
  const routeRel = `${project.appDir}/api/patchback/route.${project.typescript ? "ts" : "js"}`;
  report(routeRel, writeIfMissing(root, routeRel, routeFile(), opts.force));
  report(project.componentFile, writeIfMissing(root, project.componentFile, componentFile(project), opts.force));
  if (project.layoutFile) {
    const layoutAbs = join(root, project.layoutFile);
    const source = readFileSync(layoutAbs, "utf8");
    const patched = patchLayout(source, project.componentImport);
    if (patched === source) skip(`${project.layoutFile} zaten <Patchback /> içeriyor`);
    else if (patched) {
      writeFileSync(layoutAbs, patched);
      ok(`${project.layoutFile} → <Patchback /> eklendi`);
    } else warn(`${project.layoutFile} otomatik düzenlenemedi. <body> içine ekleyin: <Patchback />  (import { Patchback } from "${project.componentImport}")`);
  } else warn(`${project.appDir}/layout bulunamadı; <Patchback /> bileşenini kök layout'a ekleyin.`);

  // 3. Keys
  console.log("");
  let jevKey = process.env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || "";
  if (!jevKey && !opts.yes) {
    console.log(`${bold("Jev (TypeSafe)")} her raporu sınıflar: frontend/backend, ciddiyet, zorluk. ${dim("https://docs.typesafe.ai")}`);
    jevKey = await ask2("  TYPESAFE_API_KEY (Enter: şimdilik atla): ", { secret: true });
  } else if (jevKey) skip("TYPESAFE_API_KEY zaten tanımlı");

  let ghToken = process.env.PATCHBACK_GITHUB_TOKEN || env.PATCHBACK_GITHUB_TOKEN || "";
  if (!ghToken && !opts.yes && repo) {
    console.log(`\n${bold("GitHub issue'ları")} için sadece Issues izni olan bir token gerekiyor. Sayfayı açıyorum;`);
    console.log(`  "Repository access" kısmında ${cyan(repo)} reposunu seçip "Generate token"a basın.`);
    const url = tokenUrl(repo);
    console.log(dim(`  ${url}`));
    if (interactive()) openUrl(url);
    ghToken = await ask2("  Token (Enter: şimdilik atla, raporlar terminale yazılır): ", { secret: true });
  } else if (ghToken) skip("PATCHBACK_GITHUB_TOKEN zaten tanımlı");

  const knownProvider = (Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).find((p) => process.env[PROVIDERS[p].keyEnv] || env[PROVIDERS[p].keyEnv]);
  let provider: ProviderChoice = opts.provider ?? knownProvider ?? "none";
  if (!opts.provider && !knownProvider && !opts.yes) {
    console.log("");
    provider = (await choose(`${bold("Kod önerileri")} hangi modelle yazılsın?`, [
      { key: "gemini", label: "Google Gemini" },
      { key: "anthropic", label: "Anthropic Claude" },
      { key: "openai", label: "OpenAI" },
      { key: "none", label: "Şimdilik yok (sadece rapor toplansın)" },
    ])) as ProviderChoice;
  }
  let modelKey = "";
  if (provider !== "none") {
    const p = PROVIDERS[provider];
    modelKey = process.env[p.keyEnv] || env[p.keyEnv] || "";
    if (!modelKey && !opts.yes) {
      console.log(dim(`  Anahtar: ${p.keyUrl}`));
      modelKey = await ask2(`  ${p.keyEnv} (Enter: atla): `, { secret: true });
    }
  }

  // 4. Files: env, repo config, workflow
  console.log("");
  const envValues: Record<string, string> = {};
  if (jevKey) envValues.TYPESAFE_API_KEY = jevKey;
  if (ghToken) envValues.PATCHBACK_GITHUB_TOKEN = ghToken;
  if (ghToken && repo) envValues.PATCHBACK_GITHUB_REPO = repo;
  if (provider !== "none" && modelKey) {
    envValues[PROVIDERS[provider].keyEnv] = modelKey;
    // Same key doubles as the triage fallback when Jev is unreachable.
    if (!process.env.TRIAGE_MODEL && !env.TRIAGE_MODEL) envValues.TRIAGE_MODEL = PROVIDERS[provider].models[1];
  }
  const changed = upsertEnv(join(root, ".env.local"), envValues);
  if (changed.length) ok(`.env.local → ${changed.join(", ")}`);
  else skip(".env.local değişmedi");

  const yml = patchbackYml({
    allowed: allowedPaths(project),
    deny: sensitivePaths(project),
    routes: scanAppRoutes(project),
    provider,
  });
  report(".patchback.yml", writeIfMissing(root, ".patchback.yml", yml, opts.force));
  report(".github/workflows/patchback.yml", writeIfMissing(root, ".github/workflows/patchback.yml", workflowYml(), opts.force));

  const gitignore = join(root, ".gitignore");
  if (existsSync(gitignore) && !/^\.env(\*|\.local|\*\.local)?$/m.test(readFileSync(gitignore, "utf8"))) {
    writeFileSync(gitignore, `${readFileSync(gitignore, "utf8").replace(/\n?$/, "\n")}.env.local\n`);
    ok(".gitignore → .env.local");
  }

  // 5. GitHub: labels and the Actions secret, through the GitHub CLI when it is logged in
  if (repo) {
    if (opts.useGh !== false && ghReady()) {
      if (ghCreateLabels(repo)) ok(`GitHub etiketleri hazır (${repo})`);
      if (modelKey && provider !== "none") {
        const name = PROVIDERS[provider].keyEnv;
        if (opts.yes || (await confirm(`${name} anahtarını GitHub Actions secret'ı olarak kaydedeyim mi?`))) {
          if (ghSetSecret(repo, name, modelKey)) ok(`GitHub secret ${name} kaydedildi`);
          else warn(`${name} secret'ı kaydedilemedi; Settings → Secrets and variables → Actions'tan ekleyin.`);
        }
      }
    } else if (provider !== "none") {
      warn(`GitHub Actions için repo ayarlarına ${PROVIDERS[provider].keyEnv} secret'ını ekleyin (ya da \`gh auth login\` sonrası init'i tekrar çalıştırın).`);
    }
  } else warn("GitHub remote'u bulunamadı; issue ve öneriler için repoyu GitHub'a bağlayın.");

  // 6. Done
  const devCmd = project.packageManager === "npm" ? "npm run dev" : `${project.packageManager} dev`;
  console.log(`\n${bold("Hazır.")} ${cyan(devCmd)} ile açın; sağ altta "Sorun bildir" butonu çıkar.`);
  if (!ghToken) console.log(dim("  GitHub token'ı olmadan raporlar geliştirme sunucusunun terminaline yazılır."));
  if (!jevKey) console.log(dim("  Jev anahtarı olmadan triyaj kurallarla yapılır; eklemek için init'i tekrar çalıştırın."));
  console.log(dim("  Canlıya alırken .env.local'deki PATCHBACK_* ve anahtar değişkenlerini hosting ayarlarına da ekleyin."));
  console.log(dim("  Öneriyi hemen denemek için: npx patchback suggest <issue-no>\n"));
}
