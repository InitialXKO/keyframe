import type { SdfScene } from './scene.js';
import { type PackedStatic, type ProbeResult } from './pack.js';
type V3 = [number, number, number];
type Q = [number, number, number, number];
export interface MapHit {
    d: number;
    la: number;
    slb: number;
    sw: number;
    ip: number;
}
/** 全局场：依结合描述表顺序折叠（与 WGSL map 逐分支一致，含标签继承） */
export declare function evalSceneMap(p: V3, pc: number, P0: Float32Array, P1: Float32Array, P2: Float32Array, P3: Float32Array, B0: Float32Array, B1: Float32Array): MapHit;
export interface PickCtx {
    pc: number;
    st: PackedStatic;
    P1: Float32Array;
    P3: Float32Array;
    waveMax: number;
    boundC: V3;
    boundR: number;
    resY: number;
    camQ: Q;
    dist: number;
    zoom: number;
    /** 集群增殖域重复实例层（null/off = 单物体直通） */
    cluster: {
        on: boolean;
        cellSize: number;
        spreadAmp: number;
        time: number;
    } | null;
}
/** 球体追踪 + 解析法线/曲率（与 WGSL march/normalCurv 同式） */
export declare function cpuProbe(rdW: V3, ctx: PickCtx): ProbeResult | null;
/** 由引擎场景状态构建求交上下文（引擎侧薄封装） */
export declare function makePickCtx(sc: SdfScene, st: PackedStatic, P1: Float32Array, P3: Float32Array, camQ: Q, dist: number, zoom: number, resY: number, cluster?: {
    on: boolean;
    cellSize: number;
    spreadAmp: number;
    time: number;
} | null): PickCtx;
export {};
