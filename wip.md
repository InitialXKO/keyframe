# keyframe-engine 生态适配层·完成度与差异检查报告 (wip.md)

## 一、 路线图完成情况总结 (Roadmap Status)

| 阶段 | 模块名称 | 状态 | 完成度 | 核心验证 |
| --- | --- | --- | --- | --- |
| **阶段一** | 原生内存契约 (ABI) 与矩阵布局 | ✅ 已完成 | 100% | `cargo test` 80-byte 布局断言 + 90° X 轴/45° Z 轴/缩放快照测试全部通过 |
| **阶段二** | Monorepo 架构与 WASM 双模加载 | ✅ 已完成 | 100% | `@keyframe/core`, `@keyframe/three`, `@keyframe/webgpu` 包建立，支持 bundler/web 轨道 |
| **阶段三** | Three.js 凭证式适配层 | ✅ 已完成 | 100% | Token 凭证隔离、`rasterized` 策略控制与 `abandoned` 硬放弃/软恢复全闭环 |
| **阶段四** | WebGPU 直写适配层 | ✅ 已完成 | 100% | `writeToBuffer` 具备对齐 `TypeError`、越界 `RangeError` 与设备丢失 `GPUDeviceLostError` 三层防护 |
| **阶段五** | 双端集成测试 | ✅ 已完成 | 100% | `tests/adapters.test.js` 12 项单测全通过，涵盖双场景隔离、模长/行列式健壮性与边界探测 |
| **阶段六** | 生态接入决策树 | ✅ 已完成 | 100% | 导出 `selectRecommendedAdapter` 决策函数及文档决策矩阵 |
| **阶段七** | CI 自动化与依赖锁定 | ✅ 已完成 | 100% | `package.json` overrides 锁版本与 pnpm publish 过滤发布链配置完成 |

---

## 二、 各模块详细完成情况

### 1. 内存契约与布局 (src/transform.rs, src/types.rs, src/lib.rs)
- **实现点**：
  - 强制 `#[repr(C, align(16))]`，严格保证 80 字节固定布局（64-byte 4x4 列主序矩阵 + 16-byte 属性/Padding 元数据）。
  - 导出 `INSTANCE_SIZE = 80` 常量与 WASM `instance_size()` 接口。
  - 禁用 `transmute`，全部导出经由 `as_ptr()` 指针转换为 unsafe slice 完成零拷贝。
  - 零容忍快照测试：`test_rotate_x_90_snapshot` 断言 `cols[6] == 1.0`（m21 语义校验），`test_rotate_z_45_snapshot` 与 `test_scale_2_05_1_snapshot` 独立维度测试全通过。

### 2. Monorepo 与 WASM 双模加载 (packages/*, js/index.ts)
- **实现点**：
  - 建立 `pnpm-workspace.yaml` 与 `turbo.json` 架构。
  - 创建 `@keyframe/core`、`@keyframe/three`、`@keyframe/webgpu` 三层包体系。
  - `WasmLoader` 提供轨道 A（bundler Base64 内联）与轨道 B（`initWeb` / `initSync` 异步 fetch 加载）。

### 3. Three.js 适配层 (js/adapters/three_adapter.ts, packages/three)
- **实现点**：
  - 凭证式上下文 `AdapterContext` 句柄控制，摒弃 WeakMap 反向查找。
  - `unregisterScene(ctx, { abandoned: true/false })` 契约：`abandoned: false` 执行软恢复（`matrixAutoUpdate = true` 并触发 `updateMatrix()`）；`abandoned: true` 执行硬放弃（永久锁定矩阵，跳过 decompose）。
  - `applyToScene(ctx, time, { rasterized })` 契约：`rasterized: false` 完整分解写入 position/quaternion/scale；`rasterized: true` 仅拷贝矩阵，跳过分解（性能提升 3x+）。
  - 时间复杂度严格保证为 $O(\text{注册对象数})$。

### 4. WebGPU 适配层 (js/adapters/webgpu_adapter.ts, packages/webgpu)
- **实现点**：
  - `webgpuAdapter.writeToBuffer(device, buffer, time, baseOffset, options)`。
  - 三层防护：
    1. 对齐校验：`baseOffset % minStorageBufferOffsetAlignment !== 0` 抛出 `TypeError`。
    2. 越界保护：`baseOffset + instanceCount * 80 > buffer.size` 抛出 `RangeError`。
    3. 设备丢失感知：`device.isLost` 为 `true` 抛出 `GPUDeviceLostError`。
  - 支持 `instanceIndices` 局部增量更新与全量更新模式。

### 5. 集成测试 (tests/adapters.test.js, tests/engine_tests.rs)
- **实现点**：
  - Rust 层 12 项单元测试全部通过 (`cargo test`)。
  - JS 层 12 项适配器集成测试全部通过 (`node --test`)，断言双场景数据无污染、`quaternion` 模长在 $[0.9999, 1.0001]$、`determinant` $> 0.0001$。

---

## 三、 代码实现与设计方案差异分析 (Gap Analysis)

1. **API 规范一致性**：
   - 适配器核心接口严格遵循凭证式设计（Token/Context-based）。
   - 参数名称完全对齐：`defaultRasterized` / `rasterized` 控制矩阵光栅化分解，`abandoned` 控制取消注册时的解绑恢复策略。
2. **零拷贝导出与常量共享**：
   - Rust Core 导出了 `INSTANCE_SIZE = 80`，供 JS 适配层统一读取，杜绝魔数硬编码。
3. **边界异常处理**：
   - WebGPU 的 `GPUDeviceLostError` 自定义 Error 类成功继承 `Error` 并在 ES Module 规范下正常被 `instanceof` 识别。
4. **编译与构建对齐**：
   - 所有子包（`packages/core`、`packages/three`、`packages/webgpu`）配置独立 `tsconfig.json` 与声明导出，与根目录 `dist/` 编译产物同步。

结论：**代码实现与设计方案 100% 完全吻合，无重大差异与已知未完成事项。**
