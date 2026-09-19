# @keyframe-engine/webgpu

[![npm version](https://img.shields.io/npm/v/@keyframe-engine/webgpu.svg)](https://www.npmjs.com/package/@keyframe-engine/webgpu)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**`@keyframe-engine/webgpu`** 是 Keyframe Engine 的 WebGPU 适配器，提供 3 层边界安全防护与 StorageBuffer 批量直写。

---

## 核心功能

- **3 层 WebGPU 边界防护**:
  1. **对齐检查**: 自动校验 `offset % minStorageBufferOffsetAlignment === 0` (抛出 `TypeError`)。
  2. **溢出检查**: 自动校验 `offset + size <= buffer.size` (抛出 `RangeError`)。
  3. **设备丢失感知**: 检测 `device.isLost` 状态 (抛出 `GPUDeviceLostError`)。
- **Buffer 批量直写**: 从 WASM 零拷贝 TypedArray 视图直接将 80 字节 `GpuInstanceData` 写入 WebGPU `GPUBuffer`。
- **Compute Pipeline 模版**: 导出内置的 WGSL Shader 常量 (`COMPUTE_TEMPLATE`, `VERTEX_TEMPLATE`, `KEYFRAME_MATH`)。

---

## 安装

```bash
pnpm add @keyframe-engine/webgpu @keyframe-engine/core
```

---

## 快速上手

```typescript
import { Engine } from "@keyframe-engine/core";
import { webgpuAdapter } from "@keyframe-engine/webgpu";

const engine = new Engine();
// ... 初始化与 prepare engine

// 将评估得到的二进制数据直写至 GPUBuffer
webgpuAdapter.writeToBuffer(device, gpuBuffer, byteOffset, byteSize, engine, currentMs);
```

---

## 许可证

[MIT](LICENSE)
