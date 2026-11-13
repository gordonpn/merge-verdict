import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  target: "node22",
  platform: "node",
  format: ["esm", "cjs"],
  outDir: "dist",
  outExtension: ({ format }) => ({ js: format === "esm" ? ".js" : ".cjs" }),
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
  loader: { ".graphql": "text" },
  // Include runtime packages; Node.js built-ins remain provided by the runtime.
  noExternal: [/.*/],
  banner: ({ format }) =>
    format === "esm"
      ? {
          js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
        }
      : {},
});
