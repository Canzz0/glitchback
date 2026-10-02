import { readFileSync } from "node:fs";
import type { NextProject } from "./detect.ts";
import type { ScannedRoute } from "./routes.ts";

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
    `// Patchback: "Sorun bildir" raporlarını karşılar. Ayarlar .env.local içinde (PATCHBACK_*, TYPESAFE_API_KEY).`,
    `export { GET, POST, OPTIONS } from "patchback/next";`,
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
    `import { init } from "patchback/widget";`,
    "",
    `/**`,
    ` * Sağ alttaki "Sorun bildir" butonu. Raporlar /api/patchback'e gider.`,
    ` * Başarısız istekler (400+) ve yakalanmamış hatalar, kimse butona basmasa da otomatik rapor olur.`,
    ` * Kapatmak için: init({ autoReport: false }). Diğer seçenekler (labels, button: false, getRoute...) README'de.`,
    ` */`,
    `export function Patchback()${ts ? ": null" : ""} {`,
    `  useEffect(() => {`,
    `    init({ askContact: true });`,
    `  }, []);`,
    `  return null;`,
    `}`,
    "",
  ].join("\n");
}

/** Adds the import and <Patchback /> to the root layout. Returns null if it cannot do it safely. */
export function patchLayout(source: string, importPath: string): string | null {
  if (/<Patchback\s*\/>/.test(source)) return source;
  if (!/<\/body>/.test(source)) return null;
  const importLine = `import { Patchback } from "${importPath}";`;
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
  return out.replace(/(\n?)([ \t]*)<\/body>/, (_m, nl: string, indent: string) => `${nl}${indent}  <Patchback />\n${indent}</body>`);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function patchbackYml(opts: {
  allowed: string[];
  deny: string[];
  routes: ScannedRoute[];
  provider: ProviderChoice;
}): string {
  const models = PROVIDERS[opts.provider === "none" ? "gemini" : opts.provider].models;
  const lines = [
    "# Patchback ayarları. `npx patchback init` oluşturdu; elle düzenleyebilirsiniz.",
    "",
    "# Model yalnızca bu klasörlerdeki dosyaları okuyup değiştirebilir.",
    "allowed_paths:",
    ...opts.allowed.map((p) => `  - ${q(p)}`),
    "",
    "# İzinli klasörlerde olsalar bile asla dokunulmaz: sunucu kodu, kimlik doğrulama, veritabanı, ayarlar.",
    "deny_paths:",
    ...opts.deny.map((p) => `  - ${q(p)}`),
    "",
    "# Zorluk kademesine göre kod modeli, \"sağlayıcı:model\" biçiminde (anthropic, openai, gemini, openrouter, ollama).",
    ...(opts.provider === "none" ? ["# Henüz anahtar girilmedi: GitHub'da GEMINI_API_KEY secret'ı ekleyince çalışır ya da başka sağlayıcı yazın."] : []),
    "models:",
    `  low: ${q(models[0])}`,
    `  mid: ${q(models[1])}`,
    `  high: ${q(models[2])}`,
    "",
    "# Sayfa → o sayfayı oluşturan dosyalar. Uygulamanızdaki sayfalar taranarak bulundu.",
    "routes:",
    ...(opts.routes.length ? opts.routes.flatMap((r) => [`  ${q(r.url)}:`, ...r.specs.map((s) => `    - ${q(s)}`)]) : ["  {}"]),
    "",
    "max_changed_lines: 300",
    "language: tr",
    "",
  ];
  return lines.join("\n");
}

/**
 * The exact version that wrote the workflow. The jobs hold secrets and write access, so they
 * must never pull whatever is newest on npm: upgrading is a reviewed change to this file.
 */
export function packageVersion(): string {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (pkg.name === "patchback" && /^\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
    } catch {}
  }
  throw new Error("patchback: could not read its own version from package.json");
}

/** One workflow, two jobs: a read-only suggestion, and a write job that only a teammate's label can start. */
export function workflowYml(version = packageVersion()): string {
  return `# Patchback: frontend hata raporlarına düzeltme önerir, ekip onaylayınca PR açar.
# Öneri adımı yalnızca okuma izniyle çalışır. Koda yazma, bir ekip üyesi issue'ya
# \`autofix\` etiketini eklediğinde başlar ve yalnızca bot yorumundaki diff'i uygular.
name: Patchback

on:
  issues:
    types: [opened, labeled]

permissions: {}

jobs:
  suggest:
    if: >-
      contains(github.event.issue.labels.*.name, 'patchback') &&
      !contains(github.event.issue.labels.*.name, 'patchback:needs-review') &&
      (
        (github.event.action == 'opened' &&
          (contains(github.event.issue.labels.*.name, 'area:frontend') ||
           contains(github.event.issue.labels.*.name, 'area:both'))) ||
        (github.event.action == 'labeled' && github.event.label.name == 'patchback:suggest')
      )
    runs-on: ubuntu-latest
    timeout-minutes: 15
    concurrency: patchback-\${{ github.event.issue.number }}
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y patchback@${version} suggest
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # Yalnızca .patchback.yml'deki sağlayıcının anahtarı gerekir.
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}

  fix:
    if: github.event.action == 'labeled' && github.event.label.name == 'autofix' && contains(github.event.issue.labels.*.name, 'patchback')
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency: patchback-\${{ github.event.issue.number }}
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # GITHUB_TOKEN ile açılan PR'lar CI'ı tetiklemez. Testlerin PR'da çalışması için
          # isteğe bağlı PATCHBACK_TOKEN secret'ı (Contents + Pull requests yazma izinli token) ekleyin.
          token: \${{ secrets.PATCHBACK_TOKEN || secrets.GITHUB_TOKEN }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Bu adım modeli çağırmaz; model anahtarı verilmez.
      - run: npx -y patchback@${version} fix
        env:
          GITHUB_TOKEN: \${{ secrets.PATCHBACK_TOKEN || secrets.GITHUB_TOKEN }}
`;
}

/** Fine-grained token page with the right permission already selected (the repo is picked by the user). */
export function tokenUrl(repo: string | null): string {
  const owner = repo?.split("/")[0];
  const params = new URLSearchParams({
    name: `Patchback ${repo?.split("/")[1] ?? ""}`.trim().slice(0, 40),
    description: "Patchback: son kullanıcı raporlarını bu repoda issue olarak açar. Sadece Issues: write.",
    expires_in: "366",
    issues: "write",
  });
  if (owner) params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}
