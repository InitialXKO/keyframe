# Keyframe Engine Starter Kits

本目录包含 Keyframe Engine 在各类使用场景下的参考实现与起步模版 (Starter Kits)。每个起步模版均演示了 Keyframe Engine 与不同渲染后端或应用框架的无缝整合。

---

## 目录与场景说明

| 模版目录 | 场景 / 技术栈 | 核心演示内容 |
| :--- | :--- | :--- |
| **`dom-css`** | DOM & CSS3D | 演示 `@keyframe-engine/dom` 配合 `@keyframe-engine/controller` 进行批量 CSS `matrix3d()` 渲染与属性绑定。 |
| **`web-webgpu`** | WebGPU Compute | 演示将 Keyframe Engine 的 80 字节 Zero-Copy Buffer 批量直写至 GPUStorageBuffer 并由 WGSL Shader 渲染。 |
| **`three-js`** | Three.js 3D 场景 | 演示无状态凭证 Token (`AdapterContext`) 在 Three.js Mesh / Scene 中的矩阵同步。 |
| **`remotion-compat`** | Remotion 代码组件 | 演示 `spring`、`interpolate`、`Sequence` 等声明式 Remotion 风格动画函数。 |
| **`live-physics`** | 实时交互弹簧物理 | 演示 `@keyframe-engine/physics` (`RealTimeSpring`) 进行手势跟随与交互弹簧计算。 |
| **`sdf-raymarching`** | WebGL2/WebGPU SDF | 演示 CSG 隐式距离场 SDF 造型与 Keyframe 变换矩阵解算的实时桥接。 |
| **`img2sdf`** | AI 视觉与 SDF 隐式造型 | 基于 vinhhien112/img2obj 5 步收敛协议的参考图片 SDF 场景生成与 Keyframe 动画桥接。 |
| **`motion-studio`** | Next.js / React 视觉工作台 | 2D/3D 可视化关键帧动画创作工作台（时间轴、轨道、速度图曲线、洋葱皮与导出中心）。 |

---

## 快速运行

进入任意模版目录并使用 HTTP 静态服务器（如 `npx serve` 或 Vite）打开 `index.html`，或按照该模版的说明直接运行项目。
