/**
 * 行星数学 —— 全球拼接与升空渲染的共享基础（渲染后端无关）。
 *
 * 平面区域坐标（terrain 表格世界坐标，x 东 / z 南 / y 海拔，原点 = 网格中心）
 * 与行星球面的关系：
 *
 *  · 水平映射：等距圆柱投影（equirectangular），与本 DEM 网格间距推导严格
 *    一致 —— dxEastM = R·cosφ0·Δλ、dzNorthM = R·Δφ（φ0/λ0 = 网格中心经纬度）。
 *  · 曲率弯曲：平面点 (x, z, h) 沿「径向抬升」精确放置到球面：
 *        pos = C + (R + h) · normalize(vec3(x, R, z))，C = (0, -R, 0)
 *    该式即球面的精确参数化 —— 区域网格与全球球体在边界逐点重合
 *    （海面尤为精确：h = 0 时恰为球面本身）。
 *  · CPU 侧（相机 / 拾取）使用抛物线近似 y -= d²/2R：与 GPU 精确式的差异
 *    为四阶小量（区域边缘 < 0.3m），避免逐帧平方根开销。
 *
 * 全球高程：earth.ktdem 等距圆柱网格（row 0 = +90°纬线），双线性采样。
 */

export const PLANET_RADIUS = 6371000; // 米（平均半径，与 DEM 网格间距推导一致）

/** 全球参考帧（锚定于 BC 海岸山脉中心，立方球/全球表格经纬解算的恒定基准） */
export const REF_CENTER_LAT = 51.37083;
export const REF_CENTER_LON = -125.2625;
/** 15″ 格网角步长（度）—— 全球瓦片金字塔与窗口锚点的公共格点 */
export const LATTICE_DEG = 15 / 3600;

/** 曲率下降量（米）：距区域原点 d 处的球面相对切平面下沉 d²/2R */
export function curvatureDrop(x: number, z: number): number {
  return (x * x + z * z) / (2 * PLANET_RADIUS);
}

/**
 * 精确径向抬升：平面点 (x, z, hM) → 区域相对帧下的球面位置。
 * 与 GPU 着色器（GLSL/WGSL）中的公式逐式对应，任何表面消费方
 * （地形/水/树/草/全球球体）必须使用同一式保证无缝。
 */
export function liftToCurved(x: number, z: number, hM: number): [number, number, number] {
  const L = Math.hypot(x, PLANET_RADIUS, z);
  const s = (PLANET_RADIUS + hM) / L;
  return [x * s, -PLANET_RADIUS + PLANET_RADIUS * s, z * s];
}

/** 全球等距圆柱高程网格（earth.ktdem 解析结果） */
export interface GlobeGrid {
  w: number;
  h: number;
  /** 每像元度数（经度 = resDeg，纬度 = resDeg） */
  resDeg: number;
  /** 海拔（米），行主序，row 0 = +90°纬线，col 0 = -180°经线 */
  heights: Float32Array;
  minH: number;
  maxH: number;
}

/** 全球网格双线性采样（米）；经度取回绕，纬度钳制 */
export function globeHeightAt(g: GlobeGrid, latDeg: number, lonDeg: number): number {
  let u = (lonDeg + 180) / g.resDeg;
  const v = (90 - latDeg) / g.resDeg;
  u = ((u % g.w) + g.w) % g.w; // 经度回绕
  const fv = Math.min(g.h - 1.001, Math.max(0, v));
  const iu = Math.floor(u);
  const iv = Math.floor(fv);
  const fu = u - iu;
  const fvv = fv - iv;
  const iu1 = (iu + 1) % g.w;
  const iv1 = Math.min(g.h - 1, iv + 1);
  const r = g.w;
  const h00 = g.heights[iv * r + iu];
  const h10 = g.heights[iv * r + iu1];
  const h01 = g.heights[iv1 * r + iu];
  const h11 = g.heights[iv1 * r + iu1];
  return (h00 * (1 - fu) + h10 * fu) * (1 - fvv) + (h01 * (1 - fu) + h11 * fu) * fvv;
}

/**
 * 全球球体在着色器中的方向基（区域中心 (φ0, λ0) 的切平面坐标架）：
 *   d(φ,λ) = sinφ·pole + cosφ·[cos(λ-λ0)·eq + sin(λ-λ0)·east]
 * 其中 pole 指向北极、eq 指向 (0°N, λ0) 赤道点、east 指向区域中心正东。
 * 着色器由 baked 单位方向反解纬度：asin(d·pole)；经度差：atan2(d·east, d·eq)。
 */
export interface GlobeBasis {
  pole: [number, number, number];
  eq: [number, number, number];
  east: [number, number, number];
}

export function globeBasis(centerLatDeg: number): GlobeBasis {
  const p = (centerLatDeg * Math.PI) / 180;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  return {
    pole: [0, sp, -cp],
    eq: [0, cp, sp],
    east: [1, 0, 0],
  };
}

/**
 * 球面经纬度 → 区域平面坐标（米）—— 与 pickCoordLabel/网格定义严格互逆：
 *   x = ((lon - lonW)/(lonE - lonW) - 0.5)·spanX
 *   z = ((latN - lat)/(latN - latS) - 0.5)·spanZ
 */
export function latLonToPlanar(
  bounds: { latN: number; latS: number; lonW: number; lonE: number },
  spanX: number,
  spanZ: number,
  latDeg: number,
  lonDeg: number,
): [number, number] {
  const x = ((lonDeg - bounds.lonW) / (bounds.lonE - bounds.lonW) - 0.5) * spanX;
  const z = ((bounds.latN - latDeg) / (bounds.latN - bounds.latS) - 0.5) * spanZ;
  return [x, z];
}

/* ---------------- 多锚点行星框架（流式全球窗口的地心定位） ---------------- */

export interface AnchorFrame {
  /** 局部 → 全局旋转（列 = [东, 上, 南] 在全局参考帧的方向） */
  m: [number, number, number, number, number, number, number, number, number];
  /** 全局 → 局部旋转（m 的转置） */
  mi: [number, number, number, number, number, number, number, number, number];
  /** 锚点海平面点在全局帧的世界坐标 = (0,−R,0) + R·up */
  c: [number, number, number];
  /** 锚点经纬度（已吸附 15″ 格点） */
  lat: number;
  lon: number;
  /** 窗口像元间距（米）：东 = R·cosφ·15″rad，北 = R·15″rad */
  dxEast: number;
  dzNorth: number;
}

export function wrap180(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/** 全球参考帧下的地心单位方向（lat/lon 度）—— 与着色器 lat=asin(d·pole) 解算互逆 */
export function geodesicDir(latDeg: number, lonDeg: number): [number, number, number] {
  const b = globeBasis(REF_CENTER_LAT);
  const p = (latDeg * Math.PI) / 180;
  const dl = ((lonDeg - REF_CENTER_LON) * Math.PI) / 180;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const cd = Math.cos(dl);
  const sd = Math.sin(dl);
  const v = [
    sp * b.pole[0] + cp * (cd * b.eq[0] + sd * b.east[0]),
    sp * b.pole[1] + cp * (cd * b.eq[1] + sd * b.east[1]),
    sp * b.pole[2] + cp * (cd * b.eq[2] + sd * b.east[2]),
  ];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * 锚点切线框架：局部平面坐标（x 东 / y 海拔 / z 南，原点=锚点海平面点）
 * → 全局帧世界坐标 world = c + M·p。曲率弯曲（liftCurved）在局部帧内完成，
 * 旋转后保持球面精确（M 正交）。锚点吸附 15″ 格点 → 窗口与全球瓦片格网逐像素对齐。
 */
export function anchorFrame(latDegIn: number, lonDegIn: number, w?: number): AnchorFrame {
  const dLat = LATTICE_DEG;
  const lat = latDegIn;
  const lon = lonDegIn;
  const rad = Math.PI / 180;
  const dRad = dLat * rad;
  const up = geodesicDir(lat, lon);
  // 数值方向导数 → 东/北基（在球面上精确正交于 up）
  const eps = 1e-5;
  const dE = geodesicDir(lat, lon + eps * 180 / Math.PI / Math.max(0.2, Math.cos(lat * rad)));
  const dN = geodesicDir(lat + eps * 180 / Math.PI, lon);
  let e = [dE[0] - up[0], dE[1] - up[1], dE[2] - up[2]];
  let n = [dN[0] - up[0], dN[1] - up[1], dN[2] - up[2]];
  const el = Math.hypot(e[0], e[1], e[2]) || 1;
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  e = [e[0] / el, e[1] / el, e[2] / el];
  n = [n[0] / nl, n[1] / nl, n[2] / nl];
  const s: [number, number, number] = [-n[0], -n[1], -n[2]]; // 局部 +z = 南
  const m: AnchorFrame["m"] = [e[0], e[1], e[2], up[0], up[1], up[2], s[0], s[1], s[2]];
  const mi: AnchorFrame["mi"] = [
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ];
  const c: [number, number, number] = [
    -0 + PLANET_RADIUS * up[0],
    -PLANET_RADIUS + PLANET_RADIUS * up[1],
    -0 + PLANET_RADIUS * up[2],
  ];
  return {
    m,
    mi,
    c,
    lat,
    lon,
    dxEast: PLANET_RADIUS * Math.cos(lat * rad) * dRad,
    dzNorth: PLANET_RADIUS * dRad,
  };
}

/** mat3（9 元组，列主）× 向量 */
export function matVec(m: AnchorFrame["m"], v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** mat3ᵀ × 向量 */
export function matTVec(m: AnchorFrame["m"], v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
