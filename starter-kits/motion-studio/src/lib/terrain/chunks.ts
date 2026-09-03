/**
 * 空间划分与调度 —— 方形子块四叉树 LOD（7 级：L-3..L3）
 *
 * 每帧依据两个条件决定子块是否参与构建：
 *   ① 该子块是否处于观察者的朝向范围内（视锥平面 + AABB 相交）
 *   ② 该子块距离观察者的远近程度（LOD 距离环）
 * 近处子块用表格完整数值（L0，stride=1），L-1..L-3 在表格像元内继续细分
 * （亚像元双线性 + 近景浮雕场），远处抽样稀疏（stride 2/4/8），视野外不构建。
 * 每帧新建网格数受预算钳制 → 处理数据总量保持恒定。
 *
 * 宏观骨架：仅依据表格数值把平面点垂直抬起（数值高→山峰，相邻差→坡度）；
 * 近景（<2.5km）叠加程序化浮雕（detailRelief，与 GPU 严格同式）。
 * 无任何预存几何：顶点位置与法线全部由表格数值实时差分产生（LRU 缓存 GPU 缓冲，
 * 淘汰即销毁，非预计算资产）。
 *
 * 浮动原点：观察者固定在逻辑原点，移动时反向平移整片数字派生表面 ——
 * 实现为顶点保持区域坐标、由 uFocus 每帧把世界拉回相机附近，GPU 全程小数值。
 */

import { PLANET_RADIUS } from "./planet";
import type { DirtyRect } from "./stream";
import { detailRelief, gridHeightAt, type TerrainTable } from "./table";

/** LOD0 子块边沿采样数（64 采样 ≈ 28.8km 边长，区域 1024 像元 ≈ 460km） */
export const CHUNK_SAMPLES = 64;
/** 最细 LOD：L-3 覆盖 8 像元（3.6km）× 65 顶点 → 顶点间距 56m，可解析浮雕带 */
export const MIN_LEVEL = -3;
const MAX_LEVEL = 3;
/**
 * LOD 距离环（米）：块中心近角距 < 阈值则继续细分到下一级（索引 = 子级 + 3）。
 * L-3 ← 1.1km · L-2 ← 3.6km · L-1 ← 12km · L0 ← 16km · L1 ← 45km · L2 ← 140km
 */
const RING_T = [1100, 3600, 12000, 16000, 45000, 140000];
/** LRU 缓存上限（块数；远场距离上限随窗口幅面联动后，高空可见块数增多） */
const MESH_CACHE_MAX = 320;
/** 每帧默认新建网格（构建预算） */
export const BUILD_BUDGET_PER_FRAME = 3;
/**
 * 流式脏矩形外扩（表格采样格）：网格法线用 ±1 采样差分 → 邻块数据补丁会影响
 * 本块边缘法线；外扩 4 格覆盖全部跨界采样。
 */
const DIRTY_REACH = 4;

export interface ChunkNode {
  /** 采样原点（表格坐标） */
  ox: number;
  oz: number;
  level: number;
  /** 中心世界坐标 */
  cx: number;
  cz: number;
  half: number;
}

export interface ChunkMesh {
  vbo: WebGLBuffer;
  vertCount: number;
  level: number;
  lastUsed: number;
  /** 构建时的流式数据版本（版本变化 = 数据已变 → 网格陈旧需重建） */
  ver: number;
  /** 构建时的几何帧纪元（窗口原点/步长变更后旧网格坐标系作废，不可续绘） */
  fe: number;
  /** 顶点海拔范围（米，未夸张）供视锥 AABB */
  yMin: number;
  yMax: number;
}

interface FrustumPlane {
  a: number;
  b: number;
  c: number;
  d: number;
}

export class ChunkScheduler {
  private meshes = new Map<string, ChunkMesh>();
  /** 共享索引缓冲（含裙边），按 LOD 级别 */
  private ibos = new Map<number, WebGLBuffer>();
  private indexCounts = new Map<number, number>();
  /** 每帧统计（7 级：L-3..L3）；cover = 本帧分块覆盖矩形 [x0,x1,z0,z1]（全球球体衔接用） */
  stats = {
    visible: 0,
    byLevel: [0, 0, 0, 0, 0, 0, 0] as number[],
    builtThisFrame: 0,
    cached: 0,
    cover: [Infinity, -Infinity, Infinity, -Infinity] as [number, number, number, number],
  };

  constructor(
    private gl: WebGL2RenderingContext,
    private table: TerrainTable,
  ) {
    for (let l = MIN_LEVEL; l <= MAX_LEVEL; l++) {
      const n = this.meshSide(l);
      const { ibo, count } = this.buildIndexBuffer(n);
      this.ibos.set(l, ibo);
      this.indexCounts.set(l, count);
    }
  }

  /** 每帧构建预算（重锚定/区域细化时可临时提高） */
  budget = BUILD_BUDGET_PER_FRAME;

  /** 流式数据更新（重锚定/瓦片到达）→ 丢弃全部缓存网格（按新数据重建） */
  invalidate(): void {
    for (const m of this.meshes.values()) this.gl.deleteBuffer(m.vbo);
    this.meshes.clear();
  }

  /**
   * 每边顶点数：全级别恒定 65（64 细分区间）。
   * 关键：顶点间距随级别 ×2（stride=2^level 采样），块逻辑边长同样 ×2（64·2^level 采样）
   * → 顶点数必须恒定 65，网格才能覆盖块的全部逻辑范围。此前 L1..3 顶点数按 2^level
   * 缩减而步长只放大 2^level，网格仅覆盖左上角 1/2^level（L3 只画 28.8km/230km），
   * 远场块之间出现巨大空隙 —— 空隙落在覆盖矩形内被全球球体丢弃 → 直通天空背景
   * （低空呈雾色不可见，升空后呈太空黑块）。v16.1 修复。
   */
  private meshSide(level: number): number {
    return CHUNK_SAMPLES + 1;
  }

  /**
   * 网格顶点缓冲：pos(3f)+normal(3f) 交错 + 裙边环。
   * 负级（亚像元）用浮点网格坐标 + 表格双线性；全级别叠加近景浮雕带（与 GPU 同式）。
   *
   * 无缝关键：① 浮雕为窗口锚点系纯位置场（与相机无关）→ 任意时刻烘焙的相邻网格
   * 在共享顶点处严格同值；② 法线差分间距恒定 ±1 采样（不随 LOD 步长缩放）→
   * 相邻不同级网格在共享边顶点的法线严格相等（同一公式同一采样点）→ 光照无缝；
   * ③ 网格只依赖 (ox,oz,level,数据版本,detailAmp) → 缓存永不因相机移动陈旧。
   */
  private buildMesh(
    key: string,
    ox: number,
    oz: number,
    level: number,
    detailAmp: number,
  ): ChunkMesh | null {
    const gl = this.gl;
    const t = this.table;
    const strideF = Math.pow(2, level); // DEM 网格步长（可 <1：亚像元细分）
    const n = this.meshSide(level);
    const sizeSamples = Math.round(CHUNK_SAMPLES * Math.pow(2, level));
    const dx = t.dxEast * strideF;
    const dz = t.dzNorth * strideF;
    const cxw = ((ox + sizeSamples / 2) / t.w - 0.5) * t.spanX;
    const czw = ((oz + sizeSamples / 2) / t.h - 0.5) * t.spanZ;
    // 中心距离 → 裙边深度（远处更大，遮挡 LOD 缝隙与数据精度混合边界的高度差）
    const cdist = Math.hypot(cxw, czw);
    const skirt = 80 + Math.min(1200, cdist * 0.03);

    /** 含近景浮雕的网格坐标海拔（米）。世界坐标 = 网格坐标线性映射 */
    const hRel = (gx: number, gz: number): number => {
      const hM = gridHeightAt(t, gx, gz);
      if (detailAmp <= 0) return hM;
      const wx = (gx / (t.w - 1) - 0.5) * t.spanX;
      const wz = (gz / (t.h - 1) - 0.5) * t.spanZ;
      return hM + detailRelief(wx, wz, hM, detailAmp);
    };

    const verts = new Float32Array((n * n + 4 * n) * 6);
    let yMin = Infinity;
    let yMax = -Infinity;
    let p = 0;
    for (let j = 0; j < n; j++) {
      const gj = Math.min(t.h - 1, Math.max(0, oz + j * strideF));
      for (let i = 0; i < n; i++) {
        const gi = Math.min(t.w - 1, Math.max(0, ox + i * strideF));
        const x = (gi / (t.w - 1) - 0.5) * t.spanX;
        const z = (gj / (t.h - 1) - 0.5) * t.spanZ;
        // 中央差分 → 坡面朝向（宏观光照法线）。间距恒定 ±1 采样（与 LOD 无关）：
        // 相邻不同级网格的共享边顶点采样同一对格点 → 法线逐位相等 → 无光照接缝。
        // 代价：粗级法线携带细级坡度细节（法线贴图式增强，跨级过渡平滑）。
        const gL = Math.max(0, gi - 1);
        const gR = Math.min(t.w - 1, gi + 1);
        const gU = Math.max(0, gj - 1);
        const gD = Math.min(t.h - 1, gj + 1);
        const gx = (hRel(gR, gj) - hRel(gL, gj)) / Math.max(1e-6, (gR - gL) * dx);
        const gzn = (hRel(gi, gD) - hRel(gi, gU)) / Math.max(1e-6, (gD - gU) * dz);
        const len = Math.hypot(gx, 1, gzn);
        const hv = hRel(gi, gj);
        if (hv < yMin) yMin = hv;
        if (hv > yMax) yMax = hv;
        verts[p++] = x;
        verts[p++] = hv;
        verts[p++] = z;
        verts[p++] = -gx / len;
        verts[p++] = 1 / len;
        verts[p++] = -gzn / len;
      }
    }
    // 裙边：四边各复制一排顶点下沉 skirt（含浮雕，避免裂缝）
    const edge = (i: number, j: number): [number, number, number] => {
      const gi = Math.min(t.w - 1, Math.max(0, ox + i * strideF));
      const gj = Math.min(t.h - 1, Math.max(0, oz + j * strideF));
      const x = (gi / (t.w - 1) - 0.5) * t.spanX;
      const z = (gj / (t.h - 1) - 0.5) * t.spanZ;
      return [x, hRel(gi, gj), z];
    };
    const sides: Array<[number, number][]> = [
      Array.from({ length: n }, (_, k) => [k, 0] as [number, number]),
      Array.from({ length: n }, (_, k) => [k, n - 1] as [number, number]),
      Array.from({ length: n }, (_, k) => [0, k] as [number, number]),
      Array.from({ length: n }, (_, k) => [n - 1, k] as [number, number]),
    ];
    for (const side of sides) {
      for (const [i, j] of side) {
        const [x, y, z] = edge(i, j);
        verts[p++] = x;
        verts[p++] = y - skirt;
        verts[p++] = z;
        verts[p++] = 0;
        verts[p++] = 1;
        verts[p++] = 0;
      }
    }

    const vbo = gl.createBuffer();
    if (!vbo) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const mesh: ChunkMesh = {
      vbo,
      vertCount: n * n + 4 * n,
      level,
      lastUsed: 0,
      ver: t.version,
      fe: t.frameEpoch,
      yMin: yMin - 30,
      yMax: yMax + 30,
    };
    this.meshes.set(key, mesh);
    return mesh;
  }

  private buildIndexBuffer(n: number): { ibo: WebGLBuffer; count: number } {
    const gl = this.gl;
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // 裙边索引：边环 [0..n-1] 主网格边行 + [n*n .. n*n+n-1] 裙边顶点
    const base = n * n;
    for (let k = 0; k < n - 1; k++) {
      // 北边(j=0)：主 a=k, b=k+1；裙 a2=base+k
      idx.push(k, base + k, k + 1, k + 1, base + k, base + k + 1);
      // 南边(j=n-1)
      const s = (n - 1) * n;
      idx.push(s + k, s + k + 1, base + n + k, s + k + 1, base + n + k + 1, base + n + k);
      // 西边(i=0)：主 a=k*n；裙 base+2n+k
      const wv = k * n;
      idx.push(wv, wv + n, base + 2 * n + k, wv + n, base + 2 * n + k + 1, base + 2 * n + k);
      // 东边(i=n-1)
      const ev = k * n + (n - 1);
      idx.push(ev, base + 3 * n + k, ev + n, ev + n, base + 3 * n + k, base + 3 * n + k + 1);
    }
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return { ibo, count: idx.length };
  }

  /** 从 view-proj 矩阵（列主序）提取 6 个视锥平面 */
  static extractFrustum(m: Float32Array): FrustumPlane[] {
    const p: FrustumPlane[] = [];
    // 行组合：left = row3+row0, right = row3-row0, bottom = row3+row1, top = row3-row1, near = row3+row2, far = row3-row2
    const combos: Array<[number, number]> = [
      [3, 0],
      [3, 0],
      [3, 1],
      [3, 1],
      [3, 2],
      [3, 2],
    ];
    const signs = [1, -1, 1, -1, 1, -1];
    for (let i = 0; i < 6; i++) {
      const [r0, r1] = combos[i];
      const s = signs[i];
      // GLSL 列主序：第 r 行第 c 列 = m[c*4+r]
      const a = m[0 * 4 + r0] * 1 + m[0 * 4 + r1] * s;
      const b = m[1 * 4 + r0] * 1 + m[1 * 4 + r1] * s;
      const c = m[2 * 4 + r0] * 1 + m[2 * 4 + r1] * s;
      const d = m[3 * 4 + r0] * 1 + m[3 * 4 + r1] * s;
      const len = Math.hypot(a, b, c) || 1;
      p.push({ a: a / len, b: b / len, c: c / len, d: d / len });
    }
    return p;
  }

  private aabbVisible(f: FrustumPlane[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
    for (const pl of f) {
      // 取 AABB 正向最远点
      const px = pl.a > 0 ? x1 : x0;
      const py = pl.b > 0 ? y1 : y0;
      const pz = pl.c > 0 ? z1 : z0;
      if (pl.a * px + pl.b * py + pl.c * pz + pl.d < 0) return false;
    }
    return true;
  }

  /**
   * 每帧调度：返回本次应绘制的 [mesh, level] 列表。
   * 递归四叉树：距相机近且未到最细级 → 细分；视锥外 → 剪枝。
   * 新网格构建受 BUILD_BUDGET_PER_FRAME 钳制；预算耗尽时优先续绘已有网格
   * （连续性优先，绝不空洞）——数据补丁未重建的陈旧网格同样续绘，下一帧优先补建。
   *
   * dataRects：流式瓦片本帧写入镜像的脏矩形（窗口格坐标）。落在矩形（外扩
   * DIRTY_REACH）内的缓存网格视为陈旧 → 预算内重建（流式数据边界随瓦片到达
   * 逐块自愈，新数据网格与旧数据网格之间不再残留精度接缝）。
   */
  schedule(
    focusX: number,
    focusZ: number,
    frustum: FrustumPlane[],
    exagg: number,
    frameNo: number,
    detailAmp = 0,
    dataRects?: DirtyRect[],
  ): Array<{ mesh: ChunkMesh; level: number }> {
    const t = this.table;
    const out: Array<{ mesh: ChunkMesh; level: number }> = [];
    this.stats.builtThisFrame = 0;
    this.stats.byLevel = [0, 0, 0, 0, 0, 0, 0];
    this.stats.visible = 0;
    this.stats.cover = [Infinity, -Infinity, Infinity, -Infinity];

    // 流式脏矩形外扩 → 陈旧判定用
    let rects: Array<[number, number, number, number]> | null = null;
    if (dataRects && dataRects.length > 0) {
      rects = dataRects.map((r) => [r.x0 - DIRTY_REACH, r.y0 - DIRTY_REACH, r.x1 + DIRTY_REACH, r.y1 + DIRTY_REACH]);
    }
    const isStale = (mesh: ChunkMesh, ox: number, oz: number, size: number): boolean => {
      if (mesh.ver !== t.version) return true;
      if (!rects) return false;
      for (const r of rects) {
        if (ox < r[2] && ox + size > r[0] && oz < r[3] && oz + size > r[1]) return true;
      }
      return false;
    };

    // 弯曲几何的逐块 AABB 修正：liftCurved 径向弯曲使实际高度低于平面值 ≈ d²/2R
    //（近角落落差最小、远角落最大）。上沿扣最小落差、下沿扣最大落差 → 包络真实弯曲几何，
    // 高空俯瞰时近地平线块不再被平面视锥误剔除（误剔除 + 球体 discard = 黑色缺口）。
    const visit = (ox: number, oz: number, level: number) => {
      const sizeSamples = Math.round(CHUNK_SAMPLES * Math.pow(2, level));
      const half = (sizeSamples / t.w) * Math.max(t.spanX, t.spanZ) * 0.5;
      const cx = ((ox + sizeSamples / 2) / t.w - 0.5) * t.spanX;
      const cz = ((oz + sizeSamples / 2) / t.h - 0.5) * t.spanZ;
      // 视锥剔除：视锥平面在相对帧（顶点已减 focus），AABB 同步转相对帧。
      // 距离上限随窗口幅面联动（L1 窗口 2848km → 远场块不再被 300km 硬上限剔除，
      // 高空可视区域内全部参与流式绘制而非退化为低分辨率球体）。
      const dc = Math.hypot(cx - focusX, cz - focusZ);
      const rCull = dc + half * 1.42;
      if (level < MAX_LEVEL && rCull > Math.max(300000, Math.max(t.spanX, t.spanZ) * 0.8)) return;
      const dNear = Math.pow(Math.max(Math.abs(cx) - half, 0), 2) + Math.pow(Math.max(Math.abs(cz) - half, 0), 2);
      const dFar = Math.pow(Math.abs(cx) + half, 2) + Math.pow(Math.abs(cz) + half, 2);
      const yLoC = (t.minH - 80) * exagg - dFar / (2 * PLANET_RADIUS) - 80;
      const yHiC = (t.maxH + 80) * exagg - dNear / (2 * PLANET_RADIUS);
      if (!this.aabbVisible(frustum, cx - half - focusX, cx + half - focusX, yLoC, yHiC, cz - half - focusZ, cz + half - focusZ)) return;

      // 细分判定用「最近角距离」（大根块否则永不满足环阈值）
      const rNear = Math.max(0, dc - half * 1.05);
      if (level > MIN_LEVEL && rNear < RING_T[level + 2]) {
        const sub = Math.round(CHUNK_SAMPLES * Math.pow(2, level - 1));
        visit(ox, oz, level - 1);
        visit(ox + sub, oz, level - 1);
        visit(ox, oz + sub, level - 1);
        visit(ox + sub, oz + sub, level - 1);
        return;
      }

      const key = `${ox}_${oz}_${level}`;
      const cached = this.meshes.get(key);
      let mesh: ChunkMesh | null = null;
      if (cached) {
        if (cached.fe !== t.frameEpoch) {
          // 几何帧纪元已变（重锚定换窗）：旧网格坐标系作废 → 释放，不可续绘
          this.gl.deleteBuffer(cached.vbo);
          this.meshes.delete(key);
        } else if (!isStale(cached, ox, oz, sizeSamples)) {
          mesh = cached;
        }
      }
      if (!mesh && this.stats.builtThisFrame < this.budget) {
        const built = this.buildMesh(key, ox, oz, level, detailAmp);
        if (built) {
          if (cached) this.gl.deleteBuffer(cached.vbo); // 原地重建：先释放旧缓冲防泄漏
          this.stats.builtThisFrame++;
          mesh = built;
        }
      }
      // 预算耗尽：同纪元的已有网格（含数据陈旧）续绘 —— 数据量恒定的同时画面
      // 永不破洞；数据陈旧边界由数据羽化与逐帧重建自愈。
      if (!mesh && cached) mesh = cached;
      if (!mesh) {
        return;
      }
      // 覆盖矩形仅在确认本块实际参与绘制后扩张（球体丢弃区与实际地形绘制严格同源）
      const cov = this.stats.cover;
      cov[0] = Math.min(cov[0], cx - half);
      cov[1] = Math.max(cov[1], cx + half);
      cov[2] = Math.min(cov[2], cz - half);
      cov[3] = Math.max(cov[3], cz + half);
      mesh.lastUsed = frameNo;
      this.stats.visible++;
      this.stats.byLevel[level + 3]++;
      out.push({ mesh, level });
    };

    // 根：MAX_LEVEL 级（1024/512=2 → 2×2 块）
    const rootSize = CHUNK_SAMPLES << MAX_LEVEL;
    const roots = t.w / rootSize;
    for (let rz = 0; rz < roots; rz++) {
      for (let rx = 0; rx < roots; rx++) {
        visit(rx * rootSize, rz * rootSize, MAX_LEVEL);
      }
    }

    // LRU 淘汰
    if (this.meshes.size > MESH_CACHE_MAX) {
      const entries = [...this.meshes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const drop = this.meshes.size - MESH_CACHE_MAX;
      for (let k = 0; k < drop; k++) {
        const [key, mesh] = entries[k];
        if (frameNo - mesh.lastUsed < 120) break;
        this.gl.deleteBuffer(mesh.vbo);
        this.meshes.delete(key);
      }
    }
    this.stats.cached = this.meshes.size;
    return out;
  }

  /** 绘制辅助：绑定某级别的共享索引缓冲 */
  bindIndices(level: number): number {
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibos.get(level)!);
    return this.indexCounts.get(level)!;
  }

  destroy(): void {
    const gl = this.gl;
    for (const m of this.meshes.values()) gl.deleteBuffer(m.vbo);
    this.meshes.clear();
    for (const ibo of this.ibos.values()) gl.deleteBuffer(ibo);
    this.ibos.clear();
  }
}

/** 便捷：世界坐标某点的法线（与网格差分一致：±1 采样中央差分 + 锚点系浮雕带） */
export function terrainNormal(
  t: TerrainTable,
  x: number,
  z: number,
  exagg: number,
  detailAmp = 0,
): [number, number, number] {
  const e = Math.max(t.dxEast, t.dzNorth);
  const hAt = (px: number, pz: number): number => {
    const hM = gridHeightAt(t, (px / t.spanX + 0.5) * (t.w - 1), (pz / t.spanZ + 0.5) * (t.h - 1));
    return hM + detailRelief(px, pz, hM, detailAmp);
  };
  const gx = ((hAt(x + e, z) - hAt(x - e, z)) / (2 * e)) * exagg;
  const gz = ((hAt(x, z + e) - hAt(x, z - e)) / (2 * e)) * exagg;
  const len = Math.hypot(gx, 1, gz);
  return [-gx / len, 1 / len, -gz / len];
}
