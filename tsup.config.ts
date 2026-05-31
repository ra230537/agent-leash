import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  dts: false,
  clean: true,
  target: "es2022",
  platform: "node",
  splitting: false,
  sourcemap: true,
  minify: false,
  shims: false,
  external: ["sql.js", "@opencode-ai/plugin"],
})
