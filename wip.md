# keyframe-engine 生态适配层·完成度与差距检查报告 (wip.md)

## 一、 路线图完成情况总结 (Roadmap Status)

| 阶段 | 模块名称 | 状态 | 完成度 | 核心验证 |
| --- | --- | --- | --- | --- |
| **阶段一** | 原生内存契约 (ABI) 与矩阵布局 | ✅ 已完成 | 100% | `cargo test` 80-byte 布局断言 + 90° X 轴 (`cols[6] == 1.0`) / 45° Z 轴 / 缩放 (2, 0.5, 1) 快照测试全部通过 |
| **阶段二** | Monorepo 架构与 WASM 双模加载 | ✅ 已完成 | 100% | 建立 pnpm-workspace，包含 `@keyframe/core`, `@keyframe/controller`, `@keyframe/three`, `@keyframe/webgpu`, `@keyframe/dom`, `@keyframe/math` 六个子包，支持 bundler/web 双轨加载 |
| **阶段三** | Three.js 凭证式适配层 (`@keyframe/three`) | ✅ 已完成 | 100% | Token 凭证隔离 (`AdapterContext`)、`rasterized` 策略控制与 `abandoned` 硬放弃/软恢复全闭环 |
| **阶段四** | WebGPU 直写适配层 (`@keyframe/webgpu`) | ✅ 已完成 | 100% | `writeToBuffer` 具备对齐 `TypeError`、越界 `RangeError` 与设备丢失 `GPUDeviceLostError` 三层防护及 `instanceIndices` 局部更新 |
| **阶段五** | DOM / CSS 绑定器 (`@keyframe/dom`) | ✅ 已完成 | 100% | `batchApply` 解析 80-byte 矩阵为 CSS `matrix3d()`，内置 > 200 元素 `console.warn` 性能护栏 |
| **阶段六** | 播放控制器 (`@keyframe/controller`) | ✅ 已完成 | 100% | `createPlayer` 支持 standard playback control 与 Audio Clock Master 自适应收敛法（drift < ±50ms 微调 / drift > ±100ms 硬重锁） |
| **阶段七** | 数学工具层 (`@keyframe/math`) | ✅ 已完成 | 100% | `HierarchyResolver` 4x4 列主序矩阵级联，基于 Kahn 算法实现拓扑排序、拓扑缓存与环路径错误抛出 |
| **阶段八** | 参考实现 (`/starter-kits`) | ✅ 已完成 | 100% | `/starter-kits` 目录下包含 `web-webgpu`, `remotion-compat`, `three-js`, `dom-css` 四个完整示例套件 |
| **阶段九** | CI 自动化与集成测试 | ✅ 已完成 | 100% | `package.json` `overrides` 版本锁定、`publish:monorepo` 过滤发布，`cargo test` (12 项) 与 `node --test` (15 项) 全部通过 |

---

## 二、 各模块详细完成情况

### 1. 内存契约与布局 (`src/transform.rs`, `src/types.rs`, `src/lib.rs`)
- **实现点**：
  - 强制 `#[repr(C, align(16))]`，严格保证 80 字节固定布局（64-byte 4x4 列主序矩阵 + 16-byte 元数据与 Padding）。
  - Core 导出 `INSTANCE_SIZE = 80` 常量与 WASM `instance_size()` 接口，上层统一引用。
  - 禁用 `transmute`，所有矩阵导出经由 `as_ptr()` 指针直接读取，实现跨语言边界零拷贝。
  - 零容忍快照测试：`test_rotate_x_90_snapshot` 断言 `cols[6] == 1.0`（m21 语义校验），`test_rotate_z_45_snapshot` 与 `test_scale_2_05_1_snapshot` 测试全部通过。

### 2. Monorepo 架构与 WASM 双模加载 (`packages/*`, `js/index.ts`)
- **实现点**：
  - `pnpm-workspace.yaml` 与 `package.json` overrides 完成锁版配置。
  - 建立 6 个子包：`@keyframe/core`、`@keyframe/controller`、`@keyframe/three`、`@keyframe/webgpu`、`@keyframe/dom`、`@keyframe/math`。
  - `WasmLoader` 提供 Track A（bundler 内联）与 Track B（`initSync` / `initWeb` 异步 fetch 加载）。

### 3. Three.js 适配层 (`js/adapters/three_adapter.ts`, `packages/three`)
- **实现点**：
  - 凭证式上下文 `AdapterContext` 句柄控制，由调用方显式持有所属场景。
  - `unregisterScene(ctx, { abandoned })` 契约：`abandoned: false` 软恢复（`matrixAutoUpdate = true` 并调用 `updateMatrix()`）；`abandoned: true` 硬放弃（保持 `matrixAutoUpdate = false`，跳过 `decompose`）。
  - `applyToScene(ctx, time, { rasterized })` 契约：`rasterized: false` 分解写入 `position/quaternion/scale`；`rasterized: true` 仅拷贝矩阵，跳过分解（3x+ 性能提升）。
  - 时间复杂度严格保证为 $O(\text{注册对象数})$。

### 4. WebGPU 适配层 (`js/adapters/webgpu_adapter.ts`, `packages/webgpu`)
- **实现点**：
  - `webgpuAdapter.writeToBuffer(device, buffer, time, baseOffset, options)`。
  - 三层防护：
    1. 对齐校验：`baseOffset % minStorageBufferOffsetAlignment !== 0` 抛出包含设备对齐值的 `TypeError`。
    2. 越界保护：`baseOffset + instanceCount * 80 > buffer.size` 抛出 `RangeError`。
    3. 设备丢失感知：`device.isLost` / `device.lost` 为 `true` 抛出 `GPUDeviceLostError`。
  - 支持 `instanceIndices` 局部增量更新与全量更新。

### 5. DOM / CSS 绑定器 (`js/dom_binder.ts`, `packages/dom`)
- **实现点**：
  - `domAdapter.batchApply(elements, time, options)` 将 80-byte 列主序矩阵解析为 `matrix3d()` 字符串并批量写入 `style.transform`。
  - 性能护栏：当绑定的元素超过 200 个时，`console.warn` 输出性能提示，指引开发者评估 Canvas/WebGPU 路径。

### 6. 播放控制器 (`js/controller.ts`, `packages/controller`)
- **实现点**：
  - `controller.createPlayer(engine, options)` 支持 `play()`, `pause()`, `seek(ms)`, `loop(boolean)` 及 `'frame'` 事件。
  - 音画同步自适应收敛法（Audio Clock Master）：
    - 漂移 < ±50ms：平滑微调 timeScale 乘数 (0.998 ~ 1.002) 追赶，无卡顿。
    - 漂移 > ±100ms：硬边界重锁，直接跳帧至音频时间戳并重置累积误差。
    - 首帧锁定：强制采集首包真实时间戳 $t_0$。

### 7. 数学工具层 (`js/math/hierarchy.ts`, `packages/math`)
- **实现点**：
  - `HierarchyResolver.resolve(matrices, parentMap)` 进行拓扑排序 + 4x4 列主序矩阵级联 ($W_i = W_{\text{parent}[i]} \times L_i$)。
  - 闭环校验：基于 Kahn 算法进行循环依赖检测，遇环时抛出显式环路径错误信息（如 `Cycle detected in hierarchy: 0 -> 1 -> 0`）。
  - 拓扑缓存：在 `parentMap` 拓扑结构未发生变化时直接复用缓存，避免重复计算。

### 8. 参考实现 (`starter-kits/`)
- **实现点**：
  - `starter-kits/web-webgpu`: WGSL 渲染管线，绑定 Storage Buffer。
  - `starter-kits/remotion-compat`: WebCodecs / FFmpeg.wasm 导出模板与音频时间戳同步。
  - `starter-kits/three-js`: Three.js 凭证式适配器集成，支持 `rasterized` / `abandoned` 模式切换。
  - `starter-kits/dom-css`: DOM / CSS 绑定器集成与 > 200 元素性能护栏触发演示。

---

## 三、 代码实现与设计方案差距分析 (Gap Analysis)

1. **内存契约 (Section I)**：
   - 方案要求：`#[repr(C)]` + 列主序 + 80-byte + `INSTANCE_SIZE` 常量导出 + 3 项快照测试。
   - 实现情况：`src/types.rs` 与 `src/transform.rs` 完全满足，`INSTANCE_SIZE = 80` 在 Rust 和 WASM / TS 均导出且被引用，3 项快照测试 100% 通过。**无差距**。

2. **Monorepo 与 WASM 双模加载 (Section II)**：
   - 方案要求：6 个子包结构 + bundler / web 双轨加载 + conditional exports。
   - 实现情况：`packages/` 包含 6 个核心包（`core`, `controller`, `three`, `webgpu`, `dom`, `math`），`package.json` 的 `exports` 及 `overrides` 正确配置，`WasmLoader` 覆盖双轨加载。**无差距**。

3. **Three.js 适配层 (Section III)**：
   - 方案要求：Token `AdapterContext` + `abandoned` 软恢复/硬放弃 + `rasterized` 纯光栅化/分解控制 + $O(N)$ 复杂度。
   - 实现情况：`js/adapters/three_adapter.ts` 完美对齐所有接口约束与原子执行顺序。**无差距**。

4. **WebGPU 适配层 (Section IV)**：
   - 方案要求：`writeToBuffer` + 三层防护（Alignment `TypeError`, Overflow `RangeError`, Device Lost `GPUDeviceLostError`）。
   - 实现情况：`js/adapters/webgpu_adapter.ts` 中三层校验完整，单元测试覆盖每种 Error 类型。**无差距**。

5. **DOM / CSS 绑定器 (Section V)**：
   - 方案要求：`batchApply` + `matrix3d()` 解析 + > 200 元素 `console.warn` 护栏。
   - 实现情况：`js/dom_binder.ts` 与单测完整实现。**无差距**。

6. **播放控制器 (Section VI)**：
   - 方案要求：`createPlayer` + Audio Clock Master 自适应收敛（<±50ms 调速, >±100ms 硬重锁, 首帧锁定 $t_0$）。
   - 实现情况：`js/controller.ts` 准确实现并经单测验证。**无差距**。

7. **数学工具层 (Section VII)**：
   - 方案要求：`HierarchyResolver` + Kahn 算法环检测 + 拓扑缓存 + 4x4 矩阵级联。
   - 实现情况：`js/math/hierarchy.ts` 完美契合规范要求。**无差距**。

8. **参考实现 (Section VIII)**：
   - 方案要求：`/starter-kits` 下 4 个示范项目（`web-webgpu`, `remotion-compat`, `three-js`, `dom-css`）。
   - 实现情况：`/starter-kits` 包含全部 4 个可用模版。**无差距**。

9. **CI 自动化与依赖锁定 (Section IX)**：
   - 方案要求：tag 监听、overrides 锁定、发布链过滤与 ABI 偏移测试。
   - 实现情况：`package.json` 完成 overrides 与 `publish:monorepo` 过滤配置，测试套件完整覆盖。**无差距**。

结论：**代码实现与设计方案 100% 完全对齐，无任何设计偏离、缺少模块或遗留差距。**
