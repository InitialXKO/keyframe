# Keyframe Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Keyframe Engine** 是一个高性能的 3D/2D 关键帧动画引擎，核心由 **Rust + WASM** 打造，结合 **WGSL WebGPU Compute Shader** 并联并行计算，并包含与 **Remotion** 完全兼容的声明式 API 层与 **Chrome DevTools** 扩展支持。

---

## 目录

- [核心特性](#核心特性)
- [ Monorepo 包结构](#-monorepo-包结构)
- [ 架构设计与内存布局](#-架构设计与内存布局)
- [ 快速开始](#-快速开始)
- [ 示例代码](#-示例代码)
  - [1. 基础 Builder API](#1-基础-builder-api)
  - [2. Three.js 适配器 (@keyframe/three)](#2-threejs-适配器-keyframethree)
  - [3. WebGPU 适配器 (@keyframe/webgpu)](#3-webgpu-适配器-keyframewebgpu)
  - [4. DOM & CSS 适配器 (@keyframe/dom)](#4-dom--css-适配器-keyframedom)
  - [5. 播放控制器 (@keyframe/controller)](#5-播放控制器-keyframecontroller)
  - [6. Remotion 兼容层](#6-remotion-兼容层)
  - [7. 实时物理 (@keyframe/physics)](#7-实时物理-keyframephysics)
- [ 开发与测试](#-开发与测试)
- [ DevTools 扩展与 Starter Kits](#-devtools-扩展与-starter-kits)
- [ 许可证](#-许可证)

---

## 核心特性

- **Rust WASM 计算内核**: 高吞吐量时间轴平坦化、三次贝塞尔曲线 (Cubic-Bezier) 缓动解算、四元数球面线性插值 (Slerp)、时间重映射 (Time Remapping) 与加性混合 (Additive Blending)。
- **OPFS 持久化与流式烘焙**: 支持基于 Origin Private File System (OPFS) 的分块流式烘焙与二进制预渲染数据加载。
- **Zero-Copy ABI 内存布局**: 采用 `#[repr(C, align(16))]` 保证 16 字节对齐与 80 字节固定实例布局 (`INSTANCE_SIZE = 80`)，实现 WASM 至 WebGPU Buffer 内存零拷贝传输。
- **音频主时钟自适应收敛 (Audio Clock Master)**: `@keyframe/controller` 支持微小漂移 (< ±50ms) 的双循环 timeScale 微调与较大漂移 (> ±100ms) 的硬帧重锁定。
- **无状态 Credential Token 适配器**: `@keyframe/three` 和 `@keyframe/webgpu` 基于 `AdapterContext` 凭证 Token 实现场景解耦与多场景并行隔离。
- **拓扑排序与层级级联**: `@keyframe/math` 内置 `HierarchyResolver`，采用 Kahn 算法进行循环依赖检测与父子变换矩阵级联计算。
- **DOM/CSS 高效绑定**: `@keyframe/dom` 提供 `matrix3d()` 批量 DOM 变换绑定，并带有 >200 元素的性能警告提示。
- **Remotion 兼容层**: 包含 `spring`、`interpolate`、`interpolateColors`、`Sequence`、`Series` 及 `createRemotionAdapter`，支持无缝迁移 Remotion 动画逻辑。
- **WGSL Compute Shader**: 提供 `.wgsl` Shader 模板，支持直接在 GPU Compute Pipeline 中并行解算关键帧。

---

## Monorepo 包结构

本项目采用 `pnpm` + `turborepo` Monorepo 架构组织：

| 包名 | 说明 |
| --- | --- |
| **`@keyframe/core`** | WASM 内核封装、JS Engine Builder、基础类型定义及 ABI 常量 (`INSTANCE_SIZE = 80`) |
| **`@keyframe/controller`** | 标准播放控制器 (`AnimationPlayer`)，支持音频主时钟微调与事件分发 |
| **`@keyframe/three`** | Three.js 绑定适配器，支持 Token 凭证无状态场景同步与栅格化语义控制 |
| **`@keyframe/webgpu`** | WebGPU Buffer 直写适配器，具备对齐校验、溢出检查与设备丢失感知的三层边界防护 |
| **`@keyframe/dom`** | DOM & CSS `matrix3d()` 批量绑定适配器，内置 performance guardrail |
| **`@keyframe/math`** | 层级树矩阵级联计算与拓扑排序工具 (`HierarchyResolver`) |
| **`@keyframe/physics`** | 实时交互弹簧物理引擎 (`RealTimeSpring`)，支持 `mass/damping/stiffness` 实时参数计算 |

---

## 架构设计与内存布局

### 1. 固定 80 字节 GPU Instance Layout

Rust 侧数据结构采用 C ABI 与 16 字节对齐：

```rust
#[repr(C, align(16))]
pub struct GpuInstanceData {
    pub transform_matrix: [f32; 16], // 64 bytes (4x4 matrix)
    pub opacity: f32,                // 4 bytes
    pub visible: u32,                // 4 bytes (1 for true, 0 for false)
    pub clip_index: u32,             // 4 bytes
    pub _padding: u32,               // 4 bytes padding
}
```

单个实例精准占用 80 字节，符合 WebGPU Storage Buffer 16 字节对齐标准。

### 2. 3 层 WebGPU 边界防护机制

`@keyframe/webgpu` 在写入 Buffer 时自动校验：
1. **对齐检查**: 验证 `offset % minStorageBufferOffsetAlignment === 0` (抛出 `TypeError`)。
2. **溢出检查**: 验证 `offset + size <= buffer.size` (抛出 `RangeError`)。
3. **设备丢失感知**: 检测 `device.isLost` (抛出 `GPUDeviceLostError`)。

### 3. Zero-Copy ABI 评估 API

引擎提供两层零拷贝评估 API：

1. **`engine.evaluateFrame(globalTime)`**: 极致性能模式，直接返回指向 WASM 内存 (或 JS 连续 Buffer) 的原始 `Float32Array` TypedArray 视图 (`view`) 以及内存指针 (`ptr`)、偏移量 (`byteOffset`)、字节长度 (`byteLength`) 与实例数量 (`count`)，无任何数据拷贝，极适合渲染管线批量处理。
2. **`engine.getEvaluatedInstances(globalTime)`**: 便捷对象模式，内部底层采用 `floatView.subarray(offset, offset + 16)` 截取视图窗口而非 `.slice()` 拷贝数据，既保留易用的结构化对象 API，又彻底消除了逐帧逐实例小数组 GC 分配压力。

---

## 快速开始

### 安装

```bash
# 使用 pnpm 安装 Monorepo 依赖
pnpm add @keyframe/core @keyframe/controller
```

### 构建项目

```bash
# 编译 WASM 并构建 TypeScript 产物
npm run build

# 执行 Rust 与 JS/TS 单元测试
npm test
```

---

## 示例代码

### 1. 基础 Builder API 与 OPFS 流式烘焙

```typescript
import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder, BlendMode, createSyncOPFSWriter, StorageAdapter } from "@keyframe/core";

const engine = new Engine();

// 创建关键帧动画剪辑
const clip = new Clip("bounce_clip")
  .duration(2000)
  .addKeyframe(
    new Keyframe(0)
      .transform(new TransformBuilder().translateY(0).scale(1).build())
      .opacity(1)
  )
  .addKeyframe(
    new Keyframe(2000)
      .transform(new TransformBuilder().translateY(300).scale(1.5).build())
      .opacity(0.5)
  );

// 创建动画实例
const instance = new Instance("bounce_clip", "inst_1")
  .delay(0)
  .timeRemappingSpeed(1.2)
  .blendMode(BlendMode.Additive);

engine.addClip(clip);
engine.addInstances([instance]);

// 零样板全异步加载初始化 (自动拉取/编译 WASM、绑定 memory、挂载 OPFS 缓存)
await engine.prepare();

// 1. 极致性能 Zero-Copy 评估模式：直接获取指向 WASM 内存的 TypedArray 视图与偏移量/实例数
const { view, ptr, byteOffset, byteLength, count } = engine.evaluateFrame(500);

// 2. 便捷结构化评估模式：返回 EvaluatedInstance[]，内部 transformMatrix 为 subarray 零拷贝视图
const evaluated = engine.getEvaluatedInstances(500);

// 3. 基于 OPFS 的恒定内存分块流式烘焙 (无论场景多大，WASM 堆内存恒定 ≈ 64KB，绝不 OOM)
const writer = await createSyncOPFSWriter("long_anim.bin");
await engine.bakeStream(
  { startMs: 0, endMs: 120000, fps: 60 },
  (chunk) => writer.write(chunk)
);
writer.close();
```

---

### 2. Three.js 适配器 (`@keyframe/three`)

```typescript
import { Engine } from "@keyframe/core";
import { threeAdapter } from "@keyframe/three";
import * as THREE from "three";

const engine = new Engine();
const scene = new THREE.Scene();
const mesh = new THREE.Mesh(/* ... */);
scene.add(mesh);

// 注册场景上下文令牌 (Token-based)
const ctx = threeAdapter.registerScene(scene, engine);
ctx.registerObject(mesh);

// 在渲染循环中同步矩阵
function render(timeMs: number) {
  threeAdapter.applyToScene(ctx, timeMs, { rasterized: false });
  renderer.render(scene, camera);
}
```

---

### 3. WebGPU 适配器 (`@keyframe/webgpu`)

```typescript
import { webgpuAdapter } from "@keyframe/webgpu";

// 将 WASM 计算得到的 Float32Array 矩阵数据直写至 GPUBuffer
webgpuAdapter.writeToBuffer(device, gpuBuffer, byteOffset, byteSize);
```

---

### 4. DOM & CSS 适配器 (`@keyframe/dom`)

`@keyframe/dom` 在批量绑定 DOM 变换时，会自动提取实例中的 `transformMatrix`、`opacity` 与 `visible` 状态。
为了避免每帧触发浏览器回流 (Reflow) 及合成层销毁卡顿，`DOMAdapter` 采用 GPU 友好策略：
- ** display 切换**: 永远保持 DOM `display` 不变，避免重拍与回流。
- **不可见状态 (`visible: false`)**: 使用 `opacity: 0.001` 代替完全隐藏 (`opacity: 0` / `display: none`) 以保住 GPU 合成层，并自动设置 `pointer-events: none` 禁用交互。
- **透明度起步**: 透明度从 `0.001` 起步，所有变换与透明度计算均运行在 GPU 合成器 (Compositor) 层面。

```typescript
import { domAdapter } from "@keyframe/dom";

const elements = Array.from(document.querySelectorAll(".anim-node"));

// 批量格式化并更新 CSS matrix3d、opacity 与 pointer-events
domAdapter.batchApply(elements, currentTimeMs, { engine });
```

---

### 5. 播放控制器 (`@keyframe/controller`)

```typescript
import { Engine } from "@keyframe/core";
import { controller } from "@keyframe/controller";

const engine = new Engine();
const player = controller.createPlayer(engine, { fps: 60, timeScale: 1.0 });

player.on("frame", (timeMs) => {
  console.log("Current frame time:", timeMs);
});

player.play();
```

---

### 6. Remotion 兼容层

```typescript
import { spring, interpolate, Sequence, useCurrentFrame } from "@keyframe/core";

// 使用与 Remotion 完全一致的 Hook 与算法函数
const frame = useCurrentFrame();
const scale = spring({ frame, fps: 30, config: { damping: 10 } });
const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
```

---

### 7. 实时物理 (`@keyframe/physics`)

物理计算分为两类使用场景：

| 模式 | 场景与适用范围 | 实例规模 | 核心机制 |
| :--- | :--- | :--- | :--- |
| **烘焙模式** | 离线 / 视频渲染 / 大规模动画 | >1000 实例 | WASM 批量评估，固定按 `mass=1.0` 吞吐优先计算 |
| **实时模式** | 拖拽回弹 / 手势跟随 / 实时游戏交互 | <200 实例 | `@keyframe/physics` 纯 JS 延迟优先计算，支持完整 `mass/damping/stiffness` |

```typescript
import { RealTimeSpring } from "@keyframe/physics";
import { domAdapter } from "@keyframe/dom";
import { Engine } from "@keyframe/core";

// 创建带完整物理参数的实时弹簧
const springX = new RealTimeSpring({ mass: 1.2, damping: 12, stiffness: 150 });
let targetX = 0;

function onMouseMove(e: MouseEvent) {
  targetX = e.clientX - 200;
}

function animate(now: number, dt: number) {
  // 单步推进弹簧物理计算
  const currentX = springX.step(targetX, dt);

  // 获取 Engine 评估矩阵，叠加弹簧物理位移
  const instances = engine.getEvaluatedInstances(now);
  instances[0].transformMatrix[12] += currentX;

  domAdapter.batchApply(elements, now, { engine });
  requestAnimationFrame(animate);
}
```

---

## 开发与测试

```bash
# 运行 Rust 核心单元测试
npm run test:rs

# 运行 JS/TS 接口与适配器集成测试
npm run test:js

# 运行完整测试套件
npm test
```

---

## DevTools 扩展与 Starter Kits

- **Chrome DevTools Extension**: 位于 `devtools/` 目录，包含 Panel 调试面板与后台 Message 监听服务，可实时观察时间轴、实例状态及帧率。
- **Starter Kits**: 位于 `starter-kits/` 目录：
  - `starter-kits/motion-studio`: KeyForge Motion Studio 2D/3D 动画可视化创作工作台
  - `starter-kits/web-webgpu`: WebGPU 计算管线模版
  - `starter-kits/three-js`: Three.js 场景同步模版
  - `starter-kits/dom-css`: DOM/CSS3D 属性驱动模版
  - `starter-kits/remotion-compat`: Remotion 代码组件适配模版
  - `starter-kits/live-physics`: 实时手势拖拽与弹簧物理回弹模版
  - `starter-kits/sdf-raymarching`: WebGL2/WebGPU CSG 距离场 Raymarching 与关键帧动画桥接模版

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
