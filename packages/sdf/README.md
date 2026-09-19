# @keyframe-engine/sdf

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/sdf.svg)](https://www.npmjs.com/package/@keyframe-engine/sdf)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/sdf`** 是 Keyframe Engine 的 Signed Distance Field (SDF) 隐式距离场造型与 Raymarching 光线步进渲染包。

---

## 核心功能

- **WebGL2 / WebGPU CSG Raymarching Engine**: 提供 `SdfEngine` 与 `SdfWebGPUEngine`，支持球体 (`sdSphere`)、立方体 (`sdBox`)、圆柱 (`sdCylinder`)、胶囊体 (`sdCapsule`)、圆环 (`sdTorus`) 的构造实体几何 (CSG) 渲染。
- **CPU 距离场求值**: `evalSceneMap` 导出 CPU 端的 SDF 场景距离算法。
- **Keyframe Engine 桥接**:
  - `initKeyframeBridge` / `solvePoses` 能直接解析 Keyframe Engine 评估得到的 80 字节 `GpuInstanceData` 矩阵，提取位置与四元数姿态并同步至 SDF 几何体。

---

## 安装

```bash
pnpm add @keyframe-engine/sdf @keyframe-engine/core
```

---

## 快速上手

```typescript
import { Engine } from "@keyframe-engine/core";
import { initKeyframeBridge, SdfEngine, PRESETS } from "@keyframe-engine/sdf";

const engine = new Engine();
// ... 初始化 engine

const canvas = document.querySelector("canvas")!;
const sdfEngine = new SdfEngine(canvas);
sdfEngine.loadScene(PRESETS.twoSpheres);

// 初始化动画桥接
const bridge = initKeyframeBridge(engine, sdfEngine);

function render(timeMs: number) {
  bridge.update(timeMs);
  sdfEngine.render();
  requestAnimationFrame(render);
}
```

---

## 许可证

[MIT](LICENSE)
