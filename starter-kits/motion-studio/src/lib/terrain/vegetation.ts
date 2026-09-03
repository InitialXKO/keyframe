/**
 * 植被与生态细节增殖 —— 无任何预存树木形状。
 *
 * ① 适宜性判定：海拔（林线下）、坡度（陡坡不长树）、水体（岸线外）、
 *    汇水/湿度（谷地湿润处更密）四项复合判定该处是否适宜生长。
 * ② 迭代分叉规则：从主干起点按固定角度与长度比例反复分叉（深度 5），
 *    即时演算出完整枝干拓扑，并栅格化为平面投影遮罩（canvas 描边）。
 *    图集通道语义：A=覆盖 · R=枝干邻近度（内腔 AO）· G=叶簇（外冠受光/透光）。
 *    每个个体由位置哈希播种 → 形态随海拔/湿度连续变化，无两个完全一致的个体。
 * ③ 远景退化：与迭代规则同源的平面投影遮罩即远景形态（统计一致），
 *    距离越远个体越小并淡出 → 近树（实例化四向交叉面片）→ 远景林冠遮罩平滑衔接。
 * ④ 草丛层：近景（<750m）草甸带增殖的小型交叉面片，仅遮罩 + 程序着色。
 */

import { detailRelief, heightAt, waterAt, type TerrainTable } from "./table";

/** 树图集：单变体画布边长（px）与变体数 */
export const TREE_TEX_SIZE = 256;
export const TREE_VARIANTS = 4;
/** 草丛图集 */
export const GRASS_TEX_SIZE = 128;
export const GRASS_VARIANTS = 2;
/** 每个体面片数（四向交叉：0°/45°/90°/135°） */
export const TREE_QUADS = 4;
export const GRASS_QUADS = 2;

export interface TreeVariant {
  /** 枝干拓扑遮罩（R=枝干AO · G=叶簇 · A=覆盖） */
  canvas: HTMLCanvasElement;
  /** 拓扑参数（供图例/一致性说明） */
  depth: number;
  spread: number;
  taper: number;
}

/** mulberry32 —— 相同种子严格一致 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return rnd;
}

/** 迭代分叉规则：从主干开始递归分叉，返回线段列表（归一化坐标 0..1，y 向上） */
interface BranchSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  tip: boolean;
}

function iterateBranches(seed: number, depth: number, spread: number, taper: number): BranchSeg[] {
  const rnd = mulberry32(seed);
  const segs: BranchSeg[] = [];
  const grow = (x: number, y: number, angle: number, len: number, w: number, level: number): void => {
    const x2 = x + Math.sin(angle) * len;
    const y2 = y + Math.cos(angle) * len;
    const terminal = level >= depth || len < 0.02;
    segs.push({ x1: x, y1: y, x2, y2, w, tip: terminal });
    if (terminal) return;
    const branches = 2 + (rnd() > 0.6 ? 1 : 0);
    for (let k = 0; k < branches; k++) {
      const a = angle + (k / (branches - 1 || 1) - 0.5) * 2 * spread + (rnd() - 0.5) * spread * 0.8;
      grow(x2, y2, a, len * (0.62 + rnd() * 0.16), w * taper, level + 1);
    }
  };
  grow(0.5, 0.0, 0, 0.3 + rnd() * 0.08, 0.055, 0);
  return segs;
}

/** 把迭代拓扑栅格化为投影遮罩（即远景退化形态），附带 AO/叶簇通道 */
export function buildTreeVariants(count = TREE_VARIANTS): TreeVariant[] {
  const out: TreeVariant[] = [];
  for (let v = 0; v < count; v++) {
    const canvas = document.createElement("canvas");
    canvas.width = TREE_TEX_SIZE;
    canvas.height = TREE_TEX_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, TREE_TEX_SIZE, TREE_TEX_SIZE);
    const spread = 0.36 + v * 0.08;
    const segs = iterateBranches(0x9e3779b9 + v * 7919, 5, spread, 0.62);
    const S = TREE_TEX_SIZE;
    ctx.lineCap = "round";
    // 通道 1（R）：枝干邻近度 → 内腔 AO（软发光下划层）
    ctx.strokeStyle = "rgba(255,0,0,0.42)";
    ctx.shadowColor = "rgba(255,0,0,0.85)";
    ctx.shadowBlur = S * 0.07;
    for (const sgm of segs) {
      ctx.lineWidth = Math.max(2, sgm.w * S * 1.7);
      ctx.beginPath();
      ctx.moveTo(sgm.x1 * S, S - 2 - sgm.y1 * (S - 4));
      ctx.lineTo(sgm.x2 * S, S - 2 - sgm.y2 * (S - 4));
      ctx.stroke();
    }
    // 通道 2（G）：外冠叶簇（顶端分支处的椭圆簇 → 受光/透光标记）
    ctx.shadowColor = "rgba(0,255,0,0.7)";
    ctx.shadowBlur = S * 0.03;
    ctx.fillStyle = "rgba(0,255,0,0.8)";
    const rnd = mulberry32(0x51ed270b + v * 104729);
    for (const sgm of segs) {
      if (!sgm.tip) continue;
      const cx = sgm.x2 * S;
      const cy = S - 2 - sgm.y2 * (S - 4);
      const clumps = 2 + Math.floor(rnd() * 3);
      for (let c = 0; c < clumps; c++) {
        const rx = (3 + rnd() * 8) * (S / 256);
        const ry = (2.4 + rnd() * 6) * (S / 256);
        ctx.beginPath();
        ctx.ellipse(cx + (rnd() - 0.5) * rx * 2.4, cy + (rnd() - 0.5) * ry * 2.0, rx, ry, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 通道 3（全通道）：枝干本体（主干亮线，供 alpha 覆盖与枝干颜色定位）
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    for (const sgm of segs) {
      ctx.lineWidth = Math.max(1.2, sgm.w * S * 1.35);
      ctx.beginPath();
      ctx.moveTo(sgm.x1 * S, S - 2 - sgm.y1 * (S - 4));
      ctx.lineTo(sgm.x2 * S, S - 2 - sgm.y2 * (S - 4));
      ctx.stroke();
    }
    out.push({ canvas, depth: 5, spread, taper: 0.62 });
  }
  return out;
}

/** 草丛遮罩图集：若干弯曲叶片（仅 alpha 语义，颜色由着色器程序给出） */
export function buildGrassVariants(count = GRASS_VARIANTS): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let v = 0; v < count; v++) {
    const canvas = document.createElement("canvas");
    canvas.width = GRASS_TEX_SIZE;
    canvas.height = GRASS_TEX_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, GRASS_TEX_SIZE, GRASS_TEX_SIZE);
    const rnd = mulberry32(0xc0ffee11 + v * 65537);
    const blades = 15 + v * 4;
    ctx.lineCap = "round";
    for (let b = 0; b < blades; b++) {
      const bx = 14 + rnd() * (GRASS_TEX_SIZE - 28);
      const lean = (rnd() - 0.5) * (26 + v * 14);
      const topY = 8 + rnd() * 40;
      const w = 2.2 + rnd() * 2.6;
      // 三段递减宽度描边近似锥形叶片
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      const segsY = [GRASS_TEX_SIZE - 2, GRASS_TEX_SIZE * 0.66, GRASS_TEX_SIZE * 0.4, topY];
      for (let s = 0; s < 3; s++) {
        const y0 = segsY[s];
        const y1 = segsY[s + 1];
        const t0 = (GRASS_TEX_SIZE - y0) / GRASS_TEX_SIZE;
        const t1 = (GRASS_TEX_SIZE - y1) / GRASS_TEX_SIZE;
        const x0 = bx + lean * t0 * t0;
        const x1 = bx + lean * t1 * t1;
        ctx.lineWidth = Math.max(1.1, w * (1 - s * 0.3));
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo((x0 + x1) / 2 + (rnd() - 0.5) * 3, (y0 + y1) / 2, x1, y1);
        ctx.stroke();
      }
    }
    out.push(canvas);
  }
  return out;
}

/* ---------------- 适宜性 + 实例规划 ---------------- */

export interface TreeInstance {
  x: number;
  z: number;
  y: number;
  /** 树高（米） */
  heightM: number;
  rot: number;
  phase: number;
  /** 色相偏移（针叶→阔叶 0..1） */
  leafMix: number;
  variant: number;
  dist: number;
}

export interface VegPlan {
  instances: Float32Array;
  count: number;
}

const VEG_CELL_M = 110; // 候选格（米）
const VEG_RADIUS_M = 9000; // 增殖半径（观察距离阈值）
const GRASS_CELL_M = 16;
const GRASS_RADIUS_M = 750;
export const MAX_GRASS = 9000;

function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** 湿度代理：谷地汇聚（相对海拔低）+ 中尺度噪声 */
function moisture(table: TerrainTable, x: number, z: number, hSelf: number): number {
  const r = 2200;
  let sum = 0;
  let cnt = 0;
  for (let a = 0; a < 6; a++) {
    const ang = (a / 6) * Math.PI * 2;
    sum += heightAt(table, x + Math.cos(ang) * r, z + Math.sin(ang) * r);
    cnt++;
  }
  const rel = sum / cnt - hSelf; // 比周围低 → 汇水
  const noise = hash2(Math.floor(x / 700), Math.floor(z / 700)) * 0.35;
  return Math.min(1, Math.max(0, 0.45 + rel / 380 + noise));
}

/**
 * 观察者移动后重建可见实例集：
 * 逐候选格做适宜性判定（海拔/坡度/水体/湿度），通过者按迭代规则产出个体。
 * detailAmp>0 时树基落在含近景浮雕的地表（与地形网格/拾取严格同式）。
 */
export function planVegetation(
  table: TerrainTable,
  focusX: number,
  focusZ: number,
  exagg: number,
  density: number,
  snowLineM: number,
  detailAmp = 0,
  maxInstances = 3200,
): VegPlan {
  const out: TreeInstance[] = [];
  if (density <= 0.01) return { instances: new Float32Array(0), count: 0 };
  const cell = VEG_CELL_M;
  const cx0 = Math.floor((focusX - VEG_RADIUS_M) / cell);
  const cx1 = Math.ceil((focusX + VEG_RADIUS_M) / cell);
  const cz0 = Math.floor((focusZ - VEG_RADIUS_M) / cell);
  const cz1 = Math.ceil((focusZ + VEG_RADIUS_M) / cell);
  const keep = density * 0.5;
  const r2max = VEG_RADIUS_M * VEG_RADIUS_M;

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const hx = hash2(cx, cz);
      if (hx > keep) continue; // 候选格稀疏化（密度旋钮）
      const jx = (hash2(cx * 3 + 1, cz) - 0.5) * cell;
      const jz = (hash2(cx, cz * 3 + 2) - 0.5) * cell;
      const x = cx * cell + jx;
      const z = cz * cell + jz;
      const dx = x - focusX;
      const dz = z - focusZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2max) continue;
      if (waterAt(table, x, z) !== 0) continue; // 水体不长树
      const hSelf = heightAt(table, x, z);
      if (hSelf < 4 || hSelf > snowLineM - 260) continue; // 岸线外 / 林线下
      // 坡度判定（陡坡不生长）
      const e = 60;
      const gx = ((heightAt(table, x + e, z) - heightAt(table, x - e, z)) / (2 * e)) * exagg;
      const gz = ((heightAt(table, x, z + e) - heightAt(table, x, z - e)) / (2 * e)) * exagg;
      const slope = Math.atan(Math.hypot(gx, gz));
      if (slope > 0.52) continue; // ≈30°
      const moist = moisture(table, x, z, hSelf);
      if (moist < 0.3) continue;
      const dist = Math.sqrt(d2);
      // 形态随环境连续变化：高海拔 → 矮而尖（针叶），湿润 → 高而宽（阔叶）
      const elevT = Math.min(1, Math.max(0, (hSelf - 300) / (snowLineM - 560)));
      const heightM = 7 + (1 - elevT) * 9 + moist * 7 + hash2(cx * 7, cz * 5) * 4;
      out.push({
        x,
        z,
        y: (hSelf + detailRelief(x, z, hSelf, detailAmp)) * exagg,
        heightM,
        rot: hash2(cx * 11, cz * 13) * Math.PI * 2,
        phase: hash2(cx * 17, cz * 19) * Math.PI * 2,
        leafMix: moist * 0.7 + elevT * 0.3,
        variant: Math.floor(hash2(cx * 23, cz * 29) * TREE_VARIANTS),
        dist,
      });
    }
  }
  // 近处优先
  out.sort((a, b) => a.dist - b.dist);
  if (out.length > maxInstances) out.length = maxInstances;
  // 实例缓冲布局：x z y heightM rot phase leafMix variant(→float)
  const buf = new Float32Array(out.length * 8);
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    buf[i * 8] = t.x;
    buf[i * 8 + 1] = t.z;
    buf[i * 8 + 2] = t.y;
    buf[i * 8 + 3] = t.heightM;
    buf[i * 8 + 4] = t.rot;
    buf[i * 8 + 5] = t.phase;
    buf[i * 8 + 6] = t.leafMix;
    buf[i * 8 + 7] = t.variant;
  }
  return { instances: buf, count: out.length };
}

export interface GrassPlan {
  instances: Float32Array;
  count: number;
}

/**
 * 近景草丛增殖：草甸带（林线以下、非水体、缓坡）以 16m 候选格密集撒布，
 * 观察半径 750m（与草丛可见尺度匹配）。数量大 → 宜保持廉价判定。
 */
export function planGrass(
  table: TerrainTable,
  focusX: number,
  focusZ: number,
  exagg: number,
  density: number,
  snowLineM: number,
  detailAmp = 0,
  maxInstances = MAX_GRASS,
): GrassPlan {
  if (density <= 0.01) return { instances: new Float32Array(0), count: 0 };
  const out: number[] = []; // 交错暂存，末尾打包
  const cell = GRASS_CELL_M;
  const cx0 = Math.floor((focusX - GRASS_RADIUS_M) / cell);
  const cx1 = Math.ceil((focusX + GRASS_RADIUS_M) / cell);
  const cz0 = Math.floor((focusZ - GRASS_RADIUS_M) / cell);
  const cz1 = Math.ceil((focusZ + GRASS_RADIUS_M) / cell);
  const keep = density * 0.85;
  const r2max = GRASS_RADIUS_M * GRASS_RADIUS_M;

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const hx = hash2(cx * 5 + 3, cz * 7 + 1);
      if (hx > keep) continue;
      const jx = (hash2(cx * 9 + 2, cz) - 0.5) * cell;
      const jz = (hash2(cx, cz * 11 + 4) - 0.5) * cell;
      const x = cx * cell + jx;
      const z = cz * cell + jz;
      const dx = x - focusX;
      const dz = z - focusZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2max) continue;
      if (waterAt(table, x, z) !== 0) continue;
      const hSelf = heightAt(table, x, z);
      if (hSelf < 2.5 || hSelf > snowLineM - 180) continue; // 草甸带（雪线下 180m）
      const e = 30;
      const gx = ((heightAt(table, x + e, z) - heightAt(table, x - e, z)) / (2 * e)) * exagg;
      const gz = ((heightAt(table, x, z + e) - heightAt(table, x, z - e)) / (2 * e)) * exagg;
      if (Math.atan(Math.hypot(gx, gz)) > 0.55) continue;
      const dist2 = Math.sqrt(d2);
      const heightM = 0.32 + hash2(cx * 13 + 7, cz * 3) * 0.45;
      out.push(
        x,
        z,
        (hSelf + detailRelief(x, z, hSelf, detailAmp)) * exagg,
        heightM,
        hash2(cx * 17 + 5, cz * 19) * Math.PI * 2,
        hash2(cx * 23, cz * 29 + 9) * Math.PI * 2,
        0.3 + hash2(cx * 31, cz * 37 + 2) * 0.7, // 干→润色调
        Math.floor(hash2(cx * 41, cz * 43) * GRASS_VARIANTS),
        dist2,
      );
    }
  }
  type Row = number[];
  const rows: Row[] = [];
  for (let i = 0; i < out.length; i += 9) rows.push(out.slice(i, i + 8));
  rows.sort((a, b) => (a[0] - focusX) ** 2 + (a[1] - focusZ) ** 2 - ((b[0] - focusX) ** 2 + (b[1] - focusZ) ** 2));
  const n = Math.min(rows.length, maxInstances);
  const buf = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) buf.set(rows[i], i * 8);
  return { instances: buf, count: n };
}
