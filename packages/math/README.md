# @keyframe-engine/math

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/math.svg)](https://www.npmjs.com/package/@keyframe-engine/math)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/math`** 是 Keyframe Engine 的数学与拓扑解算包，包含 `HierarchyResolver` 层级树变换级联与 Kahn 拓扑排序算法。

---

## 核心功能

- **`HierarchyResolver`**:
  - 输入 `parentMap` (Child ID -> Parent ID) 与局部矩阵数组。
  - 使用 **Kahn 算法** 自动计算拓扑排序，并进行循环依赖检测 (Cycle Detection)。
  - 支持拓扑顺序缓存 (Topological Order Cache)，避免重复排序。
  - 按照拓扑序级联计算全局世界变换矩阵 ($\text{WorldMat}_{\text{child}} = \text{WorldMat}_{\text{parent}} \times \text{LocalMat}_{\text{child}}$)。

---

## 安装

```bash
pnpm add @keyframe-engine/math
```

---

## 快速上手

```typescript
import { HierarchyResolver } from "@keyframe-engine/math";

const resolver = new HierarchyResolver();

const localMatrices = [
  new Float32Array([...]), // Instance 0
  new Float32Array([...]), // Instance 1 (child of 0)
];

const parentMap = new Map<number, number>([
  [1, 0], // Instance 1's parent is Instance 0
]);

const worldMatrices = resolver.resolve(localMatrices, parentMap);
```

---

## 许可证

[MIT](LICENSE)
