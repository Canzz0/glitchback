import { defineConfig, type Options } from "tsup";

// One package, zero runtime dependencies: zod and yaml are bundled in.
// Type declarations are emitted by tsc into dist/types (see tsconfig.build.json).
//
// Published code is minified: smaller installs and a lighter widget for end users. No source
// maps are shipped. License comments of bundled dependencies (/*! ... */) are kept, as their
// licenses require.
const shared: Options = {
  minify: true,
  sourcemap: false,
  treeshake: true,
  esbuildOptions(options) {
    options.legalComments = "eof";
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    noExternal: [/.*/],
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __pbRequire } from 'module'; const require = __pbRequire(import.meta.url);" },
  },
  {
    ...shared,
    entry: { next: "src/next.ts", server: "src/server/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    noExternal: [/.*/],
  },
  {
    ...shared,
    entry: { widget: "src/widget/index.ts" },
    format: ["esm"],
    platform: "browser",
    target: "es2019",
  },
  {
    ...shared,
    // <script src=".../glitchback.global.js"> → window.Glitchback.init({...})
    entry: { glitchback: "src/widget/index.ts" },
    format: ["iife"],
    globalName: "Glitchback",
    platform: "browser",
    target: "es2019",
    outExtension: () => ({ js: ".global.js" }),
  },
]);
