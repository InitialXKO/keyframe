import type { SdfScene } from './scene.js';
/**
 * Keyframe Engine 实例接口（Zero-Copy ABI）
 * 实际类型来自 @keyframe-engine/core，这里只声明必要接口
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
        transform?: Float32Array;
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
 * 初始化桥接器
 * @param scene SDF 场景
 * @param config Keyframe Engine 配置
 */
export declare function initKeyframeBridge(scene: SdfScene, config: SdfKeyframeConfig): Promise<boolean>;
/**
 * 每帧位姿求解
 * 混合策略：先用 solveKinematics 计算所有基元位姿（内置运动学兜底），
 * 再用 Keyframe Engine 的数据覆盖有键帧的基元。
 * 这样即使只有部分基元绑定了关键帧，其余也能正确走内置运动学。
 * @param scene SDF 场景
 * @param timeSec 当前时间（秒）
 * @param solveKinematicsFallback 原始运动学求解函数
 */
export declare function solvePoses(scene: SdfScene, timeSec: number, solveKinematicsFallback: () => void): void;
/**
 * 销毁桥接器
 */
export declare function disposeKeyframeBridge(): void;
/**
 * 检查桥接器是否处于活动状态
 */
export declare function isKeyframeBridgeActive(): boolean;
