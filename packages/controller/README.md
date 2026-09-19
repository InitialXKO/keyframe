# @keyframe-engine/controller

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/controller.svg)](https://www.npmjs.com/package/@keyframe-engine/controller)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/controller`** 是 Keyframe Engine 的播放控制器包，提供高精度帧控制、播放/暂停/Seek 状态管理、`ApplyAligner` 信号同步屏障，以及基于 **Audio Clock Master** 的双循环自适应收敛时钟算法。

---

## 核心功能

- **AnimationPlayer**: 标准播放器，封装帧循环、`timeScale` 速率调节与事件监听 (`frame`, `play`, `pause`, `seek`, `ended`)。
- **Audio Clock Master (音频主时钟自适应收敛)**:
  - 漂移 < ±50ms: 双循环 `timeScale` 微调 (0.998 ~ 1.002) 丝滑对齐音视频。
  - 漂移 > ±100ms: 自动触发硬帧重锁定 (Hard Re-lock)，防止累积脱节。
- **ApplyAligner (信号屏障闸门)**:
  - 提供 `aligner.waitUntil(instanceId, condition).then(callback)`，实现跨对象事件触发与运行时挂起同步（类似于 JAnim 协程 Barrier）。

---

## 安装

```bash
pnpm add @keyframe-engine/controller @keyframe-engine/core
```

---

## 快速上手

```typescript
import { Engine, Clip, Instance } from "@keyframe-engine/core";
import { controller } from "@keyframe-engine/controller";

const engine = new Engine();
// ... 初始化 engine、clips 与 instances

// 1. 创建播放器
const player = controller.createPlayer(engine, {
  fps: 60,
  timeScale: 1.0,
  duration: 5000,
});

// 2. 使用 ApplyAligner 设置运行期挂起等待屏障
const aligner = player.createAligner();
aligner.waitUntil("inst_1", { trigger: "onComplete" }).then(() => {
  console.log("inst_1 播放完成，触发后续逻辑！");
});

// 3. 监听帧更新事件
player.on("frame", (timeMs) => {
  const instances = engine.getEvaluatedInstances(timeMs);
  // 执行渲染绑定 ...
});

// 4. 开始播放
player.play();
```

---

## 许可证

[MIT](LICENSE)
