import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixerFromActions } from "../fixer/run.ts";
import { serve } from "../server/serve.ts";
import { init } from "./init.ts";
import { runLocalFixer } from "./local-fixer.ts";
import { bold, dim, readEnvFiles } from "./util.ts";
import type { ProviderChoice } from "./templates.ts";
import { t } from "./i18n.ts";

const help = () =>
  t(
    `${bold("glitchback")} — son kullanıcı hata raporları → GitHub issue → düzeltme önerisi → PR

  ${bold("npx glitchback init")} [klasör]        Next.js projesine kurar (buton, endpoint, ayarlar)
      --yes                 soru sormadan, ortamdaki anahtarlarla
      --no-install          paketi kurma, sadece dosyaları yaz
      --force               var olan Glitchback dosyalarının üstüne yaz
      --provider <ad>       gemini | anthropic | openai | none

  ${bold("npx glitchback suggest")} <issue-no>   Bu makinede öneri yazar (geçici klonda çalışır)
  ${bold("npx glitchback fix")} <issue-no>       Onaylanan öneriyi branch'e uygulayıp PR açar
  ${bold("npx glitchback serve")} [--port 8787]  Next.js olmayan siteler için ayrı rapor sunucusu

  --lang tr|en              Dil (varsayılan: terminalin dili)
  GitHub Actions içinde issue numarası verilmeden çalışan suggest/fix, olayı GITHUB_EVENT_PATH'ten okur.
`,
    `${bold("glitchback")} — end-user bug reports → GitHub issue → suggested fix → PR

  ${bold("npx glitchback init")} [folder]        Sets it up in a Next.js project (button, endpoint, settings)
      --yes                 no questions, use the keys already in the environment
      --no-install          do not install the package, only write the files
      --force               overwrite existing Glitchback files
      --provider <name>     gemini | anthropic | openai | none

  ${bold("npx glitchback suggest")} <issue-no>   Writes a suggestion from this machine (works in a temporary clone)
  ${bold("npx glitchback fix")} <issue-no>       Applies the approved suggestion to a branch and opens a PR
  ${bold("npx glitchback serve")} [--port 8787]  Separate report server for sites that are not Next.js

  --lang tr|en              Language (default: your terminal's language)
  Inside GitHub Actions, suggest/fix without an issue number read the event from GITHUB_EVENT_PATH.
`,
  );

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--port", "--provider", "--dir", "--lang"].includes(args[i - 1])));

  switch (cmd) {
    case "init": {
      const provider = flag(args, "--provider") as ProviderChoice | undefined;
      if (provider && !["gemini", "anthropic", "openai", "none"].includes(provider)) throw new Error(t(`Bilinmeyen sağlayıcı: ${provider}`, `Unknown provider: ${provider}`));
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
      if (!n || !/^\d+$/.test(n)) throw new Error(t(`Kullanım: npx glitchback ${cmd} <issue-no>`, `Usage: npx glitchback ${cmd} <issue-no>`));
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
      console.log(help());
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") {
        console.log(dim(t(`Bilinmeyen komut: ${cmd}`, `Unknown command: ${cmd}`)));
        process.exitCode = 1;
      }
  }
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
