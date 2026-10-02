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

    assert.match(read("app/api/patchback/route.ts"), /export \{ GET, POST, OPTIONS \} from "patchback\/next"/);
    assert.match(read("components/patchback.tsx"), /"use client"/);
    const layout = read("app/layout.tsx");
    assert.match(layout, /import \{ Patchback \} from "@\/components\/patchback";/);
    assert.match(layout, /<Patchback \/>\n\s*<\/body>/);

    const env = read(".env.local");
    assert.match(env, /TYPESAFE_API_KEY=jv_test/);
    assert.match(env, /GEMINI_API_KEY=g_test/);
    assert.match(env, /TRIAGE_MODEL=gemini:gemini-3.5-flash\n/);
    assert.ok(!env.includes("PATCHBACK_GITHUB_TOKEN"), "no token given, nothing written");
    assert.equal(read(".env"), "NEXT_PUBLIC_API_URL=https://api.shop.test\n", "existing .env untouched");

    assert.match(read(".github/workflows/patchback.yml"), /npx -y patchback@\d+\.\d+\.\d+ suggest/);

    // The generated config is valid for the fixer and protects server code.
    process.chdir(root);
    const cfg = loadRepoConfig();
    assert.equal(cfg.models.mid, "gemini:gemini-3.5-flash");
    assert.deepEqual(cfg.allowed_paths, ["app/", "components/", "lib/"]);
    for (const p of ["app/api/orders/route.ts", "lib/auth.ts", "lib/prisma.ts", "middleware.ts", "prisma/schema.prisma", ".env.local", "components/patchback.tsx"]) {
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
    assert.equal((read(".env.local").match(/TYPESAFE_API_KEY/g) ?? []).length, 1);
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
    assert.match(out.join("\n"), /patchback serve/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = original;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchLayout handles layouts without imports and leaves unknown shapes alone", () => {
  assert.equal(patchLayout("export default function L({c}) { return c }", "@/components/patchback"), null);
  const out = patchLayout(`"use client";\nexport default function L({ children }) {\n  return <html><body>{children}</body></html>;\n}\n`, "../components/patchback")!;
  assert.match(out, /^"use client";\nimport \{ Patchback \} from "..\/components\/patchback";/);
  assert.match(out, /<Patchback \/>/);
});

test("upsertEnv replaces keys in place, appends new ones, keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-env-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "# mine\nA=1\nTYPESAFE_API_KEY=old\n");
  const changed = upsertEnv(file, { TYPESAFE_API_KEY: "new$&", GEMINI_API_KEY: "g", EMPTY: "" });
  assert.deepEqual(changed, ["TYPESAFE_API_KEY", "GEMINI_API_KEY"]);
  assert.equal(readFileSync(file, "utf8"), "# mine\nA=1\nTYPESAFE_API_KEY=new$&\n\n# Patchback\nGEMINI_API_KEY=g\n");
  rmSync(dir, { recursive: true, force: true });
});

test("GitHub remotes in every common shape", () => {
  assert.equal(githubRepoFromRemote("https://github.com/Canzz0/AppountmentService.git"), "Canzz0/AppountmentService");
  assert.equal(githubRepoFromRemote("git@github.com:acme/shop.git"), "acme/shop");
  assert.equal(githubRepoFromRemote("https://github.com/acme/shop"), "acme/shop");
  assert.equal(githubRepoFromRemote("https://gitlab.com/acme/shop.git"), null);
});
