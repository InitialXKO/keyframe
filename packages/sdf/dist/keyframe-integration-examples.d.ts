/**
 * 示例 1：基础整合 —— 用 Keyframe Engine 驱动 SDF 场景动画
 *
 * 场景：一个机械装置，曲柄盘旋转、活塞往复、连杆摆动
 * 原本由 solveKinematics 硬编码的运动学，现在可以用关键帧精确编排
 */
declare function example1_basicIntegration(): Promise<void>;
/**
 * 示例 2：混合动画 —— 部分基元用关键帧，其余用内置运动学
 *
 * 场景：机械臂（基元 0-5 用关键帧编排复杂轨迹）+ 螺栓环/曲柄等（内置运动学自动兜底）
 * 桥接器采用「先算内置、再覆盖」策略，未绑定关键帧的基元自动走 solveKinematics。
 */
declare function example2_hybridAnimation(): Promise<void>;
/**
 * 示例 3：音频驱动 —— SDF 实体随音乐律动
 *
 * 利用 Keyframe Engine 的音频主时钟能力，让 SDF 场景与音频同步
 */
declare function example3_audioDriven(): Promise<void>;
/**
 * 示例 4：运行时切换 —— 动态启用/禁用 Keyframe Engine
 *
 * 场景：用户可以在「内置运动学」和「关键帧编排」之间自由切换
 */
declare function example4_runtimeSwitch(): Promise<void>;
/**
 * 示例 5：OPFS 预烘焙 —— 复杂动画的离线预渲染 + 流式加载
 *
 * 场景：预渲染复杂的装配动画序列，存储到 OPFS，运行时流式加载
 */
declare function example5_opfsPrebake(): Promise<void>;
export { example1_basicIntegration, example2_hybridAnimation, example3_audioDriven, example4_runtimeSwitch, example5_opfsPrebake, };
