// ============================================================
// SDF 引擎 × Keyframe Engine 桥接层
// 让 SDF 基元可以消费 Keyframe Engine 的关键帧动画数据
// 当 Keyframe Engine 可用时优先使用关键帧；否则 fallback 到 solveKinematics
// ============================================================
import type { SdfScene, SdfPrim } from './scene.js';

/**
 * Keyframe Engine 实例接口（Zero-Copy ABI）
 * 实际类型来自 @keyframe/core，这里只声明必要接口
 */
export interface IKeyframeEngine {
  prepared?: boolean;
  evaluateFrame(globalTime: number): {
    view: Float32Array;
    ptr: number;
    byteOffset: number;
    byteLength: number;
    count: number;
  };
  getEvaluatedInstances(globalTime: number): Array<{
    id?: string;
    transformMatrix?: Float32Array;
    transform?: Float32Array;  // 4x4 matrix
    opacity: number;
    visible: boolean;
  }>;
  prepare(options?: any): Promise<void>;
  dispose?(): void;
}

/**
 * 关键帧动画剪辑配置
 * 每个 SDF 基元可以绑定一个或多个关键帧剪辑
 */
export interface SdfKeyframeConfig {
  /** Keyframe Engine 实例 */
  engine: IKeyframeEngine;
  /** 是否启用（false 时自动 fallback 到 solveKinematics） */
  enabled: boolean;
  /** 时间缩放因子（1.0 = 原速） */
  timeScale?: number;
  /** 全局偏移（毫秒） */
  timeOffset?: number;
  /**
   * 显式基元映射：实例 ID/索引 → SDF 基元索引
   * 例如：{ "inst_7": 7, "inst_14": 14 } 或 { 0: 7, 1: 14 }
   */
  primMapping?: Record<string | number, number> | ((instId: string, instIndex: number) => number | undefined);
}

/**
 * 桥接器状态
 */
interface BridgeState {
  config: SdfKeyframeConfig | null;
  /** 基元索引 → Keyframe 实例索引的映射 */
  primToInstance: Map<number, number>;
  /** 是否已完成初始化 */
  initialized: boolean;
}

const bridgeState: BridgeState = {
  config: null,
  primToInstance: new Map(),
  initialized: false,
};

/**
 * 初始化桥接器
 * @param scene SDF 场景
 * @param config Keyframe Engine 配置
 */
export async function initKeyframeBridge(
  scene: SdfScene,
  config: SdfKeyframeConfig
): Promise<boolean> {
  if (!config.enabled) {
    bridgeState.config = null;
    bridgeState.initialized = false;
    return false;
  }

  try {
    // 确保 Keyframe Engine 已准备
    if (!config.engine.prepared && typeof config.engine.prepare === 'function') {
      await config.engine.prepare().catch((err) => {
        console.warn('[KeyframeBridge] Engine prepare error:', err);
      });
    }

    bridgeState.primToInstance.clear();

    const instances = typeof config.engine.getEvaluatedInstances === 'function'
      ? config.engine.getEvaluatedInstances(0)
      : [];

    if (config.primMapping) {
      if (typeof config.primMapping === 'function') {
        const fn = config.primMapping;
        instances.forEach((inst, instIdx) => {
          const primIdx = fn(inst.id || `inst_${instIdx}`, instIdx);
          if (primIdx !== undefined && primIdx >= 0) {
            bridgeState.primToInstance.set(primIdx, instIdx);
          }
        });
      } else {
        const mapping = config.primMapping;
        Object.entries(mapping).forEach(([key, primIdx]) => {
          let instIdx = Number(key);
          if (isNaN(instIdx)) {
            instIdx = instances.findIndex((inst) => inst.id === key);
          }
          if (instIdx >= 0) {
            bridgeState.primToInstance.set(primIdx, instIdx);
          }
        });
      }
    } else {
      // 智能识别：若实例 ID 包含 inst_N 或 prim_N，将 N 自动作为 SDF 基元索引
      let mappedAny = false;
      instances.forEach((inst, instIdx) => {
        const id = inst.id || '';
        const match = id.match(/(?:inst|prim)_?(\d+)/i);
        if (match) {
          const primIdx = parseInt(match[1], 10);
          if (primIdx >= 0 && primIdx < scene.prims.length) {
            bridgeState.primToInstance.set(primIdx, instIdx);
            mappedAny = true;
          }
        }
      });

      if (!mappedAny) {
        // 默认按 1:1 映射 (基元 i 对应 实例 i)
        scene.prims.forEach((_: SdfPrim, i: number) => {
          bridgeState.primToInstance.set(i, i);
        });
      }
    }

    bridgeState.config = config;
    bridgeState.initialized = true;
    return true;
  } catch (err) {
    console.warn('[KeyframeBridge] 初始化失败，将使用 solveKinematics fallback:', err);
    bridgeState.config = null;
    bridgeState.initialized = false;
    return false;
  }
}

/**
 * 每帧位姿求解
 * 混合策略：先用 solveKinematics 计算所有基元位姿（内置运动学兜底），
 * 再用 Keyframe Engine 的数据覆盖有键帧的基元。
 * 这样即使只有部分基元绑定了关键帧，其余也能正确走内置运动学。
 * @param scene SDF 场景
 * @param timeSec 当前时间（秒）
 * @param solveKinematicsFallback 原始运动学求解函数
 */
export function solvePoses(
  scene: SdfScene,
  timeSec: number,
  solveKinematicsFallback: () => void
): void {
  // 始终先用内置运动学计算基线位姿
  solveKinematicsFallback();

  // 检查 Keyframe Engine 是否可用
  if (!bridgeState.config?.enabled || !bridgeState.initialized) {
    return; // 内置运动学已计算完毕，直接返回
  }

  const { engine, timeScale = 1.0, timeOffset = 0 } = bridgeState.config;
  const globalTimeMs = timeSec * 1000 * timeScale + timeOffset;

  try {
    // 使用 Zero-Copy 评估模式获取实例数据
    const evalResult = engine.evaluateFrame(globalTimeMs);

    if (evalResult.count === 0) {
      return; // 无关键帧数据，保留内置运动学结果
    }

    // 遍历有映射的基元，用 Keyframe 数据覆盖位姿
    bridgeState.primToInstance.forEach((instanceIdx, primIdx) => {
      if (primIdx >= scene.prims.length || instanceIdx >= evalResult.count) {
        return; // 无对应关键帧数据，保留内置运动学结果
      }

      const prim = scene.prims[primIdx];

      // Keyframe Engine 的 80 字节布局：
      // - transform_matrix: [f32; 16] = 64 bytes (列主序 4x4)
      // - opacity: f32 = 4 bytes
      // - visible: u32 = 4 bytes
      // - clip_index: u32 = 4 bytes
      // - _padding: u32 = 4 bytes
      const baseFloatIdx = evalResult.byteOffset / 4 + instanceIdx * 20; // 80 bytes / 4
      const m = evalResult.view;

      // 提取平移分量（位置）
      const tx = m[baseFloatIdx + 12];
      const ty = m[baseFloatIdx + 13];
      const tz = m[baseFloatIdx + 14];
      prim._wp = [tx, ty, tz];

      // 从 3x3 旋转子矩阵提取四元数
      const m00 = m[baseFloatIdx + 0], m01 = m[baseFloatIdx + 4], m02 = m[baseFloatIdx + 8];
      const m10 = m[baseFloatIdx + 1], m11 = m[baseFloatIdx + 5], m12 = m[baseFloatIdx + 9];
      const m20 = m[baseFloatIdx + 2], m21 = m[baseFloatIdx + 6], m22 = m[baseFloatIdx + 10];

      const trace = m00 + m11 + m22;
      let qw: number, qx: number, qy: number, qz: number;

      if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        qw = 0.25 / s;
        qx = (m21 - m12) * s;
        qy = (m02 - m20) * s;
        qz = (m10 - m01) * s;
      } else if (m00 > m11 && m00 > m22) {
        const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
        qw = (m21 - m12) / s;
        qx = 0.25 * s;
        qy = (m01 + m10) / s;
        qz = (m02 + m20) / s;
      } else if (m11 > m22) {
        const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
        qw = (m02 - m20) / s;
        qx = (m01 + m10) / s;
        qy = 0.25 * s;
        qz = (m12 + m21) / s;
      } else {
        const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
        qw = (m10 - m01) / s;
        qx = (m02 + m20) / s;
        qy = (m12 + m21) / s;
        qz = 0.25 * s;
      }

      // 归一化四元数
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
      prim._wq = [qx / len, qy / len, qz / len, qw / len];
    });
  } catch (err) {
    // 评估失败时静默保留内置运动学结果，不中断渲染
    console.warn('[KeyframeBridge] 帧评估异常，保留内置运动学位姿:', err);
  }
}

/**
 * 销毁桥接器
 */
export function disposeKeyframeBridge(): void {
  if (bridgeState.config?.engine) {
    if (typeof bridgeState.config.engine.dispose === 'function') {
      bridgeState.config.engine.dispose();
    }
  }
  bridgeState.config = null;
  bridgeState.primToInstance.clear();
  bridgeState.initialized = false;
}

/**
 * 检查桥接器是否处于活动状态
 */
export function isKeyframeBridgeActive(): boolean {
  return bridgeState.config?.enabled === true && bridgeState.initialized;
}
