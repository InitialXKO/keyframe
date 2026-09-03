// ============================================================
// SDF 场景 → 着色器 uniform 装载层
// WebGL2（逐 uniform）与 WebGPU（uniform block）共用同一份打包结果，
// 保证双后端看到逐位一致的场景数据 —— 统一拾取 API 的数据基座。
// ============================================================
import { SdfScene, SdfPrim, SdfBond } from './scene.js';

export const MAXP = 16;

const TYPE: Record<string, number> = { box: 0, sphere: 1, cyl: 2, torus: 3, capsule: 4, boltring: 5 };
const OP: Record<string, number> = { union: 0, sub: 1, inter: 2 };
const TT: Record<string, number> = { sharp: 0, fillet: 1, chamfer: 2, wave: 3, lap: 4 };

export interface ProbeResult {
  hit: boolean;
  tCam: number;
  point: [number, number, number]; // 世界系交点坐标
  normal: [number, number, number]; // 世界系解析法线
  labelA: number; // 主材质标签
  labelB: number; // 过渡区次标签（-1 = 无）
  w: number;      // 过渡混合权重
  curv: number;   // 局部曲率（拉普拉斯）
}

export interface PackedStatic {
  P0: Float32Array; // [type, label, hardness, -]
  P2: Float32Array; // 类型参数
  B0: Float32Array; // [op, trans, radius, waveAmp]
  B1: Float32Array; // [waveFreq, chamAxis, k0, k1]
  waveMax: number;
}

/** 静态数据（基元类型参数 + 结合描述表）—— loadScene 时打包一次 */
export function packStatic(sc: SdfScene): PackedStatic {
  const P0 = new Float32Array(MAXP * 4);
  const P2 = new Float32Array(MAXP * 4);
  const B0 = new Float32Array(MAXP * 4);
  const B1 = new Float32Array(MAXP * 4);
  let waveMax = 0;
  sc.prims.forEach((pr: SdfPrim, i: number) => {
    if (i >= MAXP) return;
    P0.set([TYPE[pr.type], pr.label, pr.hardness, 0], i * 4);
    const p = pr.p;
    let p2: number[] = [0, 0, 0, 0];
    if (pr.type === 'box') p2 = [p[0], p[1], p[2], 0];
    else if (pr.type === 'sphere') p2 = [p[0], 0, 0, 0];
    else if (pr.type === 'cyl' || pr.type === 'torus' || pr.type === 'capsule') p2 = [p[0], p[1], 0, 0];
    else if (pr.type === 'boltring') p2 = [p[0], p[1], p[2], p[3]];
    P2.set(p2, i * 4);
  });
  sc.bonds.forEach((b: SdfBond, i: number) => {
    if (i >= MAXP) return;
    B0.set([OP[b.op], TT[b.trans], b.radius ?? 0, b.waveAmp ?? 0], i * 4);
    B1.set([b.waveFreq ?? 0, b.chamAxis ?? 1, b.k0 ?? 0, b.k1 ?? 0], i * 4);
    if (b.trans === 'wave') waveMax = Math.max(waveMax, (b.waveAmp ?? 0) * (b.waveFreq ?? 0));
  });
  return { P0, P2, B0, B1, waveMax };
}

/** 每帧位姿（运动学求解结果）写入 P1/P3 */
export function packPoses(sc: SdfScene, P1: Float32Array, P3: Float32Array) {
  sc.prims.forEach((pr: SdfPrim, i: number) => {
    if (i >= MAXP) return;
    const wp = pr._wp ?? pr.pos;
    const wq = pr._wq ?? pr.quat ?? [0, 0, 0, 1];
    P1.set([wp[0], wp[1], wp[2], 0], i * 4);
    P3.set(wq, i * 4);
  });
}

export const SUN: [number, number, number] = [0.5, 0.62, 0.45];
export const SUNCOL: [number, number, number] = [1.15, 1.1, 1.0];

/** 场景磨损种子（名称 FNV 哈希）—— 同一场景刷新/切后端后痕迹形态一致 */
export function sceneSeed(name: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h % 4096) / 4096) * 80.0;
}

// ---------- WebGPU uniform block（WGSL struct Uni 布局，全部 vec4） ----------
// 头部 9 个 vec4（含 uCluster）+ 6 组场景数组（各 16 vec4）= 420 floats = 1680 字节
export const BLOCK_FLOATS = 36 + MAXP * 4 * 6;

export function packBlock(
  res: [number, number],
  camQ: [number, number, number, number],
  dist: number, scale: number, waveMax: number, primCount: number,
  bound: [number, number, number, number],
  mode: number,
  probeDir: [number, number, number],
  wear: [number, number], // [服役时长(s), 场景种子]
  st: PackedStatic,
  P1: Float32Array,
  P3: Float32Array,
  cluster: [number, number, number, number], // [on, cellSize, spreadAmp, time]
): Float32Array {
  const o = new Float32Array(BLOCK_FLOATS);
  o[0] = res[0]; o[1] = res[1];
  o.set(camQ, 4);
  o[8] = dist; o[9] = scale; o[10] = waveMax; o[11] = primCount;
  o.set(SUN, 12); o[15] = mode;
  o.set(SUNCOL, 16);
  o.set(bound, 20);
  o.set(probeDir, 24);
  o[28] = wear[0]; o[29] = wear[1];
  o.set(cluster, 32);
  o.set(st.P0, 36);
  o.set(P1, 36 + 64);
  o.set(st.P2, 36 + 128);
  o.set(P3, 36 + 192);
  o.set(st.B0, 36 + 256);
  o.set(st.B1, 36 + 320);
  return o;
}
