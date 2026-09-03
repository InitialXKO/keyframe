/**
 * 数值表格（DEM Table）—— 本系统唯一的外部数据。
 *
 * 输入是两张按行列排列的数字表格（.ktdem 单文件）：
 *   区域表 bc-coast.ktdem（450m 高分辨率）:
 *     [u32 magic][u32 w][u32 h][u32 flags] + w*h 个 i16 海拔(米) + w*h 个 u8 水体掩膜(0陆/1海/2内陆水)
 *   全球表 earth.ktdem（等距圆柱全球拼接，row 0 = +90°纬线）:
 *     [u32 magic 'KFG1'][u32 w][u32 h][u32 resDeg_x1000] + w*h 个 i16 海拔(米)
 * 表格之外没有颜色、形状或视觉素材；一切景象由表格数值 + 数学规则推导。
 *
 * 数据来源：kylecorry31/Trail-Sense-Earth-Model dem-0.4.0-high（15″≈450m 全球高程）
 * 区域提取：N60W135 瓦片 x[1825..2849] y[1559..2583] —— 加拿大 BC 海岸山脉
 * 全球拼接：全部 15°×15° 瓦片 30×30 块均值降采样 → 0.125° 全球格网
 */

import { type GlobeGrid } from "./planet";

export interface TerrainMeta {
  source: string;
  grid: { width: number; height: number; dxEastM: number; dzNorthM: number };
  centerLatLon: [number, number];
  bounds: { latN: number; latS: number; lonW: number; lonE: number };
  heightMinM: number;
  heightMaxM: number;
  region: string;
  /** 全球拼接表格信息 */
  earth?: { file: string; w: number; h: number; resDeg: number; tiles: number; source: string };
}

export interface TerrainTable {
  meta: TerrainMeta;
  w: number;
  h: number;
  /** 海拔(米)，行主序，row 0 = 北缘 */
  heights: Float32Array;
  /** 0=陆地 1=海洋 2=内陆水 */
  water: Uint8Array;
  /** 全球拼接网格（升空渲染用） */
  globe: GlobeGrid;
  dxEast: number;
  dzNorth: number;
  /** 区域世界坐标跨度（米），原点在网格中心 */
  spanX: number;
  spanZ: number;
  minH: number;
  maxH: number;
  /** 流式数据版本（重锚定/细化完成时递增；块缓存与植被据此失效） */
  version: number;
  /**
   * 几何帧纪元：窗口原点/步长变更（重锚定）时递增。旧纪元网格顶点坐标系已作废，
   * 不可续绘（必须重建）；而仅数据内容变化（细化/version）时旧网格可续绘自愈。
   */
  frameEpoch: number;
}

const MAGIC = 0x4b465431; // "KFT1"
const MAGIC_GLOBE = 0x4b464731; // "KFG1"

export async function loadTerrainTable(
  onProgress?: (frac: number) => void,
): Promise<TerrainTable> {
  const metaRes = await fetch("/terrain/meta.json");
  if (!metaRes.ok) throw new Error("meta.json 加载失败");
  const meta = (await metaRes.json()) as TerrainMeta;
  if (!meta.earth) throw new Error("meta.json 缺少全球表格信息（earth 字段）");

  // 区域表（高分辨率）→ 进度 0..0.22
  const res = await fetch("/terrain/bc-coast.ktdem");
  if (!res.ok) throw new Error("高程数值表格加载失败");
  const total = Number(res.headers.get("content-length") ?? 0);
  const buf = await readWithProgress(res, (frac) => onProgress?.(frac * 0.22), total);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("数值表格格式不符（magic 校验失败）");
  const w = dv.getUint32(4, true);
  const h = dv.getUint32(8, true);
  const n = w * h;
  const heights = new Float32Array(new Int16Array(buf, 16, n)); // 拷贝为 f32
  const water = new Uint8Array(buf, 16 + n * 2, n);

  // 全球表（全球拼接）→ 进度 0.22..1
  const gRes = await fetch(`/terrain/${meta.earth.file}`);
  if (!gRes.ok) throw new Error("全球高程表格加载失败");
  const gTotal = Number(gRes.headers.get("content-length") ?? 0);
  const gBuf = await readWithProgress(
    gRes,
    (frac) => onProgress?.(0.22 + frac * 0.78),
    gTotal,
  );
  const gdv = new DataView(gBuf);
  if (gdv.getUint32(0, true) !== MAGIC_GLOBE) throw new Error("全球表格格式不符（magic 校验失败）");
  const gw = gdv.getUint32(4, true);
  const gh = gdv.getUint32(8, true);
  const gResDeg = gdv.getUint32(12, true) / 1000;
  const gn = gw * gh;
  const gHeights = new Float32Array(new Int16Array(gBuf, 16, gn));
  let gMin = Infinity;
  let gMax = -Infinity;
  for (let i = 0; i < gn; i++) {
    const v = gHeights[i];
    if (v < gMin) gMin = v;
    if (v > gMax) gMax = v;
  }
  const globe: GlobeGrid = {
    w: gw,
    h: gh,
    resDeg: gResDeg,
    heights: gHeights,
    minH: gMin,
    maxH: gMax,
  };

  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = heights[i];
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }

  const t: TerrainTable = {
    meta,
    w,
    h,
    heights,
    water,
    globe,
    dxEast: meta.grid.dxEastM,
    dzNorth: meta.grid.dzNorthM,
    spanX: (w - 1) * meta.grid.dxEastM,
    spanZ: (h - 1) * meta.grid.dzNorthM,
    minH,
    maxH,
    version: 0,
    frameEpoch: 0,
  };
  return t;
}

async function readWithProgress(
  res: Response,
  onProgress: (frac: number) => void,
  total: number,
): Promise<ArrayBuffer> {
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/* ---------------- 近景浮雕场（与 GPU 着色器严格同式的确定性噪声） ---------------- */

function hash12f(px: number, py: number): number {
  let p3x = fract(px * 0.1031);
  let p3y = fract(py * 0.1031);
  let p3z = fract(px * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d;
  p3y += d;
  p3z += d;
  return fract((p3x + p3y) * p3z);
}
function fract(v: number): number {
  return v - Math.floor(v);
}
function vnoiseF(px: number, py: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (
    (hash12f(ix, iy) * (1 - ux) + hash12f(ix + 1, iy) * ux) * (1 - uy) +
    (hash12f(ix, iy + 1) * (1 - ux) + hash12f(ix + 1, iy + 1) * ux) * uy
  );
}
function fbmF(px: number, py: number): number {
  let a = 0.5;
  let s = 0;
  let x = px;
  let y = py;
  for (let k = 0; k < 4; k++) {
    s += a * vnoiseF(x, y);
    x = x * 2.03 + 37.1;
    y = y * 2.03 + 17.7;
    a *= 0.5;
  }
  return s;
}

/**
 * 浮雕作用域（窗口锚点系）：以表格原点（= 流式窗口中心）为圆心的纯位置场 ——
 * 60km 内全量、60–160km 平滑渐隐。关键性质：**与相机位置无关**。
 * 相机焦点每帧移动，若浮雕遮罩跟随焦点，则 CPU 烘焙的网格缓存（键不含焦点）会与
 * 新建网格的浮雕场错位 → 相邻地块边界出现高差接缝；树/草基点与拾取同理错位。
 * 改为锚点系后浮雕是纯位置函数：任意时刻、任意 LOD、任意消费方在同一世界坐标
 * 得到同一浮雕值 → 跨级/跨帧/跨消费方严格无缝。重锚定时表格重建 + 版本递增，
 * 全部缓存按新原点重建，场永远自洽。
 */
export function reliefZone(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const t = Math.min(1, Math.max(0, (r - 60000) / 100000));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * 近景浮雕（几何位移带）：波长约 715m 的起伏 ±22m，窗口锚点系 60–160km 渐隐，
 * 低海拔（岸线/海床）渐隐。所有消费方（地形网格、树/草基点、射线拾取）
 * 必须调用同一函数保证表面一致 —— 与 GLSL/WGSL DETAIL 块逐式对应。
 */
export function detailRelief(x: number, z: number, hSelf: number, amp: number): number {
  if (amp <= 0) return 0;
  const mask = reliefZone(x, z) * Math.min(1, Math.max(0, (hSelf - 2) / 12));
  if (mask <= 0) return 0;
  const n = fbmF(x * 0.0014 + 53.1, z * 0.0014 + 91.7);
  return (n - 0.5) * 44 * mask * amp;
}

/** 网格坐标（可含小数）双线性海拔（米）—— 负 LOD 级细分网格用 */
export function gridHeightAt(t: TerrainTable, fx: number, fz: number): number {
  const cx = Math.min(t.w - 1, Math.max(0, fx));
  const cz = Math.min(t.h - 1, Math.max(0, fz));
  const i = Math.min(t.w - 2, Math.floor(cx));
  const j = Math.min(t.h - 2, Math.floor(cz));
  const u = cx - i;
  const v = cz - j;
  const r = t.w;
  const h00 = t.heights[j * r + i];
  const h10 = t.heights[j * r + i + 1];
  const h01 = t.heights[(j + 1) * r + i];
  const h11 = t.heights[(j + 1) * r + i + 1];
  return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
}

/* ---------------- 采样数学（一切几何的来源） ---------------- */

/** 双线性海拔（米），世界坐标（原点=网格中心，x 东 z 南），clamp 到表格范围 */
export function heightAt(t: TerrainTable, x: number, z: number): number {
  const fx = x / t.dxEast + (t.w - 1) / 2;
  const fz = z / t.dzNorth + (t.h - 1) / 2;
  const i = Math.min(t.w - 2, Math.max(0, Math.floor(fx)));
  const j = Math.min(t.h - 2, Math.max(0, Math.floor(fz)));
  const u = Math.min(1, Math.max(0, fx - i));
  const v = Math.min(1, Math.max(0, fz - j));
  const r = t.w;
  const h00 = t.heights[j * r + i];
  const h10 = t.heights[j * r + i + 1];
  const h01 = t.heights[(j + 1) * r + i];
  const h11 = t.heights[(j + 1) * r + i + 1];
  return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
}

/** 水体类别（最近邻，0/1/2） */
export function waterAt(t: TerrainTable, x: number, z: number): number {
  const i = Math.min(t.w - 1, Math.max(0, Math.round(x / t.dxEast + (t.w - 1) / 2)));
  const j = Math.min(t.h - 1, Math.max(0, Math.round(z / t.dzNorth + (t.h - 1) / 2)));
  return t.water[j * t.w + i];
}

/** 坡度（度）与坡向（方位角，北=0 顺时针），基于中央差分 */
export function slopeAspectAt(
  t: TerrainTable,
  x: number,
  z: number,
  exagg: number,
): { slopeDeg: number; aspectDeg: number } {
  const e = 1;
  const hx1 = heightAt(t, x - e, z);
  const hx2 = heightAt(t, x + e, z);
  const hz1 = heightAt(t, x, z - e);
  const hz2 = heightAt(t, x, z + e);
  const gx = ((hx2 - hx1) / (2 * e)) * exagg; // 米/米
  const gz = ((hz2 - hz1) / (2 * e)) * exagg;
  const slopeRad = Math.atan(Math.hypot(gx, gz));
  // 坡向 = 下坡方向方位角（北=0，东=90）
  let aspect = (Math.atan2(-gx, -gz) * 180) / Math.PI;
  if (aspect < 0) aspect += 360;
  return { slopeDeg: (slopeRad * 180) / Math.PI, aspectDeg: aspect };
}

/** f32 → f16 bits（供 R16F 纹理上传） */
export function f32ToF16Bits(val: number): number {
  f32buf[0] = val;
  const x = u32buf[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let man = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00;
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    man = (man | 0x800000) >>> (1 - e);
    return sign | (man >>> 13);
  }
  return sign | (e << 10) | (man >>> 13);
}
const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
