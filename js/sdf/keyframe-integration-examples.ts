// ============================================================
// SDF 引擎 × Keyframe Engine 整合示例
// 演示如何用 Keyframe Engine 的关键帧动画驱动 SDF 基元位姿
// ============================================================

/**
 * 示例 1：基础整合 —— 用 Keyframe Engine 驱动 SDF 场景动画
 *
 * 场景：一个机械装置，曲柄盘旋转、活塞往复、连杆摆动
 * 原本由 solveKinematics 硬编码的运动学，现在可以用关键帧精确编排
 */
async function example1_basicIntegration() {
  // 1. 导入（实际项目中从对应包导入）
  // import { Engine, Clip, Keyframe, TransformBuilder, BlendMode } from '@keyframe/core';
  // import { SdfEngine } from './engine';
  // import { PRESETS } from './scene';

  // 2. 创建 SDF 引擎并加载场景
  const canvas = document.getElementById('sdf-canvas') as HTMLCanvasElement;
  // const sdfEngine = new SdfEngine(canvas);
  // sdfEngine.loadScene(PRESETS[0]); // 曲柄滑块演示机

  // 3. 创建 Keyframe Engine 实例
  // const kfEngine = new Engine();

  // 4. 为每个 SDF 基元创建对应的关键帧剪辑
  // 以曲柄盘（索引 7）为例：从静止到匀速旋转
  // const crankClip = new Clip('crank_rotation')
  //   .duration(10000) // 10秒一个周期
  //   .addKeyframe(
  //     new Keyframe(0)
  //       .transform(new TransformBuilder().rotateZ(0).build())
  //       .opacity(1)
  //   )
  //   .addKeyframe(
  //     new Keyframe(10000)
  //       .transform(new TransformBuilder().rotateZ(Math.PI * 2).build())
  //       .opacity(1)
  //   );

  // 5. 创建实例（索引需与 SDF 基元索引对应）
  // const crankInstance = new Instance('crank_rotation', 'inst_7')
  //   .delay(0)
  //   .timeRemappingSpeed(1.0);

  // kfEngine.addClip(crankClip);
  // kfEngine.addInstances([crankInstance]);
  // await kfEngine.prepare();

  // 6. 接入桥接器
  // const success = await sdfEngine.enableKeyframeEngine({
  //   engine: kfEngine,
  //   enabled: true,
  //   timeScale: 1.0,
  // });

  // if (success) {
  //   console.log('Keyframe Engine 已激活，SDF 动画由关键帧驱动');
  // } else {
  //   console.log('Keyframe Engine 初始化失败，自动回退到内置运动学');
  // }
}


/**
 * 示例 2：混合动画 —— 部分基元用关键帧，其余用内置运动学
 *
 * 场景：机械臂（基元 0-5 用关键帧编排复杂轨迹）+ 螺栓环/曲柄等（内置运动学自动兜底）
 * 桥接器采用「先算内置、再覆盖」策略，未绑定关键帧的基元自动走 solveKinematics。
 */
async function example2_hybridAnimation() {
  // const canvas = document.getElementById('sdf-canvas') as HTMLCanvasElement;
  // const sdfEngine = new SdfEngine(canvas);
  // sdfEngine.loadScene(PRESETS[0]); // 曲柄滑块演示机（16 个基元）

  // const kfEngine = new Engine();

  // 只为基元 0-5（结构件）创建关键帧动画
  // for (let i = 0; i < 6; i++) {
  //   const clip = new Clip(`arm_part_${i}`)
  //     .duration(5000)
  //     .addKeyframe(
  //       new Keyframe(0)
  //         .transform(new TransformBuilder().translateY(0).rotateY(0).build())
  //     )
  //     .addKeyframe(
  //       new Keyframe(2500)
  //         .transform(new TransformBuilder().translateY(0.3).rotateY(Math.PI / 4).build())
  //     )
  //     .addKeyframe(
  //       new Keyframe(5000)
  //         .transform(new TransformBuilder().translateY(0).rotateY(0).build())
  //     );
  //   kfEngine.addClip(clip);
  //   kfEngine.addInstance(new Instance(`arm_part_${i}`, `inst_${i}`));
  // }
  // // 注意：只为索引 0-5 创建了实例，6-15 没有对应实例

  // await kfEngine.prepare();
  // await sdfEngine.enableKeyframeEngine({
  //   engine: kfEngine,
  //   enabled: true,
  // });
  //
  // 效果：
  // - 基元 0-5：位姿由 Keyframe Engine 关键帧驱动（覆盖内置运动学）
  // - 基元 6-15（曲柄盘、活塞、连杆、螺栓环等）：自动走 solveKinematics 内置运动学
  // - 两者在同一帧内无缝共存，无需手动管理
}


/**
 * 示例 3：音频驱动 —— SDF 实体随音乐律动
 *
 * 利用 Keyframe Engine 的音频主时钟能力，让 SDF 场景与音频同步
 */
async function example3_audioDriven() {
  // const canvas = document.getElementById('sdf-canvas') as HTMLCanvasElement;
  // const sdfEngine = new SdfEngine(canvas);
  // sdfEngine.loadScene(PRESETS[1]); // 波浪熔接三通管件

  // const kfEngine = new Engine();
  // const controller = new AnimationPlayer(kfEngine);

  // 创建脉动效果的关键帧
  // const pulseClip = new Clip('audio_pulse')
  //   .duration(500) // 半秒一拍
  //   .addKeyframe(
  //     new Keyframe(0)
  //       .transform(new TransformBuilder().scale(1.0).build())
  //   )
  //   .addKeyframe(
  //     new Keyframe(250)
  //       .transform(new TransformBuilder().scale(1.15).build())
  //   )
  //   .addKeyframe(
  //     new Keyframe(500)
  //       .transform(new TransformBuilder().scale(1.0).build())
  //   );

  // kfEngine.addClip(pulseClip);
  // // 为所有基元创建循环实例
  // for (let i = 0; i < 16; i++) {
  //   kfEngine.addInstance(
  //     new Instance('audio_pulse', `inst_${i}`)
  //       .loop(true)
  //       .blendMode(BlendMode.Additive) // 叠加混合，产生共振效果
  //   );
  // }

  // await kfEngine.prepare();
  // await sdfEngine.enableKeyframeEngine({
  //   engine: kfEngine,
  //   enabled: true,
  //   timeScale: 1.0, // 由音频主时钟控制
  // });

  // 绑定音频源
  // controller.attachAudioClock(audioContext, audioSource);
}


/**
 * 示例 4：运行时切换 —— 动态启用/禁用 Keyframe Engine
 *
 * 场景：用户可以在「内置运动学」和「关键帧编排」之间自由切换
 */
async function example4_runtimeSwitch() {
  // const sdfEngine = new SdfEngine(canvas);
  // sdfEngine.loadScene(PRESETS[0]);

  // 初始使用内置运动学
  // console.log('当前模式：内置运动学');

  // 用户点击按钮切换到关键帧模式
  // function onSwitchToKeyframe() {
  //   const kfEngine = new Engine();
  //   // ... 配置关键帧 ...
  //   sdfEngine.enableKeyframeEngine({
  //     engine: kfEngine,
  //     enabled: true,
  //   });
  //   console.log('已切换到 Keyframe Engine 驱动');
  // }

  // 用户点击按钮切回内置运动学
  // function onSwitchToKinematics() {
  //   sdfEngine.disableKeyframeEngine();
  //   console.log('已切回内置运动学');
  // }

  // 检查当前状态
  // if (sdfEngine.isKeyframeActive) {
  //   console.log('当前由 Keyframe Engine 驱动');
  // } else {
  //   console.log('当前由内置运动学驱动');
  // }
}


/**
 * 示例 5：OPFS 预烘焙 —— 复杂动画的离线预渲染 + 流式加载
 *
 * 场景：预渲染复杂的装配动画序列，存储到 OPFS，运行时流式加载
 */
async function example5_opfsPrebake() {
  // const kfEngine = new Engine();

  // 1. 离线阶段：创建复杂动画并烘焙到 OPFS
  // const clip = new Clip('complex_assembly')
  //   .duration(60000) // 60秒复杂装配动画
  //   // ... 添加大量关键帧 ...
  //   ;
  // kfEngine.addClip(clip);
  // await kfEngine.prepare();

  // 2. 烘焙到 OPFS
  // const writer = createSyncOPFSWriter(kfEngine);
  // await writer.bake({
  //   outputName: 'assembly_v1',
  //   sampleRate: 60, // 60fps
  //   chunkSize: 1000, // 每 1000 帧一个块
  // });

  // 3. 运行时：从 OPFS 流式加载（无需重新计算）
  // const storage = new StorageAdapter();
  // await storage.loadFromOPFS('assembly_v1');

  // 4. 接入 SDF 引擎
  // const sdfEngine = new SdfEngine(canvas);
  // sdfEngine.loadScene(PRESETS[0]);
  // await sdfEngine.enableKeyframeEngine({
  //   engine: kfEngine,
  //   enabled: true,
  // });
}


// 导出示例（仅用于文档和测试参考）
export {
  example1_basicIntegration,
  example2_hybridAnimation,
  example3_audioDriven,
  example4_runtimeSwitch,
  example5_opfsPrebake,
};
