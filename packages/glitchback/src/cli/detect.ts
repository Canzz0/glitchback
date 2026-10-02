import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { t } from "./i18n.ts";

export interface NextProject {
  root: string;
  /** "app" or "src/app", relative to root, forward slashes. */
  appDir: string;
  layoutFile: string | null;
  typescript: boolean;
  /** Where the generated client component goes, relative to root. */
  componentFile: string;
  /** How layout.tsx imports it: "@/components/glitchback" or a relative path. */
  componentImport: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  nextVersion: string | null;
}

const exists = (root: string, p: string) => existsSync(join(root, p));
const posix = (p: string) => p.split("\\").join("/");

function readJson(path: string): any {
  try {
    // tsconfig allows comments and trailing commas
    const text = readFileSync(path, "utf8")
      .replace(/("(?:[^"\\]|\\.)*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function detectPackageManager(root: string): NextProject["packageManager"] {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "bun.lockb") || exists(root, "bun.lock")) return "bun";
  return "npm";
}

export type DetectResult = { ok: true; project: NextProject } | { ok: false; reason: string };

export function detectNext(root: string): DetectResult {
  const pkg = readJson(join(root, "package.json"));
  if (!pkg) return { ok: false, reason: t("Bu klasörde package.json yok.", "There is no package.json in this folder.") };
  const nextVersion = pkg.dependencies?.next ?? pkg.devDependencies?.next ?? null;
  if (!nextVersion) return { ok: false, reason: t("Bu proje Next.js değil.", "This project is not a Next.js app.") };

  const appDir = ["src/app", "app"].find((d) => exists(root, d) && statSync(join(root, d)).isDirectory());
  if (!appDir) return { ok: false, reason: t("App Router (app/ klasörü) bulunamadı. Şimdilik yalnızca App Router destekleniyor.", "No App Router (app/ folder) found. Only the App Router is supported for now.") };

  const layoutName = ["layout.tsx", "layout.jsx", "layout.js", "layout.ts"].find((f) => exists(root, `${appDir}/${f}`));
  const typescript = exists(root, "tsconfig.json");
  const srcBased = appDir.startsWith("src/");
  const componentsDir = srcBased ? "src/components" : exists(root, "components") ? "components" : "components";
  const componentFile = `${componentsDir}/glitchback.${typescript ? "tsx" : "jsx"}`;

  // Prefer the project's "@/..." alias when it points at the folder we write into.
  const cfg = readJson(join(root, typescript ? "tsconfig.json" : "jsconfig.json"));
  const alias: string[] | undefined = cfg?.compilerOptions?.paths?.["@/*"];
  const aliasTarget = alias?.[0]?.replace(/^\.\//, "").replace(/\*$/, "");
  let componentImport: string;
  if (aliasTarget !== undefined && posix(componentFile).startsWith(aliasTarget)) {
    componentImport = `@/${posix(componentFile).slice(aliasTarget.length).replace(/\.[jt]sx$/, "")}`;
  } else {
    const rel = posix(relative(join(root, appDir), join(root, componentFile))).replace(/\.[jt]sx$/, "");
    componentImport = rel.startsWith(".") ? rel : `./${rel}`;
  }

  return {
    ok: true,
    project: {
      root,
      appDir,
      layoutFile: layoutName ? `${appDir}/${layoutName}` : null,
      typescript,
      componentFile,
      componentImport,
      packageManager: detectPackageManager(root),
      nextVersion,
    },
  };
}

/** Top-level folders that exist, for allowed_paths. */
export function existingDirs(root: string, candidates: string[]): string[] {
  return candidates.filter((d) => exists(root, d) && statSync(join(root, d)).isDirectory());
}

export function listDir(dir: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
}
