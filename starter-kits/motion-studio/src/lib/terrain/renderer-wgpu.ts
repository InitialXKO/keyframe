/**
 * 数字表格 → 三维景象 —— WebGPU 渲染路径（全面 GPU 化）
 *
 * 与 WebGL2 路径（renderer.ts）像素级同源，但结构全面 GPU 化：
 *
 * ① 分块网格零 CPU 生成：GL 路径由 JS 逐块建 VBO（LRU 缓存 + 每帧预算），
 *    此路径改为「顶点着色器高程纹理位移」——七个 LOD（L-3..L3）共享静态索引缓冲，
 *    VS 依据 chunk 描述符（storage buffer）自行采样高度纹理生成位置与法线，
 *    负级以浮点网格坐标做亚像元双线性 + 近景浮雕带（与 TS/GLSL 严格同式），
 *    每个 LOD 一次 instanced draw（全帧地形 ≤7 次 draw），CPU 只做四叉树筛选。
 * ② 植被增殖 compute shader 化：树与草丛两套适宜性并行评估（atomic 追加实例 +
 *    drawIndexedIndirect）—— 焦点移动重建时零 CPU 参与、零回读（绘制参数由 finalize 写入）。
 * ③ 近景细节：浮雕带（几何位移）、浮雕法线带、碎石/裸土斑、凹腔 AO、
 *    树四向交叉面片 + AO/叶簇通道着色 + 逆光透射、近景草丛层（风摇 + 逆光）。
 * ④ 浮动原点：着色器顶点 = 区域坐标 − uFocus（相对帧），view 矩阵同相对帧构建。
 * ⑤ MSAA 4×；WGSL 编译错误在初始化时经 getCompilationInfo 捕获 → 上层回退 WebGL2；
 *    运行期 device lost / uncaptured error → onFatal 回退。
 *
 * Frame uniform（656B / 164 floats）浮点布局：
 *   [0..16) viewProj | 16 eyeRel | 20 focus | 24 sunDir | 28 sunColor | 32 ambient
 *   36 fogColor | 40 skyZenith | 44 skyHorizon | 48 windDir+span | 52 time,wind,exagg,fogDensity
 *   56 snowLine,treeLine,cloudStrength,shadowOn | 60 mist,cloudCover,tanHalf,aspect
 *   64 camRight | 68 camUp | 72 camFwd | 76 grid(w,h,dxE,dzN) | 80 chunkBase L-3..L0
 *   84 markerCenter | 88 markerSize | 92 chunkBase L1..L3 | 96 detailAmp
 *   100 gPad(保留) | 104 gPole | 108 gEq | 112 gEast | 116 gConf0 | 120 gConf1 | 124 gClip
 *   128 gMisc(globeW,globeH,spaceMix,fogD)
 *   132 actM(3×vec4) | 144 actMi(3×vec4) | 156 focusW | 160 gAux(lam0,0,0,0)
 */

import { ChunkScheduler } from "./chunks";
import {
  buildGrassVariants,
  buildTreeVariants,
  MAX_GRASS,
  TREE_VARIANTS,
} from "./vegetation";
import { f32ToF16Bits, heightAt, type TerrainTable } from "./table";
import {
  curvatureDrop,
  globeBasis,
  PLANET_RADIUS,
  REF_CENTER_LAT,
  REF_CENTER_LON,
} from "./planet";
import type { DirtyRect, TerrainStream } from "./stream";
import {
  cameraBasis,
  lookAt,
  mul4,
  pickSurface,
  type CameraState,
  type PickResult,
} from "./camera";

export type { CameraState, PickResult };

export interface RenderParams {
  hour: number;
  wind: number;
  exagg: number;
  snowLineM: number;
  treeLineM: number;
  vegDensity: number;
  cloudCover: number;
  showVeg: boolean;
  shadows: boolean;
  mist: boolean;
  detail: boolean;
  grass: boolean;
}

export interface TerrainStats {
  chunks: number;
  byLevel: number[];
  tris: number;
  vegCount: number;
  grassCount: number;
  meshCache: number;
  built: number;
}

/* ============================ WGSL ============================ */

/** 公共段：Frame/VegParams 结构、共享绑定（0-3）、采样助手、噪声、浮雕带、色调映射、高度场自阴影 */
export const WGSL_COMMON = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  eyeRel: vec4f,
  focus: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  ambient: vec4f,
  fogColor: vec4f,
  skyZenith: vec4f,
  skyHorizon: vec4f,
  windSpan: vec4f,
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  camFwd: vec4f,
  grid: vec4f,
  bases: vec4f,
  markerC: vec4f,
  markerS: vec4f,
  bases2: vec4f,
  p3: vec4f,
  gPad: vec4f,     // 保留（旧 gCenter 位置，维持索引稳定）
  gPole: vec4f,
  gEq: vec4f,
  gEast: vec4f,
  gConf0: vec4f,
  gConf1: vec4f,
  gClip: vec4f,
  gMisc: vec4f,
  actM0: vec4f,
  actM1: vec4f,
  actM2: vec4f,
  actMi0: vec4f,
  actMi1: vec4f,
  actMi2: vec4f,
  focusW: vec4f,
  gAux: vec4f,
};

struct VegParams {
  keep: f32,
  cell: f32,
  baseCx: f32,
  baseCz: f32,
  focusX: f32,
  focusZ: f32,
  r2max: f32,
  snowLine: f32,
  exagg: f32,
  maxTrees: f32,
  cellsSide: f32,
  detailAmp: f32,
  gKeep: f32,
  gCell: f32,
  gBaseCx: f32,
  gBaseCz: f32,
  gCellsSide: f32,
  gR2max: f32,
  gMax: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
  pad3: f32,
  pad4: f32,
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var heightsTex: texture_2d<f32>;
@group(0) @binding(2) var waterTex: texture_2d<f32>;
@group(0) @binding(3) var texSamp: sampler;

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var a = 0.5;
  var s = 0.0;
  for (var k = 0; k < 4; k++) {
    s = s + a * vnoise(p);
    p = p * 2.03 + vec2f(37.1, 17.7);
    a = a * 0.5;
  }
  return s;
}
fn toneFilm(c0: vec3f) -> vec3f {
  let c = 1.25 * c0 / (1.0 + 0.30 * c0);
  return clamp(c, vec3f(0.0), vec3f(1.0));
}
/** 世界坐标 → 表格 uv（与 WebGL2 路径同约定：0..1 横跨 w-1 格） */
fn uvWorld(p: vec2f) -> vec2f {
  return p / F.windSpan.zw + 0.5;
}
/** 精确 texel 中心读数（参数为连续网格坐标，可含小数）：与 CPU 双线性插值严格一致 */
fn heightGrid(fx: f32, fz: f32) -> f32 {
  return textureSampleLevel(heightsTex, texSamp, (vec2f(fx, fz) + 0.5) / F.grid.xy, 0.0).r;
}
/** 世界坐标双线性海拔 */
fn heightWorldGrid(wx: f32, wz: f32) -> f32 {
  let fx = wx / F.grid.z + (F.grid.x - 1.0) * 0.5;
  let fz = wz / F.grid.w + (F.grid.y - 1.0) * 0.5;
  return heightGrid(fx, fz);
}
/** 网格坐标 → 世界坐标 */
fn gridWorld(gx: f32, gz: f32) -> vec2f {
  return vec2f((gx / (F.grid.x - 1.0) - 0.5) * F.windSpan.z, (gz / (F.grid.y - 1.0) - 0.5) * F.windSpan.w);
}
/** 水体最近邻（模拟 NEAREST：先取 texel 再读中心） */
fn waterNearestUv(uv: vec2f) -> f32 {
  let c = (floor(uv * F.grid.xy) + 0.5) / F.grid.xy;
  return textureSampleLevel(waterTex, texSamp, c, 0.0).r;
}
fn waterNearest(wx: f32, wz: f32) -> f32 {
  return waterNearestUv(uvWorld(vec2f(wx, wz)));
}

/* ---- 曲率弯曲（全球球面精确径向抬升，与 TS/WebGL2/全球球体同一式） ---- */
fn liftCurved(xz: vec2f, h: f32) -> vec3f {
  let L = length(vec3f(xz.x, 6371000.0, xz.y));
  let s = (6371000.0 + h) / L;
  return vec3f(xz.x * s, -6371000.0 + 6371000.0 * s, xz.y * s);
}

/* ---- 近景浮雕带（与 TS detailRelief / GLSL DETAIL 严格同式） ---- */
/** 浮雕作用域：窗口锚点系（原点）纯位置场，60km 内全量、60–160km 渐隐 —— 与相机无关，
 *  任意 LOD/任意时刻在同一世界坐标逐点同值 → 跨级/跨帧无缝（接缝修复核心）。 */
fn reliefZone(p: vec2f) -> f32 {
  let r = length(p);
  let t = clamp((r - 60000.0) / 100000.0, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}
/** 相机邻域遮罩（2.5–9km），仅供阴影步进的 detailB 岩石细节使用 */
fn nearMask(p: vec2f, f: vec2f) -> f32 {
  let r = distance(p, f);
  let t = clamp((r - 2500.0) / 6500.0, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}
fn detailA(p: vec2f, hSelf: f32, amp: f32) -> f32 {
  if (amp <= 0.0) { return 0.0; }
  let m = reliefZone(p) * smoothstep(2.0, 14.0, hSelf) * amp;
  if (m <= 0.0) { return 0.0; }
  let n = fbm(p * 0.0014 + vec2f(53.1, 91.7));
  return (n - 0.5) * 44.0 * m;
}
fn detailB(p: vec2f) -> f32 {
  return (vnoise(p * 0.0062) - 0.5) * 16.0 + (vnoise(p * 0.019) - 0.5) * 3.4 + (vnoise(p * 0.052) - 0.5) * 1.1;
}

/** 高度场自阴影（与 WebGL2 SHADOW_COMMON 同参数；前 6 步叠加浮雕细节带）；含曲率修正 */
fn terrainShadow(pos: vec3f, sunDir: vec3f, focusXZ: vec2f, detAmp: f32) -> f32 {
  if (F.p1.w < 0.5 || sunDir.y < 0.03) { return 1.0; }
  var sh = 1.0;
  var sp = pos + sunDir * 55.0;
  var stepLen = 85.0;
  for (var i = 0; i < 40; i++) {
    let uv = sp.xz / F.windSpan.zw + 0.5;
    if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) { break; }
    var h = textureSampleLevel(heightsTex, texSamp, uv, 0.0).r * F.p0.z;
    // 近距离步长内叠加几何位移场（锚点系浮雕 + 岩石细节）→ 阴影与渲染几何同源；
    // 步长超过浮雕波长后不再叠加（防步进混叠）
    if (stepLen < 320.0) {
      let hm = h / max(F.p0.z, 0.001);
      h = h + detailA(sp.xz, hm, detAmp) * F.p0.z;
      h = h + detailB(sp.xz) * 0.55 * F.p0.z * detAmp * nearMask(sp.xz, focusXZ) * smoothstep(2.0, 14.0, hm);
    }
    // 曲率修正：采样高度场未弯曲，而几何已径向抬升 → 减去抛物线落差
    let drop = (sp.x * sp.x + sp.z * sp.z) / 12742000.0;
    sh = min(sh, smoothstep(0.0, 45.0 + f32(i) * 26.0, sp.y - (h - drop)));
    if (sh <= 0.0) { return 0.0; }
    sp = sp + sunDir * stepLen;
    stepLen = stepLen * 1.24;
  }
  return sh;
}
fn terrainShadowShort(pos: vec3f, sunDir: vec3f) -> f32 {
  if (F.p1.w < 0.5 || sunDir.y < 0.03) { return 1.0; }
  var sh = 1.0;
  var sp = pos + sunDir * 40.0;
  var stepLen = 70.0;
  for (var i = 0; i < 16; i++) {
    let uv = sp.xz / F.windSpan.zw + 0.5;
    if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) { break; }
    let h = textureSampleLevel(heightsTex, texSamp, uv, 0.0).r * F.p0.z;
    let drop = (sp.x * sp.x + sp.z * sp.z) / 12742000.0;
    sh = min(sh, smoothstep(0.0, 50.0 + f32(i) * 34.0, sp.y - (h - drop)));
    if (sh <= 0.0) { return 0.0; }
    sp = sp + sunDir * stepLen;
    stepLen = stepLen * 1.38;
  }
  return sh;
}
`;

/* ---------------- 天空 ---------------- */

export const WGSL_SKY = /* wgsl */ `
${WGSL_COMMON}
struct SkyVOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};
struct SkyFIn {
  @builtin(position) fpos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> SkyVOut {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = pts[vi];
  var o: SkyVOut;
  o.pos = vec4f(p, 0.99999, 1.0);
  o.ndc = p;
  return o;
}

@fragment
fn fs(inp: SkyFIn) -> @location(0) vec4f {
  let vNdc = inp.ndc;
  let dir = normalize(F.camFwd.xyz + vNdc.x * F.p2.z * F.p2.w * F.camRight.xyz + vNdc.y * F.p2.z * F.camUp.xyz);
  let t = clamp(dir.y, -1.0, 1.0);
  let spaceMix = F.gMisc.z;
  var col = mix(F.skyHorizon.xyz, F.skyZenith.xyz, pow(max(t, 0.0), 0.5));
  if (t < 0.0) { col = F.fogColor.xyz; }
  // 升空：大气渐隐 → 太空黑
  col = mix(col, vec3f(0.0025, 0.0035, 0.007), spaceMix);
  // 星空（确定性哈希点阵，视线方向量化；地平线下不生成）
  if (spaceMix > 0.01 && dir.y > -0.25) {
    let cell = floor(dir * 230.0);
    let star = step(0.9972, hash12(cell.xy + cell.z * 17.17));
    let tw = 0.55 + 0.45 * sin(F.p0.x * 2.1 + hash12(cell.zx) * 43.0);
    col = col + vec3f(0.88, 0.91, 1.0) * star * tw * spaceMix * 0.9;
  }
  let sd = dot(dir, F.sunDir.xyz);
  col = col + F.sunColor.xyz * (pow(max(sd, 0.0), 900.0) * 1.7 + pow(max(sd, 0.0), 7.0) * 0.13);
  let azW = pow(max(dot(normalize(dir.xz + vec2f(1e-4, 1e-4)), normalize(F.sunDir.xz + vec2f(1e-4, 1e-4))), 0.0), 3.0);
  col = col + F.sunColor.xyz * azW * exp(-max(dir.y, 0.0) * 7.0) * step(0.0, dir.y) * (1.0 - F.sunColor.y) * 0.5 * (1.0 - spaceMix);
  if (dir.y > 0.015) {
    let cp = dir.xz / (dir.y + 0.14) * 9000.0 + F.windSpan.xy * F.p0.x * 26.0;
    let cn = fbm(cp * 0.00007);
    let cover = smoothstep(1.0 - F.p2.y * 1.15, 1.02 - F.p2.y * 0.9, cn);
    let lit = 0.55 + 0.45 * max(F.sunDir.y, 0.0);
    let cloudCol = mix(vec3f(0.98, 0.99, 1.0) * lit, vec3f(0.40, 0.43, 0.49) * lit, smoothstep(0.5, 0.95, cn));
    let fade = smoothstep(0.015, 0.12, dir.y);
    col = mix(col, cloudCol, cover * 0.92 * fade * (1.0 - spaceMix));
  }
  col = mix(col, F.fogColor.xyz, F.p2.x * exp(-max(dir.y, 0.0) * 8.0) * 0.75 * (1.0 - spaceMix));
  return vec4f(toneFilm(col), 1.0);
}
`;

/* ---------------- 全球球体（全瓦片拼接 · 等距圆柱全球表格 → 球面位移） ----------------
 * 活动窗口（流式高程镜像）内逐片元丢弃；窗口邻接带下沉；
 * 窗口内「仿射平面坐标径向抬升」经锚点框架旋转到全球帧，远域用地理球面方向。 */

export const WGSL_GLOBE = /* wgsl */ `
${WGSL_COMMON}
@group(0) @binding(12) var globeH: texture_2d<i32>;

const R_PLANET: f32 = 6371000.0;
fn dlon180(d: f32) -> f32 {
  return (d + 540.0) % 360.0 - 180.0;
}
struct GOut {
  @builtin(position) pos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) rel: vec3f,
  @location(2) dir: vec3f,
  @location(3) h: f32,
  @location(4) lat: f32,
  @location(5) dlon: f32,
  @location(6) planar: vec2f,
};
struct GIn {
  @builtin(position) fpos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) rel: vec3f,
  @location(2) dir: vec3f,
  @location(3) h: f32,
  @location(4) lat: f32,
  @location(5) dlon: f32,
  @location(6) planar: vec2f,
};

fn globeSample(lat: f32, lon: f32) -> f32 {
  let w = F.gMisc.x;
  let hh = F.gMisc.y;
  let u = ((fract((lon + 180.0) / 360.0) * w - 0.5) + w) % w;
  let v = clamp((90.0 - lat) / 180.0 * hh - 0.5, 0.0, hh - 1.001);
  let iu = floor(u);
  let iv = floor(v);
  let fr = vec2f(u - iu, v - iv);
  let iu1 = (iu + 1.0) % w;
  let iv1 = min(iv + 1.0, hh - 1.0);
  // texture_2d<i32> 的 textureLoad 坐标必须为 vec2<i32>（WGSL 无 f32→u32/i32 隐式转换）
  let h00 = f32(textureLoad(globeH, vec2i(i32(iu), i32(iv)), 0).r);
  let h10 = f32(textureLoad(globeH, vec2i(i32(iu1), i32(iv)), 0).r);
  let h01 = f32(textureLoad(globeH, vec2i(i32(iu), i32(iv1)), 0).r);
  let h11 = f32(textureLoad(globeH, vec2i(i32(iu1), i32(iv1)), 0).r);
  return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
}

@vertex
fn vs(@location(0) aDir: vec3f) -> GOut {
  let dG = normalize(aDir);
  let lat = degrees(asin(clamp(dot(dG, F.gPole.xyz), -1.0, 1.0)));
  let lonAbs = dlon180(degrees(atan2(dot(dG, F.gEast.xyz), dot(dG, F.gEq.xyz))) + F.gAux.x);
  let hg = globeSample(lat, lonAbs);
  let latC = (F.gConf0.x + F.gConf0.y) * 0.5;
  let lonC = (F.gConf0.z + F.gConf0.w) * 0.5;
  let halfLat = (F.gConf0.x - F.gConf0.y) * 0.5;
  let halfLon = (F.gConf0.w - F.gConf0.z) * 0.5;
  let dL = dlon180(lonAbs - lonC);
  let exD = max(abs(dL) - halfLon, 0.0);
  let eyD = max(abs(lat - latC) - halfLat, 0.0);
  let wRg = 1.0 - smoothstep(0.0, 0.42, max(exD, eyD));
  let x = dL / (2.0 * halfLon) * F.gConf1.x;
  let z = (latC - lat) / halfLat * F.gConf1.y * 0.5;
  let hr = textureSampleLevel(heightsTex, texSamp, vec2f(x / F.gConf1.x, z / F.gConf1.y) + 0.5, 0.0).r;
  var h = mix(hg, hr, wRg) * F.gConf1.z;
  // 覆盖矩形内部整体下沉 250m（4km 边界渐变；与 GL 同步）—— 下沉作用于钳制之后，
  // 海洋也随之沉降，避免与水面网格共面 z-fight。
  let dEdge = min(min(x - F.gClip.x, F.gClip.y - x), min(z - F.gClip.z, F.gClip.w - z));
  let gSink = 250.0 * smoothstep(0.0, 4000.0, dEdge);
  h = h - gSink;
  let M = mat3x3f(F.actM0.xyz, F.actM1.xyz, F.actM2.xyz);
  let Mi = mat3x3f(F.actMi0.xyz, F.actMi1.xyz, F.actMi2.xyz);
  let hd = max(h, 0.0) - gSink;
  let plL = normalize(vec3f(x, R_PLANET, z));
  let posG = mix(dG * (R_PLANET + hd), M * (plL * (R_PLANET + hd)), wRg) + vec3f(0.0, -R_PLANET, 0.0);
  let rel = Mi * (posG - F.focusW.xyz);
  var o: GOut;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.nrm = Mi * normalize(posG + vec3f(0.0, R_PLANET, 0.0));
  o.rel = rel;
  o.dir = Mi * dG;
  o.h = h;
  o.lat = lat;
  o.dlon = lonAbs;
  o.planar = vec2f(x, z);
  return o;
}

@fragment
fn fs(inp: GIn) -> @location(0) vec4f {
  // 覆盖矩形内不再逐片元丢弃（v16.1，与 GL 同步）：VS 已将矩形内部整体下沉 250m，
  // 由深度测试让高分辨率地形自然遮挡 —— 分块剔除缺陷时球体恒定兜底，永不露黑。
  let n = normalize(inp.nrm);
  let viewDir = normalize(F.eyeRel.xyz - inp.rel);
  let ndl = dot(n, F.sunDir.xyz);
  let dayF = smoothstep(-0.10, 0.16, ndl);
  var col: vec3f;
  if (inp.h < 0.5) {
    // 海洋：源数据无测深（哨兵填充 0m）→ 深海基色 + 洋流噪声微变，不含浅滩逻辑
    let swirl = fbm(inp.dir.xz * 8.0 + inp.dir.y * 4.1);
    let oc = mix(vec3f(0.015, 0.065, 0.125), vec3f(0.030, 0.105, 0.170), swirl);
    let spec = pow(max(dot(reflect(-F.sunDir.xyz, n), viewDir), 0.0), 110.0);
    let fres = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
    col = oc * (0.24 + 0.9 * dayF) + F.sunColor.xyz * spec * 1.1 * dayF
        + vec3f(0.30, 0.46, 0.66) * fres * dayF * 0.38;
  } else {
    // 地貌：纬度带 + 海拔雪线 + 副热带干旱带 + 湿度噪声
    let latA = abs(inp.lat);
    let n1 = fbm(inp.dir.xz * 5.3 + inp.dir.y * 2.9);
    let n2 = fbm(inp.dir.yx * 12.7 + 4.1);
    let snowLine = 2500.0 - latA * 30.0 + (n1 - 0.5) * 1300.0;
    let snowF = clamp(smoothstep(snowLine, snowLine + 420.0, inp.h) + smoothstep(57.0, 66.0, latA + n2 * 7.0), 0.0, 1.0);
    let desert = smoothstep(12.0, 20.0, latA) * (1.0 - smoothstep(30.0, 40.0, latA)) * smoothstep(0.42, 0.72, n1);
    let veg = mix(vec3f(0.13, 0.24, 0.10), vec3f(0.36, 0.36, 0.16), n2);
    var land = mix(mix(veg, vec3f(0.58, 0.49, 0.31), desert), vec3f(0.36, 0.33, 0.30), smoothstep(2100.0, 3300.0, inp.h) * 0.72);
    land = mix(land, vec3f(0.92, 0.95, 0.98), snowF);
    col = land * (0.30 + 1.05 * max(ndl, 0.0));
  }
  // 云层（球面噪声带，随风漂移，与云量滑块同控）
  if (F.p2.y > 0.01) {
    let cp = inp.dir.xz / max(0.32, abs(inp.dir.y) + 0.34) * 2.1 + F.windSpan.xy * F.p0.x * 0.015;
    let c = fbm(cp * 2.9) * 0.65 + fbm(cp * 8.3) * 0.35;
    let cover = smoothstep(1.0 - F.p2.y * 1.08, 1.03 - F.p2.y * 0.85, c);
    col = mix(col, vec3f(0.97, 0.98, 1.0) * (0.42 + 0.58 * max(ndl, 0.0)), cover * 0.88);
  }
  // 夜面 + 晨昏线
  col = mix(vec3f(0.008, 0.013, 0.026), col, dayF);
  // 大气缘（瑞利散射近似：掠射蓝色亮缘，向光侧增强）
  let rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.7);
  let rimDay = 0.22 + 0.78 * clamp(dot(n, F.sunDir.xyz) * 0.6 + 0.42, 0.0, 1.0);
  col = mix(col, vec3f(0.44, 0.64, 0.94), rim * 0.62 * rimDay);
  // 大气雾（与地形/水面同一雾模型；密度随眼位海拔衰减 → 地表时接缝无痕，轨道时归零）
  let gdist = length(inp.rel);
  let gfog = 1.0 - exp(-pow(gdist * F.gMisc.w, 1.4));
  col = mix(col, F.fogColor.xyz, min(gfog, 1.0));
  return vec4f(toneFilm(col), 1.0);
}
`;

/* ---------------- 地形（VS 高程位移 + 近景浮雕；7 个 LOD 管线以 LEVEL 组常量区分 0..6 = L-3..L3） ---------------- */

export const WGSL_TERRAIN = /* wgsl */ `
${WGSL_COMMON}
@group(0) @binding(5) var<storage, read> chunkDescs: array<vec4f>;
override LEVEL: u32 = 0;

fn baseFor(l: u32) -> f32 {
  var b = F.bases.x;
  if (l == 1u) { b = F.bases.y; }
  if (l == 2u) { b = F.bases.z; }
  if (l == 3u) { b = F.bases.w; }
  if (l == 4u) { b = F.bases2.x; }
  if (l == 5u) { b = F.bases2.y; }
  if (l == 6u) { b = F.bases2.z; }
  return b;
}

struct TVOut {
  @builtin(position) pos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) wpos: vec3f,
  @location(2) rel: vec3f,
  @location(3) hm: f32,
  @location(4) gdir: vec3f,
  @location(5) glat: f32,
};
struct TFIn {
  @builtin(position) fpos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) wpos: vec3f,
  @location(2) rel: vec3f,
  @location(3) hm: f32,
  @location(4) gdir: vec3f,
  @location(5) glat: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TVOut {
  let desc = chunkDescs[u32(baseFor(LEVEL)) + ii];
  let lv = desc.z;                 // -3..3（浮点级别）
  let strideF = exp2(lv);          // 网格步长（可 <1：亚像元细分）
  // 全级别恒定 65×65 顶点：步长 ×2^level 与块边长 ×2^level 同比 → 覆盖完整逻辑范围。
  // 此前 lv≥1 顶点数按 2^level 缩减而步长只放大 2^level，网格仅覆盖左上角 1/2^level，
  // 远场块之间出现巨大空隙且被球体丢弃区覆盖 → 升空后呈太空黑块（v16.1 修复，与 GL 同源）。
  let n = 65u;
  let nn = n * n;
  var ix: u32 = 0u;
  var iz: u32 = 0u;
  var skirtM = 0.0;
  if (vi < nn) {
    ix = vi % n;
    iz = vi / n;
  } else {
    let k = vi - nn;
    let side = k / n;
    let kk = k % n;
    ix = kk;
    iz = 0u;
    if (side == 1u) { iz = n - 1u; }
    if (side == 2u) { ix = 0u; iz = kk; }
    if (side == 3u) { ix = n - 1u; iz = kk; }
    skirtM = desc.w;
  }
  let gxf = clamp(f32(desc.x) + f32(ix) * strideF, 0.0, F.grid.x - 1.0);
  let gzf = clamp(f32(desc.y) + f32(iz) * strideF, 0.0, F.grid.y - 1.0);
  let hC = heightGrid(gxf, gzf);
  var y = (hC + detailA(gridWorld(gxf, gzf), hC, F.p3.x)) * F.p0.z;
  let wm = textureSampleLevel(waterTex, texSamp, (vec2f(gxf, gzf) + 0.5) / F.grid.xy, 0.0).r;
  if (wm > 0.9) { y = min(y, -2.0); }
  y = y - skirtM * F.p0.z;
  let wpos = liftCurved(gridWorld(gxf, gzf), y);   // 曲率弯曲：径向抬升到球面
  var nrm = vec3f(0.0, 1.0, 0.0);
  if (vi < nn) {
    // 法线差分间距恒定 ±1 采样（与 LOD 无关）：相邻不同级网格的共享边顶点采样
    // 同一对格点 → 法线逐位相等 → 无光照接缝（与 GL 网格烘焙严格同式）。
    let gL = max(gxf - 1.0, 0.0);
    let gR = min(gxf + 1.0, F.grid.x - 1.0);
    let gU = max(gzf - 1.0, 0.0);
    let gD = min(gzf + 1.0, F.grid.y - 1.0);
    let hL = heightGrid(gL, gzf) + detailA(gridWorld(gL, gzf), heightGrid(gL, gzf), F.p3.x);
    let hR = heightGrid(gR, gzf) + detailA(gridWorld(gR, gzf), heightGrid(gR, gzf), F.p3.x);
    let hU = heightGrid(gxf, gU) + detailA(gridWorld(gxf, gU), heightGrid(gxf, gU), F.p3.x);
    let hD = heightGrid(gxf, gD) + detailA(gridWorld(gxf, gD), heightGrid(gxf, gD), F.p3.x);
    let gx = (hR - hL) / max((gR - gL) * F.grid.z, 0.0001) * F.p0.z;
    let gzn = (hD - hU) / max((gD - gU) * F.grid.w, 0.0001) * F.p0.z;
    let len = length(vec3f(gx, 1.0, gzn));
    nrm = vec3f(-gx / len, 1.0 / len, -gzn / len);
  }
  let rel = wpos - vec3f(F.focus.x, 0.0, F.focus.y);
  // 远景一致化：窗口内片元的全球方向与球体 vDir 在窗口区域逐点同源 → 共享噪声场；
  // 纬度由锚点 up（actM 第二列）点积解算
  let gwd = gridWorld(gxf, gzf);
  let plDir = normalize(vec3f(gwd.x, 6371000.0, gwd.y));
  var o: TVOut;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.nrm = nrm;
  o.wpos = wpos;
  o.rel = rel;
  o.hm = y;   // 弯曲前真实海拔（含夸张，物质带用）
  o.gdir = plDir;
  o.glat = degrees(asin(clamp(dot(F.actM1.xyz, plDir), -1.0, 1.0)));
  return o;
}

@fragment
fn fs(inp: TFIn) -> @location(0) vec4f {
  let vN = inp.nrm;
  let vPos = inp.wpos;
  let vRel = inp.rel;
  let n = normalize(vN);
  let p = vPos.xz;
  let hM = inp.hm / F.p0.z;   // 弯曲前真实海拔（米，物质带用）
  let steep = 1.0 - n.y;
  let wm = waterNearestUv(p / F.windSpan.zw + 0.5);
  let dist = length(vRel);
  let focusXZ = vPos.xz - vRel.xz;
  let detAmp = F.p3.x;
  let globeBlend = F.p3.y;
  let cloudCover = F.p3.z;

  let n1 = fbm(p * 0.00033);
  let n2 = fbm(p * 0.0021);
  let n3 = fbm(p * 0.011);
  let snowLine = F.p1.x + (n1 - 0.5) * 520.0 + (n2 - 0.5) * 150.0;
  let treeLine = F.p1.y + (n1 - 0.5) * 380.0 + (n2 - 0.5) * 110.0;

  let slopeF = smoothstep(0.16, 0.42, steep);
  var snowF = smoothstep(snowLine, snowLine + 90.0, hM) * (1.0 - slopeF * 0.6);
  let rockHigh = smoothstep(snowLine - 280.0, snowLine - 60.0, hM);
  let meadowF = smoothstep(treeLine + 150.0, treeLine - 80.0, hM);
  let moisture = fbm(p * 0.0008 + vec2f(41.7));
  var meadow = mix(vec3f(0.16, 0.27, 0.12), vec3f(0.44, 0.46, 0.24), smoothstep(0.35, 0.75, moisture));
  let canopy = meadowF * smoothstep(0.4, 0.68, n2) * 0.5;
  meadow = mix(meadow, vec3f(0.09, 0.17, 0.08), canopy);
  let strata = sin(hM * 0.013 + (n1 - 0.5) * 9.0) * 0.5 + 0.5;
  var rock = mix(vec3f(0.38, 0.35, 0.31), vec3f(0.52, 0.49, 0.45), n3);
  rock = mix(rock, rock * vec3f(1.12, 0.99, 0.90), strata * 0.4);
  let snow = vec3f(0.93, 0.96, 0.99);
  let rockMix = clamp(rockHigh + slopeF * (1.0 - snowF), 0.0, 1.0);
  var col = mix(meadow, rock, rockMix);
  col = mix(col, snow, snowF);
  let glacier = snowF * smoothstep(0.20, 0.38, steep);
  col = mix(col, vec3f(0.50, 0.68, 0.74), glacier * 0.8);
  let ridge = 1.0 - abs(2.0 * vnoise(p * 0.008) - 1.0);
  let crev = smoothstep(0.965, 0.995, ridge)
    * snowF * (1.0 - smoothstep(0.22, 0.40, steep))
    * smoothstep(0.52, 0.72, fbm(p * 0.0009 + vec2f(7.3)))
    * exp(-dist * 0.00010);
  col = mix(col, vec3f(0.30, 0.42, 0.47), crev * 0.6);
  let shoreF = smoothstep(9.0, 0.8, hM) * (1.0 - snowF) * step(0.05, hM);
  col = mix(col, vec3f(0.42, 0.37, 0.28), shoreF * 0.75);
  let lakeF = step(0.30, wm) * step(wm, 0.72) * smoothstep(0.03, 0.008, steep);
  col = mix(col, vec3f(0.11, 0.25, 0.30), lakeF);

  // ---- 近景材质细化：碎石斑驳 + 草甸尘土斑 + 雪面融洞 ----
  let nearFade2 = (1.0 - smoothstep(500.0, 2200.0, dist)) * detAmp;
  if (nearFade2 > 0.001) {
    let gr = vnoise(p * 0.85);
    col = col * (1.0 + (gr - 0.5) * 0.16 * (1.0 - snowF) * nearFade2);
    let dirt = smoothstep(0.60, 0.78, fbm(p * 0.004 + vec2f(13.1)));
    col = mix(col, vec3f(0.30, 0.24, 0.16),
      dirt * (1.0 - rockMix) * (1.0 - snowF) * (1.0 - shoreF) * (1.0 - lakeF) * nearFade2 * 0.55);
    let thaw = smoothstep(0.62, 0.8, fbm(p * 0.0028 + vec2f(77.7)));
    snowF = clamp(snowF - thaw * snowF * 0.4 * nearFade2, 0.0, 1.0);
  }

  let microFade = exp(-dist * 0.00022);
  var rough = mix(0.32, 1.0, rockMix);
  rough = mix(rough, 0.06, snowF);
  rough = mix(rough, 0.10, glacier);
  rough = mix(rough, 0.5, shoreF * 0.6);
  rough = mix(rough, 0.05, lakeF);
  let mp = mix(p, vec2f(dot(p, vec2f(0.71, -0.70)), vPos.y), smoothstep(0.28, 0.5, steep) * rockMix) * 0.09;
  let m0 = fbm(mp);
  let mx = fbm(mp + vec2f(1.1, 0.0));
  let my = fbm(mp + vec2f(0.0, 1.1));
  let micro = vec3f((mx - m0), 0.0, (my - m0)) * rough * 1.6 * microFade;
  var nn2 = normalize(n + micro);

  // ---- 近景浮雕法线带（170m/53m/19m 岩石三频 + 5.5m 碎石 + 浮雕坡度补偿），雪面平滑化 ----
  // 顶点法线固定 ±1 采样差分（跨 LOD 无缝），不解析 715m 浮雕带高频分量 →
  // 片元级前向差分补足（与几何位移同场），近景岩脊/丘包光影随几何一致。
  var cav = 1.0;
  let nearFade = (1.0 - smoothstep(900.0, 3200.0, dist)) * detAmp;
  if (nearFade > 0.001) {
    let e = 42.0;
    let b0 = detailB(p);
    var gB = vec2f(detailB(p + vec2f(e, 0.0)) - b0, detailB(p + vec2f(0.0, e)) - b0) / e;
    gB = gB * (1.0 - snowF * 0.75);
    let gv = vnoise(p * 0.85);
    let gG = vec2f(vnoise(p * 0.85 + vec2f(0.9, 0.0)) - gv, vnoise(p * 0.85 + vec2f(0.0, 0.9)) - gv) / 0.9;
    let eR = 55.0;
    let r0 = detailA(p, hM, detAmp);
    let gR = vec2f(detailA(p + vec2f(eR, 0.0), hM, detAmp) - r0,
                   detailA(p + vec2f(0.0, eR), hM, detAmp) - r0) / eR;
    nn2 = normalize(nn2 + vec3f(-gB.x, 0.0, -gB.y) * nearFade * 0.85 + vec3f(-gG.x, 0.0, -gG.y) * nearFade * 0.30 * (1.0 - snowF)
                         + vec3f(-gR.x, 0.0, -gR.y) * nearFade * 1.05);
    cav = mix(0.74, 1.0, smoothstep(-7.0, 2.5, b0));
  }

  let sh = terrainShadow(vPos, F.sunDir.xyz, focusXZ, detAmp);
  let dl = dot(nn2, F.sunDir.xyz);
  var diff = max(dl, 0.0);
  let diffSnow = clamp((dl + 0.42) / 1.42, 0.0, 1.0);
  diff = mix(diff, diffSnow, snowF) * sh;
  let amb = F.ambient.xyz * (0.55 + 0.45 * nn2.y) * mix(1.0, cav, nearFade);
  let viewDir = normalize(F.eyeRel.xyz - vRel);
  let hv = normalize(F.sunDir.xyz + viewDir);
  let specPow = mix(mix(10.0, 16.0, rockMix), 96.0, max(snowF, lakeF));
  let specI = mix(mix(0.02, 0.05, rockMix), 0.30, max(snowF, lakeF)) + shoreF * 0.15;
  let spec = pow(max(dot(nn2, hv), 0.0), specPow) * specI * sh;
  let cs = 1.0 - F.p1.z * smoothstep(0.55, 0.85, fbm(p * 0.00006 + F.windSpan.xy * F.p0.x * 0.026));
  var lit = col * (F.sunColor.xyz * diff * cs * 1.35 + amb) + F.sunColor.xyz * spec * cs;
  let spark = step(0.9975, hash12(floor(p * 3.5) + vec2f(floor(F.p0.x * 2.5) * 7.31, floor(F.p0.x * 1.7) * 3.17)));
  lit = lit + F.sunColor.xyz * spark * snowF * pow(max(dot(reflect(-viewDir, nn2), F.sunDir.xyz), 0.0), 3.0) * 1.4 * microFade;
  if (hM < 0.0) {
    lit = mix(vec3f(0.05, 0.14, 0.16), vec3f(0.10, 0.22, 0.23), smoothstep(-60.0, 0.0, hM));
    let ca = fbm(p * 0.02 + vec2f(F.p0.x * 0.33)) * fbm(p * 0.023 - vec2f(F.p0.x * 0.27));
    lit = lit + vec3f(0.32, 0.46, 0.46) * pow(smoothstep(0.14, 0.42, ca), 2.0) * smoothstep(-34.0, -0.5, hM) * (0.35 + 0.65 * max(F.sunDir.y, 0.0));
  }

  // 远景一致化：升空后窗口地形片元 → 全球球体同源色板（与 GL 路径逐式一致），
  // 窗口矩形与球体的材质边界在任意观测高度上均不可见。
  if (globeBlend > 0.001) {
    let gdir = normalize(inp.gdir);
    let ndlG = dot(n, F.sunDir.xyz);
    let dayF = smoothstep(-0.10, 0.16, ndlG);
    let hE = hM * F.p0.z;
    var gcol: vec3f;
    if (hE < 0.5) {
      let swirl = fbm(gdir.xz * 8.0 + vec2f(gdir.y * 4.1));
      let oc = mix(vec3f(0.015, 0.065, 0.125), vec3f(0.030, 0.105, 0.170), swirl);
      let specG = pow(max(dot(reflect(-F.sunDir.xyz, n), viewDir), 0.0), 110.0);
      let fres = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
      gcol = oc * (0.24 + 0.9 * dayF) + F.sunColor.xyz * specG * 1.1 * dayF + vec3f(0.30, 0.46, 0.66) * fres * dayF * 0.38;
    } else {
      let latA = abs(inp.glat);
      let gn1 = fbm(gdir.xz * 5.3 + vec2f(gdir.y * 2.9));
      let gn2 = fbm(gdir.yx * 12.7 + vec2f(4.1));
      let snowLineG = 2500.0 - latA * 30.0 + (gn1 - 0.5) * 1300.0;
      let snowFG = clamp(smoothstep(snowLineG, snowLineG + 420.0, hE) + smoothstep(57.0, 66.0, latA + gn2 * 7.0), 0.0, 1.0);
      let desert = smoothstep(12.0, 20.0, latA) * (1.0 - smoothstep(30.0, 40.0, latA)) * smoothstep(0.42, 0.72, gn1);
      let veg = mix(vec3f(0.13, 0.24, 0.10), vec3f(0.36, 0.36, 0.16), gn2);
      var land = mix(mix(veg, vec3f(0.58, 0.49, 0.31), desert), vec3f(0.36, 0.33, 0.30), smoothstep(2100.0, 3300.0, hE) * 0.72);
      land = mix(land, vec3f(0.92, 0.95, 0.98), snowFG);
      gcol = land * (0.30 + 1.05 * max(ndlG, 0.0));
    }
    if (cloudCover > 0.01) {
      let cp = gdir.xz / max(0.32, abs(gdir.y) + 0.34) * 2.1 + F.windSpan.xy * F.p0.x * 0.015;
      let c = fbm(cp * 2.9) * 0.65 + fbm(cp * 8.3) * 0.35;
      let cover = smoothstep(1.0 - cloudCover * 1.08, 1.03 - cloudCover * 0.85, c);
      gcol = mix(gcol, vec3f(0.97, 0.98, 1.0) * (0.42 + 0.58 * max(ndlG, 0.0)), cover * 0.88);
    }
    gcol = mix(vec3f(0.008, 0.013, 0.026), gcol, dayF);   // 夜面/晨昏线
    lit = mix(lit, gcol, globeBlend);
  }

  var fogF = 1.0 - exp(-pow(dist * F.p0.w, 1.4));
  let fogTop = mix(90.0, 340.0, F.p2.x);
  let hf = F.p2.x * smoothstep(fogTop + 240.0, fogTop - 160.0, hM) * (0.55 + 0.5 * fbm(p * 0.00045 + F.windSpan.xy * F.p0.x * 0.013));
  fogF = 1.0 - (1.0 - fogF) * (1.0 - min(hf, 1.0));
  return vec4f(toneFilm(mix(lit, F.fogColor.xyz, fogF)), 1.0);
}
`;

/* ---------------- 水面 ---------------- */

export const WGSL_WATER = /* wgsl */ `
${WGSL_COMMON}
struct WVOut {
  @builtin(position) pos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) rel: vec3f,
};
struct WFIn {
  @builtin(position) fpos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) rel: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> WVOut {
  let ix = vi % 128u;
  let iz = vi / 128u;
  let halfX = F.windSpan.z * 0.5 + 4000.0;
  let halfZ = F.windSpan.w * 0.5 + 4000.0;
  let x = -halfX + (f32(ix) / 127.0) * 2.0 * halfX;
  let z = -halfZ + (f32(iz) / 127.0) * 2.0 * halfZ;
  // 海面 = 海平面球面（h=0 径向抬升即为球面本身，与全球球体海洋逐点重合）
  let wpos = liftCurved(vec2f(x, z), 0.0);
  let rel = wpos - vec3f(F.focus.x, 0.0, F.focus.y);
  var o: WVOut;
  o.pos = F.viewProj * vec4f(rel, 1.0);
  o.wpos = wpos;
  o.rel = rel;
  return o;
}

@fragment
fn fs(inp: WFIn) -> @location(0) vec4f {
  let vPos = inp.wpos;
  let vRel = inp.rel;
  let p = vPos.xz;
  let uv = p / F.windSpan.zw + 0.5;
  let bedM = textureSample(heightsTex, texSamp, uv).r;
  let wmask = waterNearestUv(uv);
  let depth = -bedM;
  if (depth <= 0.02 && wmask < 0.9) { discard; }
  let effDepth = max(depth, wmask * 8.0);
  let dist = length(vRel);
  let distFade = exp(-dist * 0.00035);
  let amp = (0.35 + F.p0.y * 1.9) * mix(0.08, 1.0, distFade);
  let wp = p * 0.016;
  let w0 = fbm(wp + F.p0.x * vec2f(0.62, 0.34));
  let wx = fbm(wp + vec2f(1.2, 0.0) + F.p0.x * vec2f(0.62, 0.34));
  let wy = fbm(wp + vec2f(0.0, 1.2) + F.p0.x * vec2f(0.62, 0.34));
  let ripple = fbm(p * 0.10 + F.p0.x * vec2f(1.7, -1.1));
  let grad = vec2f(wx - w0, wy - w0) * amp + vec2f(ripple - 0.5) * 0.25 * amp * distFade;
  let n = normalize(vec3f(-grad.x, 1.0, -grad.y));
  let viewDir = normalize(F.eyeRel.xyz - vRel);
  let fres = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0) * 0.9 + 0.06;
  let skyRef = mix(F.skyHorizon.xyz, F.skyZenith.xyz, clamp(reflect(-viewDir, n).y, 0.0, 1.0));
  let sh = terrainShadow(vPos, F.sunDir.xyz, vPos.xz - vRel.xz, F.p3.x);   // vPos 已曲率抬升
  let spec = pow(max(dot(reflect(-F.sunDir.xyz, n), viewDir), 0.0), 260.0) * (1.4 + F.p0.y * 2.6) * sh;
  let base = mix(vec3f(0.030, 0.115, 0.135), vec3f(0.10, 0.31, 0.33), smoothstep(0.0, 16.0, effDepth));
  var col = mix(base * (0.45 + 0.55 * sh), skyRef, fres) + F.sunColor.xyz * spec;
  let cap = smoothstep(0.66, 0.88, w0 + (ripple - 0.5) * 0.4) * smoothstep(0.18, 0.55, F.p0.y) * distFade;
  col = mix(col, vec3f(0.93, 0.96, 0.97), cap * 0.4);
  let foamN = fbm(p * 0.28 + vec2f(F.p0.x * 0.9));
  let foam = smoothstep(1.4, 0.1, effDepth + foamN * 0.8);
  col = mix(col, vec3f(0.92, 0.96, 0.97), foam * 0.6);
  let alpha = clamp(smoothstep(0.02, 1.1, max(depth, wmask)) * (0.75 + fres * 0.25) + foam * 0.4, 0.0, 1.0);
  var fogF = 1.0 - exp(-pow(dist * F.p0.w, 1.4));
  let hf = F.p2.x * 0.72 * exp(-dist * 0.00003);
  fogF = 1.0 - (1.0 - fogF) * (1.0 - hf);
  col = mix(col, F.fogColor.xyz, fogF);
  return vec4f(toneFilm(col), alpha);
}
`;

/* ---------------- 植被（树：实例数据来自 compute 产出，四向交叉面片） ---------------- */

export const WGSL_TREE = /* wgsl */ `
${WGSL_COMMON}
@group(0) @binding(4) var treeTex: texture_2d<f32>;
@group(0) @binding(7) var<storage, read> vegDataIn: array<vec4f>;
struct TreeVOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) leaf: f32,
  @location(2) relY: f32,
  @location(3) elev: f32,
  @location(4) fogDist: f32,
  @location(5) shadow: f32,
  @location(6) rel: vec3f,
};
struct TreeFIn {
  @builtin(position) fpos: vec4f,
  @location(0) uv: vec2f,
  @location(1) leaf: f32,
  @location(2) relY: f32,
  @location(3) elev: f32,
  @location(4) fogDist: f32,
  @location(5) shadow: f32,
  @location(6) rel: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TreeVOut {
  let iA = vegDataIn[ii * 2u];
  let iB = vegDataIn[ii * 2u + 1u];
  let q = vi / 4u;
  let c = vi % 4u;
  let aCorner = vec2f(f32(select(0u, 1u, c == 1u || c == 2u)), f32(select(0u, 1u, c >= 2u)));
  let h = iA.w;
  let elevM = iA.z / F.p0.z;
  let cvec = (aCorner - 0.5) * vec2f(h * 0.72, h);
  let ang = iB.x + f32(q) * 0.7853981634;
  let off = vec2f(cos(ang), -sin(ang)) * cvec.x;
  let relY = aCorner.y;
  let gust = 0.6 + 0.4 * sin(F.p0.x * 0.31 + iB.y * 0.7);
  let sway = (sin(F.p0.x * 1.6 + iB.y) + 0.35 * sin(F.p0.x * 3.4 + iB.y * 1.7)) * F.p0.y * 0.16 * gust;
  // 树基点随地表曲率弯曲（实例布局 (x,z,y,h) → 抬升后 (x, elev, z)）
  var base = liftCurved(vec2f(iA.x, iA.y), iA.z) - vec3f(F.focus.x, 0.0, F.focus.y);
  base = base + vec3f(F.windSpan.x, 0.0, F.windSpan.y) * sway * h * relY * relY;
  let world = base + vec3f(off.x, cvec.y + h * 0.5, off.y);   // 面片底部锚定树基
  let shd = terrainShadowShort(vec3f(iA.x, iA.z, iA.y), F.sunDir.xyz);
  let fogDist = distance(world, F.eyeRel.xyz);
  var o: TreeVOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = vec2f((iB.w + aCorner.x) / ${TREE_VARIANTS.toFixed(1)}, 1.0 - aCorner.y);
  o.leaf = iB.z;
  o.relY = relY;
  o.elev = elevM;
  o.fogDist = fogDist;
  o.shadow = shd;
  o.rel = world;
  return o;
}

@fragment
fn fs(inp: TreeFIn) -> @location(0) vec4f {
  let tx = textureSample(treeTex, texSamp, inp.uv);
  if (tx.a < 0.32) { discard; }
  let ao = tx.r;
  let tip = tx.g;
  let trunk = vec3f(0.23, 0.17, 0.11);
  let leafA = vec3f(0.12, 0.22, 0.09);
  let leafB = vec3f(0.30, 0.38, 0.14);
  var col = mix(leafA, leafB, inp.leaf);
  col = mix(trunk, col, smoothstep(0.06, 0.2, 1.0 - inp.uv.y));   // 树干在面片底部
  let shade = (0.60 + 0.40 * inp.relY) * mix(1.08, 0.74, ao);
  col = col * (0.86 + 0.28 * vnoise(inp.uv * vec2f(46.0, 60.0) + inp.leaf * 7.0));
  let diff = (0.55 + 0.45 * max(F.sunDir.y, 0.0)) * (0.62 + 0.48 * inp.relY);
  var lit = col * (F.sunColor.xyz * diff * 1.1 * mix(0.42, 1.0, inp.shadow) + F.ambient.xyz) * shade;
  let viewDir = normalize(F.eyeRel.xyz - inp.rel);
  let back = pow(max(dot(viewDir, -F.sunDir.xyz), 0.0), 4.0);
  lit = lit + col * F.sunColor.xyz * back * tip * 0.55;
  let snowOnTree = smoothstep(F.p1.x - 420.0, F.p1.x - 80.0, inp.elev);
  lit = mix(lit, vec3f(0.88, 0.91, 0.95) * shade * mix(0.45, 1.0, inp.shadow), snowOnTree * 0.55);
  var fogF = 1.0 - exp(-pow(inp.fogDist * F.p0.w, 1.4));
  let fogTop = mix(90.0, 340.0, F.p2.x);
  let hf = F.p2.x * smoothstep(fogTop + 240.0, fogTop - 160.0, inp.elev) * 0.7;
  fogF = 1.0 - (1.0 - fogF) * (1.0 - hf);
  return vec4f(toneFilm(mix(lit, F.fogColor.xyz, fogF)), 1.0);
}
`;

/* ---------------- 近景草丛（双向交叉面片，风摇 + 逆光透射） ---------------- */

export const WGSL_GRASS = /* wgsl */ `
${WGSL_COMMON}
@group(0) @binding(4) var grassTex: texture_2d<f32>;
@group(0) @binding(10) var<storage, read> grassDataIn: array<vec4f>;
struct GVOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) relY: f32,
  @location(2) tint: f32,
  @location(3) rel: vec3f,
  @location(4) fogDist: f32,
};
struct GFIn {
  @builtin(position) fpos: vec4f,
  @location(0) uv: vec2f,
  @location(1) relY: f32,
  @location(2) tint: f32,
  @location(3) rel: vec3f,
  @location(4) fogDist: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GVOut {
  let iA = grassDataIn[ii * 2u];
  let iB = grassDataIn[ii * 2u + 1u];
  let q = vi / 4u;
  let c = vi % 4u;
  let aCorner = vec2f(f32(select(0u, 1u, c == 1u || c == 2u)), f32(select(0u, 1u, c >= 2u)));
  let h = iA.w;
  let relY = aCorner.y;
  let gust = 0.65 + 0.35 * sin(F.p0.x * 0.5 + iB.y * 0.9);
  let sway = (sin(F.p0.x * 2.3 + iB.y) + 0.4 * sin(F.p0.x * 4.7 + iB.y * 1.9)) * F.p0.y * 0.28 * gust;
  let ang = iB.x + f32(q) * 1.5707963;
  let cvec = (aCorner - 0.5) * vec2f(h * 1.2, h);
  let off = vec2f(cos(ang), -sin(ang)) * cvec.x;
  // 草基点随地表曲率弯曲（实例布局 (x,z,y,h)）
  var base = liftCurved(vec2f(iA.x, iA.y), iA.z) - vec3f(F.focus.x, 0.0, F.focus.y);
  base = base + vec3f(F.windSpan.x, 0.0, F.windSpan.y) * sway * h * relY * relY;
  let world = base + vec3f(off.x, cvec.y + h * 0.5, off.y);   // 面片底部锚定草基
  var o: GVOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = vec2f((iB.w + aCorner.x) / 2.0, 1.0 - aCorner.y);
  o.relY = relY;
  o.tint = iB.z;
  o.rel = world;
  o.fogDist = distance(world, F.eyeRel.xyz);
  return o;
}

@fragment
fn fs(inp: GFIn) -> @location(0) vec4f {
  let a = textureSample(grassTex, texSamp, inp.uv).a;
  if (a < 0.4) { discard; }
  let dry = vec3f(0.34, 0.30, 0.14);
  let lush = vec3f(0.13, 0.28, 0.09);
  let tipC = mix(dry, lush, inp.tint) * 1.18;
  var col = mix(tipC * 0.42, tipC, smoothstep(0.0, 0.75, inp.relY));
  col = col * (0.85 + 0.3 * vnoise(inp.uv * vec2f(30.0, 44.0) + inp.tint * 5.0));
  let viewDir = normalize(F.eyeRel.xyz - inp.rel);
  let back = pow(max(dot(viewDir, -F.sunDir.xyz), 0.0), 4.0);
  var lit = col * (F.sunColor.xyz * (0.5 + 0.5 * max(F.sunDir.y, 0.0)) * 1.05 + F.ambient.xyz);
  lit = lit + tipC * F.sunColor.xyz * back * 0.5 * inp.relY;
  var fogF = 1.0 - exp(-pow(inp.fogDist * F.p0.w, 1.4));
  lit = mix(lit, F.fogColor.xyz, fogF);
  return vec4f(toneFilm(lit), 1.0);
}
`;

/* ---------------- 拾取标记 ---------------- */

export const WGSL_MARKER = /* wgsl */ `
${WGSL_COMMON}
struct MVOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
struct MFIn {
  @builtin(position) fpos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> MVOut {
  var pts = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let aCorner = pts[vi];
  let world = F.markerC.xyz + vec3f(aCorner.x * F.markerS.x, 0.0, aCorner.y * F.markerS.x);
  var o: MVOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = aCorner;
  return o;
}

@fragment
fn fs(inp: MFIn) -> @location(0) vec4f {
  let d = length(inp.uv);
  let ring = smoothstep(0.5, 0.42, d) * smoothstep(0.30, 0.38, d);
  let pulse = 0.75 + 0.25 * sin(d * 22.0);
  return vec4f(vec3f(1.0, 0.72, 0.2) * ring * pulse, ring);
}
`;

/* ---------------- 植被增殖 compute（树 + 草丛：适宜性并行评估 + atomic 追加 + 间接绘制参数） ---------------- */

export const WGSL_VEG = /* wgsl */ `
${WGSL_COMMON}
@group(0) @binding(6) var<storage, read_write> vegData: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> vegMeta: array<atomic<u32>>;
@group(0) @binding(9) var<uniform> VP: VegParams;
@group(0) @binding(10) var<storage, read_write> grassData: array<vec4f>;
@group(0) @binding(11) var<storage, read_write> grassMeta: array<atomic<u32>>;

fn hash2i(xi: i32, zi: i32) -> f32 {
  var h = (bitcast<u32>(xi) * 0x27d4eb2du) ^ (bitcast<u32>(zi) * 0x165667b1u);
  h = h ^ (h >> 15u);
  h = h * 0x85ebca6bu;
  h = h ^ (h >> 13u);
  return f32(h) * (1.0 / 4294967296.0);
}

@compute @workgroup_size(8, 8)
fn vegMain(@builtin(global_invocation_id) gid: vec3u) {
  let side = u32(VP.cellsSide);
  if (gid.x >= side || gid.y >= side) { return; }
  let cx = i32(gid.x) + i32(VP.baseCx);
  let cz = i32(gid.y) + i32(VP.baseCz);
  if (hash2i(cx, cz) > VP.keep) { return; }
  let jx = (hash2i(cx * 3 + 1, cz) - 0.5) * VP.cell;
  let jz = (hash2i(cx, cz * 3 + 2) - 0.5) * VP.cell;
  let x = f32(cx) * VP.cell + jx;
  let z = f32(cz) * VP.cell + jz;
  let dx = x - VP.focusX;
  let dz = z - VP.focusZ;
  let d2 = dx * dx + dz * dz;
  if (d2 > VP.r2max) { return; }
  if (waterNearest(x, z) > 0.001) { return; }
  let hSelf = heightWorldGrid(x, z);
  if (hSelf < 4.0 || hSelf > VP.snowLine - 260.0) { return; }
  let e = 60.0;
  let gx = (heightWorldGrid(x + e, z) - heightWorldGrid(x - e, z)) / (2.0 * e) * VP.exagg;
  let gz = (heightWorldGrid(x, z + e) - heightWorldGrid(x, z - e)) / (2.0 * e) * VP.exagg;
  if (atan(length(vec2f(gx, gz))) > 0.52) { return; }
  var sum = 0.0;
  for (var a = 0; a < 6; a++) {
    let ang = f32(a) / 6.0 * 6.28318530718;
    sum = sum + heightWorldGrid(x + cos(ang) * 2200.0, z + sin(ang) * 2200.0);
  }
  let rel = sum / 6.0 - hSelf;
  let nz = hash2i(i32(floor(x / 700.0)), i32(floor(z / 700.0))) * 0.35;
  let moist = clamp(0.45 + rel / 380.0 + nz, 0.0, 1.0);
  if (moist < 0.3) { return; }
  let elevT = clamp((hSelf - 300.0) / (VP.snowLine - 560.0), 0.0, 1.0);
  let heightM = 7.0 + (1.0 - elevT) * 9.0 + moist * 7.0 + hash2i(cx * 7, cz * 5) * 4.0;
  let slot = atomicAdd(&vegMeta[0], 1u);
  if (slot >= u32(VP.maxTrees)) { return; }
  let dR = detailA(vec2f(x, z), hSelf, VP.detailAmp);
  vegData[slot * 2u] = vec4f(x, z, (hSelf + dR) * VP.exagg, heightM);
  vegData[slot * 2u + 1u] = vec4f(
    hash2i(cx * 11, cz * 13) * 6.28318530718,
    hash2i(cx * 17, cz * 19) * 6.28318530718,
    moist * 0.7 + elevT * 0.3,
    floor(hash2i(cx * 23, cz * 29) * 4.0),
  );
}

/** 汇总树实例数 → drawIndexedIndirect 参数（GPU 驱动绘制，零 CPU 回读） */
@compute @workgroup_size(1)
fn vegFinalize() {
  let cnt = atomicLoad(&vegMeta[0]);
  atomicStore(&vegMeta[1], 24u);
  atomicStore(&vegMeta[2], min(cnt, u32(VP.maxTrees)));
  atomicStore(&vegMeta[3], 0u);
  atomicStore(&vegMeta[4], 0u);
  atomicStore(&vegMeta[5], 0u);
}

/** 近景草丛增殖：草甸带适宜性（海拔带/缓坡/非水体）逐候选格并行评估 */
@compute @workgroup_size(8, 8)
fn grassMain(@builtin(global_invocation_id) gid: vec3u) {
  let side = u32(VP.gCellsSide);
  if (gid.x >= side || gid.y >= side) { return; }
  let cx = i32(gid.x) + i32(VP.gBaseCx);
  let cz = i32(gid.y) + i32(VP.gBaseCz);
  if (hash2i(cx * 5 + 3, cz * 7 + 1) > VP.gKeep) { return; }
  let jx = (hash2i(cx * 9 + 2, cz) - 0.5) * VP.gCell;
  let jz = (hash2i(cx, cz * 11 + 4) - 0.5) * VP.gCell;
  let x = f32(cx) * VP.gCell + jx;
  let z = f32(cz) * VP.gCell + jz;
  let dx = x - VP.focusX;
  let dz = z - VP.focusZ;
  if (dx * dx + dz * dz > VP.gR2max) { return; }
  if (waterNearest(x, z) > 0.001) { return; }
  let hSelf = heightWorldGrid(x, z);
  if (hSelf < 2.5 || hSelf > VP.snowLine - 180.0) { return; }
  let e = 30.0;
  let gx = (heightWorldGrid(x + e, z) - heightWorldGrid(x - e, z)) / (2.0 * e) * VP.exagg;
  let gz = (heightWorldGrid(x, z + e) - heightWorldGrid(x, z - e)) / (2.0 * e) * VP.exagg;
  if (atan(length(vec2f(gx, gz))) > 0.55) { return; }
  let slot = atomicAdd(&grassMeta[0], 1u);
  if (slot >= u32(VP.gMax)) { return; }
  let dR = detailA(vec2f(x, z), hSelf, VP.detailAmp);
  grassData[slot * 2u] = vec4f(x, z, (hSelf + dR) * VP.exagg, 0.32 + hash2i(cx * 13 + 7, cz * 3) * 0.45);
  grassData[slot * 2u + 1u] = vec4f(
    hash2i(cx * 17 + 5, cz * 19) * 6.28318530718,
    hash2i(cx * 23, cz * 29 + 9) * 6.28318530718,
    0.3 + hash2i(cx * 31, cz * 37 + 2) * 0.7,
    floor(hash2i(cx * 41, cz * 43) * 2.0),
  );
}

/** 汇总草丛实例数 → drawIndexedIndirect 参数 */
@compute @workgroup_size(1)
fn grassFinalize() {
  let cnt = atomicLoad(&grassMeta[0]);
  atomicStore(&grassMeta[1], 12u);
  atomicStore(&grassMeta[2], min(cnt, u32(VP.gMax)));
  atomicStore(&grassMeta[3], 0u);
  atomicStore(&grassMeta[4], 0u);
  atomicStore(&grassMeta[5], 0u);
}
`;

/* ============================ 渲染器 ============================ */

const MIN_LEVEL = -3;
const MAX_LEVEL = 3;
/** LOD 距离环（索引 = 子级 + 3）：L-3←1.1km · L-2←3.6km · L-1←12km · L0←16km · L1←45km · L2←140km */
const RING_T = [1100, 3600, 12000, 16000, 45000, 140000];
const MAX_CHUNKS = 1024;
const MAX_TREES = 6000;
const VEG_CELL_M = 110;
const VEG_RADIUS_M = 9000;
const GRASS_CELL_M = 16;
const GRASS_RADIUS_M = 750;
/** 132 floats = 528B（含全球球体 uniform 组） */
const FRAME_FLOATS = 164;
const VEG_FLOATS = 24;
/** 全球球体：立方球每面细分段数 */
const GSEG = 160;

interface FrustumPlane { a: number; b: number; c: number; d: number }

/** WebGPU 约定：NDC 深度 0..1（与 GL 的 -1..1 不同） */
function perspectiveWGPU(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ]);
}

export class WebGPUTerrainRenderer {
  readonly backendName = "WebGPU · VS位移分块 + Compute植被";
  private dead = false;
  private msaaTex: GPUTexture | null = null;
  private depthTex: GPUTexture | null = null;
  private lastW = 0;
  private lastH = 0;
  private frameNo = 0;
  private frameArr = new Float32Array(FRAME_FLOATS);
  private vegArr = new Float32Array(VEG_FLOATS);
  private descArr = new Float32Array(MAX_CHUNKS * 4);
  private descCount = 0;
  private selCounts = [0, 0, 0, 0, 0, 0, 0];
  private selBases = [0, 0, 0, 0, 0, 0, 0];
  private lastVegKey = "";
  private lastGrassKey = "";
  private vegCountGpu = 0;
  private grassCountGpu = 0;
  private stageBufs: GPUBuffer[] = [];
  private stageIdx = 0;
  private stageBusy = false;
  private markerRel: [number, number, number] | null = null;

  private device: GPUDevice;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private bgRender: GPUBindGroup;
  private bgCompute: GPUBindGroup;
  private frameBuf: GPUBuffer;
  private vegParamBuf: GPUBuffer;
  private chunkBuf: GPUBuffer;
  private vegDataBuf: GPUBuffer;
  private vegMetaBuf: GPUBuffer;
  private grassDataBuf: GPUBuffer;
  private grassMetaBuf: GPUBuffer;
  private heightsTex: GPUTexture;
  private waterTex: GPUTexture;
  private treeTex: GPUTexture;
  private grassTex: GPUTexture;
  private globeTex: GPUTexture;
  private pipeSky: GPURenderPipeline;
  private pipeGlobe: GPURenderPipeline;
  private pipeTerrain: GPURenderPipeline[];
  private pipeWater: GPURenderPipeline;
  private pipeTree: GPURenderPipeline;
  private pipeGrass: GPURenderPipeline;
  private pipeMarker: GPURenderPipeline;
  private pipeVegMain: GPUComputePipeline;
  private pipeVegFinal: GPUComputePipeline;
  private pipeGrassMain: GPUComputePipeline;
  private pipeGrassFinal: GPUComputePipeline;
  private iboTerrain: GPUBuffer[] = [];
  private idxCountTerrain: number[] = [];
  private iboWater: GPUBuffer;
  private waterIdxCount: number;
  private iboTree: GPUBuffer;
  private iboGrass: GPUBuffer;
  private iboMarker: GPUBuffer;
  private vboGlobe: GPUBuffer;
  private iboGlobe: GPUBuffer;
  private globeIdxCount = 0;
  private gb: ReturnType<typeof globeBasis>;
  private coverRect: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  private texW = 0;
  private texH = 0;

  private constructor(
    device: GPUDevice,
    private canvas: HTMLCanvasElement,
    private table: TerrainTable,
    private stream: TerrainStream | null,
    private onFatal: (reason: string) => void,
    modules: Record<string, GPUShaderModule>,
  ) {
    this.device = device;
    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("webgpu context 不可用");
    this.ctx = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: "opaque" });

    const d = device;
    const { w, h } = table;

    // ---- 数值表格上 GPU：海拔 R16F + 水体 R8 ----
    const f16 = new Uint16Array(w * h);
    for (let i = 0; i < w * h; i++) f16[i] = f32ToF16Bits(table.heights[i]);
    this.heightsTex = d.createTexture({
      size: [w, h],
      format: "r16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture(
      { texture: this.heightsTex },
      f16.buffer,
      { bytesPerRow: w * 2, rowsPerImage: h },
      [w, h],
    );
    this.waterTex = d.createTexture({
      size: [w, h],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture(
      { texture: this.waterTex },
      new Uint8Array(table.water), // 拷贝视图（water 带 byteOffset，且规避 ArrayBufferLike 泛型差异）
      { bytesPerRow: w, rowsPerImage: h },
      [w, h],
    );

    // ---- 全球拼接表格上 GPU：r16sint（手动双线性，确定性等同 CPU）；bytesPerRow 需 256 对齐 → 行填充 ----
    // 全球参考基恒定（与流式锚点无关）
    this.gb = globeBasis(REF_CENTER_LAT);
    this.texW = table.w;
    this.texH = table.h;
    const g = table.globe;
    const rowBytes = g.w * 2;
    const rowStride = Math.ceil(rowBytes / 256) * 256;
    const gPadded = new Uint8Array(rowStride * g.h);
    for (let j = 0; j < g.h; j++) {
      const row = new Int16Array(g.w);
      for (let i = 0; i < g.w; i++) row[i] = g.heights[j * g.w + i];
      gPadded.set(new Uint8Array(row.buffer), j * rowStride);
    }
    this.globeTex = d.createTexture({
      size: [g.w, g.h],
      format: "r16sint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture(
      { texture: this.globeTex },
      gPadded,
      { bytesPerRow: rowStride, rowsPerImage: g.h },
      [g.w, g.h],
    );

    // ---- 迭代分叉拓扑 → 投影遮罩图集（R=枝干AO · G=叶簇 · A=覆盖；与 GL 路径同源生成） ----
    const variants = buildTreeVariants();
    const cv = document.createElement("canvas");
    cv.width = 256 * variants.length;
    cv.height = 256;
    const c2 = cv.getContext("2d")!;
    variants.forEach((v, i) => c2.drawImage(v.canvas, i * 256, 0));
    this.treeTex = d.createTexture({
      size: [cv.width, cv.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    d.queue.copyExternalImageToTexture({ source: cv }, { texture: this.treeTex }, [cv.width, cv.height]);

    // ---- 草丛遮罩图集（仅 alpha 语义；与 GL 路径同源生成器） ----
    const gcv = document.createElement("canvas");
    gcv.width = 256;
    gcv.height = 128;
    const g2 = gcv.getContext("2d")!;
    buildGrassVariants().forEach((c, i) => g2.drawImage(c, i * 128, 0));
    this.grassTex = d.createTexture({
      size: [gcv.width, gcv.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    d.queue.copyExternalImageToTexture({ source: gcv }, { texture: this.grassTex }, [gcv.width, gcv.height]);

    // ---- 常驻缓冲 ----
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vegParamBuf = d.createBuffer({ size: VEG_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.chunkBuf = d.createBuffer({ size: MAX_CHUNKS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.vegDataBuf = d.createBuffer({ size: MAX_TREES * 32, usage: GPUBufferUsage.STORAGE });
    this.vegMetaBuf = d.createBuffer({
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.grassDataBuf = d.createBuffer({ size: MAX_GRASS * 32, usage: GPUBufferUsage.STORAGE });
    this.grassMetaBuf = d.createBuffer({
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // ---- 绑定组布局（渲染 / 计算分离，避免跨 stage 可见性歧义） ----
    const bglRender = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 10, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 12, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: "sint" } },
      ],
    });
    const bglCompute = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: {} },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const plRender = d.createPipelineLayout({ bindGroupLayouts: [bglRender] });
    const plCompute = d.createPipelineLayout({ bindGroupLayouts: [bglCompute] });

    this.bgRender = d.createBindGroup({
      layout: bglRender,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: this.heightsTex.createView() },
        { binding: 2, resource: this.waterTex.createView() },
        { binding: 3, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) },
        { binding: 4, resource: this.treeTex.createView() },
        { binding: 5, resource: { buffer: this.chunkBuf } },
        { binding: 7, resource: { buffer: this.vegDataBuf } },
        { binding: 10, resource: { buffer: this.grassDataBuf } },
        { binding: 12, resource: this.globeTex.createView() },
      ],
    });
    this.bgCompute = d.createBindGroup({
      layout: bglCompute,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: this.heightsTex.createView() },
        { binding: 2, resource: this.waterTex.createView() },
        { binding: 3, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) },
        { binding: 6, resource: { buffer: this.vegDataBuf } },
        { binding: 8, resource: { buffer: this.vegMetaBuf } },
        { binding: 9, resource: { buffer: this.vegParamBuf } },
        { binding: 10, resource: { buffer: this.grassDataBuf } },
        { binding: 11, resource: { buffer: this.grassMetaBuf } },
      ],
    });

    // ---- 管线 ----
    const blendAlpha: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const fmt = this.format;

    this.pipeSky = d.createRenderPipeline({
      layout: plRender,
      vertex: { module: modules.sky, entryPoint: "vs" },
      fragment: { module: modules.sky, entryPoint: "fs", targets: [{ format: fmt }] },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
      primitive: { cullMode: "none" },
      multisample: { count: 4 },
    });

    this.pipeGlobe = d.createRenderPipeline({
      layout: plRender,
      vertex: { module: modules.globe, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: modules.globe, entryPoint: "fs", targets: [{ format: fmt }] },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      primitive: { cullMode: "back" },
      multisample: { count: 4 },
    });

    this.pipeTerrain = [];
    for (let g = 0; g <= 6; g++) {
      this.pipeTerrain.push(
        d.createRenderPipeline({
          layout: plRender,
          vertex: { module: modules.terrain, entryPoint: "vs", constants: { LEVEL: g } },
          fragment: { module: modules.terrain, entryPoint: "fs", targets: [{ format: fmt }] },
          depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
          primitive: { cullMode: "back" },
          multisample: { count: 4 },
        }),
      );
    }

    this.pipeWater = d.createRenderPipeline({
      layout: plRender,
      vertex: { module: modules.water, entryPoint: "vs" },
      fragment: { module: modules.water, entryPoint: "fs", targets: [{ format: fmt, blend: blendAlpha }] },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
      primitive: { cullMode: "back" },
      multisample: { count: 4 },
    });

    this.pipeTree = d.createRenderPipeline({
      layout: plRender,
      vertex: { module: modules.tree, entryPoint: "vs" },
      fragment: { module: modules.tree, entryPoint: "fs", targets: [{ format: fmt }] },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      primitive: { cullMode: "none" },
      multisample: { count: 4 },
    });

    this.pipeGrass = d.createRenderPipeline({
      layout: plRender,
      vertex: { module: modules.grass, entryPoint: "vs" },
      fragment: { module: modules.grass, entryPoint: "fs", targets: [{ format: fmt }] },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
      primitive: { cullMode: "none" },
      multisample: { count: 4 },
    });

    this.pipeMarker = d.createRenderPipeline({
      layout: plRender,
      vertex: { module: modules.marker, entryPoint: "vs" },
      fragment: { module: modules.marker, entryPoint: "fs", targets: [{ format: fmt, blend: blendAlpha }] },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
      primitive: { cullMode: "none" },
      multisample: { count: 4 },
    });

    this.pipeVegMain = d.createComputePipeline({ layout: plCompute, compute: { module: modules.veg, entryPoint: "vegMain" } });
    this.pipeVegFinal = d.createComputePipeline({ layout: plCompute, compute: { module: modules.veg, entryPoint: "vegFinalize" } });
    this.pipeGrassMain = d.createComputePipeline({ layout: plCompute, compute: { module: modules.veg, entryPoint: "grassMain" } });
    this.pipeGrassFinal = d.createComputePipeline({ layout: plCompute, compute: { module: modules.veg, entryPoint: "grassFinalize" } });

    // ---- 静态索引缓冲：地形 7 级（含裙边，全级别 65² 网格）/ 水面 128² / 树（4 面片）/ 草（2 面片）/ 标记 ----
    for (let l = MIN_LEVEL; l <= MAX_LEVEL; l++) {
      const n = 65;
      const { buf, count } = this.buildTerrainIndices(n);
      this.iboTerrain.push(buf);
      this.idxCountTerrain.push(count);
    }
    {
      const WN = 128;
      const idx = new Uint16Array((WN - 1) * (WN - 1) * 6);
      let wi = 0;
      for (let j = 0; j < WN - 1; j++)
        for (let i = 0; i < WN - 1; i++) {
          const a = j * WN + i;
          idx[wi++] = a; idx[wi++] = a + WN; idx[wi++] = a + 1;
          idx[wi++] = a + 1; idx[wi++] = a + WN; idx[wi++] = a + WN + 1;
        }
      this.iboWater = d.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.iboWater, 0, idx);
      this.waterIdxCount = idx.length;
    }
    {
      const treeIdx = new Uint16Array(24);
      for (let q = 0; q < 4; q++) {
        const b = q * 4;
        treeIdx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
      }
      this.iboTree = d.createBuffer({ size: treeIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.iboTree, 0, treeIdx);
    }
    {
      const grassIdx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
      this.iboGrass = d.createBuffer({ size: grassIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.iboGrass, 0, grassIdx);
    }
    {
      const mIdx = new Uint16Array([0, 1, 2, 0, 2, 3]);
      this.iboMarker = d.createBuffer({ size: mIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.iboMarker, 0, mIdx);
    }

    // ---- 行星网格：立方球 6 面 × GSEG²（单位方向烘焙，与 GL 路径同源；uint32 索引） ----
    {
      const faceAxes: Array<[number[], number[], number[]]> = [
        [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
        [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
        [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
        [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
        [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
        [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
      ];
      const verts = new Float32Array(6 * (GSEG + 1) * (GSEG + 1) * 3);
      let vp = 0;
      for (const [f, r, u] of faceAxes) {
        for (let j = 0; j <= GSEG; j++) {
          for (let i = 0; i <= GSEG; i++) {
            const a = (i / GSEG) * 2 - 1;
            const b = (j / GSEG) * 2 - 1;
            const x = f[0] + r[0] * a + u[0] * b;
            const y = f[1] + r[1] * a + u[1] * b;
            const z = f[2] + r[2] * a + u[2] * b;
            const il = 1 / Math.hypot(x, y, z);
            verts[vp++] = x * il;
            verts[vp++] = y * il;
            verts[vp++] = z * il;
          }
        }
      }
      const idx = new Uint32Array(6 * GSEG * GSEG * 6);
      let ip = 0;
      for (let fI = 0; fI < 6; fI++) {
        const base = fI * (GSEG + 1) * (GSEG + 1);
        for (let j = 0; j < GSEG; j++) {
          for (let i = 0; i < GSEG; i++) {
            const p00 = base + j * (GSEG + 1) + i;
            const p10 = p00 + 1;
            const p01 = p00 + GSEG + 1;
            const p11 = p01 + 1;
            idx[ip++] = p00; idx[ip++] = p10; idx[ip++] = p11;
            idx[ip++] = p00; idx[ip++] = p11; idx[ip++] = p01;
          }
        }
      }
      this.vboGlobe = d.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.vboGlobe, 0, verts);
      this.iboGlobe = d.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(this.iboGlobe, 0, idx);
      this.globeIdxCount = idx.length;
    }

    // ---- 计数回读暂存（HUD 树/草数量显示） ----
    for (let i = 0; i < 2; i++) {
      this.stageBufs.push(d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    }

    // ---- 设备级自愈：uncaptured error / device lost → 回退 WebGL2 ----
    d.onuncapturederror = (ev) => {
      const msg = (ev.error as Error)?.message ?? String(ev.error);
      console.error("[terrain-wgpu] uncaptured error:", msg);
      if (!this.dead) {
        this.dead = true;
        this.onFatal(`webgpu-error:${msg.slice(0, 80)}`);
      }
    };
    void d.lost.then((info) => {
      if (info.reason !== "destroyed") {
        console.warn("[terrain-wgpu] device lost:", info.reason);
        if (!this.dead) {
          this.dead = true;
          this.onFatal(`device-lost:${info.reason}`);
        }
      }
    });
  }

  private buildTerrainIndices(n: number): { buf: GPUBuffer; count: number } {
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const dd = c + 1;
        idx.push(a, c, b, b, c, dd);
      }
    const base = n * n;
    for (let k = 0; k < n - 1; k++) {
      idx.push(k, base + k, k + 1, k + 1, base + k, base + k + 1);
      const s = (n - 1) * n;
      idx.push(s + k, s + k + 1, base + n + k, s + k + 1, base + n + k + 1, base + n + k);
      const wv = k * n;
      idx.push(wv, wv + n, base + 2 * n + k, wv + n, base + 2 * n + k + 1, base + 2 * n + k);
      const ev = k * n + (n - 1);
      idx.push(ev, base + 3 * n + k, ev + n, ev + n, base + 3 * n + k, base + 3 * n + k + 1);
    }
    const arr = new Uint16Array(idx);
    const buf = this.device.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, arr);
    return { buf, count: idx.length };
  }

  /** WGSL 编译信息自检：任何 error 级消息 → 初始化失败（上层回退 WebGL2） */
  static async checkModules(device: GPUDevice, sources: Record<string, string>): Promise<Record<string, GPUShaderModule>> {
    const out: Record<string, GPUShaderModule> = {};
    for (const [name, code] of Object.entries(sources)) {
      const mod = device.createShaderModule({ code, label: `terrain-${name}` });
      const info = await mod.getCompilationInfo();
      let errs = 0;
      for (const m of info.messages) {
        if (m.type === "error") {
          errs++;
          console.error(`[terrain-wgpu] WGSL ${name}:${m.lineNum}:${m.linePos} ${m.message}`);
        }
      }
      if (errs > 0) throw new Error(`WGSL ${name} 编译失败`);
      out[name] = mod;
    }
    return out;
  }

  static async create(
    canvas: HTMLCanvasElement,
    table: TerrainTable,
    onFatal: (reason: string) => void,
    stream?: TerrainStream | null,
  ): Promise<WebGPUTerrainRenderer | null> {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    let device: GPUDevice | null = null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
      const modules = await WebGPUTerrainRenderer.checkModules(device, {
        sky: WGSL_SKY,
        globe: WGSL_GLOBE,
        terrain: WGSL_TERRAIN,
        water: WGSL_WATER,
        tree: WGSL_TREE,
        grass: WGSL_GRASS,
        marker: WGSL_MARKER,
        veg: WGSL_VEG,
      });
      return new WebGPUTerrainRenderer(device, canvas, table, stream ?? null, onFatal, modules);
    } catch (e) {
      console.warn("[terrain-wgpu] 初始化失败，回退 WebGL2:", e);
      device?.destroy();
      return null;
    }
  }

  private aabbVisible(f: FrustumPlane[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
    for (const pl of f) {
      const px = pl.a > 0 ? x1 : x0;
      const py = pl.b > 0 ? y1 : y0;
      const pz = pl.c > 0 ? z1 : z0;
      if (pl.a * px + pl.b * py + pl.c * pz + pl.d < 0) return false;
    }
    return true;
  }

  /**
   * 四叉树筛选（与 WebGL2 chunks.ts 同判据），但不建任何网格 ——
   * 只产出 chunk 描述符（origin/level/skirt），网格由 VS 高程位移即时生成。
   * 级别 -3..3：负级为亚像元细分（近景浮雕几何带）。
   */
  private selectChunks(focusX: number, focusZ: number, frustum: FrustumPlane[], exagg: number): void {
    const t = this.table;
    this.selCounts = [0, 0, 0, 0, 0, 0, 0];
    this.coverRect = [Infinity, -Infinity, Infinity, -Infinity];
    let total = 0;

    const visit = (ox: number, oz: number, level: number): void => {
      const sizeSamples = Math.round(64 * Math.pow(2, level));
      const half = (sizeSamples / t.w) * Math.max(t.spanX, t.spanZ) * 0.5;
      const cx = ((ox + sizeSamples / 2) / t.w - 0.5) * t.spanX;
      const cz = ((oz + sizeSamples / 2) / t.h - 0.5) * t.spanZ;
      const dc = Math.hypot(cx - focusX, cz - focusZ);
      const rCull = dc + half * 1.42;
      // 距离上限随窗口幅面联动（与 GL chunks.ts 同步；L1 窗口远场块全部参与绘制）
      if (level < MAX_LEVEL && rCull > Math.max(300000, Math.max(t.spanX, t.spanZ) * 0.8)) return;
      // 弯曲几何逐块 AABB 修正（与 GL chunks.ts 同式）：上沿扣最小落差、下沿扣最大落差
      const dNear = Math.pow(Math.max(Math.abs(cx) - half, 0), 2) + Math.pow(Math.max(Math.abs(cz) - half, 0), 2);
      const dFar = Math.pow(Math.abs(cx) + half, 2) + Math.pow(Math.abs(cz) + half, 2);
      const yLoC = (t.minH - 80) * exagg - dFar / (2 * PLANET_RADIUS) - 80;
      const yHiC = (t.maxH + 80) * exagg - dNear / (2 * PLANET_RADIUS);
      if (!this.aabbVisible(frustum, cx - half - focusX, cx + half - focusX, yLoC, yHiC, cz - half - focusZ, cz + half - focusZ)) return;

      const rNear = Math.max(0, dc - half * 1.05);
      if (level > MIN_LEVEL && rNear < RING_T[level + 2]) {
        const sub = Math.round(64 * Math.pow(2, level - 1));
        visit(ox, oz, level - 1);
        visit(ox + sub, oz, level - 1);
        visit(ox, oz + sub, level - 1);
        visit(ox + sub, oz + sub, level - 1);
        return;
      }

      if (total >= MAX_CHUNKS) return;
      // 裙边深度（与 GL 路径同式：随块中心离区域中心距离增大）
      const cdist = Math.hypot(cx, cz);
      const skirt = 80 + Math.min(1200, cdist * 0.03);
      this.descArr[total * 4] = ox;
      this.descArr[total * 4 + 1] = oz;
      this.descArr[total * 4 + 2] = level;
      this.descArr[total * 4 + 3] = skirt;
      const cov = this.coverRect;
      cov[0] = Math.min(cov[0], cx - half);
      cov[1] = Math.max(cov[1], cx + half);
      cov[2] = Math.min(cov[2], cz - half);
      cov[3] = Math.max(cov[3], cz + half);
      this.selCounts[level + 3]++;
      total++;
    };

    const rootSize = 64 << MAX_LEVEL;
    const roots = t.w / rootSize;
    for (let rz = 0; rz < roots; rz++)
      for (let rx = 0; rx < roots; rx++) visit(rx * rootSize, rz * rootSize, MAX_LEVEL);

    let acc = 0;
    for (let g = 0; g <= 6; g++) {
      this.selBases[g] = acc;
      acc += this.selCounts[g];
    }
    this.descCount = total;
  }

  private ensureSize(viewportW: number, viewportH: number): void {
    if (this.lastW === viewportW && this.lastH === viewportH && this.msaaTex && this.depthTex) return;
    this.msaaTex?.destroy();
    this.depthTex?.destroy();
    this.msaaTex = this.device.createTexture({
      size: [viewportW, viewportH],
      format: this.format,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTex = this.device.createTexture({
      size: [viewportW, viewportH],
      format: "depth24plus",
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.lastW = viewportW;
    this.lastH = viewportH;
  }

  render(cam: CameraState, prm: RenderParams, viewportW: number, viewportH: number): TerrainStats {
    if (this.dead || this.descCount < 0) {
      return { chunks: 0, byLevel: [0, 0, 0, 0, 0, 0, 0], tris: 0, vegCount: this.vegCountGpu, grassCount: this.grassCountGpu, meshCache: 0, built: 0 };
    }
    const d = this.device;
    this.frameNo++;
    const t = this.table;
    const detailAmp = prm.detail ? 1 : 0;
    const basis = cameraBasis(cam, t, prm.exagg);
    const eye = basis.eye;
    const fwd = basis.fwd;
    const right = basis.right;
    const up = basis.up;
    const near = Math.max(20, cam.dist * 0.02);
    // 远平面必须覆盖全球球体背面（升空后可见行星星缘）
    const far = cam.dist + 2 * PLANET_RADIUS + 300000;
    // 浮动原点：view 矩阵在相对帧构建（eye/target 都减 focus.xz）
    const eyeRel: [number, number, number] = [eye[0] - cam.fx, eye[1], eye[2] - cam.fz];
    // 曲率弯曲：焦点地表高度按球面下沉修正（与渲染几何同一弯曲场）
    const focusY = heightAt(t, cam.fx, cam.fz) * prm.exagg - curvatureDrop(cam.fx, cam.fz);
    const view = lookAt([eyeRel[0], eye[1], eyeRel[2]], [0, focusY, 0], [0, 1, 0]);
    const proj = perspectiveWGPU(cam.fovY, viewportW / Math.max(1, viewportH), near, far);
    const viewProj = mul4(proj, view);
    const frustum = ChunkScheduler.extractFrustum(viewProj);

    // 眼位海拔（高于弯曲地表）→ 太空渐入系数（30..130km）
    const eyeAlt =
      eye[1] - (heightAt(t, eye[0], eye[2]) * prm.exagg - curvatureDrop(eye[0], eye[2]));
    const spaceMix = Math.min(1, Math.max(0, (eyeAlt - 30000) / 100000));

    // ---- 太阳弧线：时刻 → 方位/高度/色温（与 GL 路径同一公式） ----
    const t01 = Math.min(1, Math.max(0, (prm.hour - 5) / 16));
    const elev = Math.max(0.035, Math.sin(t01 * Math.PI) * 1.15);
    const az = (95 + t01 * 170) * (Math.PI / 180);
    const sunDir: [number, number, number] = [
      Math.sin(az) * Math.cos(elev),
      Math.sin(elev),
      -Math.cos(az) * Math.cos(elev),
    ];
    const warm = Math.max(0, 1 - elev / 0.32);
    const sunColor: [number, number, number] = [1.0, 0.86 - warm * 0.28, 0.68 - warm * 0.5];
    const dayF = Math.sin(t01 * Math.PI);
    const skyZenith: [number, number, number] = [0.22 * dayF + 0.02, 0.42 * dayF + 0.03, 0.72 * dayF + 0.06];
    const skyHorizon: [number, number, number] = [
      0.72 * dayF + warm * 0.25 + 0.04,
      0.62 * dayF + warm * 0.1 + 0.05,
      0.55 * dayF + 0.08,
    ];
    const ambient: [number, number, number] = [0.3 * dayF + 0.05, 0.33 * dayF + 0.055, 0.4 * dayF + 0.07];
    const fogColor: [number, number, number] = [
      0.66 * dayF + warm * 0.28 + 0.05,
      0.72 * dayF + warm * 0.12 + 0.06,
      0.78 * dayF + 0.1,
    ];
    const timeS = this.frameNo / 60;
    let mistAmt = 0;
    if (prm.mist) {
      const morning =
        Math.min(1, Math.max(0, 1 - (prm.hour - 6.2) / 3.0)) *
        Math.min(1, Math.max(0, (prm.hour - 4.4) * 1.6));
      mistAmt = Math.min(1, morning * (0.6 + 0.4 * prm.cloudCover));
    }

    // ---- 分块筛选（零网格生成） ----
    this.selectChunks(cam.fx, cam.fz, frustum, prm.exagg);

    // ---- Frame uniform（164 floats） ----
    const fa = this.frameArr;
    fa.fill(0);
    fa.set(viewProj, 0);
    fa[16] = eyeRel[0]; fa[17] = eyeRel[1]; fa[18] = eyeRel[2];
    fa[20] = cam.fx; fa[21] = cam.fz;
    fa[24] = sunDir[0]; fa[25] = sunDir[1]; fa[26] = sunDir[2];
    fa[28] = sunColor[0]; fa[29] = sunColor[1]; fa[30] = sunColor[2];
    fa[32] = ambient[0]; fa[33] = ambient[1]; fa[34] = ambient[2];
    fa[36] = fogColor[0]; fa[37] = fogColor[1]; fa[38] = fogColor[2];
    fa[40] = skyZenith[0]; fa[41] = skyZenith[1]; fa[42] = skyZenith[2];
    fa[44] = skyHorizon[0]; fa[45] = skyHorizon[1]; fa[46] = skyHorizon[2];
    fa[48] = 0.77; fa[49] = -0.64; fa[50] = t.spanX; fa[51] = t.spanZ;
    const fogD = 0.0000038 * Math.min(1, Math.max(0, 1 - (eyeAlt - 60000) / 340000));   // 统一雾密度曲线（与 GL 路径/全球球体一致）
    fa[52] = timeS; fa[53] = prm.wind; fa[54] = prm.exagg; fa[55] = fogD;
    fa[56] = prm.snowLineM; fa[57] = prm.treeLineM; fa[58] = 0.3 + prm.cloudCover * 0.45; fa[59] = prm.shadows ? 1 : 0;
    fa[60] = mistAmt; fa[61] = prm.cloudCover; fa[62] = Math.tan(cam.fovY / 2); fa[63] = viewportW / Math.max(1, viewportH);
    fa[64] = right[0]; fa[65] = right[1]; fa[66] = right[2];
    fa[68] = up[0]; fa[69] = up[1]; fa[70] = up[2];
    fa[72] = fwd[0]; fa[73] = fwd[1]; fa[74] = fwd[2];
    fa[76] = t.w; fa[77] = t.h; fa[78] = t.dxEast; fa[79] = t.dzNorth;
    fa[80] = this.selBases[0]; fa[81] = this.selBases[1]; fa[82] = this.selBases[2]; fa[83] = this.selBases[3];
    fa[92] = this.selBases[4]; fa[93] = this.selBases[5]; fa[94] = this.selBases[6];
    fa[96] = detailAmp;
    // 远景一致化（p3.y/p3.z）：升空后窗口地形片元 → 全球球体同源色板（20..120km 渐变）
    fa[97] = Math.min(1, Math.max(0, (eyeAlt - 20000) / 100000));
    fa[98] = prm.cloudCover;
    // ---- 全球球体 uniform 组（100..163） ----
    const frame = this.stream?.frame ?? null;
    if (frame) {
      fa[132] = frame.m[0]; fa[133] = frame.m[1]; fa[134] = frame.m[2];
      fa[136] = frame.m[3]; fa[137] = frame.m[4]; fa[138] = frame.m[5];
      fa[140] = frame.m[6]; fa[141] = frame.m[7]; fa[142] = frame.m[8];
      fa[144] = frame.mi[0]; fa[145] = frame.mi[1]; fa[146] = frame.mi[2];
      fa[148] = frame.mi[3]; fa[149] = frame.mi[4]; fa[150] = frame.mi[5];
      fa[152] = frame.mi[6]; fa[153] = frame.mi[7]; fa[154] = frame.mi[8];
      const fw = this.stream!.focusWorld(cam.fx, cam.fz);
      fa[156] = fw[0]; fa[157] = fw[1]; fa[158] = fw[2];
      fa[160] = REF_CENTER_LON;
    } else {
      fa[144] = 1; fa[149] = 1; fa[154] = 1; // actMi = I
      fa[156] = cam.fx; fa[158] = cam.fz;
    }
    fa[104] = this.gb.pole[0]; fa[105] = this.gb.pole[1]; fa[106] = this.gb.pole[2];
    fa[108] = this.gb.eq[0]; fa[109] = this.gb.eq[1]; fa[110] = this.gb.eq[2];
    fa[112] = this.gb.east[0]; fa[113] = this.gb.east[1]; fa[114] = this.gb.east[2];
    fa[116] = t.meta.bounds.latN; fa[117] = t.meta.bounds.latS;
    fa[118] = t.meta.bounds.lonW; fa[119] = t.meta.bounds.lonE;
    fa[120] = t.spanX; fa[121] = t.spanZ; fa[122] = prm.exagg;
    fa[124] = this.coverRect[0]; fa[125] = this.coverRect[1];
    fa[126] = this.coverRect[2]; fa[127] = this.coverRect[3];
    fa[128] = t.globe.w; fa[129] = t.globe.h; fa[130] = spaceMix;
    fa[131] = fogD;
    if (this.markerRel) {
      fa[84] = this.markerRel[0] - cam.fx;
      fa[85] = this.markerRel[1];
      fa[86] = this.markerRel[2] - cam.fz;
      const mdist = Math.hypot(this.markerRel[0] - cam.fx, this.markerRel[2] - cam.fz);
      fa[88] = Math.max(30, mdist * 0.012);
    }

    // ---- 植被重建判定（焦点移动 → compute 重新增殖；树 400m / 草 80m 粒度） ----
    const vegActive = prm.showVeg && prm.vegDensity > 0.01;
    let rebuildVeg = false;
    let rebuildGrass = false;
    if (vegActive) {
      const va = this.vegArr;
      va[0] = prm.vegDensity * 0.5;
      va[1] = VEG_CELL_M;
      va[2] = Math.floor((cam.fx - VEG_RADIUS_M) / VEG_CELL_M);
      va[3] = Math.floor((cam.fz - VEG_RADIUS_M) / VEG_CELL_M);
      va[4] = cam.fx;
      va[5] = cam.fz;
      va[6] = VEG_RADIUS_M * VEG_RADIUS_M;
      va[7] = prm.snowLineM;
      va[8] = prm.exagg;
      va[9] = MAX_TREES;
      va[10] = Math.ceil((2 * VEG_RADIUS_M) / VEG_CELL_M) + 1;
      va[11] = detailAmp;
      va[12] = prm.grass ? prm.vegDensity * 0.85 : 0;
      va[13] = GRASS_CELL_M;
      va[14] = Math.floor((cam.fx - GRASS_RADIUS_M) / GRASS_CELL_M);
      va[15] = Math.floor((cam.fz - GRASS_RADIUS_M) / GRASS_CELL_M);
      va[16] = Math.ceil((2 * GRASS_RADIUS_M) / GRASS_CELL_M) + 1;
      va[17] = GRASS_RADIUS_M * GRASS_RADIUS_M;
      va[18] = MAX_GRASS;

      const key = `${Math.round(cam.fx / 400)}_${Math.round(cam.fz / 400)}_${prm.vegDensity.toFixed(2)}_${prm.snowLineM}_${prm.exagg}_${detailAmp}_${t.version}`;
      if (key !== this.lastVegKey) {
        this.lastVegKey = key;
        rebuildVeg = true;
      }
      if (prm.grass) {
        const gkey = `${Math.round(cam.fx / 80)}_${Math.round(cam.fz / 80)}_${prm.vegDensity.toFixed(2)}_${prm.snowLineM}_${prm.exagg}_${detailAmp}_${t.version}`;
        if (gkey !== this.lastGrassKey) {
          this.lastGrassKey = gkey;
          rebuildGrass = true;
        }
      }
      if (rebuildVeg || rebuildGrass) {
        d.queue.writeBuffer(this.vegParamBuf, 0, va);
      }
    }

    // ---- 上传 ----
    d.queue.writeBuffer(this.frameBuf, 0, fa);
    if (this.descCount > 0) d.queue.writeBuffer(this.chunkBuf, 0, this.descArr, 0, this.descCount * 4);
    this.ensureSize(viewportW, viewportH);
    const enc = d.createCommandEncoder();
    if (rebuildVeg || rebuildGrass) {
      if (rebuildVeg) enc.clearBuffer(this.vegMetaBuf, 0, 4);
      if (rebuildGrass) enc.clearBuffer(this.grassMetaBuf, 0, 4);
      const cp = enc.beginComputePass();
      if (rebuildVeg) {
        cp.setPipeline(this.pipeVegMain);
        cp.setBindGroup(0, this.bgCompute);
        const g = Math.ceil(((2 * VEG_RADIUS_M) / VEG_CELL_M + 1) / 8);
        cp.dispatchWorkgroups(g, g);
        cp.setPipeline(this.pipeVegFinal);
        cp.dispatchWorkgroups(1);
      }
      if (rebuildGrass) {
        cp.setPipeline(this.pipeGrassMain);
        cp.setBindGroup(0, this.bgCompute);
        const g = Math.ceil(((2 * GRASS_RADIUS_M) / GRASS_CELL_M + 1) / 8);
        cp.dispatchWorkgroups(g, g);
        cp.setPipeline(this.pipeGrassFinal);
        cp.dispatchWorkgroups(1);
      }
      cp.end();
    }

    const msaaView = this.msaaTex!.createView();
    const depthView = this.depthTex!.createView();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: msaaView,
          resolveTarget: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: "clear",
        depthClearValue: 1,
        depthStoreOp: "discard",
      },
    });
    pass.setBindGroup(0, this.bgRender);

    // 1) 天空
    pass.setPipeline(this.pipeSky);
    pass.draw(3);

    // 1.5) 全球球体（全瓦片拼接，升空可见行星；地表视角被地形遮挡/覆盖区内逐片丢弃）
    pass.setPipeline(this.pipeGlobe);
    pass.setVertexBuffer(0, this.vboGlobe);
    pass.setIndexBuffer(this.iboGlobe, "uint32");
    pass.drawIndexed(this.globeIdxCount);

    // 2) 地形（每 LOD 组一次 instanced draw，VS 高程位移 + 近景浮雕）
    for (let g = 0; g <= 6; g++) {
      if (this.selCounts[g] > 0) {
        pass.setPipeline(this.pipeTerrain[g]);
        pass.setIndexBuffer(this.iboTerrain[g], "uint16");
        pass.drawIndexed(this.idxCountTerrain[g], this.selCounts[g]);
      }
    }

    // 3) 植被（间接绘制：实例数由 compute finalize 写入）+ 近景草丛
    if (vegActive) {
      pass.setPipeline(this.pipeTree);
      pass.setIndexBuffer(this.iboTree, "uint16");
      pass.drawIndexedIndirect(this.vegMetaBuf, 4);
      if (prm.grass) {
        pass.setPipeline(this.pipeGrass);
        pass.setIndexBuffer(this.iboGrass, "uint16");
        pass.drawIndexedIndirect(this.grassMetaBuf, 4);
      }
    }

    // 4) 水面
    pass.setPipeline(this.pipeWater);
    pass.setIndexBuffer(this.iboWater, "uint16");
    pass.drawIndexed(this.waterIdxCount);

    // 5) 拾取标记
    if (this.markerRel) {
      pass.setPipeline(this.pipeMarker);
      pass.setIndexBuffer(this.iboMarker, "uint16");
      pass.drawIndexed(6);
    }
    pass.end();

    // ---- 提交 + 周期性植被计数回读（仅 HUD 显示用） ----
    if (this.frameNo % 20 === 0 && !this.stageBusy && vegActive) {
      const stg = this.stageBufs[this.stageIdx];
      this.stageIdx = (this.stageIdx + 1) % this.stageBufs.length;
      enc.copyBufferToBuffer(this.vegMetaBuf, 0, stg, 0, 8);
      enc.copyBufferToBuffer(this.grassMetaBuf, 0, stg, 8, 8);
      d.queue.submit([enc.finish()]);
      this.stageBusy = true;
      stg
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const v = new Uint32Array(stg.getMappedRange());
          this.vegCountGpu = Math.min(v[0], MAX_TREES);
          this.grassCountGpu = Math.min(v[2], MAX_GRASS);
          stg.unmap();
        })
        .catch(() => {
          try { stg.unmap(); } catch { /* already unmapped */ }
        })
        .finally(() => {
          this.stageBusy = false;
        });
    } else {
      d.queue.submit([enc.finish()]);
    }

    let tris = 0;
    for (let g = 0; g <= 6; g++) tris += (this.selCounts[g] * this.idxCountTerrain[g]) / 3;
    return {
      chunks: this.descCount,
      byLevel: [...this.selCounts],
      tris,
      vegCount: vegActive ? this.vegCountGpu : 0,
      grassCount: vegActive && prm.grass ? this.grassCountGpu : 0,
      meshCache: 0,
      built: 0,
    };
  }

  /** 设置拾取标记（区域绝对坐标；随地表曲率同步下沉） */
  setMarker(x: number, z: number, elevM: number, exagg: number): void {
    this.markerRel = [x, elevM * exagg - curvatureDrop(x, z), z];
  }

  /** 重锚定：整幅重传窗口镜像（纹理尺寸恒定，绑定组无需重建） */
  onWindowChanged(): void {
    this.syncWindow([]);
  }

  /** 流式镜像 → GPU 纹理增量上传（脏矩形按整行扩展）；整幅重建时 rect 为空 */
  syncWindow(rects: DirtyRect[]): void {
    const d = this.device;
    const t = this.table;
    if (this.texW !== t.w || this.texH !== t.h) {
      this.texW = t.w;
      this.texH = t.h;
      rects = [];
    }
    const rowMark = new Uint8Array(t.h);
    if (rects.length === 0) {
      rowMark.fill(1);
    } else {
      for (const r of rects) {
        for (let j = Math.max(0, Math.floor(r.y0)); j < Math.min(t.h, Math.ceil(r.y1)); j++) rowMark[j] = 1;
      }
    }
    let j0 = -1;
    for (let j = 0; j <= t.h; j++) {
      if (j < t.h && rowMark[j]) {
        if (j0 < 0) j0 = j;
        continue;
      }
      if (j0 < 0) continue;
      const rows = j - j0;
      const f16 = new Uint16Array(t.w * rows);
      for (let jj = 0; jj < rows; jj++) {
        const base = (j0 + jj) * t.w;
        for (let i = 0; i < t.w; i++) f16[jj * t.w + i] = f32ToF16Bits(t.heights[base + i]);
      }
      d.queue.writeTexture(
        { texture: this.heightsTex, origin: { x: 0, y: j0, z: 0 } },
        f16.buffer,
        { bytesPerRow: t.w * 2, rowsPerImage: rows },
        [t.w, rows],
      );
      const wrows = new Uint8Array(t.w * rows);
      for (let jj = 0; jj < rows; jj++) {
        wrows.set(t.water.subarray((j0 + jj) * t.w, (j0 + jj + 1) * t.w), jj * t.w);
      }
      d.queue.writeTexture(
        { texture: this.waterTex, origin: { x: 0, y: j0, z: 0 } },
        wrows.buffer,
        { bytesPerRow: t.w, rowsPerImage: rows },
        [t.w, rows],
      );
      j0 = -1;
    }
  }

  clearMarker(): void {
    this.markerRel = null;
  }

  /** 空间交互求交（与 GL 路径同一纯数学实现） */
  pick(ndcX: number, ndcY: number, cam: CameraState, exagg: number, detailAmp = 0): PickResult | null {
    return pickSurface(this.table, cam, exagg, ndcX, ndcY, detailAmp);
  }

  /** 无 CPU 网格缓存 → 分块预算无意义（接口对齐用） */
  setBurst(_n: number): void {
    void _n;
  }

  destroy(): void {
    this.dead = true;
    try {
      this.device.destroy();
    } catch {
      /* 已销毁 */
    }
  }
}
