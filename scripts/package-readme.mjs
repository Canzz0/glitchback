// Runs on `npm pack` / `npm publish` (prepack) inside packages/glitchback.
// npmjs.com cannot resolve relative image paths of a monorepo README, so the package gets a
// copy of the root README with images and repo links pointing at GitHub, plus the LICENSE.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "packages", "glitchback");
const RAW = "https://raw.githubusercontent.com/Canzz0/glitchback/master/";
const BLOB = "https://github.com/Canzz0/glitchback/blob/master/";
const TREE = "https://github.com/Canzz0/glitchback/tree/master/";

const readme = readFileSync(join(root, "README.md"), "utf8")
  .replace(/src="\.\/(docs\/images\/[^"]+)"/g, `src="${RAW}$1"`)
  .replace(/\]\(\.\/(README_TR\.md)\)/g, `](${BLOB}$1)`)
  .replace(/`(examples\/webhook-receiver)`/g, `[\`$1\`](${TREE}$1)`);

writeFileSync(join(pkgDir, "README.md"), readme);
copyFileSync(join(root, "LICENSE"), join(pkgDir, "LICENSE"));
console.log("glitchback: README.md and LICENSE prepared for the package");
