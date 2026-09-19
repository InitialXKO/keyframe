# @keyframe-engine/physics

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/physics.svg)](https://www.npmjs.com/package/@keyframe-engine/physics)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/physics`** 是 Keyframe Engine 的实时交互弹簧物理引擎包，提供基于半隐式欧拉积分 (Semi-implicit Euler) 的 `RealTimeSpring` 解算器。

---

## 核心功能

- **`RealTimeSpring`**:
  - 支持完整自定义 `mass`、`damping`、`stiffness` 物理参数。
  - 支持半隐式欧拉积分与子步 (Sub-stepping) 计算，保证高频手势跟随与拖拽回弹稳定不发散。
  - 支持秒 (s) 与毫秒 (ms) `dt` 单位自动识别。
  - 活跃实例数 > 200 时自动触发性能提示。

---

## 安装

```bash
pnpm add @keyframe-engine/physics
```

---

## 快速上手

```typescript
import { RealTimeSpring } from "@keyframe-engine/physics";

const springX = new RealTimeSpring({
  mass: 1.2,
  damping: 12,
  stiffness: 150,
  initialPosition: 0,
});

// 在 rAF 循环中调用 step 推进物理位移
function animate(dtSeconds: number) {
  const targetX = 200;
  const currentX = springX.step(targetX, dtSeconds);
  console.log("Current position:", currentX);
}
```

---

## 许可证

[MIT](LICENSE)
