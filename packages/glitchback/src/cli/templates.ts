import { readFileSync } from "node:fs";
import type { NextProject } from "./detect.ts";
import type { ScannedRoute } from "./routes.ts";
import { lang, t } from "./i18n.ts";

export type ProviderChoice = "gemini" | "anthropic" | "openai" | "none";

export const PROVIDERS: Record<Exclude<ProviderChoice, "none">, { label: string; keyEnv: string; keyUrl: string; models: [string, string, string] }> = {
  gemini: {
    label: "Google Gemini",
    keyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    models: ["gemini:gemini-3.5-flash-lite", "gemini:gemini-3.5-flash", "gemini:gemini-3.8-flash"],
  },
  anthropic: {
    label: "Anthropic Claude",
    keyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://platform.claude.com/settings/keys",
    models: ["anthropic:claude-haiku-4-5-20251001", "anthropic:claude-sonnet-5", "anthropic:claude-opus-5-5"],
  },
  openai: {
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    models: ["openai:gpt-6-luna", "openai:gpt-6-sol", "openai:gpt-6-astra"],
  },
};

export function routeFile(): string {
  return [
    t(
      `// Glitchback: "Sorun bildir" raporlarını karşılar. Ayarlar .env.local içinde (GLITCHBACK_*, TYPESAFE_API_KEY).`,
      `// Glitchback: receives "Report a problem" reports. Settings live in .env.local (GLITCHBACK_*, TYPESAFE_API_KEY).`,
    ),
    `export { GET, POST, OPTIONS } from "${packageName()}/next";`,
    `export const runtime = "nodejs";`,
    "",
  ].join("\n");
}

export function componentFile(project: NextProject): string {
  const ts = project.typescript;
  return [
    `"use client";`,
    "",
    `import { useEffect } from "react";`,
    `import { init } from "${packageName()}/widget";`,
    "",
    `/**`,
    ...(lang() === "tr"
      ? [
          ` * Sağ alttaki "Sorun bildir" butonu. Raporlar /api/glitchback adresine gider.`,
          ` * Başarısız istekler (400+) ve yakalanmamış hatalar, kimse butona basmasa da otomatik rapor olur.`,
          ` * Kapatmak için: init({ autoReport: false }). Diğer seçenekler (labels, button: false, getRoute...) README'de.`,
          ` * Butonun dili sayfadan otomatik seçilir (locale: "auto").`,
        ]
      : [
          ` * The "Report a problem" button in the bottom right. Reports go to /api/glitchback.`,
          ` * Failed requests (400+) and uncaught errors are reported automatically, even without a click.`,
          ` * To turn that off: init({ autoReport: false }). Other options (labels, button: false, getRoute...) are in the README.`,
          ` * The button's language follows the page (locale: "auto").`,
        ]),
    ` */`,
    `export function Glitchback()${ts ? ": null" : ""} {`,
    `  useEffect(() => {`,
    `    init({ askContact: true });`,
    `  }, []);`,
    `  return null;`,
    `}`,
    "",
  ].join("\n");
}

/** Adds the import and <Glitchback /> to the root layout. Returns null if it cannot do it safely. */
export function patchLayout(source: string, importPath: string): string | null {
  if (/<Glitchback\s*\/>/.test(source)) return source;
  if (!/<\/body>/.test(source)) return null;
  const importLine = `import { Glitchback } from "${importPath}";`;
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["'][^"']+["'];?[^\S\n]*$/gm)];
  let out: string;
  if (imports.length) {
    const last = imports[imports.length - 1];
    const at = last.index! + last[0].length;
    out = `${source.slice(0, at)}\n${importLine}${source.slice(at)}`;
  } else {
    const directive = source.match(/^(["']use (client|server)["'];?\s*\n)/);
    out = directive ? `${directive[1]}${importLine}\n${source.slice(directive[1].length)}` : `${importLine}\n${source}`;
  }
  return out.replace(/(\n?)([ \t]*)<\/body>/, (_m, nl: string, indent: string) => `${nl}${indent}  <Glitchback />\n${indent}</body>`);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function glitchbackYml(opts: {
  allowed: string[];
  deny: string[];
  routes: ScannedRoute[];
  provider: ProviderChoice;
}): string {
  const models = PROVIDERS[opts.provider === "none" ? "gemini" : opts.provider].models;
  const lines = [
    t("# Glitchback ayarları. `npx glitchback init` oluşturdu; elle düzenleyebilirsiniz.", "# Glitchback settings. Written by `npx glitchback init`; edit freely."),
    "",
    t("# Model yalnızca bu klasörlerdeki dosyaları okuyup değiştirebilir.", "# The model can only read and change files under these folders."),
    "allowed_paths:",
    ...opts.allowed.map((p) => `  - ${q(p)}`),
    "",
    t("# İzinli klasörlerde olsalar bile asla dokunulmaz: sunucu kodu, kimlik doğrulama, veritabanı, ayarlar.", "# Never touched, even inside allowed folders: server code, auth, database, config."),
    "deny_paths:",
    ...opts.deny.map((p) => `  - ${q(p)}`),
    "",
    t('# Zorluk kademesine göre kod modeli, "sağlayıcı:model" biçiminde (anthropic, openai, gemini, openrouter, ollama).', '# Code model per difficulty tier, as "provider:model" (anthropic, openai, gemini, openrouter, ollama).'),
    ...(opts.provider === "none"
      ? [t("# Henüz anahtar girilmedi: GitHub'da GEMINI_API_KEY secret'ı ekleyince çalışır ya da başka sağlayıcı yazın.", "# No key entered yet: works once you add a GEMINI_API_KEY secret on GitHub, or write another provider.")]
      : []),
    "models:",
    `  low: ${q(models[0])}`,
    `  mid: ${q(models[1])}`,
    `  high: ${q(models[2])}`,
    "",
    t("# Sayfa → o sayfayı oluşturan dosyalar. Uygulamanızdaki sayfalar taranarak bulundu.", "# Page → the files that build it. Found by scanning your app's pages."),
    "routes:",
    ...(opts.routes.length ? opts.routes.flatMap((r) => [`  ${q(r.url)}:`, ...r.specs.map((s) => `    - ${q(s)}`)]) : ["  {}"]),
    "",
    "max_changed_lines: 300",
    t("# Öneri yorumlarının dili: tr ya da en", "# Language of suggestion comments: en or tr"),
    `language: ${lang()}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * This package's npm name and exact version, read from its own package.json, so the name
 * lives in one place. The workflow pins the exact version: its jobs hold secrets and write
 * access, so they must never pull whatever is newest on npm.
 */
export function packageInfo(): { name: string; version: string } {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (pkg.bin?.glitchback && /^\d+\.\d+\.\d+/.test(pkg.version)) return { name: pkg.name, version: pkg.version };
    } catch {}
  }
  throw new Error("glitchback: could not read its own package.json");
}
export const packageVersion = () => packageInfo().version;
export const packageName = () => packageInfo().name;

/** One workflow, two jobs: a read-only suggestion, and a write job that only a teammate's label can start. */
export function workflowYml(version = packageVersion(), name = packageName()): string {
  const header = t(
    `# Glitchback: frontend hata raporlarına düzeltme önerir, ekip onaylayınca PR açar.
# Öneri adımı yalnızca okuma izniyle çalışır. Koda yazma, bir ekip üyesi issue'ya
# \`autofix\` etiketini eklediğinde başlar ve yalnızca bot yorumundaki diff'i uygular.`,
    `# Glitchback: suggests fixes for frontend bug reports and opens a PR once the team approves.
# The suggestion step runs with read-only access. Writing code starts only when a teammate
# adds the \`autofix\` label, and only the diff from the bot's comment is applied.`,
  );
  const keyNote = t("# Yalnızca .glitchback.yml'deki sağlayıcının anahtarı gerekir.", "# Only the key of the provider in .glitchback.yml is needed.");
  const prNote = t(
    `# GITHUB_TOKEN ile açılan PR'lar CI'ı tetiklemez. Testlerin PR'da çalışması için
          # isteğe bağlı GLITCHBACK_TOKEN secret'ı (Contents + Pull requests yazma izinli token) ekleyin.`,
    `# PRs opened with GITHUB_TOKEN do not trigger CI. To run your tests on the PR, add an
          # optional GLITCHBACK_TOKEN secret (a token with Contents + Pull requests write access).`,
  );
  const noModel = t("# Bu adım modeli çağırmaz; model anahtarı verilmez.", "# This step never calls a model; no model key is passed.");
  return `${header}
name: Glitchback

on:
  issues:
    types: [opened, labeled]

permissions: {}

jobs:
  suggest:
    if: >-
      contains(github.event.issue.labels.*.name, 'glitchback') &&
      !contains(github.event.issue.labels.*.name, 'glitchback:needs-review') &&
      (
        (github.event.action == 'opened' &&
          (contains(github.event.issue.labels.*.name, 'area:frontend') ||
           contains(github.event.issue.labels.*.name, 'area:both'))) ||
        (github.event.action == 'labeled' && github.event.label.name == 'glitchback:suggest')
      )
    runs-on: ubuntu-latest
    timeout-minutes: 15
    concurrency: glitchback-\${{ github.event.issue.number }}
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y ${name}@${version} suggest
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ${keyNote}
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}

  fix:
    if: github.event.action == 'labeled' && github.event.label.name == 'autofix' && contains(github.event.issue.labels.*.name, 'glitchback')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency: glitchback-\${{ github.event.issue.number }}
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ${prNote}
          token: \${{ secrets.GLITCHBACK_TOKEN || secrets.GITHUB_TOKEN }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      ${noModel}
      - run: npx -y ${name}@${version} fix
        env:
          GITHUB_TOKEN: \${{ secrets.GLITCHBACK_TOKEN || secrets.GITHUB_TOKEN }}
`;
}

/** Fine-grained token page with the right permission already selected (the repo is picked by the user). */
export function tokenUrl(repo: string | null): string {
  const owner = repo?.split("/")[0];
  const params = new URLSearchParams({
    name: `Glitchback ${repo?.split("/")[1] ?? ""}`.trim().slice(0, 40),
    description: t("Glitchback: son kullanıcı raporlarını bu repoda issue olarak açar. Sadece Issues: write.", "Glitchback: opens end-user reports as issues in this repo. Issues: write only."),
    expires_in: "366",
    issues: "write",
  });
  if (owner) params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}
