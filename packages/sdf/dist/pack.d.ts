import { SdfScene } from './scene.js';
export declare const MAXP = 16;
export interface ProbeResult {
    hit: boolean;
    tCam: number;
    point: [number, number, number];
    normal: [number, number, number];
    labelA: number;
    labelB: number;
    w: number;
    curv: number;
}
export interface PackedStatic {
    P0: Float32Array;
    P2: Float32Array;
    B0: Float32Array;
    B1: Float32Array;
    waveMax: number;
}
/** 静态数据（基元类型参数 + 结合描述表）—— loadScene 时打包一次 */
export declare function packStatic(sc: SdfScene): PackedStatic;
/** 每帧位姿（运动学求解结果）写入 P1/P3 */
export declare function packPoses(sc: SdfScene, P1: Float32Array, P3: Float32Array): void;
export declare const SUN: [number, number, number];
export declare const SUNCOL: [number, number, number];
/** 场景磨损种子（名称 FNV 哈希）—— 同一场景刷新/切后端后痕迹形态一致 */
export declare function sceneSeed(name: string): number;
export declare const BLOCK_FLOATS: number;
export declare function packBlock(res: [number, number], camQ: [number, number, number, number], dist: number, scale: number, waveMax: number, primCount: number, bound: [number, number, number, number], mode: number, probeDir: [number, number, number], wear: [number, number], // [服役时长(s), 场景种子]
st: PackedStatic, P1: Float32Array, P3: Float32Array, cluster: [number, number, number, number]): Float32Array;
