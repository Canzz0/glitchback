// Keeps only the declaration files the public entry points need (widget, next, server).
// tsc writes one .d.ts per source file in the program; internal modules (triage, privacy,
// the GitHub client...) are not API, so they are not shipped.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist/types");
const entries = ["widget/index.d.ts", "next.d.ts", "server/index.d.ts"].map((f) => join(root, f));

const keep = new Set();
const queue = entries.filter((f) => existsSync(f));
while (queue.length) {
  const file = queue.pop();
  if (keep.has(file)) continue;
  keep.add(file);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']|import\(["'](\.{1,2}\/[^"']+)["']\)/g)) {
    const spec = (m[1] ?? m[2]).replace(/\.(ts|js)$/, "");
    const target = resolve(dirname(file), `${spec}.d.ts`);
    if (existsSync(target)) queue.push(target);
  }
}

let removed = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      if (!readdirSync(p).length) rmSync(p, { recursive: true });
    } else if (!keep.has(p)) {
      rmSync(p);
      removed++;
    }
  }
};
walk(root);
console.log(`types: kept ${keep.size} (${[...keep].map((f) => relative(root, f)).sort().join(", ")}), removed ${removed}`);
