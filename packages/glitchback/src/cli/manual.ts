import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NextProject } from "./detect.ts";
import { allowedPaths, scanAppRoutes, sensitivePaths } from "./routes.ts";
import { PROVIDERS, componentFile, glitchbackYml, packageName, routeFile, tokenUrl, workflowYml } from "./templates.ts";
import { bold, cyan, dim, openUrl } from "./util.ts";
import { lang, t } from "./i18n.ts";

/**
 * Manual setup: the same files `init` would write, shown instead of written. Nothing in the
 * project changes. The guide is printed briefly in the terminal and in full as a local HTML
 * page (a file in the temp folder, no server, works offline).
 */
export interface GuideBlock {
  /** File path or a short caption shown above the code. */
  label?: string;
  code: string;
}
export interface GuideStep {
  title: string;
  /** Optional steps add GitHub issues, AI triage and suggestions on top of the working button. */
  optional?: boolean;
  /** Paragraphs; `backticks` become inline code. */
  text: string[];
  blocks?: GuideBlock[];
  links?: { label: string; url: string }[];
}
export interface Guide {
  title: string;
  intro: string;
  steps: GuideStep[];
}

const installCmd = (pm: NextProject["packageManager"]) => `${pm} ${pm === "npm" ? "install" : "add"} ${packageName()}`;
const devCmd = (pm: NextProject["packageManager"]) => (pm === "npm" ? "npm run dev" : `${pm} dev`);

function aiStep(): GuideStep {
  const providers = Object.values(PROVIDERS);
  return {
    title: t("Yapay zekâyı bağlayın", "Connect an AI"),
    optional: true,
    text: [
      t(
        "Raporları sınıflamak (frontend/backend, ciddiyet, zorluk) ve düzeltme önermek için Gemini, Claude ya da GPT'den birini seçin. Anahtarı aşağıdaki sayfadan alıp `.env.local` dosyasına yazın. Yalnızca seçtiğiniz sağlayıcının satırları gerekir.",
        "Pick Gemini, Claude or GPT to triage reports (frontend/backend, severity, difficulty) and to suggest fixes. Get a key from the page below and put it in `.env.local`. Only the lines of the provider you pick are needed.",
      ),
      t("Yapay zekâ olmadan da çalışır: raporlar kurallarla sınıflanır, kod önerisi yazılmaz.", "It also works without an AI: reports are triaged by rules and no code suggestions are written."),
    ],
    blocks: providers.map((p) => ({ label: `.env.local · ${p.label}`, code: `${p.keyEnv}=...\nTRIAGE_MODEL=${p.models[1]}` })),
    links: providers.map((p) => ({ label: t(`${p.label} anahtarı`, `${p.label} key`), url: p.keyUrl })),
  };
}

function githubStep(repo: string | null): GuideStep {
  return {
    title: t("Raporları GitHub issue'su yapın", "Turn reports into GitHub issues"),
    optional: true,
    text: [
      t(
        `Yalnızca **Issues: write** izni olan bir token oluşturun. Aşağıdaki bağlantı izni hazır seçili açar; "Repository access" kısmında ${repo ? `\`${repo}\`` : "reponuzu"} seçip "Generate token"a basın.`,
        `Create a token with only the **Issues: write** permission. The link below opens with that permission selected; under "Repository access" pick ${repo ? `\`${repo}\`` : "your repo"} and press "Generate token".`,
      ),
      t("Token olmadan raporlar geliştirme sunucusunun terminaline yazılır.", "Without a token, reports are printed in the dev server's terminal."),
    ],
    blocks: [
      { label: ".env.local", code: `GLITCHBACK_GITHUB_TOKEN=github_pat_...\nGLITCHBACK_GITHUB_REPO=${repo ?? t("sahip/repo", "owner/repo")}` },
      { label: ".gitignore", code: ".env.local" },
    ],
    links: [{ label: t("Token sayfası", "Token page"), url: tokenUrl(repo) }],
  };
}

export function buildNextGuide(project: NextProject, repo: string | null): Guide {
  const ext = project.typescript ? "ts" : "js";
  const routeRel = `${project.appDir}/api/glitchback/route.${ext}`;
  const pm = project.packageManager;
  const firstKeyEnv = PROVIDERS.gemini.keyEnv;
  const steps: GuideStep[] = [
    {
      title: t("Paketi kurun", "Install the package"),
      text: [t("Proje klasöründe:", "In your project folder:")],
      blocks: [{ code: installCmd(pm) }],
    },
    {
      title: t("Rapor uç noktasını ekleyin", "Add the report endpoint"),
      text: [t("Raporlar uygulamanızın içinde karşılanır; ayrı sunucu gerekmez.", "Reports are received inside your app; no separate server.")],
      blocks: [{ label: routeRel, code: routeFile() }],
    },
    {
      title: t("Buton bileşenini ekleyin", "Add the button component"),
      text: [t("Seçenekler (dil, tema, konum, otomatik raporlar) bu dosyadaki `init({...})` çağrısına verilir.", "Options (language, theme, position, automatic reports) go into the `init({...})` call in this file.")],
      blocks: [{ label: project.componentFile, code: componentFile(project) }],
    },
    {
      title: t("Kök layout'a koyun", "Put it in the root layout"),
      text: [
        project.layoutFile
          ? t(`\`${project.layoutFile}\` dosyasına import satırını ekleyin ve \`<Glitchback />\` bileşenini \`</body>\` etiketinin hemen üstüne koyun.`, `In \`${project.layoutFile}\`, add the import line and put \`<Glitchback />\` right above \`</body>\`.`)
          : t("Kök layout dosyanıza import satırını ekleyin ve `<Glitchback />` bileşenini `<body>` içine koyun.", "In your root layout, add the import line and put `<Glitchback />` inside `<body>`."),
      ],
      blocks: [
        { label: project.layoutFile ?? "layout", code: `import { Glitchback } from "${project.componentImport}";` },
        { label: project.layoutFile ?? "layout", code: `<body>\n  {children}\n  <Glitchback />\n</body>` },
      ],
    },
    {
      title: t("Çalıştırın", "Run it"),
      text: [
        t(
          `Sağ altta "Sorun bildir" butonu çıkar. Raporlar şimdilik geliştirme sunucusunun terminaline yazılır. Buraya kadarı yeterli; aşağıdaki adımlar isteğe bağlı.`,
          `The "Report a problem" button appears in the bottom right. For now reports are printed in the dev server's terminal. This is enough to start; the steps below are optional.`,
        ),
      ],
      blocks: [{ code: devCmd(pm) }],
    },
    aiStep(),
    githubStep(repo),
    {
      title: t("Kod önerilerini açın", "Turn on code suggestions"),
      optional: true,
      text: [
        t(
          "Frontend hataları için GitHub Actions düzeltme önerisi yazar; ekipten biri `autofix` etiketini eklerse PR açar. Bunun için yapay zekâ ve GitHub adımları gerekir. `models` satırlarını seçtiğiniz sağlayıcıya göre değiştirin.",
          "For frontend bugs, GitHub Actions writes a suggested fix; when a teammate adds the `autofix` label it opens a PR. This needs the AI and GitHub steps. Change the `models` lines to the provider you picked.",
        ),
        t(
          `Yapay zekâ anahtarını GitHub'da Actions secret'ı olarak ekleyin (örn. \`${firstKeyEnv}\`).`,
          `Add the AI key as a GitHub Actions secret (e.g. \`${firstKeyEnv}\`).`,
        ),
        t(
          "Bu iki dosyayı commit'leyip **varsayılan branch'e (main)** alın: GitHub, issue ve etiket olaylarında yalnızca oradaki workflow'u çalıştırır.",
          "Commit these two files and get them onto the **default branch (main)**: GitHub runs only that branch's workflow for issue and label events.",
        ),
        t(
          'Repo ayarlarında **Settings → Actions → General → Workflow permissions** altında **"Allow GitHub Actions to create and approve pull requests"** kutusunu işaretleyin; yoksa autofix PR açamaz.',
          'In the repo, under **Settings → Actions → General → Workflow permissions**, check **"Allow GitHub Actions to create and approve pull requests"**; without it autofix cannot open a PR.',
        ),
        t(
          "Kullanımı: öneri frontend issue'larına kendiliğinden yorum olarak gelir. Beğenirseniz issue'ya `autofix` **etiketini** ekleyin (yorum yazmak bir şey yapmaz). Öneri gelmediyse `glitchback:suggest` etiketi yenisini ister.",
          "Using it: suggestions arrive on frontend issues as a comment. If you like one, add the `autofix` **label** to the issue (a comment does nothing). No suggestion? The `glitchback:suggest` label asks for one.",
        ),
      ],
      blocks: [
        { label: ".glitchback.yml", code: glitchbackYml({ allowed: allowedPaths(project), deny: sensitivePaths(project), routes: scanAppRoutes(project), provider: "gemini" }) },
        { label: ".github/workflows/glitchback.yml", code: workflowYml() },
        { label: t("GitHub CLI ile secret (isteğe bağlı)", "Secret with the GitHub CLI (optional)"), code: `gh secret set ${firstKeyEnv}${repo ? ` --repo ${repo}` : ""}` },
      ],
      links: repo
        ? [
            { label: t("Actions secret'ı ekle", "Add an Actions secret"), url: `https://github.com/${repo}/settings/secrets/actions/new` },
            { label: t("Actions PR izni", "Actions PR permission"), url: `https://github.com/${repo}/settings/actions` },
          ]
        : [],
    },
    {
      title: t("Canlıya alırken", "When you go live"),
      optional: true,
      text: [
        t(
          "`.env.local` içindeki `GLITCHBACK_*` ve yapay zekâ anahtarı değişkenlerini hosting ayarlarına da ekleyin (Vercel'de repo adı otomatik bulunur).",
          "Add the `GLITCHBACK_*` and AI key variables from `.env.local` to your hosting settings too (on Vercel the repo name is detected).",
        ),
      ],
    },
    {
      title: t("Kontrol edin", "Check the setup"),
      text: [t("Neyin hazır, neyin eksik olduğunu tek komutla görün:", "See what is ready and what is missing with one command:")],
      blocks: [{ code: `npx ${packageName()} doctor` }],
    },
  ];
  return {
    title: t("Glitchback manuel kurulum", "Glitchback manual setup"),
    intro: t(
      `Next.js ${project.nextVersion ?? ""} · ${project.appDir}/ · ${pm}${repo ? ` · github.com/${repo}` : ""}. Bu rehber projeniz için hazırlandı; dosya yolları ve kodlar kopyalanmaya hazır. Glitchback hiçbir dosyanıza dokunmadı.`,
      `Next.js ${project.nextVersion ?? ""} · ${project.appDir}/ · ${pm}${repo ? ` · github.com/${repo}` : ""}. This guide was written for your project; paths and code are ready to copy. Glitchback has not changed any of your files.`,
    ),
    steps,
  };
}

/** Sites that are not Next.js: a separate report server and one script tag. */
export function buildPlainGuide(): Guide {
  const name = packageName();
  return {
    title: t("Glitchback kurulumu (Next.js olmayan siteler)", "Glitchback setup (sites that are not Next.js)"),
    intro: t(
      "Bu proje Next.js değil. Raporları karşılayan ayrı bir sunucu açın ve sayfanıza tek bir script ekleyin.",
      "This project is not Next.js. Run a separate server that receives reports and add one script to your pages.",
    ),
    steps: [
      {
        title: t("Rapor sunucusunu açın", "Start the report server"),
        text: [
          t(
            "`GLITCHBACK_ALLOWED_ORIGINS` rapor gönderebilecek siteleri belirler. Sunucu, bulunduğu klasördeki `.env` / `.env.local` dosyalarını da okur.",
            "`GLITCHBACK_ALLOWED_ORIGINS` sets which sites may send reports. The server also reads `.env` / `.env.local` in its folder.",
          ),
        ],
        blocks: [
          { code: `GLITCHBACK_ALLOWED_ORIGINS=https://siteniz.com npx ${name} serve` },
          { label: t("ya da Docker ile", "or with Docker"), code: "docker build -t glitchback . && docker run -p 8787:8787 --env-file .env glitchback" },
        ],
      },
      {
        title: t("Sayfanıza ekleyin", "Add it to your pages"),
        text: [t("`endpoint` rapor sunucunuzun adresidir.", "`endpoint` is the address of your report server.")],
        blocks: [
          {
            code: `<script src="https://unpkg.com/${name}/dist/glitchback.global.js"></script>\n<script>Glitchback.init({ endpoint: "${t("https://rapor-sunucunuz.com", "https://your-report-server.com")}" })</script>`,
          },
        ],
      },
      aiStep(),
      githubStep(null),
    ],
  };
}

/** The short version for the terminal: step titles and the one-line commands. */
export function guideText(g: Guide): string {
  const lines = [bold(g.title), dim(g.intro), ""];
  g.steps.forEach((s, i) => {
    lines.push(`${cyan(String(i + 1))}. ${s.title}${s.optional ? dim(t(" (isteğe bağlı)", " (optional)")) : ""}`);
    // Short: one-line commands are shown, files and links are only named. The page has everything.
    const files = new Set<string>();
    for (const b of s.blocks ?? []) {
      const code = b.code.trimEnd();
      if (!b.label && code.split("\n").length <= 3) for (const l of code.split("\n")) lines.push(`     ${l}`);
      else if (b.label && /[./]/.test(b.label)) files.add(b.label.split(" · ")[0]);
    }
    if (files.size) lines.push(dim(`     ${[...files].join(", ")}`));
  });
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Escaped first, then `code` and **bold**: nothing from the project can become markup. */
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

export function guideHtml(g: Guide): string {
  const steps = g.steps
    .map((s, i) => {
      const blocks = (s.blocks ?? [])
        .map(
          (b) => `<div class="block">${b.label ? `<div class="label"><span>${esc(b.label)}</span></div>` : ""}<button type="button" class="copy">${esc(t("Kopyala", "Copy"))}</button><pre><code>${esc(b.code.trimEnd())}</code></pre></div>`,
        )
        .join("");
      const links = (s.links ?? []).length
        ? `<p class="links">${s.links!.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join("")}</p>`
        : "";
      return `<section class="step${s.optional ? " optional" : ""}"><h2><span class="n">${i + 1}</span>${esc(s.title)}${s.optional ? `<span class="tag">${esc(t("isteğe bağlı", "optional"))}</span>` : ""}</h2>${s.text.map((p) => `<p>${inline(p)}</p>`).join("")}${blocks}${links}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${lang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.title)}</title>
<style>
:root { --bg:#f7f7f4; --card:#fff; --fg:#191b1f; --muted:#5f6470; --line:#e3e3dd; --accent:#2557c4; --code:#f2f2ed; --ok:#17804a; }
@media (prefers-color-scheme: dark) { :root { --bg:#121316; --card:#1a1c20; --fg:#eceef2; --muted:#a2a7b2; --line:#2c2f36; --accent:#7aa2ff; --code:#23262c; --ok:#6fd3a0; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:780px; margin:0 auto; padding:40px 16px 80px; }
h1 { font-size:24px; margin:0 0 6px; letter-spacing:-.01em; }
.intro { color:var(--muted); margin:0 0 28px; }
.step { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:14px; }
.step h2 { display:flex; align-items:center; gap:10px; font-size:16px; margin:0 0 8px; }
.n { display:inline-grid; place-items:center; width:24px; height:24px; border-radius:50%; background:var(--accent); color:var(--card); font-size:13px; flex:none; }
.optional .n { background:transparent; color:var(--muted); border:1px solid var(--line); }
.tag { font-size:12px; font-weight:500; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:1px 8px; }
p { margin:6px 0; }
code { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--code); padding:1px 5px; border-radius:4px; }
.block { position:relative; margin-top:10px; }
.label { display:flex; align-items:center; min-height:28px; padding-right:90px; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); margin-bottom:4px; }
pre { margin:0; background:var(--code); border-radius:8px; padding:12px 14px; overflow:auto; max-height:420px; }
pre code { padding:0; background:none; font-size:12.5px; }
.copy { position:absolute; right:0; top:0; font:inherit; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
.block:not(:has(.label)) .copy { top:8px; right:8px; }
.block:not(:has(.label)) pre { padding-right:96px; }
.copy.done { color:var(--ok); border-color:var(--ok); }
.links { display:flex; flex-wrap:wrap; gap:6px 16px; margin-top:10px; }
a { color:var(--accent); }
footer { color:var(--muted); font-size:13px; margin-top:24px; }
</style>
</head>
<body>
<main>
<h1>${esc(g.title)}</h1>
<p class="intro">${inline(g.intro)}</p>
${steps}
<footer>${esc(t("Bu sayfa bilgisayarınızda oluşturuldu; hiçbir yere gönderilmedi.", "This page was created on your computer and sent nowhere."))}</footer>
</main>
<script>
document.querySelectorAll(".copy").forEach(function (b) {
  b.addEventListener("click", function () {
    var text = b.parentElement.querySelector("pre").innerText;
    var done = function () { var l = b.textContent; b.textContent = ${JSON.stringify(t("Kopyalandı", "Copied"))}; b.classList.add("done"); setTimeout(function () { b.textContent = l; b.classList.remove("done"); }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { var r = document.createRange(); r.selectNodeContents(b.parentElement.querySelector("pre")); var s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand("copy"); done(); } catch (e) {} }
  });
});
</script>
</body>
</html>
`;
}

/** Prints the short guide, writes the full page to the temp folder and opens it. Returns the page's path. */
export function showGuide(g: Guide, projectRoot: string, opts: { open: boolean }): string {
  const name = basename(projectRoot).replace(/[^\w.-]+/g, "-").slice(0, 40) || "proje";
  const file = join(tmpdir(), `glitchback-${t("kurulum", "setup")}-${name}.html`);
  writeFileSync(file, guideHtml(g));
  const url = pathToFileURL(file).href;
  console.log(`\n${guideText(g)}\n`);
  console.log(`${bold(t("Ayrıntılı rehber", "Full guide"))}: ${cyan(url)}${opts.open ? dim(t("  (tarayıcıda açıldı)", "  (opened in your browser)")) : ""}\n`);
  if (opts.open) openUrl(url);
  return file;
}
