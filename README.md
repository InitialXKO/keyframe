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
  - [2. Three.js 适配器 (@keyframe-engine/three)](#2-threejs-适配器-keyframethree)
  - [3. WebGPU 适配器 (@keyframe-engine/webgpu)](#3-webgpu-适配器-keyframewebgpu)
  - [4. DOM & CSS 适配器 (@keyframe-engine/dom)](#4-dom--css-适配器-keyframedom)
  - [5. 播放控制器 (@keyframe-engine/controller)](#5-播放控制器-keyframecontroller)
  - [6. Remotion 兼容层](#6-remotion-兼容层)
  - [7. 实时物理 (@keyframe-engine/physics)](#7-实时物理-keyframephysics)
  - [8. 双路径动画组合 AnimationStack (@keyframe-engine/core)](#8-双路径动画组合-animationstack-keyframeenginecore)
  - [9. CSG 距离场与 Keyframe 动画桥接 (@keyframe-engine/sdf)](#9-csg-距离场与-keyframe-动画桥接-keyframeenginesdf)
- [ 开发与测试](#-开发与测试)
- [ DevTools 扩展与 Starter Kits](#-devtools-扩展与-starter-kits)
- [ 许可证](#-许可证)

---

## 核心特性

- **Rust WASM 计算内核与 $O(\log N)$ 二分查找**: 高吞吐量时间轴平坦化、预计算 Keyframe 分块边界 ($O(\log N)$ 二分快速查找)、三次贝塞尔曲线 (Cubic-Bezier) 缓动解算、四元数球面线性插值 (Slerp)、时间重映射 (Time Remapping) 与加性混合 (Additive Blending)。
- **双路径动画组合 (Dual-Path Animation Composition)**:
  - **路径 A (烘焙期静态展开)**: 通过 `AnimationStack` (`expandStack` / `stack.expand()`) 在编译/烘焙期展开动画链，自动求解多 Clip 拼接处的缝隙值 (Value Seams)，并支持非线性曲线自适应采样细分 (Adaptive Sampling Subdivision)。
  - **路径 B (运行时动态状态继承)**: 通过 `BlendMode.Inherit` 和 `inherit_from: { source_instance_id }` 实现跨 Instance 运行期动态状态继承与属性级联。
  - **自定义属性轨道 (Property Track Registry)**: `PropertyTrackRegistry` 支持注册与插值自定义属性轨道 (`transform`, `opacity`, `number`, `color_rgb`)。
- **多 Instance 联动 (Multi-Instance Coupling)**:
  - **方案 A (声明式 DAG 依赖)**：通过 `Instance.prototype.dependsOn()` 设置 `onComplete` / `onStart` / `onKeyframe` 事件条件及偏移量，由引擎拓扑计算动态延时。
  - **方案 B (响应式 Apply Chain)**：通过 `Instance.prototype.bindTransformFrom()` 实现属性实时追随与空间变换绑定。
  - **方案 C (播放器 Aligner 屏障)**：通过 `@keyframe-engine/controller` 的 `player.createAligner().waitUntil()` 机制提供运行时信号屏障与挂起同步。
- **CSG 距离场与 Raymarching 桥接 (`@keyframe-engine/sdf`)**: 提供 WebGL2 (`SdfEngine`) 与 WebGPU (`SdfWebGPUEngine`) CSG 隐式 Signed Distance Field (SDF) 光线追踪解算器、CPU 距离场求值器 (`evalSceneMap`) 以及 Keyframe Engine 80 字节 `GpuInstanceData` 零拷贝变换自动桥接器 (`initKeyframeBridge` / `solvePoses`)。
- **OPFS 持久化与流式烘焙**: 支持基于 Origin Private File System (OPFS) 的分块流式烘焙与二进制预渲染数据加载。
- **Zero-Copy ABI 内存布局**: 采用 `#[repr(C, align(16))]` 保证 16 字节对齐与 80 字节固定实例布局 (`INSTANCE_SIZE = 80`)，实现 WASM 至 WebGPU Buffer 内存零拷贝传输。
- **音频主时钟自适应收敛 (Audio Clock Master)**: `@keyframe-engine/controller` 支持微小漂移 (< ±50ms) 的双循环 timeScale 微调与较大漂移 (> ±100ms) 的硬帧重锁定。
- **无状态 Credential Token 适配器**: `@keyframe-engine/three` 和 `@keyframe-engine/webgpu` 基于 `AdapterContext` 凭证 Token 实现场景解耦与多场景并行隔离。
- **拓扑排序与层级级联**: `@keyframe-engine/math` 内置 `HierarchyResolver`，采用 Kahn 算法进行循环依赖检测与父子变换矩阵级联计算。
- **DOM/CSS 高效绑定**: `@keyframe-engine/dom` 提供 `matrix3d()` 批量 DOM 变换绑定，并带有 >200 元素的性能警告提示。
- **Remotion 兼容层**: 包含 `spring`、`interpolate`、`interpolateColors`、`Sequence`、`Series` 及 `createRemotionAdapter`，支持无缝迁移 Remotion 动画逻辑。
- **WGSL Compute Shader**: 提供 `.wgsl` Shader 模板，支持直接在 GPU Compute Pipeline 中并行解算关键帧。

---

## Monorepo 包结构

本项目采用 `pnpm` + `turborepo` Monorepo 架构组织：

| 包名 | 说明 |
| --- | --- |
| **`@keyframe-engine/core`** | WASM 内核封装、JS Engine Builder、AnimationStack 组合机制、基础类型定义及 ABI 常量 (`INSTANCE_SIZE = 80`) |
| **`@keyframe-engine/controller`** | 标准播放控制器 (`AnimationPlayer`)，支持音频主时钟微调与事件分发 |
| **`@keyframe-engine/three`** | Three.js 绑定适配器，支持 Token 凭证无状态场景同步与栅格化语义控制 |
| **`@keyframe-engine/webgpu`** | WebGPU Buffer 直写适配器，具备对齐校验、溢出检查与设备丢失感知的三层边界防护 |
| **`@keyframe-engine/dom`** | DOM & CSS `matrix3d()` 批量绑定适配器，内置 performance guardrail |
| **`@keyframe-engine/math`** | 层级树矩阵级联计算与拓扑排序工具 (`HierarchyResolver`) |
| **`@keyframe-engine/physics`** | 实时交互弹簧物理引擎 (`RealTimeSpring`)，支持 `mass/damping/stiffness` 实时参数计算 |
| **`@keyframe-engine/sdf`** | WebGL2 / WebGPU CSG 距离场 (SDF) Raymarching 引擎、CPU 距离场求值器与 Keyframe 动画桥接器 (`SdfEngine`, `SdfWebGPUEngine`, `evalSceneMap`, `initKeyframeBridge`, `solvePoses`) |

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

`@keyframe-engine/webgpu` 在写入 Buffer 时自动校验：
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
pnpm add @keyframe-engine/core @keyframe-engine/controller
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
import { Engine, Clip, Instance, Keyframe, Easing, TransformBuilder, BlendMode, createSyncOPFSWriter, StorageAdapter } from "@keyframe-engine/core";

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

// 创建动画实例并配置多 Instance 联动
const instance1 = new Instance("bounce_clip", "inst_1")
  .delay(0)
  .timeRemappingSpeed(1.2)
  .blendMode(BlendMode.Additive);

// 方案 A: inst_2 在 inst_1 播放完毕后延时 200ms 开始
// 方案 B: inst_2 的起始 X 坐标响应式绑定 inst_1 求值得到的 X 坐标 + 10
const instance2 = new Instance("bounce_clip", "inst_2")
  .dependsOn("inst_1", { trigger: "onComplete", offsetMs: 200 })
  .bindTransformFrom("inst_1", {
    sourceProperty: "translation.x",
    targetProperty: "initial_transform.translation.x",
    offset: 10,
  });

engine.addClip(clip);
engine.addInstances([instance1, instance2]);

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

### 2. Three.js 适配器 (`@keyframe-engine/three`)

```typescript
import { Engine } from "@keyframe-engine/core";
import { threeAdapter } from "@keyframe-engine/three";
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

### 3. WebGPU 适配器 (`@keyframe-engine/webgpu`)

```typescript
import { webgpuAdapter } from "@keyframe-engine/webgpu";

// 将 WASM 计算得到的 Float32Array 矩阵数据直写至 GPUBuffer
webgpuAdapter.writeToBuffer(device, gpuBuffer, byteOffset, byteSize);
```

---

### 4. DOM & CSS 适配器 (`@keyframe-engine/dom`)

`@keyframe-engine/dom` 在批量绑定 DOM 变换时，会自动提取实例中的 `transformMatrix`、`opacity` 与 `visible` 状态。
为了避免每帧触发浏览器回流 (Reflow) 及合成层销毁卡顿，`DOMAdapter` 采用 GPU 友好策略：
- ** display 切换**: 永远保持 DOM `display` 不变，避免重拍与回流。
- **不可见状态 (`visible: false`)**: 使用 `opacity: 0.001` 代替完全隐藏 (`opacity: 0` / `display: none`) 以保住 GPU 合成层，并自动设置 `pointer-events: none` 禁用交互。
- **透明度起步**: 透明度从 `0.001` 起步，所有变换与透明度计算均运行在 GPU 合成器 (Compositor) 层面。

```typescript
import { domAdapter } from "@keyframe-engine/dom";

const elements = Array.from(document.querySelectorAll(".anim-node"));

// 批量格式化并更新 CSS matrix3d、opacity 与 pointer-events
domAdapter.batchApply(elements, currentTimeMs, { engine });
```

---

### 5. 播放控制器 (`@keyframe-engine/controller`)

```typescript
import { Engine } from "@keyframe-engine/core";
import { controller } from "@keyframe-engine/controller";

const engine = new Engine();
const player = controller.createPlayer(engine, { fps: 60, timeScale: 1.0 });

// 方案 C: 使用 Controller 的 ApplyAligner 创建运行时事件同步屏障
const aligner = player.createAligner();
aligner.waitUntil("inst_1", { trigger: "onComplete" }).then(() => {
  console.log("inst_1 finished! Proceeding with next animation step.");
});

player.on("frame", (timeMs) => {
  console.log("Current frame time:", timeMs);
});

player.play();
```

---

### 6. Remotion 兼容层

```typescript
import { spring, interpolate, Sequence, useCurrentFrame } from "@keyframe-engine/core";

// 使用与 Remotion 完全一致的 Hook 与算法函数
const frame = useCurrentFrame();
const scale = spring({ frame, fps: 30, config: { damping: 10 } });
const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
```

---

### 7. 实时物理 (`@keyframe-engine/physics`)

物理计算分为两类使用场景：

| 模式 | 场景与适用范围 | 实例规模 | 核心机制 |
| :--- | :--- | :--- | :--- |
| **烘焙模式** | 离线 / 视频渲染 / 大规模动画 | >1000 实例 | WASM 批量评估，固定按 `mass=1.0` 吞吐优先计算 |
| **实时模式** | 拖拽回弹 / 手势跟随 / 实时游戏交互 | <200 实例 | `@keyframe-engine/physics` 纯 JS 延迟优先计算，支持完整 `mass/damping/stiffness` |

```typescript
import { RealTimeSpring } from "@keyframe-engine/physics";
import { domAdapter } from "@keyframe-engine/dom";
import { Engine } from "@keyframe-engine/core";

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

### 8. 双路径动画组合 AnimationStack (`@keyframe-engine/core`)

Keyframe Engine 支持静态展开 (Path A) 与动态运行时继承 (Path B) 两种动画组合机制：

```typescript
import { AnimationStack, Clip, Instance, Keyframe, TransformBuilder, BlendMode } from "@keyframe-engine/core";

// 1. 创建动画剪辑链
const clip1 = new Clip("walk")
  .duration(1000)
  .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateX(0).build()))
  .addKeyframe(new Keyframe(1000).transform(new TransformBuilder().translateX(100).build()));

const clip2 = new Clip("jump")
  .duration(800)
  .addKeyframe(new Keyframe(0).transform(new TransformBuilder().translateY(0).build()))
  .addKeyframe(new Keyframe(800).transform(new TransformBuilder().translateY(150).build()));

// 2. 创建 AnimationStack 并添加 Clip 节点
const stack = new AnimationStack("hero_sequence")
  .add(clip1, { offsetMs: 0 })
  .add(clip2, { offsetMs: 100, dynamic: false }); // dynamic: false 采用 Path A 烘焙期缝隙自动求解与平滑拼接

// 3. 展开 AnimationStack 得到 Engine IR (支持非线性曲线自适应采样细分)
const ir = stack.expand({ adaptiveSampling: true, maxErrorThreshold: 1e-4 });
engine.loadIR(ir);

// 4. 或采用 Path B 运行时状态继承 (BlendMode.Inherit)
const dynamicInst = new Instance("jump", "hero_jump_inst")
  .delay(1100)
  .inheritFrom("hero_walk_inst", ["transform", "opacity"]);
```

---

### 9. CSG 距离场与 Keyframe 动画桥接 (`@keyframe-engine/sdf`)

```typescript
import { SdfEngine, initKeyframeBridge } from "@keyframe-engine/sdf";
import { Engine } from "@keyframe-engine/core";

const engine = new Engine();
// ... 初始化 Clip 与 Instance ...

// 创建 WebGL2 CSG SDF 渲染引擎
const canvas = document.querySelector("#sdf-canvas") as HTMLCanvasElement;
const sdfEngine = new SdfEngine(canvas);

// 初始化 Keyframe 80 字节 GpuInstanceData 与 SDF Primitive 自动映射桥接
const bridge = initKeyframeBridge(engine, sdfEngine, {
  primMapping: {
    inst_1: 0, // 将 inst_1 映射至 SDF Scene Primitive #0
    inst_2: 1, // 将 inst_2 映射至 SDF Scene Primitive #1
  },
});

function render(timeMs: number) {
  // 零拷贝更新 SDF 几何体位姿与四元数旋转
  bridge.update(timeMs);
  sdfEngine.render();
  requestAnimationFrame(render);
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
  - `starter-kits/img2sdf`: 基于 vinhhien112/img2obj 规范合约的参考图片程序化 SDF CSG 隐式距离场造型与 Keyframe 动画桥接 Starter Kit

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
