import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const packages = resolve(root, "packages");

const copy = (packageName, source, destination = source) => {
  const from = resolve(dist, source);
  const to = resolve(packages, packageName, "dist", destination);

  if (!existsSync(from)) {
    throw new Error(`Missing build output for @keyframe-engine/${packageName}: ${source}`);
  }

  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

// The root compiler emits the shared implementation into dist/. Copy each
// package's public entry point and its local dependencies into the package
// directory so npm/pnpm publish never relies on files outside the package.
const files = {
  core: [
    ["core.js", "index.js"],
    ["core.d.ts", "index.d.ts"],
    ["web.js"],
    ["web.d.ts"],
    ["wasm_loader.js"],
    ["wasm_loader.d.ts"],
    ["builder"],
    ["opfs_storage.js"],
    ["opfs_storage.d.ts"],
    ["storage_adapter.js"],
    ["storage_adapter.d.ts"],
  ],
  controller: [["controller.js", "index.js"], ["controller.d.ts", "index.d.ts"]],
  three: [["adapters/three_adapter.js", "index.js"], ["adapters/three_adapter.d.ts", "index.d.ts"]],
  webgpu: [
    ["adapters/webgpu_adapter.js", "index.js"],
    ["adapters/webgpu_adapter.d.ts", "index.d.ts"],
    ["generated"],
  ],
  dom: [["dom_binder.js", "index.js"], ["dom_binder.d.ts", "index.d.ts"]],
  math: [["math/hierarchy.js", "index.js"], ["math/hierarchy.d.ts", "index.d.ts"]],
  physics: [
    ["physics/RealTimeSpring.js", "RealTimeSpring.js"],
    ["physics/RealTimeSpring.d.ts", "RealTimeSpring.d.ts"],
    ["physics/index.js"],
    ["physics/index.d.ts"],
  ],
  sdf: [["sdf"]],
};

for (const [packageName, entries] of Object.entries(files)) {
  for (const [source, destination = source] of entries) {
    copy(packageName, source, destination);
  }
}

console.log("Distributed root build output to all publishable packages.");
