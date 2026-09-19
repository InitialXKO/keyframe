# @keyframe-engine/dom

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/dom.svg)](https://www.npmjs.com/package/@keyframe-engine/dom)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/dom`** 是 Keyframe Engine 的 DOM & CSS 适配器，提供高性能 CSS `matrix3d()` 批量更新与 GPU 合成层保护。

---

## 核心功能

- **`matrix3d()` 批量更新**: 将 4x4 变换矩阵直接转换为 CSS `matrix3d()` 属性，利用 GPU Compositor 硬件加速。
- **GPU 合成层防护**:
  - `visible: false` 时使用 `opacity: 0.001` 与 `pointer-events: none` 代替 `display: none`，避免销毁 GPU 合成层与触发浏览器重排 (Reflow)。
- **Performance Guardrail**: 元素数量超过 200 时自动发出控制台性能优化警示。

---

## 安装

```bash
pnpm add @keyframe-engine/dom @keyframe-engine/core
```

---

## 快速上手

```typescript
import { Engine } from "@keyframe-engine/core";
import { domAdapter } from "@keyframe-engine/dom";

const engine = new Engine();
// ... 初始化 engine

const elements = Array.from(document.querySelectorAll(".anim-node"));

// 批量更新 DOM 样式
domAdapter.batchApply(elements, currentTimeMs, { engine });
```

---

## 许可证

[MIT](LICENSE)
