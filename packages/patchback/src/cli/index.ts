import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixerFromActions } from "../fixer/run.ts";
import { serve } from "../server/serve.ts";
import { init } from "./init.ts";
import { runLocalFixer } from "./local-fixer.ts";
import { bold, dim, readEnvFiles } from "./util.ts";
import type { ProviderChoice } from "./templates.ts";

const HELP = `${bold("patchback")} — son kullanıcı hata raporları → GitHub issue → düzeltme önerisi → PR

  ${bold("npx patchback init")} [klasör]        Next.js projesine kurar (buton, endpoint, ayarlar)
      --yes                 soru sormadan, ortamdaki anahtarlarla
      --no-install          paketi kurma, sadece dosyaları yaz
      --force               var olan Patchback dosyalarının üstüne yaz
      --provider <ad>       gemini | anthropic | openai | none

  ${bold("npx patchback suggest")} <issue-no>   Bu makinede öneri yazar (geçici klonda çalışır)
  ${bold("npx patchback fix")} <issue-no>       Onaylanan öneriyi branch'e uygulayıp PR açar
  ${bold("npx patchback serve")} [--port 8787]  Next.js olmayan siteler için ayrı rapor sunucusu

  GitHub Actions içinde issue numarası verilmeden çalışan suggest/fix, olayı GITHUB_EVENT_PATH'ten okur.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--port", "--provider", "--dir"].includes(args[i - 1])));

  switch (cmd) {
    case "init": {
      const provider = flag(args, "--provider") as ProviderChoice | undefined;
      if (provider && !["gemini", "anthropic", "openai", "none"].includes(provider)) throw new Error(`Bilinmeyen sağlayıcı: ${provider}`);
      await init({
        dir: positional[0] ?? process.cwd(),
        yes: args.includes("--yes") || args.includes("-y"),
        install: !args.includes("--no-install"),
        force: args.includes("--force"),
        provider,
      });
      return;
    }
    case "suggest":
    case "fix": {
      const n = positional[0];
      if (!n && process.env.GITHUB_EVENT_PATH) return runFixerFromActions(cmd);
      if (!n || !/^\d+$/.test(n)) throw new Error(`Kullanım: npx patchback ${cmd} <issue-no>`);
      return runLocalFixer(cmd, Number(n), flag(args, "--dir") ?? process.cwd());
    }
    case "serve": {
      // Like the dev servers people know: .env / .env.local in the current folder are read too.
      for (const [k, v] of Object.entries(readEnvFiles(process.cwd()))) process.env[k] ??= v;
      serve(Number(flag(args, "--port") ?? process.env.PORT ?? 8787));
      return;
    }
    case "--version":
    case "-v": {
      const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
      console.log(pkg.version);
      return;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
        console.log(dim(`Bilinmeyen komut: ${cmd}`));
        process.exitCode = 1;
      }
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
