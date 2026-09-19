# @keyframe-engine/three

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/three.svg)](https://www.npmjs.com/package/@keyframe-engine/three)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/three`** 是 Keyframe Engine 的 Three.js 适配层，采用凭证 Token (AdapterContext) 模型实现无状态、高性能的三维场景矩阵同步。

---

## 核心功能

- **Credential Token 模型**: 基于 `AdapterContext` 管理场景注册，支持多 Scene / 多 Mesh 并行独立更新。
- **Zero-Copy Matrix Transfer**: 直接将 Keyframe Engine 的 16-float 变换矩阵应用至 `THREE.Object3D.matrix`，并设置 `matrixAutoUpdate = false`，绕过 CPU 冗余 TRS 重算。
- **栅格化语义控制**: 支持 `rasterized: false` 矢量无损更新模式。

---

## 安装

```bash
pnpm add @keyframe-engine/three three @keyframe-engine/core
```

---

## 快速上手

```typescript
import * as THREE from "three";
import { Engine, Clip, Instance, Keyframe, TransformBuilder } from "@keyframe-engine/core";
import { threeAdapter } from "@keyframe-engine/three";

const engine = new Engine();
// ... 配置 Keyframe Engine clip 与 instance

const scene = new THREE.Scene();
const mesh = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff00 })
);
scene.add(mesh);

// 1. 注册场景上下文令牌
const ctx = threeAdapter.registerScene(scene, engine);
ctx.registerObject(mesh, "inst_1"); // 关联 mesh 与 instance id

// 2. 渲染循环中更新场景
function animate(timeMs: number) {
  threeAdapter.applyToScene(ctx, timeMs);
  renderer.render(scene, camera);
  requestAnimationFrame((t) => animate(t));
}
requestAnimationFrame((t) => animate(t));
```

---

## 许可证

[MIT](LICENSE)
