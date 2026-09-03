/**
 * 全球地形流式引擎 —— 全地形数据无缝拼接的运行时
 *
 * 数据模型：三层金字塔 + 全球底座
 *   L0  earth.ktdem          0.125°（≈14km/px）全球等距圆柱格网（内存常驻）
 *   L1  pyramid/l1/*.ktdt    60″（≈1.8km/px）432² 瓦片，按需
 *   L2  pyramid/l2/*.ktdt    30″（≈900m/px）432² 瓦片，按需
 *   L3  pyramid/l3/*.ktdt    15″（≈450m/px）432² 瓦片，按需
 *   +  bc-coast.ktdem        15″ 1024² 引导种子（首锚点瞬时全分辨率）
 *
 * 运行时：以相机焦点为锚点维持一块 W×W（1536²）「高程窗口镜像」——引擎全部消费方
 * （分块调度/植被/拾取/相机/贴地）以窗口表格为唯一数据源，与静态区域表完全同接口；
 * 窗口外由全球球体渲染。
 *
 *  · 海拔自适应多分辨率（GeoClipmap 式层级缩放）：窗口格网步长随观测海拔动态选择 ——
 *      低空   L3 窗口  15″（463m/px，幅面 ≈712km）
 *      中空   L2 窗口  30″（926m/px，幅面 ≈1424km）
 *      高空/轨道 L1 窗口 60″（1852m/px，幅面 ≈2848km）
 *    升空后视野远超固定幅面 → 窗口自动换用粗层格网，可视区域内始终以「该海拔下
 *    可用最高分辨率」流式铺满，而非退化为 0.125°（14km/px）全球球体兜底。
 *  · 锚点移动：焦点偏离窗口中心超过 30% 幅面 → 重锚定（格点吸附 → L0 瞬时
 *    预填充 → BC 种子 → 瓦片按距离优先级流入细化）——任意地点连续细化。
 *  · 一致性：镜像数组是唯一真源，GPU 纹理经 uploadRects 从镜像增量上传，
 *    CPU（拾取/植被/建网格）与 GPU（VS 位移/阴影）采样逐位一致。
 *  · 确定性：瓦片为确定脚本的产物；填充顺序 = 精度优先级（L0 < L1 < L2 < L3/种子），
 *    高精度数据到达后覆盖低精度，渲染结果与到达顺序无关。
 */

import {
  anchorFrame,
  globeHeightAt,
  LATTICE_DEG,
  matVec,
  wrap180,
  type AnchorFrame,
  type GlobeGrid,
} from "./planet";
import type { TerrainTable } from "./table";

export const WINDOW_W = 1536;
/** 重锚定阈值：焦点距窗口中心超过幅面的 30% */
const REANCHOR_MARGIN = 0.3;
/**
 * 窗口层级海拔阈值（米，高于弯曲地表的眼位海拔，非对称滞回见 setEyeAlt）：
 * 低空 <12km 用 L3 窗口（15″，步行/低空观测距离最高优先）→ 中空 L2（30″）
 * → 高空/轨道 L1（60″）。层级切换另需目标层级持续 ≥500ms + 距上次切换 ≥1.2s。
 */
/** 层级切换滞回：目标层级需持续存在 ≥500ms（时间基准，帧率无关） */
const LVL_HYST_MS = 500;
/** 两次层级切换最小间隔（ms） */
const LVL_SWITCH_GAP_MS = 1200;
/** 同级瓦片 LRU 容量 */
const CACHE_CAP: Record<number, number> = { 1: 400, 2: 220, 3: 110 };
/**
 * 精度边界羽化带宽（米）：流入数据（种子/瓦片）与镜像中旧低精度数据的边界若直接
 * 硬覆盖，会在 rugged 地形上形成数百米高的 1 格悬崖（用户报告的「地块不无缝拼接」）。
 * 在覆盖区边缘带内对新旧值线性-平滑过渡，把悬崖摊开为物理宽度恒定的缓坡；
 * 羽化带格子以降级优先级写入，更高精度瓦片到达后仍可覆写自愈。
 */
const FEATHER_M = 12000;
/** 取并发 / 每帧应用上限 */
const FETCH_CONCURRENCY = 8;
const APPLY_PER_UPDATE = 8;

interface TileData {
  h: Int16Array;
  w: number;
  hgt: number;
  water: Uint8Array;
}

interface ManifestLevel {
  cols: number;
  rows: number;
  runs: Array<[number, number]>;
}

interface PyramidManifest {
  v: number;
  tile: number;
  dDeg: number;
  levels: Record<string, ManifestLevel>;
}

export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 地标命名表（HUD 锚点标注用；纯展示，不参与渲染） */
const LANDMARKS: Array<{ name: string; lat: number; lon: number }> = [
  { name: "BC 海岸山脉 · Waddington 冰原", lat: 51.37, lon: -125.26 },
  { name: "珠穆朗玛峰 · 喜马拉雅", lat: 27.988, lon: 86.925 },
  { name: "阿尔卑斯 · 勃朗峰", lat: 45.83, lon: 6.865 },
  { name: "马特洪峰 · 瓦莱", lat: 45.976, lon: 7.658 },
  { name: "多洛米蒂 · 南蒂罗尔", lat: 46.43, lon: 11.85 },
  { name: "迪纳利 · 阿拉斯加", lat: 63.07, lon: -151.007 },
  { name: "巴塔哥尼亚 · 托雷斯三塔", lat: -50.94, lon: -73.0 },
  { name: "南阿尔卑斯 · 库克山", lat: -43.59, lon: 170.14 },
  { name: "乞力马扎罗", lat: -3.066, lon: 37.356 },
  { name: "富士山", lat: 35.36, lon: 138.73 },
  { name: "厄尔布鲁士 · 高加索", lat: 43.35, lon: 42.44 },
  { name: "科罗拉多大峡谷", lat: 36.06, lon: -112.14 },
  { name: "勃朗峰疾速铁路沿线", lat: 45.55, lon: 6.9 },
  { name: "格林兰冰盖西缘", lat: 69.2, lon: -50.0 },
  { name: "安第斯 · 阿空加瓜", lat: -32.65, lon: -70.01 },
  { name: "喀喇昆仑 · K2", lat: 35.881, lon: 76.513 },
  { name: "青藏高原 · 拉萨谷地", lat: 29.65, lon: 91.1 },
  { name: "新西兰峡湾 · 米尔福德", lat: -44.67, lon: 167.93 },
  { name: "夏威夷 · 冒纳凯亚", lat: 19.82, lon: -155.47 },
  { name: "冰岛 · 瓦特纳冰川", lat: 64.4, lon: -16.8 },
];

function landmarkName(lat: number, lon: number): string {
  let best: string | null = null;
  let bestD = Infinity;
  for (const lm of LANDMARKS) {
    const d = Math.hypot((lm.lat - lat) * 111, wrap180(lm.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180));
    if (d < bestD) {
      bestD = d;
      best = lm.name;
    }
  }
  if (best && bestD < 350) return best;
  const ns = lat >= 0 ? "北纬" : "南纬";
  const ew = lon >= 0 ? "东经" : "西经";
  return `${ns}${Math.abs(lat).toFixed(1)}° ${ew}${Math.abs(lon).toFixed(1)}° 流式窗口`;
}

export class TerrainStream {
  readonly table: TerrainTable;
  frame!: AnchorFrame;
  version = 1;
  /** 窗口 L3 就绪度（核心 4×4 瓦片） */
  l3Ready = 0;
  l3Total = 16;
  /** 当前窗口层级：3=L3 窗口（15″）· 2=L2 窗口（30″）· 1=L1 窗口（60″） */
  winLvl = 3;
  /** 窗口格网步长（15″ 单位）：1/2/4 —— 与 winLvl 严格对应 */
  private winStep = 1;
  private lvlCandidate = 0;
  private lvlCandidateAt = 0;
  private lastLvlSwitch = 0;
  private lvlSwitchReq: [number, number, number] | null = null;
  private refined = false;
  private refinePending = false;
  private l0: GlobeGrid;
  /** BC 引导种子（原始 1024² 表） */
  private bc: { h: Float32Array; w: Uint8Array; w2: number; h2: number; c0: number; r0: number } | null = null;
  private prio: Uint8Array = new Uint8Array(0);
  private manifest: PyramidManifest | null = null;
  private manifestRetryAt = 0;
  private tileSets: Record<number, Set<number>> = {};
  private cache = new Map<string, TileData>();
  private cacheOrder: string[] = [];
  private inflight = new Set<string>();
  private queue: Array<{ key: string; lvl: number; tx: number; ty: number; d2: number }> = [];
  private pending: Array<{ key: string; td: TileData | null }> = [];
  private dirty: DirtyRect[] = [];
  private knownOcean = new Set<string>();

  constructor(table: TerrainTable) {
    this.table = table;
    this.l0 = table.globe;
    // BC 种子：格点索引（15″ 格网与 bc 网格同源）
    const b = table.meta.bounds;
    const c0 = Math.round((b.lonW + 180) / LATTICE_DEG);
    const r0 = Math.round((90 - b.latN) / LATTICE_DEG);
    this.bc = {
      h: table.heights.slice(),
      w: table.water.slice(),
      w2: table.w,
      h2: table.h,
      c0,
      r0,
    };
    void this.loadManifest();
    this.reanchor(table.meta.centerLatLon[0], table.meta.centerLatLon[1]);
  }

  private async loadManifest(): Promise<void> {
    try {
      const res = await fetch("/terrain/pyramid/manifest.json");
      if (!res.ok) throw new Error(String(res.status));
      const m = (await res.json()) as PyramidManifest;
      this.manifest = m;
      for (const k of Object.keys(m.levels)) {
        const lvl = Number(k);
        const set = new Set<number>();
        for (const [a, b2] of m.levels[k].runs) {
          for (let v = a; v <= b2; v++) set.add(v);
        }
        this.tileSets[lvl] = set;
      }
      this.enqueueWindow();
      console.info(
        `[terrain-stream] 金字塔清单就绪 L3:${this.tileSets[3]?.size ?? 0} L2:${this.tileSets[2]?.size ?? 0} L1:${this.tileSets[1]?.size ?? 0}`,
      );
    } catch {
      // 网络未就绪（服务器重启/离线打开）→ 周期重试，成功后自动开始流入
      this.manifestRetryAt = performance.now() + 3000;
    }
  }

  /* ---------------- 锚点与坐标 ---------------- */

  /** 局部平面坐标（米）→ 经纬度（度） */
  localToLatLon(fx: number, fz: number): [number, number] {
    const t = this.table;
    const b = t.meta.bounds;
    const lon = b.lonW + (fx / t.spanX + 0.5) * (b.lonE - b.lonW);
    const lat = b.latN + (fz / t.spanZ + 0.5) * (b.latS - b.latN);
    return [lat, lon];
  }

  /** 焦点是否需要重锚定（偏离窗口中心 > 30% 幅面） */
  needsReanchor(fx: number, fz: number): boolean {
    const t = this.table;
    return (
      Math.abs(fx) > (t.spanX / 2) * REANCHOR_MARGIN ||
      Math.abs(fz) > (t.spanZ / 2) * REANCHOR_MARGIN
    );
  }

  /**
   * 每帧喂入眼位海拔（高于弯曲地表）→ 层级窗口状态机。
   * 目标层级连续 LVL_HYST_FRAMES 帧一致且距上次切换 > LVL_HYST_MS → 发起层级切换
   * 请求（窗口中心不动，pollLevelSwitch 取走后由宿主触发无缝 reanchor）。
   */
  setEyeAlt(alt: number): void {
    // 非对称滞回（防贴阈值抖动）：升空切粗层阈值高、降落回细层阈值低
    let target = this.winLvl;
    if (this.winLvl === 3) {
      if (alt >= 12000) target = 2;
    } else if (this.winLvl === 2) {
      if (alt >= 90000) target = 1;
      else if (alt < 9000) target = 3;
    } else if (alt < 70000) {
      target = 2;
    }
    if (target === this.winLvl) {
      this.lvlCandidate = 0;
      return;
    }
    if (target !== this.lvlCandidate) {
      this.lvlCandidate = target;
      this.lvlCandidateAt = performance.now();
    }
    const now = performance.now();
    if (now - this.lvlCandidateAt >= LVL_HYST_MS && now - this.lastLvlSwitch >= LVL_SWITCH_GAP_MS) {
      this.lvlCandidate = 0;
      this.lastLvlSwitch = now;
      // 层级切换保持窗口中心不变 → 旧层镜像与新建镜像逐点对齐（无缝无闪烁）
      this.lvlSwitchReq = [this.frame.lat, this.frame.lon, target];
    }
  }

  /** 取走层级切换请求（[lat, lon, lvl] = 当前窗口中心 + 目标层级；null = 无请求） */
  pollLevelSwitch(): [number, number, number] | null {
    const r = this.lvlSwitchReq;
    this.lvlSwitchReq = null;
    return r;
  }

  /**
   * 重锚定：窗口原点吸附 15″ 全球格点 → 重建镜像（L0 预填充 → 旧层拷贝 → BC 种子）
   * → 排队新窗口瓦片。表格对象原地更新（渲染器/调度器持引用自动可见）。
   *
   * lvl 决定窗口格网步长（15″×2^(3-lvl)）：平移重锚定保持当前层级；
   * 层级切换由状态机发起（窗口中心不动 → 旧层镜像逐点对齐拷贝，消除清晰度闪降）。
   */
  reanchor(latDeg: number, lonDeg: number, lvl?: number): void {
    const t = this.table;
    const W = WINDOW_W;
    const d = LATTICE_DEG;
    const newLvl = Math.max(1, Math.min(3, lvl ?? this.winLvl));
    const step = 1 << (3 - newLvl);
    // 旧镜像引用（换层/同层连续拷贝用；首帧或尺寸异常时跳过）
    const oldH = t.heights;
    const oldW = t.water;
    const oldP = this.prio;
    const oldStep = this.winStep;
    const oldLatC = this.frame?.lat ?? NaN;
    const oldLonC = this.frame?.lon ?? NaN;
    const hadOld =
      oldH.length === W * W && oldW.length === W * W && oldP.length === W * W;
    // 窗口中心 = 焦点经纬度（层级切换时 = 旧窗口中心）；边缘吸附到全球 15″ 格点
    const latA = Math.max(-89.9, Math.min(89.9, latDeg));
    const lonA = wrap180(lonDeg);
    const r0 = Math.round((90 - latA) / d - ((W - 1) / 2) * step);
    const c0 = Math.round((lonA + 180) / d - ((W - 1) / 2) * step);
    const latN = 90 - r0 * d;
    const lonW = c0 * d - 180;
    const latC = latN - ((W - 1) / 2) * step * d;
    const lonC = lonW + ((W - 1) / 2) * step * d;
    const seamless = hadOld && latC === oldLatC && lonC === oldLonC;
    this.frame = anchorFrame(latC, lonC);
    this.winLvl = newLvl;
    this.winStep = step;
    const dxEast = this.frame.dxEast * step;
    const dzNorth = this.frame.dzNorth * step;

    t.w = W;
    t.h = W;
    t.dxEast = dxEast;
    t.dzNorth = dzNorth;
    t.spanX = (W - 1) * dxEast;
    t.spanZ = (W - 1) * dzNorth;
    t.meta.bounds = { latN, latS: latN - (W - 1) * step * d, lonW, lonE: lonW + (W - 1) * step * d };
    t.meta.centerLatLon = [latC, lonC];
    t.meta.grid = { width: W, height: W, dxEastM: dxEast, dzNorthM: dzNorth };
    t.meta.region = landmarkName(latC, lonC);
    t.meta.source = `kylecorry31/Trail-Sense-Earth-Model dem-0.4.0-high · L${newLvl} 窗口（${(t.spanX / 1000).toFixed(0)}km）金字塔 L0/L1/L2/L3 @ ${latC.toFixed(3)}°,${lonC.toFixed(3)}°`;

    // ---- L0 全球底座预填充（瞬时无空洞；经纬逐点采样，与窗口步长无关） ----
    const heights = new Float32Array(W * W);
    const water = new Uint8Array(W * W);
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = 0; j < W; j++) {
      const lat = latN - j * step * d;
      for (let i = 0; i < W; i++) {
        const h = globeHeightAt(this.l0, lat, lonW + i * step * d);
        heights[j * W + i] = h;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
        if (h <= 0) water[j * W + i] = 1;
      }
    }
    t.heights = heights;
    t.water = water;
    t.minH = Math.min(0, mn) - 300;
    t.maxH = mx * 1.35 + 300; // 块均值低估峰顶 → 预留视锥 AABB 余量
    this.prio = new Uint8Array(W * W);

    // ---- 旧层镜像连续拷贝（无缝重锚定/换层：全球 15″ 格点索引严格对齐） ----
    // 仅在窗口中心未变（层级切换）时执行 —— 平移重锚定伴随锚点旋转基变化，
    // 直接拷贝会引入横向错位，故只对无缝路径拷贝。prio=1（低于一切流入瓦片，
    // BC 区 3）→ 对应层级瓦片到达后逐块覆盖。消除换层瞬间的 L0 清晰度闪降。
    if (seamless) {
      // 旧表原点（15″ 全球格点）：旧窗口中心即新窗口中心，反推严格一致
      const oldR0 = Math.round((90 - oldLatC) / d - ((W - 1) / 2) * oldStep);
      const oldC0 = Math.round((oldLonC + 180) / d - ((W - 1) / 2) * oldStep);
      const sh = oldStep === 4 ? 2 : oldStep === 2 ? 1 : 0;
      const half = oldStep >> 1;
      for (let j = 0; j < W; j++) {
        // 新表行 j 的全球 15″ 行号 → 旧表行号（最近邻对齐，2 的幂 → 移位）
        const jo = (r0 + j * step - oldR0 + half) >> sh;
        if (jo < 0 || jo >= W) continue;
        const jk = jo * W;
        for (let i = 0; i < W; i++) {
          const io = (c0 + i * step - oldC0 + half) >> sh;
          if (io < 0 || io >= W) continue;
          const k = j * W + i;
          heights[k] = oldH[jk + io];
          water[k] = oldW[jk + io];
          this.prio[k] = oldP[jk + io] >= 3 ? 3 : 1;
        }
      }
    }

    // ---- BC 种子（若窗口与之相交；全球 15″ 格点对齐，步长随窗口层级） ----
    // 边缘羽化：种子与 L0 底座的边界若硬覆盖 → 450m 真值 vs 14km 块均值在
    // rugged 海岸山区相差数百米 → 巨型悬崖（用户报告的接缝主源之一）。
    // 在种子边缘 12km 带内对 L0 预填值平滑过渡；羽化带以 prio 2 写入，
    // 后续 L3 瓦片到达后可覆写自愈。
    if (this.bc) {
      const bc = this.bc;
      const offC = bc.c0 - c0; // bc 格点原点相对窗口原点的偏移（15″ 单位）
      const offR = bc.r0 - r0;
      const band15 = Math.max(4, Math.round(FEATHER_M / (d * 111320))); // ≈26 个 15″ 格（12km）
      const l0H = heights.slice(); // 羽化基准（L0 预填/旧层拷贝值）
      for (let j = 0; j < W; j++) {
        const sy = offR + j * step;
        if (sy < 0 || sy >= bc.h2) continue;
        const rowBase = sy * bc.w2;
        for (let i = 0; i < W; i++) {
          const sx = offC + i * step;
          if (sx < 0 || sx >= bc.w2) continue;
          const k = j * W + i;
          const bcH = bc.h[rowBase + sx];
          // 距种子数据边缘的最近距离（15″ 格单位）→ 羽化权重
          const dEdge = Math.min(sx, bc.w2 - 1 - sx, sy, bc.h2 - 1 - sy);
          let w = 1;
          if (dEdge < band15) {
            w = (dEdge + 0.5) / band15;
            w = w * w * (3 - 2 * w);
          }
          if (w >= 1) {
            heights[k] = bcH;
            water[k] = bc.w[rowBase + sx];
            this.prio[k] = 3;
          } else {
            heights[k] = l0H[k] * (1 - w) + bcH * w;
            if (w >= 0.5) water[k] = bc.w[rowBase + sx];
            this.prio[k] = 2; // 羽化带：允许更高精度瓦片覆写自愈
          }
        }
      }
    }

    this.version++;
    this.table.frameEpoch++; // 窗口原点/步长变更 → 旧网格坐标系作废（不可续绘）
    this.refined = false;
    this.refinePending = false;
    // 瓦片缓存/在途请求/海洋清单均为全球格网坐标（key = lvl_tx_ty），跨窗口复用；
    // 由各自 LRU 容量自然淘汰 —— 换层往返不重复下载。
    this.queue = [];
    this.pending = [];
    this.dirty = [{ x0: 0, y0: 0, x1: W, y1: W }];
    this.enqueueWindow();
  }

  /* ---------------- 瓦片调度 ---------------- */

  /**
   * 计算覆盖当前窗口的瓦片集合并入队（L1 → L2 → L3 优先级）。
   *
   * 镶嵌预算（GeoClipmap 环）：每层只排「以窗口中心为中心、半幅 = min(窗口半幅,
   * 该层满幅半幅)」的瓦片 —— L1 全窗、L2 中心半幅、L3 中心 1/4。任意窗口层级下
   * 每层 ≈ 4×4 瓦片，总量恒定；层级逐级细化（中心最精），与观感一致。
   */
  private enqueueWindow(): void {
    const m = this.manifest;
    if (!m) return;
    const b = this.table.meta.bounds;
    const d = LATTICE_DEG;
    const latC = (b.latN + b.latS) / 2;
    const lonC = (b.lonW + b.lonE) / 2;
    // 窗口半幅（纬向，度）与该层满幅半幅（度）
    const winHalf = (b.latN - b.latS) / 2;
    const fullHalf = ((WINDOW_W - 1) / 2) * d;
    this.queue = [];
    for (const lvl of [1, 2, 3]) {
      // 层级步长：L3=15″=Δ · L2=30″=2Δ · L1=60″=4Δ（全球瓦片格：L3 1.8°/块 200×100、
      // L2 3.6°/块 100×50、L1 7.2°/块 50×25）。指数必须为 3-lvl —— 此前写成 lvl-1
      // 导致 L3/L1 索引错位 → tileExists 恒 false → 永不发瓦片请求（L3流 镇 0%）。
      const stepDeg = d * Math.pow(2, 3 - lvl);
      const tile = m.tile;
      const grid = m.levels[String(lvl)];
      if (!grid) continue;
      // 瓦片跨度（度）：L3 432·15″=1.8° · L2 3.6° · L1 7.2° —— 瓦片索引必须除以跨度而非采样步长
      const spanDeg = stepDeg * tile;
      // 本层镶嵌目标半幅（度）：低层只覆盖窗口中心（与高层间由精度优先级自然分层）
      const half = Math.min(winHalf, fullHalf * Math.pow(2, 3 - lvl));
      // 经向瓦片范围按 1/cosφ 扩张（高纬窗口跨更多经度）
      const halfLon = half / Math.max(0.15, Math.cos((latC * Math.PI) / 180));
      const tx0 = Math.floor((lonC - halfLon + 180) / spanDeg) - 1;
      const tx1 = Math.floor((lonC + halfLon + 180) / spanDeg) + 1;
      const ty0 = Math.floor((90 - (latC + half)) / spanDeg) - 1;
      const ty1 = Math.floor((90 - (latC - half)) / spanDeg) + 1;
      for (let ty = Math.max(0, ty0); ty <= Math.min(grid.rows - 1, ty1); ty++) {
        for (let tx = Math.max(0, tx0); tx <= Math.min(grid.cols - 1, tx1); tx++) {
          const id = ty * grid.cols + tx;
          const key = `${lvl}_${tx}_${ty}`;
          // 瓦片中心距窗口中心（度²）→ 优先级
          const cLon = (tx + 0.5) * spanDeg - 180;
          const cLat = 90 - (ty + 0.5) * spanDeg;
          const d2 = (cLat - latC) * (cLat - latC) + Math.pow(wrap180(cLon - lonC) * Math.cos((latC * Math.PI) / 180), 2);
          this.queue.push({ key, lvl, tx, ty, d2 });
        }
      }
    }
    // L1/L2 先行（快速概览），L3 中心向外细化
    this.queue.sort((a, b2) => (a.lvl === b2.lvl ? a.d2 - b2.d2 : a.lvl - b2.lvl));
    if (this.tileSets[3]) {
      // 核心 L3 计数（就绪度指标）
      let total = 0;
      for (const q of this.queue) {
        if (q.lvl === 3) total++;
      }
      this.l3Total = Math.max(1, Math.min(total, 36));
      this.l3Ready = 0;
    }
  }

  private tileExists(lvl: number, tx: number, ty: number): boolean {
    const grid = this.manifest?.levels[String(lvl)];
    if (!grid) return false;
    return this.tileSets[lvl]?.has(ty * grid.cols + tx) ?? false;
  }

  /** 失败重试间隔（ms）：网络/解压失败的瓦片稍后自动重试，不永久丢弃 */
  private failRetryAt = new Map<string, number>();
  private static RETRY_DELAY_MS = 5000;
  private static FETCH_TIMEOUT_MS = 15000;

  private evict(): void {
    for (const lvl of [1, 2, 3]) {
      let count = 0;
      for (const key of this.cacheOrder) {
        if (Number(key[0]) === lvl) count++;
      }
      let cap = CACHE_CAP[lvl];
      if (count <= cap) continue;
      for (const key of [...this.cacheOrder]) {
        if (count <= cap) break;
        if (Number(key[0]) !== lvl) continue;
        this.cache.delete(key);
        this.cacheOrder.splice(this.cacheOrder.indexOf(key), 1);
        count--;
      }
    }
  }

  /**
   * 取瓦片：网络字节到达即 resolve（释放并发名额，后续瓦片立即上网），
   * 解压在后台异步继续（不阻塞网络层）；结果自行推入 pending。
   * 语义区分 —— 清单缺失/404 = 确定纯水域（写海面）；网络/解压/超时失败 =
   * 保持当前低精度数据（绝不把山地伪造成 0m 海面），延迟重试。
   */
  private fetchTile(lvl: number, tx: number, ty: number, key: string): Promise<void> {
    if (!this.tileExists(lvl, tx, ty)) {
      this.knownOcean.add(key); // 清单内无此瓦片 = 纯水域
      this.pending.push({ key, td: { h: new Int16Array(0), w: 0, hgt: 0, water: new Uint8Array(0) } });
      return Promise.resolve();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TerrainStream.FETCH_TIMEOUT_MS);
    return fetch(`/terrain/pyramid/l${lvl}/${ty}_${tx}.ktdt`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 404) {
          // 清单同步滞后/边缘缺失 → 确定无陆地数据 = 海面
          this.knownOcean.add(key);
          this.pending.push({ key, td: { h: new Int16Array(0), w: 0, hgt: 0, water: new Uint8Array(0) } });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 24) throw new Error("short");
        // 网络层完成 → 后台解压（fire-and-forget，不占用并发名额）
        void this.decodeTile(key, buf);
      })
      .catch(() => {
        // 网络/超时失败：不写任何数据（保持 L0/低层精度），延迟重试
        this.failRetryAt.set(key, performance.now() + TerrainStream.RETRY_DELAY_MS);
        this.pending.push({ key, td: null });
      })
      .finally(() => clearTimeout(timer));
  }

  /** 后台解压 → 入缓存 → 推入应用队列；失败不污染镜像，延迟重试 */
  private async decodeTile(key: string, buf: ArrayBuffer): Promise<void> {
    try {
      const dv = new DataView(buf);
      if (dv.getUint32(0, true) !== 0x4b544454) throw new Error("magic");
      const w = dv.getUint32(16, true);
      const h = dv.getUint32(20, true);
      let body: ArrayBuffer = buf.slice(24);
      if (typeof DecompressionStream !== "function") throw new Error("no DecompressionStream");
      const ds = new DecompressionStream("deflate");
      const stream = new Blob([body]).stream().pipeThrough(ds);
      body = await new Response(stream).arrayBuffer();
      const td: TileData = { h: new Int16Array(body, 0, w * h), w, hgt: h, water: new Uint8Array(body, w * h * 2, w * h) };
      this.cache.set(key, td);
      this.cacheOrder.push(key);
      this.evict();
      this.pending.push({ key, td: this.cache.get(key)! });
    } catch {
      this.failRetryAt.set(key, performance.now() + TerrainStream.RETRY_DELAY_MS);
      this.pending.push({ key, td: null });
    }
  }

  /** 每帧泵：清单重试 → 补发请求 → 应用已到达瓦片 → 产出需上传的镜像脏矩形 */
  update(): DirtyRect[] {
    if (!this.manifest && this.manifestRetryAt && performance.now() >= this.manifestRetryAt) {
      this.manifestRetryAt = 0;
      void this.loadManifest();
    }
    // 补发请求（正序 = 优先级序：cache 命中/已知海洋的瓦片直接进应用队列并出队 ——
    // 重锚定/换层后这些瓦片必须重新应用到新窗口镜像，仅靠 fetch 会让
    // 已缓存瓦片永远不落地（l3Ready 恒 0、窗口外围滞留 L0 底座））
    const ready: Array<{ key: string; td: TileData }> = [];
    this.queue = this.queue.filter((q) => {
      if (this.inflight.has(q.key)) return true;
      const cached = this.cache.get(q.key);
      if (cached) {
        ready.push({ key: q.key, td: cached });
        return false;
      }
      if (this.knownOcean.has(q.key)) {
        ready.push({ key: q.key, td: { h: new Int16Array(0), w: 0, hgt: 0, water: new Uint8Array(0) } });
        return false;
      }
      if (this.inflight.size >= FETCH_CONCURRENCY) return true;
      const retryAt = this.failRetryAt.get(q.key);
      if (retryAt !== undefined && performance.now() < retryAt) return true; // 失败瓦片稍后重试
      this.inflight.add(q.key);
      void this.fetchTile(q.lvl, q.tx, q.ty, q.key).finally(() => {
        this.inflight.delete(q.key);
      });
      return true;
    });
    for (const r of ready) this.pending.push(r);
    // 应用（每帧上限，避免主循环尖峰）
    const rects = this.dirty;
    this.dirty = [];
    let applied = 0;
    while (this.pending.length && applied < APPLY_PER_UPDATE) {
      const { key, td } = this.pending.shift()!;
      const [lvlS, txS, tyS] = key.split("_");
      if (td) this.applyTile(Number(lvlS), Number(txS), Number(tyS), td); // null = 失败跳过（保持低精度）
      applied++;
      if (Number(lvlS) === 3) {
        this.l3Ready++;
        if (!this.refined && this.l3Ready >= this.l3Total) {
          this.refined = true;
          this.refinePending = true; // 首次全窗细化 → 下一帧重建块缓存/植被
        }
      }
    }
    return rects;
  }

  /** 窗口首次全分辨率细化完成（每锚点至多一次）；消费时递增数据版本 */
  consumeRefine(): boolean {
    if (!this.refinePending) return false;
    this.refinePending = false;
    this.table.version++;
    return true;
  }

  /* ---------------- 瓦片应用（精度优先级覆盖） ---------------- */

  private mark(x0: number, y0: number, x1: number, y1: number): void {
    if (x1 <= x0 || y1 <= y0) return;
    this.dirty.push({ x0, y0, x1, y1 });
  }

  private applyTile(lvl: number, tx: number, ty: number, td: TileData): void {
    const W = WINDOW_W;
    const t = this.table;
    const heights = t.heights;
    const water = t.water;
    const prio = this.prio;
    const myPrio = lvl;
    const ws = this.winStep; // 窗口格网步长（15″ 单位）：窗口格点 i ↔ 全球 15″ 格点 c0+i·ws
    // 本层瓦片覆盖的全球格点范围（15″ 单位）：步长 = LATTICE·2^(3-lvl)（L3=1Δ L2=2Δ L1=4Δ）
    const step = Math.pow(2, 3 - lvl);
    const tile = this.manifest?.tile ?? 432;
    const b = t.meta.bounds;
    const d = LATTICE_DEG;
    const r0 = Math.round((90 - b.latN) / d);
    const c0 = Math.round((b.lonW + 180) / d);
    // 瓦片覆盖的全球 15″ 格点范围
    const gLon0 = (tx * tile) * step; // 全球格点列（以 15″ 为单位）
    const gLat0 = (ty * tile) * step;
    const span = tile * step;
    // → 窗口格点范围（任意 窗口步长 × 瓦片层级 组合；窗口 L2/L1 时低层瓦片自动降采样、
    //   高层瓦片自动上采样插值 —— 镶嵌填充与细化覆盖共用同一映射）。
    // 未裁剪边界保留（羽化距离基准）：窗口边缘被裁剪处并非数据边缘，不得羽化。
    const uix0 = Math.ceil((gLon0 - c0) / ws);
    const uiy0 = Math.ceil((gLat0 - r0) / ws);
    const uix1 = Math.ceil((gLon0 + span - c0) / ws);
    const uiy1 = Math.ceil((gLat0 + span - r0) / ws);
    const ix0 = Math.max(0, uix0);
    const iy0 = Math.max(0, uiy0);
    const ix1 = Math.min(W, uix1);
    const iy1 = Math.min(W, uiy1);
    if (ix1 <= ix0 || iy1 <= iy0) return;
    // 羽化带宽（窗口格单位，物理宽度恒定 ≈12km）
    const band = Math.max(3, Math.round(FEATHER_M / t.dxEast));

    if (td.w === 0) {
      // 清单缺失/失败 = 纯水域：按本层精度写 0m 海面（边缘带同样羽化）
      for (let j = iy0; j < iy1; j++) {
        for (let i = ix0; i < ix1; i++) {
          const k = j * W + i;
          if (prio[k] >= myPrio) continue;
          const dEdge = Math.min(i - uix0, uix1 - i, j - uiy0, uiy1 - j);
          if (dEdge >= band) {
            heights[k] = 0;
            water[k] = 1;
            prio[k] = myPrio;
          } else {
            let w = (dEdge + 0.5) / band;
            w = w * w * (3 - 2 * w);
            heights[k] = heights[k] * (1 - w);
            if (w >= 0.5) water[k] = 1;
            prio[k] = w >= 1 ? myPrio : Math.max(0, myPrio - 1);
          }
        }
      }
      this.mark(ix0, iy0, ix1, iy1);
      return;
    }

    for (let j = iy0; j < iy1; j++) {
      // 全球 15″ 行号 = r0 + j·ws；本层瓦片格 = step×15″ → 瓦片局部行 = grow/step − ty·tile。
      // 【接缝根因修复】此前写成 grow·invWs/step（多除 ws）：L3 窗口（ws=1）碰巧正确，
      // L2/L1 窗口下坐标减半 → 全部钳位到瓦片角点 → 整片恒定值平台（td.h[0]），
      // 与周边真实地形形成巨大精度悬崖 —— 用户报告的「部分地块不无缝拼接」。
      const grow = r0 + j * ws;
      const fy = grow / step - ty * tile;
      // 角对齐采样（与种子 1:1 拷贝同一约定）：窗口格 ↔ 全球 15″ 格角点，
      // 双线性直接在 (fx,fy) 取值 —— 勿加半格偏移，否则与种子错位半格
      // （在坡面 ≈ 90–200m 高差 → 种子/瓦片边界台阶）且与最近邻水掩膜错位。
      const y0c = Math.min(td.hgt - 1.001, Math.max(0, fy));
      const iy = Math.floor(y0c);
      const fyv = y0c - iy;
      const iy1c = Math.min(td.hgt - 1, iy + 1);
      const mw = Math.min(td.hgt - 1, Math.max(0, Math.round(fy)));
      const rowK = j * W;
      // 行内距覆盖边缘的羽化权重（每行常量部分）
      const dj = Math.min(j - uiy0, uiy1 - j);
      for (let i = ix0; i < ix1; i++) {
        const k = rowK + i;
        if (prio[k] >= myPrio) continue;
        const gcol = c0 + i * ws;
        const fx = gcol / step - tx * tile;
        const x0c = Math.min(td.w - 1.001, Math.max(0, fx));
        const ix = Math.floor(x0c);
        const fxv = x0c - ix;
        const ix1c = Math.min(td.w - 1, ix + 1);
        const h00 = td.h[iy * td.w + ix];
        const h10 = td.h[iy * td.w + ix1c];
        const h01 = td.h[iy1c * td.w + ix];
        const h11 = td.h[iy1c * td.w + ix1c];
        const tileH = (h00 * (1 - fxv) + h10 * fxv) * (1 - fyv) + (h01 * (1 - fxv) + h11 * fxv) * fyv;
        const wMask = td.water[mw * td.w + Math.min(td.w - 1, Math.max(0, Math.round(fx)))] ?? 0;
        // 距瓦片数据边缘的距离 → 羽化：把精度边界从 1 格悬崖摊开为 ≈12km 缓坡
        const dEdge = Math.min(i - uix0, uix1 - i, dj);
        if (dEdge >= band) {
          heights[k] = tileH;
          water[k] = wMask;
          prio[k] = myPrio;
        } else {
          let w = (dEdge + 0.5) / band;
          w = w * w * (3 - 2 * w);
          heights[k] = heights[k] * (1 - w) + tileH * w;
          if (w >= 0.5) water[k] = wMask;
          prio[k] = Math.max(0, myPrio - 1); // 羽化带降级：更高精度瓦片可覆写自愈
        }
      }
    }
    this.mark(ix0, iy0, ix1, iy1);
  }

  /* ---------------- 全局帧换算（渲染器 uniform 用） ---------------- */

  /** 焦点世界坐标（全局参考帧）：c + M·(fx,0,fz) */
  focusWorld(fx: number, fz: number): [number, number, number] {
    return matVec(this.frame.m, [fx, 0, fz]).map((v, i) => v + this.frame.c[i]) as [number, number, number];
  }
}
