import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import type { RepoConfig } from "./config.ts";

export function git(args: string[], input?: string): string {
  return execFileSync("git", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
}

export function tryGit(args: string[], input?: string): boolean {
  try {
    git(args, input);
    return true;
  } catch {
    return false;
  }
}

/** "src" and "src/" both mean the folder; "src/app.ts" means that file. Never a prefix of another name ("src-old/"). */
function underPrefix(norm: string, entry: string): boolean {
  const e = posix.normalize(entry).replace(/^\.\//, "");
  if (e === "." || e === "./") return true;
  const dir = e.endsWith("/") ? e : `${e}/`;
  return norm === e.replace(/\/$/, "") || norm.startsWith(dir);
}

/**
 * A deny entry without a slash also matches that file name anywhere, and its
 * variants: ".env" blocks ".env.local" and "config/.env.production".
 */
function isDenied(norm: string, entry: string): boolean {
  if (underPrefix(norm, entry)) return true;
  if (entry.includes("/")) return false;
  const base = posix.basename(norm);
  return base === entry || base.startsWith(`${entry}.`);
}

/** The single gate every read and write goes through. */
export function isPathAllowed(p: string, cfg: RepoConfig): boolean {
  if (!p || p.includes("\0") || p.includes("\\") || posix.isAbsolute(p)) return false;
  const norm = posix.normalize(p);
  if (norm.startsWith("../") || norm === ".." || norm === "." || norm.split("/").includes(".git")) return false;
  if (cfg.deny_paths.some((d) => isDenied(norm, d))) return false;
  return cfg.allowed_paths.some((a) => underPrefix(norm, a));
}

export function changedLineCount(patch: string): number {
  return patch.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;
}

/** Diff of the working tree including new files, then restore a clean tree. */
export function diffAndReset(): string {
  git(["add", "--intent-to-add", "--all"]);
  const patch = git(["diff", "--binary"]);
  git(["reset", "--hard", "--quiet"]);
  git(["clean", "-fd", "--quiet"]);
  return patch;
}
