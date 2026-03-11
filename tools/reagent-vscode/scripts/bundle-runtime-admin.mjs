import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(__dirname, "..");
const runtimeDir = resolve(extensionDir, "../../runtime/ts");
const entryFile = resolve(__dirname, "runtime-admin-entry.mjs");
const outFile = resolve(extensionDir, "bundled/runtime-admin.cjs");
const protoSourceDir = resolve(runtimeDir, "node_modules/etcd3/proto");
const protoTargetDir = resolve(extensionDir, "proto");

mkdirSync(dirname(outFile), { recursive: true });
mkdirSync(protoTargetDir, { recursive: true });

execSync("npm run build", {
  cwd: runtimeDir,
  stdio: "inherit",
});

await build({
  entryPoints: [entryFile],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  external: ["vscode"],
});

cpSync(protoSourceDir, protoTargetDir, { recursive: true });

console.log(`Bundled runtime admin API -> ${outFile}`);
