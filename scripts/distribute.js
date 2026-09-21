import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const packages = resolve(root, "packages");

// Sync root package.json version to all subpackage package.json files
const rootPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = rootPkg.version;

const copy = (packageName, source, destination = source) => {
  let from = resolve(dist, source);
  if (!existsSync(from)) {
    from = resolve(root, source);
  }
  const to = resolve(packages, packageName, "dist", destination);

  if (!existsSync(from)) {
    throw new Error(`Missing build output for @keyframe-engine/${packageName}: ${source}`);
  }

  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

const files = {
  core: [
    ["core.js"],
    ["core.d.ts"],
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
    ["pkg"],
  ],
  controller: [["controller.js"], ["controller.d.ts"], ["controller.js", "index.js"], ["controller.d.ts", "index.d.ts"]],
  three: [["adapters/three_adapter.js"], ["adapters/three_adapter.d.ts"]],
  webgpu: [["adapters/webgpu_adapter.js"], ["adapters/webgpu_adapter.d.ts"], ["generated"]],
  dom: [["dom_binder.js"], ["dom_binder.d.ts"], ["dom_binder.js", "index.js"], ["dom_binder.d.ts", "index.d.ts"]],
  math: [["math/hierarchy.js"], ["math/hierarchy.d.ts"], ["math/hierarchy.js", "index.js"], ["math/hierarchy.d.ts", "index.d.ts"]],
  physics: [
    ["physics/RealTimeSpring.js", "RealTimeSpring.js"],
    ["physics/RealTimeSpring.d.ts", "RealTimeSpring.d.ts"],
    ["physics/index.js", "index.js"],
    ["physics/index.d.ts", "index.d.ts"],
  ],
  sdf: [["sdf", "."]],
};

for (const [packageName, entries] of Object.entries(files)) {
  for (const [source, destination = source] of entries) {
    copy(packageName, source, destination);
  }

  // Clean up any .gitignore files copied into dist (e.g. wasm-pack's pkg/.gitignore containing "*")
  const pkgGitignore = resolve(packages, packageName, "dist", "pkg", ".gitignore");
  if (existsSync(pkgGitignore)) {
    rmSync(pkgGitignore, { force: true });
  }

  const pkgJsonPath = resolve(packages, packageName, "package.json");
  if (existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkgJson.version !== version) {
      pkgJson.version = version;
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
    }
  }
}

console.log(`Distributed root build output and synced version ${version} to all publishable packages.`);
