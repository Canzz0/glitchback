import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { t } from "./i18n.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint(1);
export const dim = paint(2);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

export const ok = (msg: string) => console.log(`${green("✔")} ${msg}`);
export const skip = (msg: string) => console.log(`${dim("•")} ${dim(msg)}`);
export const warn = (msg: string) => console.log(`${yellow("!")} ${msg}`);

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Asks one question; returns "" when not interactive. Secrets are never echoed. */
export async function ask(question: string, { secret = false } = {}): Promise<string> {
  if (!interactive()) return "";
  if (secret) return askSecret(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Escape sequences (arrow keys, bracketed-paste markers) are not part of a pasted key. */
const ESCAPES = /\u001b(?:\[[0-9;?]*[ -\/]*[@-~]|[@-Z\\-_])/g;

/**
 * Reads a key or token in raw mode and shows one "•" per character. Nothing of the value
 * reaches the screen, the scrollback or a screen recording. (Overriding readline's private
 * _writeToOutput used to do this, but Node no longer routes the line through it.)
 */
function askSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk.replace(ESCAPES, "")) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return resolve(value.trim());
        }
        if (ch === "\u0003") {
          finish();
          process.exit(130); // Ctrl+C
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch === "\u0015") {
          stdout.write("\b \b".repeat(value.length)); // Ctrl+U
          value = "";
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
}

export async function choose(question: string, options: { key: string; label: string }[]): Promise<string> {
  if (!interactive()) return options[0].key;
  console.log(question);
  options.forEach((o, i) => console.log(`  ${cyan(String(i + 1))}) ${o.label}`));
  const answer = await ask(t("Seçim [1]: ", "Choice [1]: "));
  const i = Number(answer || "1") - 1;
  return options[i]?.key ?? options[0].key;
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  if (!interactive()) return fallback;
  const yes = t("e", "y");
  const a = (await ask(`${question} ${fallback ? `[${yes.toUpperCase()}/${t("h", "n")}]` : `[${yes}/${t("H", "N")}]`} `)).toLowerCase();
  if (!a) return fallback;
  return a.startsWith("e") || a.startsWith("y");
}

export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    stdio: opts.input !== undefined || opts.quiet ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export const hasCommand = (cmd: string) => run(cmd, ["--version"], { quiet: true }).ok;

export function openUrl(url: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore" });
}

/** KEY=value lines; comments and blank lines ignored, surrounding quotes removed. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function readEnvFiles(dir: string, names = [".env", ".env.local"]): Record<string, string> {
  return Object.assign({}, ...names.map((n) => (existsSync(`${dir}/${n}`) ? parseEnv(readFileSync(`${dir}/${n}`, "utf8")) : {})));
}

/**
 * Sets keys in an env file without touching anything else in it.
 * Existing keys are replaced in place; new ones are appended under a header.
 */
export function upsertEnv(path: string, values: Record<string, string>, header = "# Glitchback"): string[] {
  const entries = Object.entries(values).filter(([, v]) => v !== "");
  if (!entries.length) return [];
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const changed: string[] = [];
  const append: string[] = [];
  for (const [k, v] of entries) {
    const re = new RegExp(`^(\\s*(?:export\\s+)?${k}\\s*=).*$`, "m");
    if (re.test(text)) {
      const current = parseEnv(text)[k];
      if (current === v) continue;
      text = text.replace(re, (_m, prefix: string) => prefix + v);
    } else append.push(`${k}=${v}`);
    changed.push(k);
  }
  if (append.length) {
    if (text && !text.endsWith("\n")) text += "\n";
    if (!text.includes(header)) text += `${text ? "\n" : ""}${header}\n`;
    text += append.join("\n") + "\n";
  }
  if (changed.length) writeFileSync(path, text);
  return changed;
}

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function githubRepoFromRemote(url: string): string | null {
  return url.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

export function gitRemoteRepo(dir: string): string | null {
  const r = run("git", ["-C", dir, "remote", "get-url", "origin"], { quiet: true });
  return r.ok ? githubRepoFromRemote(r.stdout) : null;
}
