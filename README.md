# keyframe-engine

> 代码驱动的高性能关键帧动画引擎 · WASM Core + WebGPU WGSL + Remotion 语法兼容

`keyframe-engine` 是一款专为前端与 Web 图形渲染打造的代码驱动关键帧动画引擎。项目底层基于 Rust 构建 WASM 高性能计算核心，结合 WGSL 计算与顶点着色器（WebGPU），并向上提供 TypeScript Builder API 以及兼容 Remotion 语法的声明式动画层，同时支持基于 OPFS（Origin Private File System）的高效烘焙二进制数据持久化存储。

---

## 🌟 核心特性

- **高性能 WASM 核心（Rust）**：内置弹簧物理（Spring Dynamics）、三次贝塞尔曲线求解、3D 贝塞尔路径插值、Slerp 四元数旋转与时间重映射（Time Remapping）。
- **WebGPU 与 WGSL 着色器**：提供 Compute Shader 与 Vertex Shader 模板，支持 GPU 端并行关键帧矩阵计算与顶点变换。
- **TypeScript 链式 Builder API**：提供类型安全的 `AnimationClipBuilder`、`InstanceBuilder`、`TimelineBuilder` 和 `EngineBuilder`，轻松构建复杂的动画中间表示（IR）。
- **Remotion 语法兼容层**：无缝对接 Remotion 常用 API（如 `spring`、`interpolate`、`interpolateColors`、`Sequence`、`Series`、`useCurrentFrame`、`useVideoConfig`）。
- **精确音画同步处理**：基于确定性无状态时间驱动机制，支持以 HTML5 Audio/Video `currentTime`、Web Audio API `AudioContext.currentTime` 或离线烘焙帧为基准实现精准音画同步。
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

## 📦 目录结构与 Workspace 包

```text
.
├── src/                    # Rust WASM 引擎核心源码
│   ├── clip.rs             # 剪辑 (Clip) 与关键帧求值逻辑
│   ├── easing.rs           # 弹簧算法与贝塞尔曲线求解
│   ├── engine.rs           # 引擎状态管理器 (EngineState)
│   ├── gpu_exporter.rs     # GPU 字节缓冲区导出与 80 字节对齐布局
│   ├── instance.rs         # 实例 (Instance) 与混合模式/时间重映射
│   ├── interpolator.rs     # 3D 贝塞尔路径与插值函数
│   ├── storage/            # 存储抽象与内存/OPFS 桥接适配
│   ├── timeline.rs         # 嵌套时间轴拍平与序列计算
│   ├── transform.rs        # Transform 矩阵与 Slerp 变换
│   ├── validator.rs        # 校验与合法性检查
│   └── lib.rs              # WASM pkg 导出接口 (KeyframeEngine)
├── js/                     # JavaScript / TypeScript 封装层
│   ├── adapters/           # 三维 / WebGPU 适配器 (ThreeAdapter, WebGPUAdapter)
│   ├── builder/            # 链式 Builder 构建器 API
│   ├── remotion/           # Remotion API 兼容层 (spring, interpolate, Sequence, Series)
│   ├── renderer/           # 渲染适配层 (AutoRenderer, Canvas2DRenderer, WebGPURenderer)
│   ├── decision_tree.ts    # 渲染器/计算策略决策树
│   ├── opfs_storage.ts     # OPFS 文件存储实现
│   ├── storage_adapter.ts  # 存储适配层
│   └── index.ts            # JS 入口导出
├── packages/               # Monorepo Workspace 子包
│   ├── core/               # @keyframe/core WASM 核心与底层数学模块
│   ├── three/              # @keyframe/three Three.js 适配包
│   └── webgpu/             # @keyframe/webgpu WebGPU 直接写入适配包
├── devtools/               # Chrome DevTools 扩展插件源码
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
├── package.json            # Root Node.js 脚本与配置
└── pnpm-workspace.yaml     # pnpm Monorepo 工作区配置
```

### 🧩 Workspace 子包说明

- **`@keyframe/core`**：封装底层 WASM 模块与核心插值计算逻辑。
- **`@keyframe/three`**：提供 `ThreeAdapter`，快速将 keyframe 矩阵评估结果同步至 Three.js Object3D / Scene Graph。
- **`@keyframe/webgpu`**：提供 `WebGPUAdapter`，支持 zero-copy / 直接写入 WebGPU Buffer 的高效传输机制。

---

## 🛠 Chrome DevTools 开发者工具扩展

项目根目录的 `devtools/` 包含专用的 Chrome 开发者工具扩展，能够在开发调试阶段观察动画时间轴、查看已求值的帧矩阵及实例属性：

1. 打开 Chrome 浏览器并访问 `chrome://extensions/`。
2. 开启右上角“开发者模式” (Developer mode)。
3. 点击“加载已解压的扩展程序” (Load unpacked)，选择项目根目录下的 `devtools` 文件夹。
4. 打开开发者工具 (F12)，即可看到 `Keyframe Engine` 调试面板。

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

通过链式调用创建动画剪辑 (`Clip`)、关键帧 (`Keyframe`)、变换 (`TransformBuilder`)、实例 (`Instance`) 及引擎 (`Engine`)：

```typescript
import { Clip, Keyframe, TransformBuilder, Instance, Engine, Easing, BlendMode } from "keyframe-engine";

// 1. 构建变换与关键帧
const initialTransform = new TransformBuilder()
  .translate(0, 0, 0)
  .rotationQuat(0, 0, 0, 1)
  .scale(1, 1, 1)
  .build();

const targetTransform = new TransformBuilder()
  .translate(100, 50, 0)
  .rotationQuat(0, 0, 0.3826, 0.9238) // 四元数旋转
  .scale(2, 2, 1)
  .build();

const kf1 = new Keyframe(0)
  .transform(initialTransform)
  .opacity(0.0)
  .easing(Easing.Linear);

const kf2 = new Keyframe(2000)
  .transform(targetTransform)
  .opacity(1.0)
  .easing(Easing.EaseOutQuad);

// 2. 创建动画剪辑 (Clip)
const moveClip = new Clip("clip-move")
  .duration(2000)
  .easing(Easing.Linear)
  .addKeyframe(kf1)
  .addKeyframe(kf2)
  .build();

// 3. 创建剪辑实例 (Instance)
const instance1 = new Instance("clip-move", "inst-1")
  .delay(0)
  .durationScale(1.0)
  .timeRemappingSpeed(1.0)
  .blendMode(BlendMode.Override)
  .initialTransform(initialTransform)
  .build();

// 4. 初始化并配置引擎
const engine = new Engine();
engine.addClip(moveClip);
engine.addInstances([instance1]);
await engine.prepare();

// 5. 求值指定时间帧 (如 1000ms) 并获取求值后的实例数据
engine.evaluateFrame(1000);
const evaluatedInstances = engine.getEvaluatedInstances(1000);
console.log("Evaluated Instances:", evaluatedInstances);

// 导出与导入引擎中间表示 (IR)
const engineIR = engine.exportIR();
console.log("Engine IR:", engineIR);
```

---

## 🎬 Remotion 兼容层

无需改写已有的 Remotion 动画习惯，引擎提供了与 Remotion 接口对齐的轻量兼容库：

```typescript
import { Remotion, Engine } from "keyframe-engine";

const { spring, interpolate, interpolateColors, Sequence, Series, setRemotionFrameContext, useCurrentFrame } = Remotion;

// 1. 弹簧动画计算
const scale = spring({
  frame: 15,
  fps: 30,
  config: { damping: 10, stiffness: 100 }
});

// 2. 数值插值
const opacity = interpolate(15, [0, 30], [0, 1], {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp"
});

// 3. 颜色插值
const color = interpolateColors(15, [0, 30], ["#ff0000", "#00ff00"]);

// 4. Sequence 适配与上下文计算
setRemotionFrameContext(15);
Sequence({
  from: 10,
  durationInFrames: 30,
  children: () => {
    const currentFrame = useCurrentFrame(); // 获得相对序列帧数: 5
    console.log("Current Frame in Sequence:", currentFrame);
  }
});

// 5. 引擎适配层创建
const engine = new Engine();
const adapter = Remotion.createRemotionAdapter(engine);
adapter.evaluateFrame(30, 30); // 评估第 30 帧 (1000ms)
```

---

## ⚡ WebGPU & WGSL 着色器集成

引擎底层实例矩阵与求值数据采用 80 字节对齐（`repr(C, align(16))`）的内存紧凑布局（`GpuInstanceData`），支持从 WASM 内存零拷贝传输至 GPU Buffer：

1. **载入 WGSL 模块**：加载 `wgsl/keyframe_math.wgsl`、`wgsl/compute_template.wgsl` 或 `wgsl/vertex_template.wgsl`。
2. **内存布局与 Buffer 直接写入**：

```typescript
import { webgpuAdapter, threeAdapter, Engine } from "keyframe-engine";

const engine = new Engine();

// --- Three.js 适配示例 ---
// 1. 注册 Three.js Scene 与 Engine
const threeCtx = threeAdapter.registerScene(threeScene, engine, { defaultRasterized: false });
// 2. 挂载 Mesh / Object3D 对象
threeCtx.registerObject(mesh1);
// 3. 将指定帧矩阵平滑同步至 Three.js Object3D 场景树
threeAdapter.applyToScene(threeCtx, 1000);

// --- WebGPU 直写示例 ---
// 直接将求值数据/矩阵零拷贝写入 WebGPU Storage Buffer
webgpuAdapter.writeToBuffer(device, gpuBuffer, 1000, 0, { engine });
```

---

## 🎵 音画同步 (Audio-Visual Sync) 处理

`keyframe-engine` 采用**纯函数式确定性求值架构**，其核心插值与评估方法 `engine.evaluateFrame(timeMs)` 不依赖全局浏览器系统定时器（`requestAnimationFrame` / `performance.now()`），因此能够天然支持多种音画同步场景：

### 1. 媒体播放器时钟同步 (HTML5 `<audio>` / `<video>`)
在实时播放场景中，通过监听 HTML5 Media Element 的播放时间作为统一主时钟驱动动画求值，避免掉帧或积累累计时间漂移：

```typescript
const audio = document.getElementById("bgm") as HTMLAudioElement;

function renderFrame() {
  if (!audio.paused) {
    // 统一以音频播放位置 (毫秒) 作为主时钟驱动动画
    const currentAudioMs = audio.currentTime * 1000;
    engine.evaluateFrame(currentAudioMs);
    renderer.render(engine.getEvaluatedInstances(currentAudioMs));
  }
  requestAnimationFrame(renderFrame);
}
```

### 2. 高精度 Web Audio API 播放同步 (`AudioContext.currentTime`)
针对需要毫秒级音频对齐的交互应用或音乐可视化，通过 `AudioContext` 采样率级精准时钟进行驱动：

```typescript
const audioCtx = new AudioContext();
const startTime = audioCtx.currentTime;

function syncWithAudioContext() {
  const elapsedMs = (audioCtx.currentTime - startTime) * 1000;
  engine.evaluateFrame(elapsedMs);
  // 执行 WebGL / WebGPU / Three.js 渲染同步...
  requestAnimationFrame(syncWithAudioContext);
}
```

### 3. 离线离散渲染与音画合成 (WebCodecs / FFmpeg)
在服务端或 WebWorker 视频渲染导出场景中，结合 OPFS 烘焙机制对每帧精确时间戳（例如按 30fps/60fps 离散时间戳 `frame * (1000 / fps)`）进行无卡顿评估并写入二进制缓存，渲染出的图像帧序列可与音频轨实现 **0 误差** 严格合成。

---

## 💾 OPFS 逐帧烘焙持久化存储

支持将离线烘焙好的动画二进制字节流分块持续追加至 Web OPFS（Origin Private File System），并结合 `StorageAdapter` 实现分块流式烘焙与加载：

```typescript
import { KeyframeEngine, OPFSStorage, StorageAdapter } from "keyframe-engine";

const engine = new Engine();
// ...配置 clips 与 instances...

// 1. 创建 StorageAdapter 管理器
const storage = new StorageAdapter();

// 2. 将 0ms ~ 5000ms (30 fps) 逐帧数据分块烘焙追加至 OPFS
await storage.bakeStreamToOPFS(engine, "animation_cache.bin", {
  startMs: 0,
  endMs: 5000,
  fps: 30,
  chunkSizeMs: 1000,
  onProgress: (percent) => console.log(`Baking progress: ${percent}%`),
});

// 3. 读取烘焙完成的二进制数据
const bakedBytes = await storage.loadBakeData("animation_cache.bin");
console.log("Baked Bytes Loaded:", bakedBytes.byteLength);
```

---

## 🧪 运行示例与测试

### 运行单元测试

```bash
# 运行全部测试 (Rust + JavaScript)
npm test

# 仅运行 Rust 单元测试
npm run test:rs
# 或直接使用 Cargo:
cargo test

# 仅运行 JavaScript / TypeScript 接口测试
npm run test:js
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
