// ============================================================
// SDF 纯逻辑 CPU 求交器（spec 同源第三翻译：TS = GLSL = WGSL）
// 用途：
//   1. WebGPU 后端 GPU 读回异常时的拾取降级路径
//      （headless/SwiftShader 存在 present 后异步回调 API 全灭的平台缺陷）
//   2. 后续自动化测试的地形级真值参照（与 GPU 探针逐位对齐）
// 仅服务单射线拾取（每次点击 ~10万次浮点运算，可忽略），
// 不参与逐像素渲染主路径。
// ============================================================
import type { SdfScene } from './scene.js';
import { MAXP, type PackedStatic, type ProbeResult } from './pack.js';

type V3 = [number, number, number];
type Q = [number, number, number, number];

const TANF = 0.3839;
const PI = 3.14159265;

function qrot(q: Q, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  const c1: V3 = [qy * v[2] - qz * v[1], qz * v[0] - qx * v[2], qx * v[1] - qy * v[0]];
  const w1: V3 = [c1[0] + qw * v[0], c1[1] + qw * v[1], c1[2] + qw * v[2]];
  const c2: V3 = [qy * w1[2] - qz * w1[1], qz * w1[0] - qx * w1[2], qx * w1[1] - qy * w1[0]];
  return [v[0] + 2 * c2[0], v[1] + 2 * c2[1], v[2] + 2 * c2[2]];
}
function qrotInv(q: Q, v: V3): V3 {
  return qrot([-q[0], -q[1], -q[2], q[3]], v);
}
function len3(v: V3): number { return Math.hypot(v[0], v[1], v[2]); }
function norm3(v: V3): V3 { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function clamp(x: number, a: number, b: number): number { return Math.min(Math.max(x, a), b); }
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smod(x: number, y: number): number { return x - y * Math.floor(x / y); }
function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}
function smax(a: number, b: number, k: number): number {
  const h = clamp(0.5 - 0.5 * (b - a) / k, 0, 1);
  return mix(b, a, h) + k * h * (1 - h);
}

/** 基元 SDF（与 WGSL primEval 逐分支一致） */
function primEval(t: number, q: V3, P2: Float32Array, i: number): number {
  const px = P2[i * 4], py = P2[i * 4 + 1], pz = P2[i * 4 + 2], pw = P2[i * 4 + 3];
  switch (t) {
    case 0: { // box
      const dx = Math.abs(q[0]) - px, dy = Math.abs(q[1]) - py, dz = Math.abs(q[2]) - pz;
      const mx = Math.max(dx, Math.max(dy, dz));
      const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
      return Math.hypot(ox, oy, oz) + Math.min(mx, 0);
    }
    case 1: return len3(q) - px; // sphere
    case 2: { // cyl
      const dx = Math.hypot(q[0], q[2]) - px, dy = Math.abs(q[1]) - py;
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    }
    case 3: return Math.hypot(Math.hypot(q[0], q[2]) - px, q[1]) - py; // torus
    case 4: { // capsule
      const cy = clamp(q[1], -py, py);
      return len3([q[0], q[1] - cy, q[2]]) - px;
    }
    default: { // 5 boltring：绕 Z 极坐标周期映射复用单一函数体
      const n = Math.max(pz, 2);
      const sec = 2 * PI / n;
      let ang = Math.atan2(q[1], q[0]);
      ang = smod(ang + sec * 0.5, sec) - sec * 0.5;
      const rr = Math.hypot(q[0], q[1]);
      const qb: V3 = [Math.cos(ang) * rr - pw, Math.sin(ang) * rr, q[2]];
      const dx = Math.hypot(qb[0], qb[1]) - px, dy = Math.abs(qb[2]) - py;
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    }
  }
}

export interface MapHit { d: number; la: number; slb: number; sw: number; ip: number; }

/** 全局场：依结合描述表顺序折叠（与 WGSL map 逐分支一致，含标签继承） */
export function evalSceneMap(
  p: V3, pc: number, P0: Float32Array, P1: Float32Array, P2: Float32Array,
  P3: Float32Array, B0: Float32Array, B1: Float32Array,
): MapHit {
  let acc = 1e9, la = 0, slb = -1, sw = 0, ip = 0;
  for (let i = 0; i < MAXP && i < pc; i++) {
    const q = qrotInv([P3[i * 4], P3[i * 4 + 1], P3[i * 4 + 2], P3[i * 4 + 3]],
      [p[0] - P1[i * 4], p[1] - P1[i * 4 + 1], p[2] - P1[i * 4 + 2]]);
    const d = primEval(Math.round(P0[i * 4]), q, P2, i);
    const lb = P0[i * 4 + 1];
    if (i === 0) { acc = d; la = lb; continue; }
    const op = Math.round(B0[i * 4]);
    const tt = Math.round(B0[i * 4 + 1]);
    const k = B0[i * 4 + 2];
    if (op === 1) {
      // 差集：max 与取反结合；切面继承宿主标签（不动 la/slb/sw/ip）
      acc = smax(acc, -d, Math.max(k, 1e-4));
    } else if (op === 2) {
      // 交集
      const kk = Math.max(k, 1e-4);
      const h = clamp(0.5 + 0.5 * (acc - d) / kk, 0, 1);
      acc = mix(d, acc, h) + kk * h * (1 - h);
      const pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4 * h * (1 - h);
    } else if (tt === 0) {
      // 尖锐并
      if (d < acc) { acc = d; la = lb; slb = -1; sw = 0; ip = i; }
    } else if (tt === 2) {
      // 变半径倒角
      const ax = B1[i * 4 + 1];
      const s = ax < 0.5 ? p[0] : ax < 1.5 ? p[1] : p[2];
      const kk = Math.max(B1[i * 4 + 2] + B1[i * 4 + 3] * s, 1e-4);
      const c = 0.5 * (acc + d) - kk;
      const r = Math.min(Math.min(acc, d), c);
      const h = clamp(0.5 + 0.5 * (d - acc) / Math.max(kk, 1e-3), 0, 1);
      const pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4 * h * (1 - h);
      acc = r;
    } else if (tt === 3) {
      // 波浪熔接
      const kk = Math.max(k, 1e-4);
      const h = clamp(0.5 + 0.5 * (d - acc) / kk, 0, 1);
      let r = smin(acc, d, kk);
      const wv = Math.sin(B1[i * 4] * (p[0] + 0.7 * p[2])) * Math.sin(B1[i * 4] * 1.31 * (p[1] - 0.41 * p[0]));
      r = r - B0[i * 4 + 3] * (4 * h * (1 - h)) * wv;
      const pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4 * h * (1 - h);
      acc = r;
    } else if (tt === 4) {
      // 错位搭接
      const kk = Math.max(k, 1e-4);
      const h = clamp(0.5 + 0.5 * (d - acc) / kk, 0, 1);
      const r = smin(acc, d, kk) + kk * 0.25 * (4 * h * (1 - h)) * (0.5 + 0.5 * Math.sin(60 * (acc - d)));
      const pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4 * h * (1 - h);
      acc = r;
    } else {
      // 恒定半径圆角
      const kk = Math.max(k, 1e-4);
      const h = clamp(0.5 + 0.5 * (d - acc) / kk, 0, 1);
      const r = mix(d, acc, h) - kk * h * (1 - h);
      const pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4 * h * (1 - h);
      acc = r;
    }
  }
  return { d: acc, la, slb, sw, ip };
}

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
  cluster: { on: boolean; cellSize: number; spreadAmp: number; time: number } | null;
}

/** 全局场入口（含集群实例层包装；与 GLSL/WGSL mapScene 同构） */
function mapSceneHit(p: V3, ctx: PickCtx): MapHit {
  const hit = evalSceneMap(p, ctx.pc, ctx.st.P0, ctx.P1, ctx.st.P2, ctx.P3, ctx.st.B0, ctx.st.B1);
  if (!ctx.cluster || !ctx.cluster.on) return hit;
  const { q, scl } = clusterXform(p, ctx);
  const h = evalSceneMap(q, ctx.pc, ctx.st.P0, ctx.P1, ctx.st.P2, ctx.P3, ctx.st.B0, ctx.st.B1);
  h.d *= scl;
  return h;
}
function mapSceneD(p: V3, ctx: PickCtx): number {
  return mapSceneHit(p, ctx).d;
}

/** 实例哈希（与 GLSL hash31 / WGSL hash31 同式，三端同构） */
function hash31(c: V3): V3 {
  const f = (x: number) => {
    const v = Math.sin(x) * 43758.5453;
    return v - Math.floor(v);
  };
  return [
    f(c[0] * 127.1 + c[1] * 311.7 + c[2] * 74.7),
    f(c[0] * 269.5 + c[1] * 183.3 + c[2] * 246.1),
    f(c[0] * 113.5 + c[1] * 271.9 + c[2] * 124.6),
  ];
}
function rotYv(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]];
}

/** 集群域重复实例层（与 GLSL/WGSL mapScene 同式）；返回 spec 空间点与距离补偿系数 */
function clusterXform(p: V3, ctx: PickCtx): { q: V3; scl: number } {
  const cl = ctx.cluster!;
  const cs = Math.max(cl.cellSize, 1.5);
  const cell: V3 = [Math.floor(p[0] / cs), Math.floor(p[1] / cs), Math.floor(p[2] / cs)];
  const h = hash31(cell);
  const centerW: V3 = [(cell[0] + 0.5) * cs, (cell[1] + 0.5) * cs, (cell[2] + 0.5) * cs];
  const pop = 0.5 - 0.5 * Math.cos(cl.time * 0.55 - h[0] * 6.2832);
  const dl = Math.hypot(h[1] - 0.5, h[2] * 0.55 + 0.15, h[0] - 0.5) || 1;
  const off: V3 = [(h[1] - 0.5) / dl * cl.spreadAmp * pop, (h[2] * 0.55 + 0.15) / dl * cl.spreadAmp * pop, (h[0] - 0.5) / dl * cl.spreadAmp * pop];
  const scl = 1 + 0.07 * Math.sin(cl.time * 1.25 + h[1] * 6.2832);
  const ang = h[2] * 6.2832 + cl.time * 0.12;
  const q = rotYv([p[0] - centerW[0] - off[0], p[1] - centerW[1] - off[1], p[2] - centerW[2] - off[2]], -ang);
  return { q: [q[0] / scl, q[1] / scl, q[2] / scl], scl };
}

/** 球体追踪 + 解析法线/曲率（与 WGSL march/normalCurv 同式） */
export function cpuProbe(rdW: V3, ctx: PickCtx): ProbeResult | null {
  const zoom = ctx.zoom;
  const roW = qrotInv(ctx.camQ, [0, 0, ctx.dist]).map((v) => v * zoom) as V3;
  const relax = 0.85 / (1 + 2.5 * ctx.waveMax);
  const clustered = !!(ctx.cluster && ctx.cluster.on);
  // 包围球预剔除（集群模式下射线需命中任意实例，跳过剔除，与着色器同构）
  let s0 = 0.002;
  let s1 = 26;
  let cap = 1e9;
  if (clustered) {
    s1 = 40;
    cap = Math.max(ctx.cluster!.cellSize, 1.5) * 0.45;
  } else {
    const oc: V3 = [roW[0] - ctx.boundC[0], roW[1] - ctx.boundC[1], roW[2] - ctx.boundC[2]];
    const b = rdW[0] * oc[0] + rdW[1] * oc[1] + rdW[2] * oc[2];
    const disc = b * b - (oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2]) + ctx.boundR * ctx.boundR;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    s0 = Math.max(-b - sq, 0);
    s1 = -b + sq;
  }
  let t = s0;
  let hit = false;
  for (let i = 0; i < 64; i++) {
    const d = mapSceneD([roW[0] + rdW[0] * t, roW[1] + rdW[1] * t, roW[2] + rdW[2] * t], ctx);
    const eps = Math.max(2e-6, (t * 3 * TANF) / (ctx.resY * zoom * zoom));
    if (d < eps) { hit = true; break; }
    t += Math.min(d * relax, cap);
    if (t > s1) break;
  }
  if (!hit) return null;
  const pw: V3 = [roW[0] + rdW[0] * t, roW[1] + rdW[1] * t, roW[2] + rdW[2] * t];
  // 解析梯度（四面体差分）+ 拉普拉斯曲率；偏移系数 0.5773 与 WGSL e=(1,-1)*0.5773 逐位一致
  const e: V3[] = [[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]];
  const epsw = Math.max(2e-6, (t * 3 * TANF) / (ctx.resY * zoom * zoom));
  const o = epsw * 0.5773;
  const m: number[] = e.map((ev) => mapSceneD([pw[0] + ev[0] * o, pw[1] + ev[1] * o, pw[2] + ev[2] * o], ctx));
  const g: V3 = [
    e[0][0] * m[0] + e[1][0] * m[1] + e[2][0] * m[2] + e[3][0] * m[3],
    e[0][1] * m[0] + e[1][1] * m[1] + e[2][1] * m[2] + e[3][1] * m[3],
    e[0][2] * m[0] + e[1][2] * m[1] + e[2][2] * m[2] + e[3][2] * m[3],
  ];
  const nW = norm3(g);
  const h = mapSceneHit(pw, ctx);
  const curv = 1.5 * (m[0] + m[1] + m[2] + m[3] - 4 * h.d) / (epsw * epsw);
  return {
    hit: true,
    tCam: t / zoom,
    point: [pw[0], pw[1], pw[2]],
    normal: nW,
    labelA: Math.round(h.la),
    labelB: Math.round(h.slb),
    w: h.sw,
    curv,
  };
}

/** 由引擎场景状态构建求交上下文（引擎侧薄封装） */
export function makePickCtx(
  sc: SdfScene, st: PackedStatic, P1: Float32Array, P3: Float32Array,
  camQ: Q, dist: number, zoom: number, resY: number,
  cluster?: { on: boolean; cellSize: number; spreadAmp: number; time: number } | null,
): PickCtx {
  return {
    pc: Math.min(sc.prims.length, MAXP),
    st, P1, P3,
    waveMax: st.waveMax,
    boundC: [sc.boundC[0], sc.boundC[1], sc.boundC[2]],
    boundR: sc.boundR,
    resY: Math.max(resY, 1),
    camQ, dist, zoom,
    cluster: cluster && cluster.on ? cluster : null,
  };
}
