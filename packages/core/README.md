# @keyframe-engine/core

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/core.svg)](https://www.npmjs.com/package/@keyframe-engine/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/core`** 是 Keyframe Engine 的核心包，包含 **Rust + WASM** 极速计算内核、TypeScript Builder API、ABI 布局常量 (`INSTANCE_SIZE = 80`)、OPFS 持久化存储与 Zero-Copy 内存评估器。

---

## 核心功能

- **WASM / JS 双内核**: 在支持 WASM 的环境自动拉取加载 Rust WASM 内核；在无 WASM 或无 Fetch 环境自动平滑回退至高性能零分配纯 JS 评估器。
- **$O(\log N)$ 二分查找**: 预计算 Keyframe 块边界时间戳，在多 Keyframe 动画求值时自动执行二分查找，替换传统的线性 $O(N)$ 遍历。
- **多 Instance 联动**:
  - **声明式 DAG 依赖** (`Instance.prototype.dependsOn`): 根据 `onComplete` / `onStart` / `onKeyframe` 事件自动拓扑推导 Instance 的延时与释放闸门。
  - **响应式 Apply Chain** (`Instance.prototype.bindTransformFrom`): 支持 Instance 的起始位置或属性实时追随其他 Instance 的评估矩阵。
- **Zero-Copy ABI 视图**: `engine.evaluateFrame()` 与 `engine.getEvaluatedInstances()` 返回连续内存切片 (Subarray / ArrayBuffer View)，彻底消除逐帧垃圾回收 (GC) 开销。
- **OPFS 分块流式烘焙**: `engine.bakeStream()` 保持 ≈64KB 的低内存占用进行动画流式预渲染与分块存储。

---

## 安装

```bash
pnpm add @keyframe-engine/core
```

---

## 快速上手

```typescript
import { Engine, Clip, Instance, Keyframe, TransformBuilder, BlendMode } from "@keyframe-engine/core";

const engine = new Engine();

// 1. 定义 Keyframe 动画剪辑
const clip = new Clip("slide_clip")
  .duration(1000)
  .addKeyframe(
    new Keyframe(0).transform(new TransformBuilder().translateX(0).build())
  )
  .addKeyframe(
    new Keyframe(1000).transform(new TransformBuilder().translateX(300).build())
  );

// 2. 定义动画实例与依赖联动
const inst1 = new Instance("slide_clip", "i1");
const inst2 = new Instance("slide_clip", "i2")
  .dependsOn("i1", { trigger: "onComplete", offsetMs: 100 })
  .bindTransformFrom("i1", {
    sourceProperty: "translation.x",
    targetProperty: "initial_transform.translation.x",
    offset: 20
  });

engine.addClip(clip);
engine.addInstances([inst1, inst2]);

// 3. 异步初始化内核 (拉取 WASM、绑定 memory、初始化 OPFS)
await engine.prepare();

// 4. 评估指定毫秒帧
const evaluated = engine.getEvaluatedInstances(500);
console.log(evaluated[0].transformMatrix);
```

---

## API 参考

### `Engine`
- `prepare(options?: PrepareOptions): Promise<void>`: 异步加载 WASM、校验 IR 兼容性并挂载 OPFS。
- `addClip(clip: Clip | AnimationClipData): this`: 注册动画剪辑。
- `addInstances(instances: (Instance | InstanceData)[]): this`: 注册动画实例。
- `evaluateFrame(globalTime: number): EvaluatedFrameResult`: Zero-Copy 低层内存评估。
- `getEvaluatedInstances(globalTime: number): EvaluatedInstance[]`: 结构化 Zero-Copy 对象评估。
- `bakeStream(options, onChunk): Promise<number>`: 分块流式烘焙。

---

## 许可证

[MIT](LICENSE)
