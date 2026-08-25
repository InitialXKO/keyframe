# keyframe-engine

> 代码驱动的高性能关键帧动画引擎 · WASM Core + WebGPU WGSL + Remotion 语法兼容

`keyframe-engine` 是一款专为前端与 Web 图形渲染打造的代码驱动关键帧动画引擎。项目底层基于 Rust 构建 WASM 高性能计算核心，结合 WGSL 计算与顶点着色器（WebGPU），并向上提供 TypeScript Builder API 以及兼容 Remotion 语法的声明式动画层，同时支持基于 OPFS（Origin Private File System）的高效烘焙二进制数据持久化存储。

---

## 🌟 核心特性

- **高性能 WASM 核心（Rust）**：内置弹簧物理（Spring Dynamics）、三次贝塞尔曲线求解、3D 贝塞尔路径插值、Slerp 四元数旋转与时间重映射（Time Remapping）。
- **WebGPU 与 WGSL 着色器**：提供 Compute Shader 与 Vertex Shader 模板，支持 GPU 端并行关键帧矩阵计算与顶点变换。
- **TypeScript 链式 Builder API**：提供类型安全的 `AnimationClipBuilder`、`InstanceBuilder`、`TimelineBuilder` 和 `EngineBuilder`，轻松构建复杂的动画中间表示（IR）。
- **Remotion 语法兼容层**：无缝对接 Remotion 常用 API（如 `spring`、`interpolate`、`interpolateColors`、`Sequence`、`Series`、`useCurrentFrame`、`useVideoConfig`）。
- **OPFS 高效存储**：支持将逐帧烘焙的 GPU Buffer 写入浏览器 Origin Private File System，提供高性能、低内存占用的动画帧缓存方案。

---

## 🏗 架构设计

```text
┌─────────────────────────────────────────────────────────────┐
│                 TypeScript / JavaScript API                 │
├──────────────────────────────┬──────────────────────────────┤
│      TS Builder API          │    Remotion Compat Layer     │
│  (Clip, Instance, Timeline)  │ (spring, interpolate, etc.)  │
└──────────────┬───────────────┴──────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  WASM Engine Core (Rust)                    │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Clip / Instance Evaluation & Time Remapping          │   │
│   │ Spring / Cubic Bezier / 3D Path Interpolation       │   │
│   │ Flat Timeline Scheduling & GPU Buffer Baking        │   │
│   └─────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────┬──────────────────────────────┐
│     WebGPU / WGSL Shaders    │      OPFS Binary Storage     │
│  (Compute & Vertex Pipeline) │  (Fast Frame Stream Baking)  │
└──────────────────────────────┴──────────────────────────────┘
```

---

## 📦 目录结构

```text
.
├── src/                    # Rust WASM 引擎核心源码
│   ├── clip.rs             # 剪辑 (Clip) 与关键帧求值逻辑
│   ├── easing.rs           # 弹簧算法与贝塞尔曲线求解
│   ├── engine.rs           # 引擎状态管理器 (EngineState)
│   ├── gpu_exporter.rs     # GPU 字节缓冲区导出与布局管理
│   ├── instance.rs         # 实例 (Instance) 与混合模式/时间重映射
│   ├── interpolator.rs     # 3D 贝塞尔路径与插值函数
│   ├── storage/            # 存储抽象与内存/OPFS 级适配
│   ├── timeline.rs         # 嵌套时间轴拍平与序列计算
│   ├── transform.rs        # Transform 矩阵与 Slerp 变换
│   └── lib.rs              # WASM pkg 导出接口 (KeyframeEngine)
├── js/                     # JavaScript / TypeScript 封装层
│   ├── builder/            # 链式 Builder 构建器 API
│   ├── remotion/           # Remotion API 兼容层
│   ├── opfs_storage.ts     # OPFS 文件存储实现
│   ├── storage_adapter.ts  # 存储适配层
│   └── index.ts            # JS 入口导出
├── wgsl/                   # WGSL 着色器源码
│   ├── keyframe_math.wgsl  # 计算与插值数学函数
│   ├── compute_template.wgsl # GPU Compute Shader 计算模板
│   └── vertex_template.wgsl  # GPU Vertex Shader 渲染模板
├── examples/               # 示例项目
│   ├── web-cpu/            # 纯 CPU / Canvas 2D 渲染示例
│   ├── web-webgpu/         # WebGPU & WGSL 计算渲染示例
│   ├── web-opfs/           # OPFS 逐帧烘焙与持久化示例
│   └── remotion-compat/    # Remotion 声明式组件风格示例
├── tests/                  # Rust 与 JavaScript 测试用例
├── Cargo.toml              # Rust 依赖与配置
└── package.json            # Node.js 脚本与配置
```

---

## 🚀 快速开始

### 1. 安装依赖与构建

确保已安装 [Rust](https://www.rust-lang.org/) (含 `wasm32-unknown-unknown` target) 及 Node.js 环境。

```bash
# 1. 安装 Node.js 依赖
npm install

# 2. 编译 Rust 为 WASM 模块
npm run build:wasm

# 3. 编译 TypeScript 代码
npm run build:ts

# 或者一步完成完整构建：
npm run build
```

---

## 💡 使用指南

### 1. 使用 TypeScript Builder API 构建动画

通过链式调用创建动画剪辑 (Clip)、实例 (Instance) 及时间轴 (Timeline)：

```typescript
import { Clip, Instance, Engine } from "keyframe-engine";

// 1. 创建动画剪辑 (Clip)
const moveClip = Clip("clip-move")
  .duration(2000)
  .property("position", [
    { time: 0, value: [0, 0, 0], easing: "linear" },
    { time: 2000, value: [100, 50, 0], easing: "easeOutQuad" }
  ])
  .property("opacity", [
    { time: 0, value: [0] },
    { time: 500, value: [1] }
  ])
  .build();

// 2. 创建剪辑实例 (Instance)
const instance1 = Instance("inst-1", "clip-move")
  .delay(0)
  .timeScale(1.0)
  .blendMode("override")
  .build();

// 3. 初始化并配置引擎
const engine = new Engine();
engine.addClip(moveClip);
engine.addInstance(instance1);
engine.prepare();

// 4. 求值指定时间帧 (如 1000ms)
engine.evaluateFrame(1000);

// 导出与导入引擎中间表示 (IR)
const irJson = engine.exportIRJson();
console.log("Engine IR:", irJson);
```

---

## 🎬 Remotion 兼容层

无需改写已有的 Remotion 动画习惯，引擎提供了与 Remotion 相同接口的轻量兼容库：

```typescript
import { Remotion } from "keyframe-engine";

const { spring, interpolate, interpolateColors, Sequence, Series } = Remotion;

// 1. 弹簧动画计算
const scale = spring({
  frame: 15,
  fps: 30,
  config: { damping: 10, stiffness: 100 }
});

// 2. 数值插值
const opacity = interpolate(frame, [0, 30], [0, 1], {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp"
});

// 3. 颜色插值
const color = interpolateColors(frame, [0, 30], ["#ff0000", "#00ff00"]);

// 4. Sequence & Series 序列逻辑适配器
const adapter = Remotion.createRemotionAdapter();
adapter.sequence({ from: 0, durationInFrames: 60 }, () => {
  // 当前序列上下文下的帧求值
  const currentFrame = adapter.useCurrentFrame(); // 相对帧数
  console.log("Current Frame in Sequence:", currentFrame);
});
```

---

## ⚡ WebGPU & WGSL 着色器集成

引擎导出了供 GPU 使用的二进制 Byte Buffer 及 WGSL 数学与计算模板，使矩阵计算与渲染完全下沉至 GPU：

1. **载入 WGSL 模块**：加载 `wgsl/keyframe_math.wgsl` 或 `wgsl/compute_template.wgsl`。
2. **内存布局与 Buffer**：
   `KeyframeEngine` 评估后的实例缓冲区紧凑排列，包含浮点数格式的移动、缩放、旋转四元数及混合权重：

```typescript
// 从引擎获取渲染/计算所需的二进制 Buffer
const bufferPtr = engine.getInstanceBufferPtr();
const byteLength = engine.getInstanceBufferByteLength();

// 将 WASM 内存缓冲区直接上传至 WebGPU Storage/Uniform Buffer
device.queue.writeBuffer(
  gpuBuffer,
  0,
  wasmMemory.buffer,
  bufferPtr,
  byteLength
);
```

---

## 💾 OPFS 逐帧烘焙持久化存储

支持将离线烘焙好的动画数据流持续追加存储至 Web OPFS（Origin Private File System），实现流式播放与秒级无卡顿加载：

```typescript
import { KeyframeEngine, OPFSStorage, StorageAdapter } from "keyframe-engine";

const wasmEngine = new KeyframeEngine();
// ...配置 clips 与 instances...

// 1. 烘焙 0ms 到 5000ms (60 fps) 的逐帧二进制数据
const bakedBytes = wasmEngine.bake_range(0, 5000, 60);

// 2. 写入 OPFS 磁盘缓存
const opfs = new OPFSStorage("animation_cache.bin");
await opfs.init();
await opfs.write(bakedBytes);

// 3. 使用 StorageAdapter 快速读取与检视
const storage = new StorageAdapter(opfs);
const readBytes = await storage.readBytes(0, bakedBytes.byteLength);
console.log("Baked Bytes Restored:", readBytes.byteLength);
```

---

## 🧪 运行示例与测试

### 运行单元测试

```bash
# 运行 Rust 单元测试
npm run test:rs
# 或者直接运行: cargo test

# 运行 JavaScript / TypeScript 接口测试
npx tsc && npm run test:js
```

### 查看 HTML 示例

可以在本地通过静态服务器（如 `npx serve` 或 Live Server）打开 `examples/` 目录中的示例：

- `examples/web-cpu/index.html`：基于 Canvas 2D / CPU 的基础渲染示例。
- `examples/web-webgpu/index.html`：基于 WebGPU 计算与渲染管线示例。
- `examples/web-opfs/index.html`：OPFS 高效二进制烘焙与读取示例。
- `examples/remotion-compat/index.html`：Remotion 语法与组件范例。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
