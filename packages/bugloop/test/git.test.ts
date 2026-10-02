import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathAllowed, changedLineCount } from "../src/fixer/git.ts";

const cfg = {
  allowed_paths: ["src/"],
  deny_paths: [".github/", ".env", "package.json", "package-lock.json"],
} as any;

test("allows files under allowed_paths", () => {
  assert.equal(isPathAllowed("src/components/Cart.tsx", cfg), true);
});

test("blocks traversal, absolute paths and denied files", () => {
  assert.equal(isPathAllowed("../secrets.txt", cfg), false);
  assert.equal(isPathAllowed("/etc/passwd", cfg), false);
  assert.equal(isPathAllowed("src/../.env", cfg), false);
  assert.equal(isPathAllowed(".github/workflows/x.yml", cfg), false);
  assert.equal(isPathAllowed("package.json", cfg), false);
  assert.equal(isPathAllowed("dist/app.js", cfg), false);
});

test("blocks .env variants and never treats an allowed folder as a name prefix", () => {
  assert.equal(isPathAllowed("src/.env.local", cfg), false);
  assert.equal(isPathAllowed("src/config/.env.production", cfg), false);
  assert.equal(isPathAllowed("src/.git/config", cfg), false);
  assert.equal(isPathAllowed("src\\..\\.env", cfg), false);
  const noSlash = { allowed_paths: ["src"], deny_paths: [] } as any;
  assert.equal(isPathAllowed("src/App.tsx", noSlash), true);
  assert.equal(isPathAllowed("src-old/App.tsx", noSlash), false);
  assert.equal(isPathAllowed("srcx", noSlash), false);
});

test("counts only added and removed content lines", () => {
  const patch = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "-old", "+new", "+more"].join("\n");
  assert.equal(changedLineCount(patch), 3);
});
