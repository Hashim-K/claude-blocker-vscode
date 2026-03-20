import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  platform: "node",
  target: "node20",
  logLevel: "info",
};

const extensionBuild = esbuild.build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  format: "cjs",
  external: ["vscode"],
});

const workerBuild = esbuild.build({
  ...shared,
  entryPoints: ["src/server/worker.ts"],
  outfile: "out/server-worker.js",
  format: "cjs",
});

await Promise.all([extensionBuild, workerBuild]);
