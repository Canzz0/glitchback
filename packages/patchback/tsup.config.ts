import { defineConfig } from "tsup";

// One package, zero runtime dependencies: zod and yaml are bundled in.
// Type declarations are emitted by tsc into dist/types (see tsconfig.build.json).
export default defineConfig([
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    noExternal: [/.*/],
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __pbRequire } from 'module'; const require = __pbRequire(import.meta.url);" },
  },
  {
    entry: { next: "src/next.ts", server: "src/server/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    noExternal: [/.*/],
  },
  {
    entry: { widget: "src/widget/index.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2019",
  },
  {
    // <script src=".../patchback.global.js"> → window.Patchback.init({...})
    entry: { patchback: "src/widget/index.ts" },
    format: ["iife"],
    globalName: "Patchback",
    platform: "browser",
    minify: true,
    target: "es2019",
    outExtension: () => ({ js: ".global.js" }),
  },
]);
