import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { init } from "../src/cli/init.ts";
import { patchLayout } from "../src/cli/templates.ts";
import { upsertEnv, githubRepoFromRemote } from "../src/cli/util.ts";
import { loadRepoConfig } from "../src/fixer/config.ts";
import { isPathAllowed } from "../src/fixer/git.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-next-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "shop", dependencies: { next: "15.2.1", react: "19.0.0" } }),
    "tsconfig.json": `{
      // comments are allowed in tsconfig
      "compilerOptions": { "paths": { "@/*": ["./*"] }, },
    }`,
    "package-lock.json": "{}",
    ".gitignore": "node_modules\n.env*\n",
    ".env": "NEXT_PUBLIC_API_URL=https://api.shop.test\n",
    "app/layout.tsx": `import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
`,
    "app/page.tsx": "export default function Home() { return null }",
    "app/(shop)/navbar/navbar.tsx": "export const Navbar = () => null",
    "app/(shop)/products/[id]/page.tsx": "export default function P() { return null }",
    "app/(shop)/products/[id]/components/gallery.tsx": "export const Gallery = () => null",
    "app/(shop)/products/[id]/reviews/page.tsx": "export default function R() { return null }",
    "app/(admin)/admin/page.tsx": "export default function A() { return null }",
    "app/(admin)/admin/_lib/table.ts": "export const t = 1",
    "app/api/orders/route.ts": "export const GET = () => new Response()",
    "components/ui/button.tsx": "export const Button = () => null",
    "lib/auth.ts": "export const secret = 1",
    "lib/prisma.ts": "export const db = 1",
    "lib/utils.ts": "export const cn = () => ''",
    "middleware.ts": "export function middleware() {}",
    "prisma/schema.prisma": "",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: root });
  return root;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

test("init wires a Next.js app in one go", async () => {
  const root = fixture();
  const saved = { ...process.env };
  process.env.TYPESAFE_API_KEY = "jv_test";
  process.env.GEMINI_API_KEY = "g_test";
  try {
    await quiet(() => init({ dir: root, yes: true, install: false, force: false, useGh: false }));
    const read = (p: string) => readFileSync(join(root, p), "utf8");

    assert.match(read("app/api/glitchback/route.ts"), /export \{ GET, POST, OPTIONS \} from "glitchback\/next"/);
    assert.match(read("components/glitchback.tsx"), /"use client"/);
    const layout = read("app/layout.tsx");
    assert.match(layout, /import \{ Glitchback \} from "@\/components\/glitchback";/);
    assert.match(layout, /<Glitchback \/>\n\s*<\/body>/);

    const env = read(".env.local");
    assert.ok(!env.includes("TYPESAFE_API_KEY"), "Jev is optional: init never writes its key");
    assert.match(env, /GEMINI_API_KEY=g_test/);
    assert.match(env, /TRIAGE_MODEL=gemini:gemini-3.5-flash\n/);
    assert.ok(!env.includes("GLITCHBACK_GITHUB_TOKEN"), "no token given, nothing written");
    assert.equal(read(".env"), "NEXT_PUBLIC_API_URL=https://api.shop.test\n", "existing .env untouched");

    assert.match(read(".github/workflows/glitchback.yml"), /npx -y glitchback@\d+\.\d+\.\d+ suggest/);

    // The generated config is valid for the fixer and protects server code.
    process.chdir(root);
    const cfg = loadRepoConfig();
    assert.equal(cfg.models.mid, "gemini:gemini-3.5-flash");
    assert.deepEqual(cfg.allowed_paths, ["app/", "components/", "lib/"]);
    for (const p of ["app/api/orders/route.ts", "lib/auth.ts", "lib/prisma.ts", "middleware.ts", "prisma/schema.prisma", ".env.local", "components/glitchback.tsx"]) {
      assert.equal(isPathAllowed(p, cfg), false, `${p} must be denied`);
    }
    assert.equal(isPathAllowed("lib/utils.ts", cfg), true);
    assert.equal(isPathAllowed("app/(shop)/products/[id]/page.tsx", cfg), true);

    // Routes: groups dropped, [id] → :id, and each route's specs match its real files in git.
    assert.deepEqual(Object.keys(cfg.routes), ["/", "/admin", "/products/:id", "/products/:id/reviews"]);
    execFileSync("git", ["add", "-A"], { cwd: root });
    const ls = (specs: string[]) => execFileSync("git", ["ls-files", "--", ...specs], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    const product = ls(cfg.routes["/products/:id"]);
    assert.ok(product.includes("app/(shop)/products/[id]/page.tsx"));
    assert.ok(product.includes("app/(shop)/products/[id]/components/gallery.tsx"));
    assert.ok(product.includes("app/(shop)/navbar/navbar.tsx"), "group-level helpers are included");
    assert.ok(product.includes("app/layout.tsx"));
    assert.ok(!product.includes("app/(shop)/products/[id]/reviews/page.tsx"), "child routes stay separate");
    assert.ok(ls(cfg.routes["/admin"]).includes("app/(admin)/admin/_lib/table.ts"), "private folders belong to their route");
    assert.deepEqual(ls(cfg.routes["/"]), ["app/layout.tsx", "app/page.tsx"]);

    // Running init again changes nothing.
    const before = layout;
    await quiet(() => init({ dir: root, yes: true, install: false, force: false, useGh: false }));
    assert.equal(read("app/layout.tsx"), before);
    assert.equal((read(".env.local").match(/GEMINI_API_KEY/g) ?? []).length, 1);
    assert.ok(!read("app/api/glitchback/route.ts").includes("TYPESAFE"), "route comment does not point at Jev");
  } finally {
    process.chdir(tmpdir());
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("init refuses non-Next projects with a clear pointer to the standalone server", async () => {
  const root = mkdtempSync(join(tmpdir(), "pb-plain-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  const out: string[] = [];
  const original = console.log;
  console.log = (s: string) => out.push(s);
  try {
    await init({ dir: root, yes: true, install: false, force: false, useGh: false });
    assert.match(out.join("\n"), /glitchback serve/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = original;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchLayout handles layouts without imports and leaves unknown shapes alone", () => {
  assert.equal(patchLayout("export default function L({c}) { return c }", "@/components/glitchback"), null);
  const out = patchLayout(`"use client";\nexport default function L({ children }) {\n  return <html><body>{children}</body></html>;\n}\n`, "../components/glitchback")!;
  assert.match(out, /^"use client";\nimport \{ Glitchback \} from "..\/components\/glitchback";/);
  assert.match(out, /<Glitchback \/>/);
});

test("upsertEnv replaces keys in place, appends new ones, keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-env-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "# mine\nA=1\nTYPESAFE_API_KEY=old\n");
  const changed = upsertEnv(file, { TYPESAFE_API_KEY: "new$&", GEMINI_API_KEY: "g", EMPTY: "" });
  assert.deepEqual(changed, ["TYPESAFE_API_KEY", "GEMINI_API_KEY"]);
  assert.equal(readFileSync(file, "utf8"), "# mine\nA=1\nTYPESAFE_API_KEY=new$&\n\n# Glitchback\nGEMINI_API_KEY=g\n");
  rmSync(dir, { recursive: true, force: true });
});

test("GitHub remotes in every common shape", () => {
  assert.equal(githubRepoFromRemote("https://github.com/Canzz0/AppountmentService.git"), "Canzz0/AppountmentService");
  assert.equal(githubRepoFromRemote("git@github.com:acme/shop.git"), "acme/shop");
  assert.equal(githubRepoFromRemote("https://github.com/acme/shop"), "acme/shop");
  assert.equal(githubRepoFromRemote("https://gitlab.com/acme/shop.git"), null);
});

/* ---- Aşama 0: kurulum hataları ---- */

const MODEL_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "TRIAGE_MODEL", "TYPESAFE_API_KEY", "GLITCHBACK_GITHUB_TOKEN"];

async function capture<T>(fn: () => Promise<T>): Promise<string> {
  const out: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return out.join("\n");
}

test("no terminal and no AI key: no model is picked and no workflow is written", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  try {
    // yes: false, but tests have no TTY: the questions cannot be asked.
    const out = await capture(() => init({ dir: root, yes: false, install: false, force: false, useGh: false }));
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    assert.throws(() => read(".github/workflows/glitchback.yml"), "no workflow without a model");
    assert.ok(!/TRIAGE_MODEL|GEMINI_API_KEY/.test((() => { try { return read(".env.local"); } catch { return ""; } })()));
    process.chdir(root);
    const cfg = loadRepoConfig();
    assert.ok(cfg.models.mid, ".glitchback.yml stays valid");
    assert.ok(!/Sayfayı açıyorum|Opening the page/.test(out), "nothing promises a browser page without a terminal");
    assert.ok(!/GEMINI_API_KEY secret/.test(out), "no secret warning for a provider nobody chose");
  } finally {
    process.chdir(tmpdir());
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("no terminal but a key in the environment: that provider is used and the workflow is written", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = "a_test";
  try {
    await quiet(() => init({ dir: root, yes: false, install: false, force: false, useGh: false }));
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    assert.match(read(".github/workflows/glitchback.yml"), /suggest/);
    assert.match(read(".glitchback.yml"), /mid: 'anthropic:/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchLayout keeps a one-line <body> readable", () => {
  const src = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
`;
  const out = patchLayout(src, "../components/glitchback")!;
  assert.ok(out.includes(`      <body>{children}\n        <Glitchback />\n      </body>\n    </html>`), out);
  // Already multi-line bodies are unchanged in shape.
  const multi = patchLayout(`import x from "y";\nexport default function L({ children }) {\n  return (\n    <html>\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n`, "@/components/glitchback")!;
  assert.ok(multi.includes(`        {children}\n        <Glitchback />\n      </body>`), multi);
});

/* ---- Aşama 1: Otomatik / Manuel kurulum ---- */
import { readdirSync, statSync, existsSync } from "node:fs";
import { buildNextGuide, buildPlainGuide, guideHtml, guideText } from "../src/cli/manual.ts";
import { detectNext } from "../src/cli/detect.ts";

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[abs.slice(root.length)] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

test("manual setup touches no project file and points to a guide written for this project", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  try {
    const before = snapshot(root);
    const out = await capture(() => init({ dir: root, yes: false, install: false, force: false, useGh: false, mode: "manual" }));
    assert.deepEqual(snapshot(root), before, "manual mode must not change the project");
    const htmlPath = out.match(/(\S+glitchback-[^\s]+\.html)/)?.[1];
    assert.ok(htmlPath && existsSync(htmlPath.replace(/^file:\/\//, "")), "guide path printed: " + out);
    const html = readFileSync(htmlPath!.replace(/^file:\/\//, ""), "utf8");
    assert.match(html, /app\/api\/glitchback\/route\.ts/);
    assert.match(out, /npm install glitchback/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manual guide uses this project's paths, routes, package manager and repo", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const det = detectNext(root);
    assert.ok(det.ok);
    const g = buildNextGuide(det.project, "acme/shop");
    // The terminal shows long files only by name; the blocks (and the page) carry them in full.
    const text = [guideText(g), ...g.steps.flatMap((s) => [...(s.blocks ?? []).map((b) => b.code), ...(s.links ?? []).map((l) => l.url)])].join("\n");
    assert.match(text, /pnpm add glitchback/);
    assert.match(text, /app\/api\/glitchback\/route\.ts/);
    assert.match(text, /components\/glitchback\.tsx/);
    assert.match(text, /import \{ Glitchback \} from "@\/components\/glitchback";/);
    assert.match(text, /app\/layout\.tsx/);
    assert.match(text, /'\/products\/:id':/, "scanned routes are in the ready-made .glitchback.yml");
    assert.match(text, /target_name=acme/, "token page for this repo's owner");
    assert.match(text, /github\.com\/acme\/shop\/settings\/secrets\/actions/);
    assert.match(text, /GLITCHBACK_GITHUB_REPO=acme\/shop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guide page escapes everything it shows", () => {
  const html = guideHtml({
    title: "T <b>",
    intro: "i",
    steps: [{ title: "<img src=x onerror=alert(1)>", text: ["a `<script>` b"], blocks: [{ label: "f", code: "</pre><script>alert(1)</script>" }] }],
  });
  assert.ok(!html.includes("<img src=x"), "title escaped");
  assert.ok(!html.includes("<script>alert(1)</script>"), "code escaped");
  assert.match(html, /&lt;script&gt;/);
});

test("sites that are not Next.js get the script-tag guide; manual mode is a success there", async () => {
  const root = mkdtempSync(join(tmpdir(), "pb-plain-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  try {
    assert.match(guideText(buildPlainGuide()), /glitchback\.global\.js/);
    const out = await capture(() => init({ dir: root, yes: false, install: false, force: false, useGh: false, mode: "manual" }));
    assert.match(out, /glitchback serve/);
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---- Aşama 2: Jev sorulmaz ---- */
test("init does not ask for or mention Jev; the AI key covers triage", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  process.env.OPENAI_API_KEY = "o_test";
  try {
    const out = await capture(() => init({ dir: root, yes: false, install: false, force: false, useGh: false }));
    assert.ok(!/Jev|TYPESAFE/i.test(out), out);
    const env = readFileSync(join(root, ".env.local"), "utf8");
    assert.match(env, /TRIAGE_MODEL=openai:/);
    assert.match(out, /OpenAI/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---- Yapay zekâ seçimi: anahtar varken de sorulur, sonradan değiştirilebilir ---- */
import { providerMenu, setYmlModels } from "../src/cli/templates.ts";

test("the AI menu is always offered; a key that is already there is only the default", () => {
  const found = providerMenu("gemini");
  assert.equal(found.fallback, "gemini");
  assert.deepEqual(found.options.map((o) => o.key), ["gemini", "anthropic", "openai", "none"]);
  assert.match(found.options[0].label, /anahtar bulundu|key found/);
  assert.ok(!/anahtar bulundu|key found/.test(found.options[1].label));
  assert.equal(providerMenu(null).fallback, "none", "with no key, Enter still means skip");
});

test("setYmlModels swaps the three tier models and keeps everything else", () => {
  const yml = "# mine\nallowed_paths:\n  - 'app/'\n# Henüz anahtar girilmedi: x\nmodels:\n  low: 'gemini:a'\n  mid: 'gemini:b'\n  high: 'gemini:c'\nroutes:\n  '/': []\n";
  const out = setYmlModels(yml, "openai");
  assert.match(out, /low: 'openai:/);
  assert.match(out, /mid: 'openai:gpt-6-sol'/);
  assert.match(out, /high: 'openai:/);
  assert.ok(out.startsWith("# mine\nallowed_paths:\n  - 'app/'\n"));
  assert.ok(out.includes("routes:\n  '/': []"));
  assert.ok(!out.includes("Henüz anahtar girilmedi"), "the 'no key yet' note goes once a provider is picked");
});

test("running init again with another AI switches triage and suggestions to it", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  process.env.GEMINI_API_KEY = "g_test";
  try {
    await quiet(() => init({ dir: root, yes: true, install: false, force: false, useGh: false }));
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    assert.match(read(".glitchback.yml"), /mid: 'gemini:/);
    const routesBefore = read(".glitchback.yml").split("routes:")[1];

    process.env.ANTHROPIC_API_KEY = "a_test";
    const out = await capture(() => init({ dir: root, yes: true, install: false, force: false, useGh: false, provider: "anthropic" }));
    const yml = read(".glitchback.yml");
    assert.match(yml, /low: 'anthropic:/);
    assert.match(yml, /mid: 'anthropic:claude-sonnet-5-5'/);
    assert.equal(yml.split("routes:")[1], routesBefore, "scanned routes and edits stay");
    const env = read(".env.local");
    assert.match(env, /TRIAGE_MODEL=anthropic:claude-sonnet-5-5/);
    assert.match(env, /ANTHROPIC_API_KEY=a_test/);
    assert.match(env, /GEMINI_API_KEY=g_test/, "the old key is left alone");
    assert.match(out, /\.glitchback\.yml/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hand-picked TRIAGE_MODEL of the same provider is kept", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  try {
    writeFileSync(join(root, ".env.local"), "GEMINI_API_KEY=g\nTRIAGE_MODEL=gemini:my-own-model\n");
    await quiet(() => init({ dir: root, yes: true, install: false, force: false, useGh: false, provider: "gemini" }));
    assert.match(readFileSync(join(root, ".env.local"), "utf8"), /TRIAGE_MODEL=gemini:my-own-model/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---- Kurulum sonu: auto-fix için sonraki adımlar ---- */
test("when the workflow is written, init ends with the steps auto-fix still needs", async () => {
  const root = fixture();
  const saved = { ...process.env };
  for (const k of MODEL_ENV) delete process.env[k];
  process.env.GEMINI_API_KEY = "g";
  try {
    const out = await capture(() => init({ dir: root, yes: true, install: false, force: false, useGh: false }));
    assert.match(out, /git push/);
    assert.match(out, /https:\/\/github\.com\/acme\/shop\/settings\/actions/);
    assert.match(out, /autofix/);
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
