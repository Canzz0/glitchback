import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { existingDirs, listDir, type NextProject } from "./detect.ts";

/** Folder names like "[id]" must not be read as git wildcards. */
const esc = (p: string) => p.replace(/([[\]*?\\])/g, "\\$1");

const PAGE = /^page\.(tsx|jsx|ts|js|mdx)$/;
const SHELL = /^(layout|template|loading|error|not-found)\.(tsx|jsx|ts|js)$/;

/** "(group)", "@slot" and intercepting "(.)x" folders do not appear in the URL. */
const isGroup = (name: string) => /^\(.*\)$/.test(name) || name.startsWith("@");
const isIntercept = (name: string) => /^\(\.{1,3}\)/.test(name) || name.startsWith("(..)");
const isPrivate = (name: string) => name.startsWith("_");

function segmentToPattern(name: string): string | null {
  if (isGroup(name)) return null;
  if (/^\[\[?\.\.\..+\]\]?$/.test(name)) return "*"; // [...slug] and [[...slug]]
  const m = name.match(/^\[(.+)\]$/);
  return m ? `:${m[1]}` : name;
}

function hasPageBelow(dir: string): boolean {
  for (const e of listDir(dir)) {
    if (!e.dir && PAGE.test(e.name)) return true;
    if (e.dir && hasPageBelow(join(dir, e.name))) return true;
  }
  return false;
}

/** Sub-folders that belong to this route (components/, hooks/, _lib/...) rather than being routes themselves. */
function helperDirs(dir: string): string[] {
  return listDir(dir)
    .filter((e) => e.dir && e.name !== "api" && !isIntercept(e.name) && (isPrivate(e.name) || !hasPageBelow(join(dir, e.name))))
    .map((e) => e.name);
}

export interface ScannedRoute {
  url: string;
  specs: string[];
}

/**
 * Maps every page of a Next.js App Router project to the files that render it:
 * the page folder, its helper folders, and the layouts and helper folders of the
 * folders above it. The fixer reads these first when a report comes from that URL.
 */
export function scanAppRoutes(project: NextProject): ScannedRoute[] {
  const routes = new Map<string, Set<string>>();
  const appAbs = join(project.root, project.appDir);

  function walk(rel: string, urlParts: string[], ancestors: string[]) {
    const abs = join(project.root, rel);
    const entries = listDir(abs);
    if (entries.some((e) => !e.dir && PAGE.test(e.name))) {
      const url = "/" + urlParts.join("/");
      const specs = routes.get(url) ?? new Set<string>();
      specs.add(`:(glob)${esc(rel)}/*`);
      for (const h of helperDirs(abs)) specs.add(`${esc(`${rel}/${h}`)}/**`);
      for (const a of ancestors) {
        for (const e of listDir(join(project.root, a))) if (!e.dir && SHELL.test(e.name)) specs.add(esc(`${a}/${e.name}`));
        if (a !== project.appDir) for (const h of helperDirs(join(project.root, a))) specs.add(`${esc(`${a}/${h}`)}/**`);
      }
      routes.set(url, specs);
    }
    for (const e of entries) {
      if (!e.dir || e.name === "api" || isPrivate(e.name) || isIntercept(e.name) || e.name === "node_modules") continue;
      const childAbs = join(abs, e.name);
      if (!hasPageBelow(childAbs)) continue;
      const seg = segmentToPattern(e.name);
      walk(`${rel}/${e.name}`, seg ? [...urlParts, seg] : urlParts, [...ancestors, rel]);
    }
  }

  if (existsSync(appAbs)) walk(project.appDir, [], []);
  return [...routes.entries()]
    .map(([url, specs]) => ({ url, specs: [...specs] }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

/** Files that hold secrets, auth or server logic: the model never edits these. */
export function sensitivePaths(project: NextProject): string[] {
  const root = project.root;
  const out = [
    ".github/", ".env", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
    ".npmrc", ".yarnrc.yml", ".husky/", "vercel.json", "netlify.toml",
  ];
  const candidates = [
    `${project.appDir}/api/`,
    "pages/api/",
    "src/pages/api/",
    "middleware.ts",
    "middleware.js",
    "src/middleware.ts",
    "src/middleware.js",
    "instrumentation.ts",
    "prisma/",
    "drizzle/",
    "supabase/",
    "migrations/",
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "Dockerfile",
  ];
  for (const c of candidates) if (existsSync(join(root, c.replace(/\/$/, "")))) out.push(c);
  const SERVERISH = /^(auth|prisma|db|database|session|sessions|cookie|cookies|jwt|server|supabase-server|admin-auth)([.-].*)?\.(ts|js|tsx|jsx|mjs)$/i;
  for (const dir of ["lib", "src/lib", "utils", "src/utils", "server", "src/server"]) {
    if (!existsSync(join(root, dir))) continue;
    if (/(^|\/)server$/.test(dir)) {
      out.push(`${dir}/`);
      continue;
    }
    for (const f of readdirSync(join(root, dir))) if (SERVERISH.test(f)) out.push(`${dir}/${f}`);
  }
  out.push(project.componentFile, "public/patchback/");
  return [...new Set(out)];
}

export function allowedPaths(project: NextProject): string[] {
  if (project.appDir.startsWith("src/")) return ["src/"];
  return existingDirs(project.root, ["app", "components", "hooks", "lib", "utils", "features", "modules", "store", "context", "styles"]).map((d) => `${d}/`);
}
