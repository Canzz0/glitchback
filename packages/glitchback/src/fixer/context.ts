import { readFileSync, statSync } from "node:fs";
import type { IssueData } from "../schema/index.ts";
import type { RepoConfig } from "./config.ts";
import { git, isPathAllowed } from "./git.ts";

export interface SourceFile {
  path: string;
  content: string;
  reason: string;
}

const NOISE = new Set([
  "TypeError", "ReferenceError", "SyntaxError", "RangeError", "Error", "Uncaught", "Unhandled",
  "Cannot", "Promise", "Object", "Array", "Function", "Failed", "Loading", "Minified", "React",
  "Warning", "Network", "Request", "Response", "Undefined", "Null", "Chrome", "Mozilla", "Safari",
]);

function routeMatches(pattern: string, route: string | undefined, pathname: string): boolean {
  if (route && route === pattern) return true;
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+").replace(/\*/g, ".*") + "/?$",
  );
  return re.test(pathname);
}

/** Paths in stack traces, e.g. "webpack-internal:///(app-pages-browser)/./app/(shop)/cart/page.tsx:42:7". */
const SOURCE_REF = /((?:[\w.@()[\]-]+\/)*[\w.-]+\.(?:tsx|ts|jsx|js|mjs|vue|svelte))\b/g;
/** File names shared by many files in a Next.js app; alone they say nothing. */
const GENERIC_NAME = /^(page|layout|index|route|loading|error|template|default|not-found|main|app|chunk|webpack)[.-]/;
const escGlob = (p: string) => p.replace(/([[\]*?\\])/g, "\\$1");

/**
 * Matches the most specific tail of the path that exists in the repo:
 * ".../app/(shop)/cart/page.tsx" tries "(shop)/cart/page.tsx", then "cart/page.tsx",
 * and only uses the bare file name when it is distinctive.
 */
function filesForStackRef(ref: string): string[] {
  const parts = ref.split("/").filter((p) => p && p !== "." && p !== "..");
  for (let n = Math.min(3, parts.length); n >= 1; n--) {
    if (n === 1 && GENERIC_NAME.test(parts[parts.length - 1])) break;
    const found = lsFiles([`:(glob)**/${escGlob(parts.slice(-n).join("/"))}`]);
    if (found.length) return found.slice(0, 5);
  }
  return [];
}

function lsFiles(pathspecs: string[]): string[] {
  if (!pathspecs.length) return [];
  return git(["ls-files", "--", ...pathspecs]).split("\n").filter(Boolean);
}

function grepFiles(term: string, cfg: RepoConfig, fixed = true): string[] {
  try {
    const args = ["grep", "-l", "-I", fixed ? "-F" : "-w", "-e", term, "--", ...cfg.allowed_paths];
    return git(args).split("\n").filter(Boolean).slice(0, 5);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
}

/**
 * Picks the files most likely involved, in priority order:
 * files named in stack traces → data-testid / visible text from the last clicks →
 * route mapping from .glitchback.yml → component names in errors.
 * The most specific evidence comes first, so broad route folders never crowd it out of the budget.
 */
export function collectContext(data: IssueData, cfg: RepoConfig): { files: SourceFile[]; tree: string[] } {
  const ctx = data.report.context;
  let pathname = "/";
  try {
    pathname = new URL(ctx.url, "http://x.invalid").pathname;
  } catch {}

  const candidates: { path: string; reason: string }[] = [];
  const add = (paths: string[], reason: string) => paths.forEach((path) => candidates.push({ path, reason }));

  const errorText = ctx.console_errors.join("\n");
  for (const ref of new Set([...errorText.matchAll(SOURCE_REF)].map((m) => m[1]))) {
    add(filesForStackRef(ref), `named in stack trace`);
  }

  for (const crumb of ctx.breadcrumbs.filter((b) => b.type === "click").slice(-3)) {
    const testId = crumb.message.match(/data-testid=([^\]\s]+)/)?.[1];
    if (testId) add(grepFiles(testId, cfg), `clicked element ${testId}`);
    const text = crumb.message.match(/"([^"]{3,40})"/)?.[1];
    if (text) add(grepFiles(text, cfg), `clicked text "${text}"`);
  }

  for (const [pattern, specs] of Object.entries(cfg.routes) as [string, string[]][]) {
    if (routeMatches(pattern, ctx.route, pathname)) add(lsFiles(specs), `route ${pattern}`);
  }

  for (const name of new Set([...errorText.matchAll(/\b([A-Z][A-Za-z0-9]{3,})\b/g)].map((m) => m[1]))) {
    if (!NOISE.has(name)) add(grepFiles(name, cfg, false), `symbol ${name} in error`);
  }

  const seen = new Set<string>();
  const files: SourceFile[] = [];
  let budget = cfg.max_context_chars;
  for (const c of candidates) {
    if (seen.has(c.path) || !isPathAllowed(c.path, cfg)) continue;
    seen.add(c.path);
    try {
      if (statSync(c.path).size > 200_000) continue;
      const content = readFileSync(c.path, "utf8");
      if (content.length > budget) continue;
      budget -= content.length;
      files.push({ path: c.path, content, reason: c.reason });
    } catch {}
  }

  const tree = lsFiles(cfg.allowed_paths).filter((p) => isPathAllowed(p, cfg)).slice(0, 400);
  return { files, tree };
}
