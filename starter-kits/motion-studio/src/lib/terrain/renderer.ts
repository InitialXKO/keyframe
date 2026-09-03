/**
 * 数字表格 → 三维景象 —— WebGL2 渲染器
 *
 * 固定工作流：区块动态筛选(chunks.ts) → 宏观骨架抬升(表格数值差分) + 近景浮雕带 → 物质场混合显影
 * (海拔带×坡度修正×多级扰动) → 独立微观纹理叠加(仅依赖坐标的波动函数，与表格数值正交)
 * → 近景细节(浮雕法线带/碎石灰尘/凹腔AO) → 光照解析 → 生态细节即时增殖(vegetation.ts：
 *   四向交叉实例树 + 近景草丛层) → 交互射线求交(纯数学迭代)。
 *
 * 坐标稳定性：观察者固定于逻辑原点，所有 GPU 位置 = 区域坐标 − uFocus（浮动原点），
 * 涉及空间位置的计算始终集中在原点附近的高精度数值区间。
 */

import { ChunkScheduler } from "./chunks";
import { f32ToF16Bits, heightAt, type TerrainTable } from "./table";
import {
  curvatureDrop,
  globeBasis,
  PLANET_RADIUS,
  REF_CENTER_LAT,
  REF_CENTER_LON,
  type AnchorFrame,
} from "./planet";
import type { DirtyRect, TerrainStream } from "./stream";
import {
  buildGrassVariants,
  buildTreeVariants,
  GRASS_VARIANTS,
  planGrass,
  planVegetation,
  TREE_VARIANTS,
} from "./vegetation";
import { cameraBasis, lookAt, mul4, pickSurface, type CameraState, type PickResult } from "./camera";

export type { CameraState, PickResult };

export interface RenderParams {
  hour: number; // 5..21 时刻（太阳弧线）
  wind: number; // 0..1
  exagg: number; // 垂直夸张（1 = 物理真实）
  snowLineM: number;
  treeLineM: number;
  vegDensity: number;
  cloudCover: number; // 0..1
  showVeg: boolean;
  shadows: boolean; // 高度场自阴影（山体投影/树影/山影落海）
  mist: boolean; // 谷地晨雾（清晨自动聚集、日升消散）
  detail: boolean; // 近景浮雕带（几何位移 + 材质/法线/AO 细化）
  grass: boolean; // 近景草丛层
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

const VS_COMMON_NOISE = `
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float a=0.5,s=0.0; for(int k=0;k<4;k++){ s+=a*vnoise(p); p=p*2.03+vec2(37.1,17.7); a*=0.5; } return s; }
`;

/**
 * 近景浮雕带（与 TS detailRelief / WGSL DETAIL 严格同式）：
 *   reliefZone —— 浮雕作用域：窗口锚点系（原点）纯位置场，60km 内全量、60–160km 渐隐。
 *   与相机无关 → 烘焙网格/树基/拾取在任意时刻任意相机位置下逐点同值 → 跨级/跨帧无缝。
 *   detailA —— 几何位移带（波长约 715m，±22m），锚点系渐隐 + 低海拔/岸线渐隐。
 *   detailB —— 法线/阴影细节带（170m/53m/19m 三频岩石起伏），仅片元与阴影步进使用。
 *   nearMask —— 相机邻域遮罩（2.5–9km），仅供阴影步进的 detailB 岩石细节使用。
 */
const DETAIL_GLSL = `
float reliefZone(vec2 p){
  float r = length(p);
  float t = clamp((r - 60000.0) / 100000.0, 0.0, 1.0);
  return 1.0 - t*t*(3.0-2.0*t);
}
float nearMask(vec2 p, vec2 f){
  float r = distance(p, f);
  float t = clamp((r - 2500.0) / 6500.0, 0.0, 1.0);
  return 1.0 - t*t*(3.0-2.0*t);
}
float detailA(vec2 p, float hSelf, float amp){
  if (amp <= 0.0) return 0.0;
  float m = reliefZone(p) * smoothstep(2.0, 14.0, hSelf) * amp;
  if (m <= 0.0) return 0.0;
  float n = fbm(p*0.0014 + vec2(53.1, 91.7));
  return (n - 0.5) * 44.0 * m;
}
float detailB(vec2 p){
  return (vnoise(p*0.0062)-0.5)*16.0 + (vnoise(p*0.019)-0.5)*3.4 + (vnoise(p*0.052)-0.5)*1.1;
}
`;

/** 色调映射：中间调微亮 + 高光软滚降（雪面/太阳耀斑不死白，胶片感） */
const TONE_COMMON = `
vec3 toneFilm(vec3 c){
  c = 1.25 * c / (1.0 + 0.30 * c);
  return clamp(c, 0.0, 1.0);
}
`;

/**
 * 高度场自阴影：沿太阳方向步进数字派生表面（uHeights × uExagg + 近景浮雕带），
 * 纯数学迭代，无阴影贴图/预计算；步长指数增长覆盖远景，
 * 半影宽度随步进距离增大（物理：光源角尺寸 × 距离）。
 * 前 6 步叠加 detailB 岩石起伏 → 近景岩脊自阴影。
 * 依赖外部已声明的 uniform：uHeights / uSpan / uExagg / uShadowOn。
 * 自带 DETAIL_GLSL（需在使用前已声明 VS_COMMON_NOISE）。
 */
const SHADOW_COMMON = `
${DETAIL_GLSL}
const float R_CURV_SH = 6371000.0;
float terrainShadow(vec3 pos, vec3 sunDir, vec2 focusXZ, float detAmp){
  if (uShadowOn < 0.5 || sunDir.y < 0.03) return 1.0;
  float sh = 1.0;
  vec3 sp = pos + sunDir * 55.0;
  float stepLen = 85.0;
  for (int i = 0; i < 40; i++){
    vec2 uv = sp.xz/uSpan + 0.5;
    if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) break;
    float h = texture(uHeights, uv).r * uExagg;
    // 近距离步长内叠加几何位移场（锚点系浮雕 + 岩石细节）→ 阴影与渲染几何同源，
    // 浮雕隆起不再向太阳方向漏光；步长超过浮雕波长后不再叠加（防步进混叠）。
    if (stepLen < 320.0) {
      float hm = h / max(uExagg, 0.001);
      h += detailA(sp.xz, hm, detAmp) * uExagg;
      h += detailB(sp.xz) * 0.55 * uExagg * detAmp * nearMask(sp.xz, focusXZ) * smoothstep(2.0, 14.0, hm);
    }
    // 曲率修正：采样高度场未弯曲，而几何已径向抬升 → 减去抛物线落差，与渲染几何同一弯曲场
    float drop = (sp.x*sp.x + sp.z*sp.z) / (2.0 * R_CURV_SH);
    sh = min(sh, smoothstep(0.0, 45.0 + float(i)*26.0, sp.y - (h - drop)));
    if (sh <= 0.0) return 0.0;
    sp += sunDir * stepLen;
    stepLen *= 1.24;
  }
  return sh;
}
float terrainShadowShort(vec3 pos, vec3 sunDir){
  if (uShadowOn < 0.5 || sunDir.y < 0.03) return 1.0;
  float sh = 1.0;
  vec3 sp = pos + sunDir * 40.0;
  float stepLen = 70.0;
  for (int i = 0; i < 16; i++){
    vec2 uv = sp.xz/uSpan + 0.5;
    if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) break;
    float h = texture(uHeights, uv).r * uExagg;
    float drop = (sp.x*sp.x + sp.z*sp.z) / (2.0 * R_CURV_SH);
    sh = min(sh, smoothstep(0.0, 50.0 + float(i)*34.0, sp.y - (h - drop)));
    if (sh <= 0.0) return 0.0;
    sp += sunDir * stepLen;
    stepLen *= 1.38;
  }
  return sh;
}
`;

const SKY_VS = `#version 300 es
out vec2 vNdc;
void main(){
  vec2 p = vec2[3](vec2(-1,-1), vec2(3,-1), vec2(-1,3))[gl_VertexID];
  vNdc = p;
  gl_Position = vec4(p, 0.99999, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform vec3 uCamRight, uCamUp, uCamFwd;
uniform float uTanHalf, uAspect;
uniform vec3 uSunDir, uSunColor, uSkyZenith, uSkyHorizon, uFogColor;
uniform float uTime, uCloudCover, uMist, uSpaceMix;
uniform vec2 uWindDir;
${VS_COMMON_NOISE}
${TONE_COMMON}
out vec4 frag;
void main(){
  vec3 dir = normalize(uCamFwd + vNdc.x*uTanHalf*uAspect*uCamRight + vNdc.y*uTanHalf*uCamUp);
  float t = clamp(dir.y, -1.0, 1.0);
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(max(t,0.0), 0.5));
  // 地平线以下：用远处雾色衔接（有限表格的世界边缘与天空无痕融合，不再是暗洞）
  if (t < 0.0) col = uFogColor;
  // 升空：大气渐隐 → 太空黑
  col = mix(col, vec3(0.0025, 0.0035, 0.007), uSpaceMix);
  // 星空（确定性哈希点阵，视线方向量化；地平线下不生成）
  if (uSpaceMix > 0.01 && dir.y > -0.25) {
    vec3 cell = floor(dir * 230.0);
    float star = step(0.9972, hash12(cell.xy + cell.z * 17.17));
    float tw = 0.55 + 0.45 * sin(uTime * 2.1 + hash12(cell.zx) * 43.0);
    col += vec3(0.88, 0.91, 1.0) * star * tw * uSpaceMix * 0.9;
  }
  float sd = dot(dir, uSunDir);
  col += uSunColor * (pow(max(sd,0.0), 900.0)*1.7 + pow(max(sd,0.0), 7.0)*0.13);
  // 黄昏/清晨：太阳方位侧地平线的暖色光带（瑞利消光 → 低角度红移）
  float azW = pow(max(dot(normalize(dir.xz + vec2(1e-4,1e-4)), normalize(uSunDir.xz + vec2(1e-4,1e-4))), 0.0), 3.0);
  col += uSunColor * azW * exp(-max(dir.y, 0.0)*7.0) * step(0.0, dir.y) * (1.0 - uSunColor.g) * 0.5 * (1.0 - uSpaceMix);
  // 云层：与地表云影同一噪声场、同一风向漂移（因果一致）；升空后云层在脚下，天穹云渐隐
  if (dir.y > 0.015) {
    vec2 cp = dir.xz/(dir.y+0.14)*9000.0 + uWindDir*uTime*26.0;
    float c = fbm(cp*0.00007);
    float cover = smoothstep(1.0-uCloudCover*1.15, 1.02-uCloudCover*0.9, c);
    float lit = 0.55+0.45*max(uSunDir.y, 0.0);
    vec3 cloudCol = mix(vec3(0.98,0.99,1.0)*lit, vec3(0.40,0.43,0.49)*lit, smoothstep(0.5,0.95,c));
    float fade = smoothstep(0.015,0.12,dir.y);
    col = mix(col, cloudCol, cover*0.92*fade*(1.0 - uSpaceMix));
  }
  // 晨雾地平线：低空白化与地表高度雾衔接
  col = mix(col, uFogColor, uMist * exp(-max(dir.y, 0.0)*8.0) * 0.75 * (1.0 - uSpaceMix));
  frag = vec4(toneFilm(col), 1.0);
}`;

/* ---------------- 曲率弯曲（全球球面精确径向抬升，所有表面消费方共用同一式） ---------------- */
const CURVATURE_GLSL = `
const float R_PLANET = ${PLANET_RADIUS.toFixed(1)};
vec3 liftCurved(vec2 xz, float h){
  float L = length(vec3(xz.x, R_PLANET, xz.y));
  float s = (R_PLANET + h) / L;
  return vec3(xz.x * s, -R_PLANET + R_PLANET * s, xz.y * s);
}`;

/* ---------------- 全球球体（全瓦片拼接 · 等距圆柱全球表格 → 球面位移） ----------------
 * 活动窗口（流式高程镜像）内逐片元丢弃 → 高分辨率地形接管；
 * 窗口邻接带（4km 渐变 250m 下沉）避开深度争用；
 * 放置：窗口内用「仿射平面坐标径向抬升」（经锚点框架旋转到全球帧，与地形网格逐点重合），
 * 远域用地地理球面方向，0.42° 边缘带平滑混合。
 * 经度以全球参考子午线解算绝对值（跨日界线安全）；锚点可为任意位置。 */
const GLOBE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aDir;
uniform mat4 uViewProj;
uniform vec3 uGlobePole, uGlobeEq, uGlobeEast; // 全球参考基（恒定）
uniform mat3 uActM;    // 活动锚点 局部→全局
uniform mat3 uActMi;   // 全局→局部
uniform vec3 uFocusW;  // 焦点世界坐标（全局帧）
uniform float uLam0;   // 全球参考子午线（度）
uniform vec4 uGlobeConf0;   // 窗口 latN, latS, lonW, lonE（度）
uniform vec4 uGlobeConf1;   // spanX, spanZ, exagg, 0
uniform vec2 uGlobeSize;    // 全球格网 w, h
uniform vec4 uClipRect;     // 地形覆盖矩形（窗口 planar: x0,x1,z0,z1）
uniform sampler2D uHeights;       // 窗口 r16f（线性）
uniform highp isampler2D uGlobeH; // 全球 r16i（手动双线性）
const float R_PLANET = ${PLANET_RADIUS.toFixed(1)};
${VS_COMMON_NOISE}
out vec3 vN;
out vec3 vRel;
out vec3 vDir;
out float vH;
out float vLat;
out float vDLon;
out vec2 vPlanar;
float dLon180(float d){ return mod(d + 540.0, 360.0) - 180.0; }
float globeSample(float lat, float lon){
  float w = uGlobeSize.x, hh = uGlobeSize.y;
  float u = mod(mod((lon + 180.0) / 360.0, 1.0) * w - 0.5 + w, w);
  float v = clamp((90.0 - lat) / 180.0 * hh - 0.5, 0.0, hh - 1.001);
  float iu = floor(u), iv = floor(v);
  vec2 fr = vec2(u - iu, v - iv);
  float iu1 = mod(iu + 1.0, w);
  float iv1 = min(iv + 1.0, hh - 1.0);
  float h00 = float(texelFetch(uGlobeH, ivec2(int(iu), int(iv)), 0).r);
  float h10 = float(texelFetch(uGlobeH, ivec2(int(iu1), int(iv)), 0).r);
  float h01 = float(texelFetch(uGlobeH, ivec2(int(iu), int(iv1)), 0).r);
  float h11 = float(texelFetch(uGlobeH, ivec2(int(iu1), int(iv1)), 0).r);
  return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
}
void main(){
  vec3 dG = normalize(aDir);
  float lat = degrees(asin(clamp(dot(dG, uGlobePole), -1.0, 1.0)));
  float lonAbs = dLon180(degrees(atan(dot(dG, uGlobeEast), dot(dG, uGlobeEq))) + uLam0);
  float hg = globeSample(lat, lonAbs);
  float latC = (uGlobeConf0.x + uGlobeConf0.y) * 0.5;
  float lonC = (uGlobeConf0.z + uGlobeConf0.w) * 0.5;
  float halfLat = (uGlobeConf0.x - uGlobeConf0.y) * 0.5;
  float halfLon = (uGlobeConf0.w - uGlobeConf0.z) * 0.5;
  float dL = dLon180(lonAbs - lonC);
  float exD = max(abs(dL) - halfLon, 0.0);
  float eyD = max(abs(lat - latC) - halfLat, 0.0);
  float wRg = 1.0 - smoothstep(0.0, 0.42, max(exD, eyD));
  float x = dL / (2.0 * halfLon) * uGlobeConf1.x;
  float z = (latC - lat) / halfLat * uGlobeConf1.y * 0.5;
  float hr = textureLod(uHeights, vec2(x / uGlobeConf1.x, z / uGlobeConf1.y) + 0.5, 0.0).r;
  float h = mix(hg, hr, wRg) * uGlobeConf1.z;
  // 覆盖矩形内部整体下沉 250m（4km 边界渐变）：高分辨率地形经深度测试自然遮挡球体。
  // 下沉作用于 max(h,0) 钳制之后 —— 海洋（h=0）也随之下沉，避免与水面网格共面 z-fight。
  float dEdge = min(min(x - uClipRect.x, uClipRect.y - x), min(z - uClipRect.z, uClipRect.w - z));
  float gSink = 250.0 * smoothstep(0.0, 4000.0, dEdge);
  h -= gSink;
  vH = h;
  vLat = lat; vDLon = lonAbs; vDir = uActMi * dG; vPlanar = vec2(x, z);
  float hd = max(h, 0.0) - gSink;
  vec3 plL = normalize(vec3(x, R_PLANET, z));
  vec3 posG = mix(dG * (R_PLANET + hd), uActM * (plL * (R_PLANET + hd)), wRg) + vec3(0.0, -R_PLANET, 0.0);
  vec3 rel = uActMi * (posG - uFocusW);
  vN = uActMi * normalize(posG + vec3(0.0, R_PLANET, 0.0));
  vRel = rel;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

const GLOBE_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vRel;
in vec3 vDir;
in float vH;
in float vLat;
in float vDLon;
in vec2 vPlanar;
uniform vec3 uSunDir, uSunColor, uEyeRel, uFogColor;
uniform float uTime, uCloudCover, uGlobeFogD;
uniform vec2 uWindDir;
uniform vec4 uClipRect;
${VS_COMMON_NOISE}
${TONE_COMMON}
out vec4 frag;
void main(){
  // 覆盖矩形内不再逐片元丢弃（v16.1）：VS 已将矩形内部整体下沉 250m，由深度测试
  // 让高分辨率地形自然遮挡。此前「矩形内丢弃」使任何分块剔除缺陷（预算跳过/视锥
  // 误剔除）都直接露出生空背景 —— 升空后呈难看黑色缺口；如今球体恒定兜底，永不露黑。
  vec3 n = normalize(vN);
  vec3 viewDir = normalize(uEyeRel - vRel);
  float ndl = dot(n, uSunDir);
  float dayF = smoothstep(-0.10, 0.16, ndl);
  vec3 col;
  if (vH < 0.5) {
    // 海洋：源数据无测深（哨兵填充 0m）→ 深海基色 + 洋流噪声微变，不含浅滩逻辑
    float swirl = fbm(vDir.xz * 8.0 + vDir.y * 4.1);
    vec3 oc = mix(vec3(0.015, 0.065, 0.125), vec3(0.030, 0.105, 0.170), swirl);
    float spec = pow(max(dot(reflect(-uSunDir, n), viewDir), 0.0), 110.0);
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
    col = oc * (0.24 + 0.9 * dayF) + uSunColor * spec * 1.1 * dayF
        + vec3(0.30, 0.46, 0.66) * fres * dayF * 0.38;
  } else {
    // 地貌：纬度带 + 海拔雪线 + 副热带干旱带 + 湿度噪声
    float latA = abs(vLat);
    float n1 = fbm(vDir.xz * 5.3 + vDir.y * 2.9);
    float n2 = fbm(vDir.yx * 12.7 + 4.1);
    float snowLine = 2500.0 - latA * 30.0 + (n1 - 0.5) * 1300.0;
    float snowF = clamp(smoothstep(snowLine, snowLine + 420.0, vH) + smoothstep(57.0, 66.0, latA + n2 * 7.0), 0.0, 1.0);
    float desert = smoothstep(12.0, 20.0, latA) * (1.0 - smoothstep(30.0, 40.0, latA)) * smoothstep(0.42, 0.72, n1);
    vec3 veg = mix(vec3(0.13, 0.24, 0.10), vec3(0.36, 0.36, 0.16), n2);
    vec3 land = mix(mix(veg, vec3(0.58, 0.49, 0.31), desert), vec3(0.36, 0.33, 0.30), smoothstep(2100.0, 3300.0, vH) * 0.72);
    land = mix(land, vec3(0.92, 0.95, 0.98), snowF);
    col = land * (0.30 + 1.05 * max(ndl, 0.0));
  }
  // 云层（球面噪声带，随风漂移，与云量滑块同控）
  if (uCloudCover > 0.01) {
    vec2 cp = vDir.xz / max(0.32, abs(vDir.y) + 0.34) * 2.1 + uWindDir * uTime * 0.015;
    float c = fbm(cp * 2.9) * 0.65 + fbm(cp * 8.3) * 0.35;
    float cover = smoothstep(1.0 - uCloudCover * 1.08, 1.03 - uCloudCover * 0.85, c);
    col = mix(col, vec3(0.97, 0.98, 1.0) * (0.42 + 0.58 * max(ndl, 0.0)), cover * 0.88);
  }
  // 夜面 + 晨昏线
  col = mix(vec3(0.008, 0.013, 0.026), col, dayF);
  // 大气缘（瑞利散射近似：掠射蓝色亮缘，向光侧增强）
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.7);
  float rimDay = 0.22 + 0.78 * clamp(dot(n, uSunDir) * 0.6 + 0.42, 0.0, 1.0);
  col = mix(col, vec3(0.44, 0.64, 0.94), rim * 0.62 * rimDay);
  // 大气雾（与地形/水面同一雾模型；密度随眼位海拔衰减 → 地表时接缝无痕，轨道时归零）
  float gdist = length(vRel);
  float gfog = 1.0 - exp(-pow(gdist * uGlobeFogD, 1.4));
  col = mix(col, uFogColor, min(gfog, 1.0));
  frag = vec4(toneFilm(col), 1.0);
}`;

const TERRAIN_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform vec3 uFocus;
uniform vec2 uSpan;
uniform float uExagg;
uniform sampler2D uWater;
uniform vec3 uActUp;   // 活动锚点全球向上单位向量（全球拼接：纬度解算）
${CURVATURE_GLSL}
out vec3 vN;
out vec3 vPos;
out vec3 vRel;
out float vHM;
out vec3 vGDir;   // 局部帧下的全球方向（与全球球体 vDir 同源，远景色板共享噪声场）
out float vGLat;  // 地心纬度（度）
void main(){
  vN = aNormal;
  // 垂直夸张在几何层生效（相机/拾取/阴影 march 均用 height*exagg，此处必须一致）
  // aPos.y 已由 CPU 网格烘焙近景浮雕带（与树基/草基/拾取同式）
  float hE = aPos.y * uExagg;
  vHM = hE;
  // 本 DEM 的海面像元海拔 ≈ 0（非负水深）：按水体掩膜沉降为海床，
  // 否则海床(+0.5m)会盖在水面(y=0)之上 → 只剩岛不见海
  float wm = texture(uWater, aPos.xz/uSpan + 0.5).r;
  float hFinal = wm > 0.9 ? min(hE, -2.0) : hE;
  // 曲率弯曲：径向抬升到球面（与全球球体/拾取/相机同一弯曲场，区域边缘与球面逐点重合）
  vPos = liftCurved(aPos.xz, hFinal);
  vRel = vPos - uFocus;
  // 远景一致化：窗口内片元的全球方向 normalize(vec3(x,R,z)) 与球体 vDir 在窗口区域
  // 逐点同源（uActMi·dG ≡ plDir）→ 共享噪声场；纬度由锚点 up 向量点积解算
  vec3 plDir = normalize(vec3(aPos.x, ${PLANET_RADIUS.toFixed(1)}, aPos.z));
  vGDir = plDir;
  vGLat = degrees(asin(clamp(dot(uActUp, plDir), -1.0, 1.0)));
  gl_Position = uViewProj * vec4(vRel, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vPos;
in vec3 vRel;
in float vHM;
in vec3 vGDir;
in float vGLat;
uniform vec3 uSunDir, uSunColor, uAmbient, uFogColor;
uniform vec3 uEyeRel;
uniform float uExagg, uSnowLine, uTreeLine, uFogDensity, uCloudStrength, uTime;
uniform float uShadowOn, uMist, uDetailAmp;
uniform float uGlobeBlend, uCloudCover;   // 远景一致化：0 近景 → 1 轨道
uniform vec2 uWindDir, uSpan;
uniform sampler2D uHeights, uWater;
${VS_COMMON_NOISE}
${TONE_COMMON}
${SHADOW_COMMON}
out vec4 frag;
// 全球球体同源色板（与 GLOBE_FS 逐式一致：海洋/地貌/云/夜面）——远景混合后
// 窗口地形与低分辨率球体在任意高度上色板连续，边界不可见。
// 输入 hM 为未夸张海拔，内部换算（球体 vH 为夸张后）。
vec3 globeSurfaceMdl(vec3 dir, vec3 n, float hM, float lat, float ndl, vec3 viewDir){
  float hE = hM * uExagg;
  float dayF = smoothstep(-0.10, 0.16, ndl);
  vec3 col;
  if (hE < 0.5) {
    float swirl = fbm(dir.xz*8.0 + dir.y*4.1);
    vec3 oc = mix(vec3(0.015,0.065,0.125), vec3(0.030,0.105,0.170), swirl);
    float spec = pow(max(dot(reflect(-uSunDir, n), viewDir), 0.0), 110.0);
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
    col = oc*(0.24+0.9*dayF) + uSunColor*spec*1.1*dayF + vec3(0.30,0.46,0.66)*fres*dayF*0.38;
  } else {
    float latA = abs(lat);
    float gn1 = fbm(dir.xz*5.3 + dir.y*2.9);
    float gn2 = fbm(dir.yx*12.7 + 4.1);
    float snowLineG = 2500.0 - latA*30.0 + (gn1-0.5)*1300.0;
    float snowFG = clamp(smoothstep(snowLineG, snowLineG+420.0, hE) + smoothstep(57.0,66.0, latA+gn2*7.0), 0.0, 1.0);
    float desert = smoothstep(12.0,20.0,latA)*(1.0-smoothstep(30.0,40.0,latA))*smoothstep(0.42,0.72,gn1);
    vec3 veg = mix(vec3(0.13,0.24,0.10), vec3(0.36,0.36,0.16), gn2);
    vec3 land = mix(mix(veg, vec3(0.58,0.49,0.31), desert), vec3(0.36,0.33,0.30), smoothstep(2100.0,3300.0,hE)*0.72);
    land = mix(land, vec3(0.92,0.95,0.98), snowFG);
    col = land*(0.30 + 1.05*max(ndl,0.0));
  }
  if (uCloudCover > 0.01) {
    vec2 cp = dir.xz/max(0.32, abs(dir.y)+0.34)*2.1 + uWindDir*uTime*0.015;
    float c = fbm(cp*2.9)*0.65 + fbm(cp*8.3)*0.35;
    float cover = smoothstep(1.0-uCloudCover*1.08, 1.03-uCloudCover*0.85, c);
    col = mix(col, vec3(0.97,0.98,1.0)*(0.42+0.58*max(ndl,0.0)), cover*0.88);
  }
  col = mix(vec3(0.008,0.013,0.026), col, dayF);   // 夜面/晨昏线
  return col;
}
void main(){
  vec3 n = normalize(vN);
  vec2 p = vPos.xz;
  float hM = vHM / uExagg;              // 真实海拔（米，弯曲前，物质带用）
  float steep = 1.0 - n.y;
  float wm = texture(uWater, p/uSpan + 0.5).r;   // 0陆 / ~1海 / ~0.5内陆水
  float dist = length(vRel);                     // 片元→相机距离（雾/衰减/淡出共用）
  vec2 focusXZ = vPos.xz - vRel.xz;              // 浮动原点：焦点世界坐标（浮雕遮罩用）

  // ---- 多级扰动（物质分界自然弯曲，杜绝等高线式硬边） ----
  float n1 = fbm(p*0.00033);
  float n2 = fbm(p*0.0021);
  float n3 = fbm(p*0.011);
  float snowLine = uSnowLine + (n1-0.5)*520.0 + (n2-0.5)*150.0;
  float treeLine = uTreeLine + (n1-0.5)*380.0 + (n2-0.5)*110.0;

  // ---- 物质带（海拔区间 × 坡度修正） ----
  float slopeF = smoothstep(0.16, 0.42, steep);          // 平坦→土草覆盖，陡峭→基岩裸露
  float snowF = smoothstep(snowLine, snowLine+90.0, hM) * (1.0 - slopeF*0.6);
  float rockHigh = smoothstep(snowLine-280.0, snowLine-60.0, hM);
  float meadowF = smoothstep(treeLine+150.0, treeLine-80.0, hM);
  float moisture = fbm(p*0.0008 + 41.7);
  vec3 meadow = mix(vec3(0.16,0.27,0.12), vec3(0.44,0.46,0.24), smoothstep(0.35,0.75,moisture));
  // 远景林冠遮罩：与实例树同源的适宜性噪声 → 统计一致的平面退化
  float canopy = meadowF * smoothstep(0.4,0.68,n2) * 0.5;
  meadow = mix(meadow, vec3(0.09,0.17,0.08), canopy);
  // 裸岩地层条纹：沉积色带随海拔起伏 + 噪声弯曲（宏观地质韵律）
  float strata = sin(hM*0.013 + (n1-0.5)*9.0)*0.5+0.5;
  vec3 rock = mix(vec3(0.38,0.35,0.31), vec3(0.52,0.49,0.45), n3);
  rock = mix(rock, rock*vec3(1.12,0.99,0.90), strata*0.4);
  vec3 snow = vec3(0.93,0.96,0.99);
  float rockMix = clamp(rockHigh + slopeF*(1.0-snowF), 0.0, 1.0);
  vec3 col = mix(meadow, rock, rockMix);
  col = mix(col, snow, snowF);
  // 冰川蓝冰（陡坡雪层滑落露出冰体）+ 冰裂隙（平缓冰川区的张性裂隙，窄带状+远距淡出抗摩尔纹）
  float glacier = snowF * smoothstep(0.20, 0.38, steep);
  col = mix(col, vec3(0.50,0.68,0.74), glacier*0.8);
  float ridge = 1.0 - abs(2.0*vnoise(p*0.008)-1.0);
  float crev = smoothstep(0.965, 0.995, ridge)
    * snowF * (1.0-smoothstep(0.22, 0.40, steep))
    * smoothstep(0.52, 0.72, fbm(p*0.0009 + 7.3))
    * exp(-dist*0.00010);
  col = mix(col, vec3(0.30,0.42,0.47), crev*0.6);
  // 水岸湿沙
  float shoreF = smoothstep(9.0, 0.8, hM) * (1.0-snowF) * step(0.05, hM);
  col = mix(col, vec3(0.42,0.37,0.28), shoreF*0.75);
  // 内陆水体（湖面：掩膜+平坦 → 静水色）
  float lakeF = step(0.30, wm)*step(wm, 0.72)*smoothstep(0.03, 0.008, steep);
  col = mix(col, vec3(0.11,0.25,0.30), lakeF);

  // ---- 近景材质细化：碎石斑驳 + 草甸尘土斑 + 雪面融洞 ----
  float nearFade2 = (1.0 - smoothstep(500.0, 2200.0, dist)) * uDetailAmp;
  if (nearFade2 > 0.001) {
    float gr = vnoise(p*0.85);
    col *= 1.0 + (gr - 0.5) * 0.16 * (1.0 - snowF) * nearFade2;              // 碎石闪变
    float dirt = smoothstep(0.60, 0.78, fbm(p*0.004 + 13.1));
    col = mix(col, vec3(0.30,0.24,0.16),
      dirt * (1.0-rockMix) * (1.0-snowF) * (1.0-shoreF) * (1.0-lakeF) * nearFade2 * 0.55); // 裸土侵蚀斑
    float thaw = smoothstep(0.62, 0.8, fbm(p*0.0028 + 77.7));
    snowF = clamp(snowF - thaw * snowF * 0.4 * nearFade2, 0.0, 1.0);         // 雪面融蚀不均
  }

  // ---- 微观纹理：双平面投影（陡壁沿高度采样避免拖影）+ 距离衰减抗闪烁 ----
  float microFade = exp(-dist*0.00022);
  float rough = mix(0.32, 1.0, rockMix); rough = mix(rough, 0.06, snowF);
  rough = mix(rough, 0.10, glacier); rough = mix(rough, 0.5, shoreF*0.6);
  rough = mix(rough, 0.05, lakeF);
  vec2 mp = mix(p, vec2(dot(p, vec2(0.71,-0.70)), vPos.y), smoothstep(0.28,0.5,steep)*rockMix) * 0.09;
  float m0 = fbm(mp), mx = fbm(mp+vec2(1.1,0.0)), my = fbm(mp+vec2(0.0,1.1));
  vec3 micro = vec3((mx-m0), 0.0, (my-m0))*rough*1.6*microFade;
  vec3 nn = normalize(n + micro);

  // ---- 近景浮雕法线带（170m/53m/19m 岩石三频 + 5.5m 碎石 + 浮雕坡度补偿），雪面平滑化 ----
  // 网格法线固定 ±1 采样差分（跨 LOD 无缝），不解析 715m 浮雕带的高频分量 →
  // 片元级前向差分补足（与几何位移同场），近景岩脊/丘包光影随几何一致。
  float cav = 1.0;
  float nearFade = (1.0 - smoothstep(900.0, 3200.0, dist)) * uDetailAmp;
  if (nearFade > 0.001) {
    float e = 42.0;
    float b0 = detailB(p);
    vec2 gB = vec2(detailB(p+vec2(e,0.0)) - b0, detailB(p+vec2(0.0,e)) - b0) / e;
    gB *= (1.0 - snowF*0.75);
    float gv = vnoise(p*0.85);
    vec2 gG = vec2(vnoise(p*0.85+vec2(0.9,0.0)) - gv, vnoise(p*0.85+vec2(0.0,0.9)) - gv) / 0.9;
    float eR = 55.0;
    float r0 = detailA(p, hM, uDetailAmp);
    vec2 gR = vec2(detailA(p+vec2(eR,0.0), hM, uDetailAmp) - r0,
                   detailA(p+vec2(0.0,eR), hM, uDetailAmp) - r0) / eR;
    nn = normalize(nn + vec3(-gB.x, 0.0, -gB.y)*nearFade*0.85 + vec3(-gG.x, 0.0, -gG.y)*nearFade*0.30*(1.0-snowF)
                        + vec3(-gR.x, 0.0, -gR.y)*nearFade*1.05);
    cav = mix(0.74, 1.0, smoothstep(-7.0, 2.5, b0));   // 凹腔环境光遮蔽（岩脊间谷线）
  }

  // ---- 光照：宏观坡向 + 微观扰动 + 高度场自阴影（纯数学步进） ----
  float sh = terrainShadow(vPos, uSunDir, focusXZ, uDetailAmp);
  float dl = dot(nn, uSunDir);
  float diff = max(dl, 0.0);
  float diffSnow = clamp((dl+0.42)/1.42, 0.0, 1.0);      // 积雪高散射（wrap lighting）
  diff = mix(diff, diffSnow, snowF) * sh;
  vec3 amb = uAmbient * (0.55+0.45*nn.y) * mix(1.0, cav, nearFade);
  vec3 viewDir = normalize(uEyeRel - vRel);
  vec3 hv = normalize(uSunDir + viewDir);
  float specPow = mix(mix(10.0, 16.0, rockMix), 96.0, max(snowF, lakeF));
  float specI = mix(mix(0.02, 0.05, rockMix), 0.30, max(snowF, lakeF)) + shoreF*0.15;
  float spec = pow(max(dot(nn, hv), 0.0), specPow) * specI * sh;
  // 云影：与天空云同一噪声场、同一风向漂移
  float cs = 1.0 - uCloudStrength * smoothstep(0.55,0.85, fbm(p*0.00006 + uWindDir*uTime*0.026));
  vec3 lit = col * (uSunColor*diff*cs*1.35 + amb) + uSunColor*spec*cs;
  // 雪面闪晶：视角相关的高频亮斑（雪晶镜面反射，随时间换粒）
  float spark = step(0.9975, hash12(floor(p*3.5) + vec2(floor(uTime*2.5)*7.31, floor(uTime*1.7)*3.17)));
  lit += uSunColor * spark * snowF * pow(max(dot(reflect(-viewDir, nn), uSunDir),0.0), 3.0) * 1.4 * microFade;
  // 海/湖床色调 + 浅水焦散（两层波场干涉，浅处更强）
  if (hM < 0.0) {
    lit = mix(vec3(0.05,0.14,0.16), vec3(0.10,0.22,0.23), smoothstep(-60.0,0.0,hM));
    float ca = fbm(p*0.02 + uTime*0.33) * fbm(p*0.023 - uTime*0.27);
    lit += vec3(0.32,0.46,0.46) * pow(smoothstep(0.14,0.42,ca), 2.0) * smoothstep(-34.0,-0.5,hM) * (0.35+0.65*max(uSunDir.y,0.0));
  }

  // ---- 大气透视 + 谷地晨雾（清晨聚集低洼、随风漂移、日升消散） ----
  // 远景一致化：升空后（20..120km 渐变）片元颜色向全球球体同源色板混合——
  // 窗口地形与球体在任意观测高度上色板/噪声/云层/晨昏完全连续，窗口边界不可见。
  if (uGlobeBlend > 0.001) {
    vec3 gcol = globeSurfaceMdl(vGDir, n, hM, vGLat, dot(n, uSunDir), viewDir);
    lit = mix(lit, gcol, uGlobeBlend);
  }
  float fogF = 1.0 - exp(-pow(dist*uFogDensity, 1.4));
  float fogTop = mix(90.0, 340.0, uMist);
  float hf = uMist * smoothstep(fogTop+240.0, fogTop-160.0, hM) * (0.55 + 0.5*fbm(p*0.00045 + uWindDir*uTime*0.013));
  fogF = 1.0 - (1.0-fogF)*(1.0-min(hf,1.0));
  frag = vec4(toneFilm(mix(lit, uFogColor, fogF)), 1.0);
}`;

const WATER_VS = `#version 300 es
layout(location=0) in vec2 aXZ;
uniform mat4 uViewProj;
uniform vec3 uFocus;
${CURVATURE_GLSL}
out vec3 vPos;
out vec3 vRel;
void main(){
  // 海面 = 海平面球面（h=0 的径向抬升即为球面本身，与全球球体海洋逐点重合）
  vPos = liftCurved(aXZ, 0.0);
  vRel = vPos - uFocus;
  gl_Position = uViewProj * vec4(vRel, 1.0);
}`;

const WATER_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vRel;
uniform vec3 uSunDir, uSunColor, uSkyZenith, uSkyHorizon, uFogColor;
uniform vec3 uEyeRel;
uniform float uTime, uWind, uFogDensity, uExagg, uShadowOn, uMist, uDetailAmp;
uniform vec2 uSpan;
uniform sampler2D uHeights, uWater;
${VS_COMMON_NOISE}
${TONE_COMMON}
${SHADOW_COMMON}
out vec4 frag;
void main(){
  vec2 p = vPos.xz;
  vec2 uv = p/uSpan + 0.5;
  float bedM = texture(uHeights, uv).r;   // 海床海拔（米，未夸张）
  float wmask = texture(uWater, uv).r;    // 本 DEM 海面像元海拔 ≈ 0（非负水深）→ 水体由掩膜驱动
  float depth = -bedM;
  if (depth <= 0.02 && wmask < 0.9) discard;
  float effDepth = max(depth, wmask * 8.0);
  // 波浪：行进噪声波（振幅随风速），仅依赖坐标与时间；远距离衰减抗闪烁
  float dist = length(vRel);
  float distFade = exp(-dist*0.00035);
  float amp = (0.35 + uWind*1.9) * mix(0.08, 1.0, distFade);
  vec2 wp = p*0.016;
  float w0 = fbm(wp + uTime*vec2(0.62,0.34));
  float wx = fbm(wp + vec2(1.2,0.0) + uTime*vec2(0.62,0.34));
  float wy = fbm(wp + vec2(0.0,1.2) + uTime*vec2(0.62,0.34));
  float ripple = fbm(p*0.10 + uTime*vec2(1.7,-1.1));
  vec2 grad = vec2(wx-w0, wy-w0)*amp + vec2(ripple-0.5)*0.25*amp*distFade;
  vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 viewDir = normalize(uEyeRel - vRel);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0)*0.9 + 0.06;
  vec3 skyRef = mix(uSkyHorizon, uSkyZenith, clamp(reflect(-viewDir, n).y, 0.0, 1.0));
  // 山体阴影投射到水面（高度场步进 → 峡湾山影）；vPos 已曲率抬升，起点与几何一致
  float sh = terrainShadow(vPos, uSunDir, vPos.xz - vRel.xz, uDetailAmp);
  float spec = pow(max(dot(reflect(-uSunDir, n), viewDir), 0.0), 260.0) * (1.4+uWind*2.6) * sh;
  vec3 base = mix(vec3(0.030,0.115,0.135), vec3(0.10,0.31,0.33), smoothstep(0.0,16.0,effDepth));
  vec3 col = mix(base*(0.45+0.55*sh), skyRef, fres) + uSunColor*spec;
  // 大风浪尖白帽（波峰噪声 + 风力阈值，随风距衰减）
  float cap = smoothstep(0.66, 0.88, w0 + (ripple-0.5)*0.4) * smoothstep(0.18, 0.55, uWind) * distFade;
  col = mix(col, vec3(0.93,0.96,0.97), cap*0.4);
  // 岸线浪花：负水深梯度 + 掩膜边界（碎浪线）双通道，噪声破形 + 波动推进
  float foamN = fbm(p*0.28 + uTime*0.9);
  float foam = smoothstep(1.4, 0.1, effDepth + foamN*0.8);
  col = mix(col, vec3(0.92,0.96,0.97), foam*0.6);
  float alpha = clamp(smoothstep(0.02, 1.1, max(depth, wmask))*(0.75+fres*0.25) + foam*0.4, 0.0, 1.0);
  float fogF = 1.0 - exp(-pow(dist*uFogDensity, 1.4));
  float hf = uMist * 0.72 * exp(-dist*0.00003);   // 水面低处全在雾带内
  fogF = 1.0 - (1.0-fogF)*(1.0-hf);
  col = mix(col, uFogColor, fogF);
  frag = vec4(toneFilm(col), alpha);
}`;

const TREE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in float aQuad;   // 0..3（四向交叉面片，45° 间隔）
layout(location=2) in vec4 iA;       // x, z, yBase(已夸张,含浮雕), heightM
layout(location=3) in vec4 iB;       // rot, phase, leafMix, variant
uniform mat4 uViewProj;
uniform vec3 uFocus, uEyeRel, uSunDir;
uniform float uTime, uWind, uExagg, uShadowOn;
uniform vec2 uWindDir, uSpan;
uniform sampler2D uHeights;
${CURVATURE_GLSL}
${VS_COMMON_NOISE}
${TONE_COMMON}
${SHADOW_COMMON}
out vec2 vUv;
out float vLeaf;
out float vRelY;
out float vElev;
out float vFogDist;
out float vShadow;
out vec3 vRel;
void main(){
  vUv = vec2((iB.w + aCorner.x) / ${TREE_VARIANTS.toFixed(1)}, 1.0 - aCorner.y);
  vLeaf = iB.z;
  float h = iA.w;
  vElev = iA.z / uExagg;
  float cs = cos(iB.x), sn = sin(iB.x);
  vec2 c = (aCorner - 0.5) * vec2(h*0.72, h);
  float ang = iB.x + aQuad * 0.7853981634;
  vec2 off = vec2(cos(ang), -sin(ang)) * c.x;
  float relY = aCorner.y;
  vRelY = relY;
  // 风摇：高度平方弯曲 + 阵风缓变（与云影同一风向，因果一致）
  float gust = 0.6 + 0.4*sin(uTime*0.31 + iB.y*0.7);
  float sway = (sin(uTime*1.6+iB.y) + 0.35*sin(uTime*3.4+iB.y*1.7)) * uWind * 0.16 * gust;
  // 树基点随地表曲率弯曲（实例布局 (x,z,y,h) → 抬升后 (x, elev, z)）
  vec3 base = liftCurved(vec2(iA.x, iA.y), iA.z) - uFocus;
  base.xz += uWindDir * sway * h * relY*relY;
  vec3 world = base + vec3(off.x, c.y + h*0.5, off.y);   // 面片底部锚定树基（冠层在地表之上）
  // 树基点地形阴影（VS 内短步进，每实例一次，低成本）
  vShadow = terrainShadowShort(vec3(iA.x, iA.z, iA.y), uSunDir);
  vRel = world;
  vFogDist = distance(world, uEyeRel);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const TREE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vLeaf;
in float vRelY;
in float vElev;
in float vFogDist;
in float vShadow;
in vec3 vRel;
uniform sampler2D uTreeTex;
uniform vec3 uSunDir, uSunColor, uAmbient, uFogColor, uEyeRel;
uniform float uSnowLine, uFogDensity, uMist;
${VS_COMMON_NOISE}
${TONE_COMMON}
out vec4 frag;
void main(){
  vec4 tx = texture(uTreeTex, vUv);
  if (tx.a < 0.32) discard;
  float ao = tx.r;     // 枝干邻近度（内腔遮蔽）
  float tip = tx.g;    // 外冠叶簇（受光/透光标记）
  vec3 trunk = vec3(0.23,0.17,0.11);
  vec3 leafA = vec3(0.12,0.22,0.09);
  vec3 leafB = vec3(0.30,0.38,0.14);
  vec3 col = mix(leafA, leafB, vLeaf);
  col = mix(trunk, col, smoothstep(0.06, 0.2, 1.0 - vUv.y));   // 树干在面片底部（v 翻转后 vUv.y≈1）
  // 内腔 AO（枝干附近压暗）+ 竖直梯度 + 叶片噪声微变
  float shade = (0.55 + 0.45*vRelY) * mix(1.10, 0.62, ao);
  col *= 0.86 + 0.28*vnoise(vUv*vec2(46.0, 60.0) + vLeaf*7.0);
  float diff = (0.55 + 0.45*max(uSunDir.y, 0.0)) * (0.62 + 0.48*vRelY);   // 冠层顶受光偏置
  // 地形阴影：直射受遮挡压暗，保留环境光底（谷内树不会死黑）
  vec3 lit = col * (uSunColor*diff*1.1*mix(0.42, 1.0, vShadow) + uAmbient) * shade;
  // 透光（逆光叶片透射：视线朝向太阳时外冠发亮）
  vec3 viewDir = normalize(uEyeRel - vRel);
  float back = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0);
  lit += col * uSunColor * back * tip * 0.55;
  // 高海拔雪挂（物理：低温→冠层积雪）
  float snowOnTree = smoothstep(uSnowLine-420.0, uSnowLine-80.0, vElev);
  lit = mix(lit, vec3(0.88,0.91,0.95)*shade*mix(0.45, 1.0, vShadow), snowOnTree*0.55);
  float fogF = 1.0 - exp(-pow(vFogDist*uFogDensity, 1.4));
  float fogTop = mix(90.0, 340.0, uMist);
  float hf = uMist * smoothstep(fogTop+240.0, fogTop-160.0, vElev) * 0.7;
  fogF = 1.0 - (1.0-fogF)*(1.0-hf);
  frag = vec4(toneFilm(mix(lit, uFogColor, fogF)), 1.0);
}`;

const GRASS_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in float aQuad;   // 0/1（双向交叉）
layout(location=2) in vec4 iA;       // x, z, yBase(含浮雕,已夸张), heightM
layout(location=3) in vec4 iB;       // rot, phase, tint, variant
uniform mat4 uViewProj;
uniform vec3 uFocus, uEyeRel;
uniform float uTime, uWind;
uniform vec2 uWindDir;
${CURVATURE_GLSL}
out vec2 vUv;
out float vRelY;
out float vTint;
out vec3 vRel;
out float vFogDist;
void main(){
  float h = iA.w;
  vRelY = aCorner.y;
  vTint = iB.z;
  vUv = vec2((iB.w + aCorner.x) / ${GRASS_VARIANTS.toFixed(1)}, 1.0 - aCorner.y);
  // 草叶风摇：更柔的阵风 + 叶尖二阶弯曲
  float gust = 0.65 + 0.35*sin(uTime*0.5 + iB.y*0.9);
  float sway = (sin(uTime*2.3+iB.y) + 0.4*sin(uTime*4.7+iB.y*1.9)) * uWind * 0.28 * gust;
  float ang = iB.x + aQuad * 1.5707963;
  vec2 c = (aCorner - 0.5) * vec2(h*1.2, h);
  vec2 off = vec2(cos(ang), -sin(ang)) * c.x;
  // 草基点随地表曲率弯曲（实例布局 (x,z,y,h)）
  vec3 base = liftCurved(vec2(iA.x, iA.y), iA.z) - uFocus;
  base.xz += uWindDir * sway * h * vRelY*vRelY;
  vec3 world = base + vec3(off.x, c.y + h*0.5, off.y);   // 面片底部锚定草基
  vRel = world;
  vFogDist = distance(world, uEyeRel);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const GRASS_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vRelY;
in float vTint;
in vec3 vRel;
in float vFogDist;
uniform sampler2D uGrassTex;
uniform vec3 uSunDir, uSunColor, uAmbient, uFogColor, uEyeRel;
uniform float uFogDensity;
${VS_COMMON_NOISE}
${TONE_COMMON}
out vec4 frag;
void main(){
  float a = texture(uGrassTex, vUv).a;
  if (a < 0.4) discard;
  vec3 dry = vec3(0.34, 0.30, 0.14);
  vec3 lush = vec3(0.13, 0.28, 0.09);
  vec3 tipC = mix(dry, lush, vTint) * 1.18;
  vec3 col = mix(tipC * 0.42, tipC, smoothstep(0.0, 0.75, vRelY));
  col *= 0.85 + 0.3*vnoise(vUv*vec2(30.0, 44.0) + vTint*5.0);   // 叶片条纹微变
  vec3 viewDir = normalize(uEyeRel - vRel);
  float back = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0);
  vec3 lit = col * (uSunColor * (0.5 + 0.5*max(uSunDir.y, 0.0)) * 1.05 + uAmbient);
  lit += tipC * uSunColor * back * 0.5 * vRelY;                 // 逆光透射（叶尖发光）
  float fogF = 1.0 - exp(-pow(vFogDist*uFogDensity, 1.4));
  lit = mix(lit, uFogColor, fogF);
  frag = vec4(toneFilm(lit), 1.0);
}`;

const MARKER_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uSize;
out vec2 vUv;
void main(){
  vUv = aCorner;
  vec3 world = uCenter + vec3(aCorner.x*uSize, 0.0, aCorner.y*uSize);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const MARKER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
void main(){
  float d = length(vUv);
  float ring = smoothstep(0.5, 0.42, d) * smoothstep(0.30, 0.38, d);
  float pulse = 0.75 + 0.25*sin(d*22.0);
  frag = vec4(vec3(1.0, 0.72, 0.2)*ring*pulse, ring);
}`;

/* ---------------- 矩阵工具（lookAt/mul4 见 camera.ts 共享实现） ---------------- */

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

/* ---------------- 渲染器 ---------------- */

const IDENT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export class TerrainRenderer {
  readonly backendName = "WebGL2 · CPU分块 + LRU缓存";
  private gl: WebGL2RenderingContext;
  private scheduler: ChunkScheduler;
  private progs: Record<string, WebGLProgram> = {};
  private heightsTex: WebGLTexture;
  private waterTex: WebGLTexture;
  private treeTex: WebGLTexture;
  private grassTex: WebGLTexture;
  private waterVbo: WebGLBuffer | null = null;
  private waterIbo: WebGLBuffer | null = null;
  private waterIdxCount = 0;
  private treeVbo: WebGLBuffer;
  private treeIbo: WebGLBuffer;
  private treeInst: WebGLBuffer;
  private grassVbo: WebGLBuffer;
  private grassIbo: WebGLBuffer;
  private grassInst: WebGLBuffer;
  private markerVbo: WebGLBuffer;
  private globeTex: WebGLTexture;
  private globeVbo: WebGLBuffer;
  private globeIbo: WebGLBuffer;
  private globeIdxCount = 0;
  private vaoGlobe?: WebGLVertexArrayObject;
  private gb: ReturnType<typeof globeBasis>;
  private uniCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private frameNo = 0;
  private lastVegKey = "";
  private lastGrassKey = "";
  private vegCountActual = 0;
  private grassCountActual = 0;
  private vaoTerrain?: WebGLVertexArrayObject;
  private vaoWater?: WebGLVertexArrayObject;
  private vaoTree?: WebGLVertexArrayObject;
  private vaoGrass?: WebGLVertexArrayObject;
  private vaoMarker?: WebGLVertexArrayObject;
  private markerRel: [number, number, number] | null = null;
  private texW = 0;
  private texH = 0;
  private lastVersion = 0;
  /** 上一帧的浮雕幅面开关（烘焙网格含浮雕 → 变化需重建全部块） */
  private lastDetailAmp = 0;
  /** 流式瓦片写入镜像的脏矩形（syncWindow 收集 → render() 交给分块调度器 → 清空） */
  private dataRects: DirtyRect[] = [];

  private constructor(gl: WebGL2RenderingContext, private table: TerrainTable, private stream?: TerrainStream) {
    this.gl = gl;
    this.scheduler = new ChunkScheduler(gl, table);

    // ---- 数值表格上 GPU：海拔 R16F（线性过滤）+ 水体 R8 ----
    const { w, h } = table;
    const f16 = new Uint16Array(w * h);
    for (let i = 0; i < w * h; i++) f16[i] = f32ToF16Bits(table.heights[i]);
    this.heightsTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, f16);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.waterTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.waterTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, table.water);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---- 迭代分叉拓扑 → 投影遮罩图集（R=枝干AO · G=叶簇 · A=覆盖；远景退化形态同源） ----
    const variants = buildTreeVariants();
    const cv = document.createElement("canvas");
    cv.width = 256 * variants.length;
    cv.height = 256;
    const c2 = cv.getContext("2d")!;
    variants.forEach((v, i) => c2.drawImage(v.canvas, i * 256, 0));
    this.treeTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.treeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);

    // ---- 草丛遮罩图集（仅 alpha 语义；颜色由程序给出） ----
    const gvar = buildGrassVariants();
    const gv = document.createElement("canvas");
    gv.width = 128 * gvar.length;
    gv.height = 128;
    const g2 = gv.getContext("2d")!;
    gvar.forEach((v, i) => g2.drawImage(v, i * 128, 0));
    this.grassTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.grassTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);

    // ---- 着色程序 ----
    const mk = (vs: string, fs: string, name: string) => {
      const p = this.link(vs, fs);
      if (!p) throw new Error(`${name} 程序链接失败`);
      this.progs[name] = p;
    };
    mk(SKY_VS, SKY_FS, "sky");
    mk(GLOBE_VS, GLOBE_FS, "globe");
    mk(TERRAIN_VS, TERRAIN_FS, "terrain");
    mk(WATER_VS, WATER_FS, "water");
    mk(TREE_VS, TREE_FS, "tree");
    mk(GRASS_VS, GRASS_FS, "grass");
    mk(MARKER_VS, MARKER_FS, "marker");

    // ---- 全球拼接表格上 GPU：R16I 整数纹理（着色器手动双线性，确定性等同 CPU） ----
    // 全球参考基恒定（与流式锚点无关）—— 经纬解算始终以全球参考子午线为基准
    this.gb = globeBasis(REF_CENTER_LAT);
    this.texW = table.w;
    this.texH = table.h;
    const g = table.globe;
    const gRaw = new Int16Array(g.w * g.h);
    for (let i = 0; i < g.w * g.h; i++) gRaw[i] = g.heights[i];
    this.globeTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.globeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, g.w, g.h, 0, gl.RED_INTEGER, gl.SHORT, gRaw);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---- 行星网格：立方球 6 面 × 160²（单位方向，地理框架烘焙；约 30 万三角，单 draw） ----
    const GSEG = 160;
    const faceAxes: Array<[number[], number[], number[]]> = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]],   // +X: f, r, u (r×u=f)
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],   // -X
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]],   // +Y
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],   // -Y
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],    // +Z
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],  // -Z
    ];
    const verts = new Float32Array(6 * (GSEG + 1) * (GSEG + 1) * 3);
    let vp = 0;
    for (const [f, r, u] of faceAxes) {
      for (let j = 0; j <= GSEG; j++) {
        for (let i = 0; i <= GSEG; i++) {
          const a = (i / GSEG) * 2 - 1;
          const b = (j / GSEG) * 2 - 1;
          let x = f[0] + r[0] * a + u[0] * b;
          let y = f[1] + r[1] * a + u[1] * b;
          let z = f[2] + r[2] * a + u[2] * b;
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
    this.globeVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.globeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.globeIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.globeIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.globeIdxCount = idx.length;

    // ---- 水面网格（覆盖区域 + 4km 余量；窗口层级切换时随 span 重建）----
    this.buildWaterMesh(table.spanX, table.spanZ);

    // ---- 树：四向交叉面片（16 顶点 + 24 索引/实例）----
    const cornerData = new Float32Array(16 * 3);
    for (let k = 0; k < 16; k++) {
      cornerData[k * 3] = k % 4 === 1 || k % 4 === 2 ? 1 : 0; // corner.x
      cornerData[k * 3 + 1] = k % 4 >= 2 ? 1 : 0; // corner.y
      cornerData[k * 3 + 2] = Math.floor(k / 4); // quad 0..3
    }
    const treeIdx = new Uint16Array(24);
    for (let q = 0; q < 4; q++) {
      const b = q * 4;
      treeIdx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    }
    this.treeVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.treeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, cornerData, gl.STATIC_DRAW);
    this.treeIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.treeIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, treeIdx, gl.STATIC_DRAW);
    this.treeInst = gl.createBuffer()!;

    // ---- 草丛：双向交叉面片（8 顶点 + 12 索引/实例）----
    const gCorner = new Float32Array(8 * 3);
    for (let k = 0; k < 8; k++) {
      gCorner[k * 3] = k % 4 === 1 || k % 4 === 2 ? 1 : 0;
      gCorner[k * 3 + 1] = k % 4 >= 2 ? 1 : 0;
      gCorner[k * 3 + 2] = k < 4 ? 0 : 1; // quad 0/1
    }
    const grassIdx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.grassVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grassVbo);
    gl.bufferData(gl.ARRAY_BUFFER, gCorner, gl.STATIC_DRAW);
    this.grassIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.grassIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grassIdx, gl.STATIC_DRAW);
    this.grassInst = gl.createBuffer()!;

    // ---- 拾取标记环 ----
    this.markerVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

    // ---- VAO ----
    this.vaoTerrain = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoTerrain);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    this.vaoGlobe = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoGlobe);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.globeVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.globeIbo);
    this.vaoWater = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoWater);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.waterVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.waterIbo);
    this.vaoTree = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoTree);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.treeVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.treeInst);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.treeIbo);
    this.vaoGrass = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoGrass);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grassVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grassInst);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.grassIbo);
    this.vaoMarker = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoMarker);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.markerVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  static create(canvas: HTMLCanvasElement, table: TerrainTable, stream?: TerrainStream): TerrainRenderer | null {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      depth: true,
      alpha: false,
    });
    if (!gl) return null;
    try {
      return new TerrainRenderer(gl, table);
    } catch (e) {
      console.error("[terrain] 渲染器初始化失败:", e);
      return null;
    }
  }

  private link(vs: string, fs: string): WebGLProgram | null {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("[terrain] 着色器编译失败:", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("[terrain] 程序链接失败:", gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  private u(prog: string, name: string): WebGLUniformLocation | null {
    let m = this.uniCache.get(this.progs[prog]);
    if (!m) {
      m = new Map();
      this.uniCache.set(this.progs[prog], m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(this.progs[prog], name));
    return m.get(name) ?? null;
  }

  /** 相机派生：eye / fwd / right / up（共享实现，与 WebGPU 路径严格一致） */
  cameraBasis(cam: CameraState, exagg: number) {
    return cameraBasis(cam, this.table, exagg);
  }

  render(cam: CameraState, prm: RenderParams, viewportW: number, viewportH: number): TerrainStats {
    const gl = this.gl;
    this.frameNo++;
    // 流式数据版本变化（重锚定/L3 细化完成）→ 失效块缓存与植被规划
    if (this.table.version !== this.lastVersion) {
      this.lastVersion = this.table.version;
      this.invalidateTerrain();
    }
    const detailAmp = prm.detail ? 1 : 0;
    // 浮雕幅面开关变化 → 烘焙网格含浮雕 → 全部重建（否则新旧网格浮雕场不一致出接缝）
    if (detailAmp !== this.lastDetailAmp) {
      this.lastDetailAmp = detailAmp;
      this.scheduler.invalidate();
    }
    const { eye, fwd, right, up } = this.cameraBasis(cam, prm.exagg);
    // 曲率弯曲：焦点地表高度按球面下沉修正（与渲染几何同一弯曲场）
    const focusY =
      heightAt(this.table, cam.fx, cam.fz) * prm.exagg - curvatureDrop(cam.fx, cam.fz);
    const near = Math.max(20, cam.dist * 0.02);
    // 远平面必须覆盖全球球体背面（升空后可见行星星缘）
    const far = cam.dist + 2 * PLANET_RADIUS + 300000;
    // 浮动原点：着色器顶点 = 区域坐标 − uFocus（相对帧），view 矩阵必须在同一相对帧
    // 构建（eye/target 都减去 focus 的 xz），否则 focus 被减两次 → 整个世界错位。
    const view = lookAt(
      [eye[0] - cam.fx, eye[1], eye[2] - cam.fz],
      [0, focusY, 0],
      [0, 1, 0],
    );
    const proj = perspective(cam.fovY, viewportW / Math.max(1, viewportH), near, far);
    const viewProj = mul4(proj, view);
    const frustum = ChunkScheduler.extractFrustum(viewProj);

    // 眼位海拔（高于弯曲地表）→ 太空渐入系数（30..130km）
    const eyeAlt =
      eye[1] - (heightAt(this.table, eye[0], eye[2]) * prm.exagg - curvatureDrop(eye[0], eye[2]));
    const spaceMix = Math.min(1, Math.max(0, (eyeAlt - 30000) / 100000));
    // 统一雾密度曲线：平面系统与全球球体共用（60km 以下全量 → 400km 归零，接缝永远一致）
    const fogD = 0.0000038 * Math.min(1, Math.max(0, 1 - (eyeAlt - 60000) / 340000));

    // ---- 太阳弧线：时刻 → 方位/高度/色温（物理因果）----
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
    const windDir: [number, number, number] = [0.77, 0, -0.64];
    const timeS = this.frameNo / 60;
    // 谷地晨雾强度：清晨（5:00 前）→ 6:20 峰值 → 9:20 消散；阴天更浓（水汽饱和）
    let mistAmt = 0;
    if (prm.mist) {
      const morning =
        Math.min(1, Math.max(0, 1 - (prm.hour - 6.2) / 3.0)) *
        Math.min(1, Math.max(0, (prm.hour - 4.4) * 1.6));
      mistAmt = Math.min(1, morning * (0.6 + 0.4 * prm.cloudCover));
    }

    gl.viewport(0, 0, viewportW, viewportH);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const eyeRel: [number, number, number] = [eye[0] - cam.fx, eye[1], eye[2] - cam.fz];

    // ============ 1) 天空 ============
    gl.useProgram(this.progs.sky);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    gl.uniform3f(this.u("sky", "uCamRight"), right[0], right[1], right[2]);
    gl.uniform3f(this.u("sky", "uCamUp"), up[0], up[1], up[2]);
    gl.uniform3f(this.u("sky", "uCamFwd"), fwd[0], fwd[1], fwd[2]);
    gl.uniform1f(this.u("sky", "uTanHalf"), Math.tan(cam.fovY / 2));
    gl.uniform1f(this.u("sky", "uAspect"), viewportW / Math.max(1, viewportH));
    gl.uniform3f(this.u("sky", "uSunDir"), sunDir[0], sunDir[1], sunDir[2]);
    gl.uniform3f(this.u("sky", "uSunColor"), sunColor[0], sunColor[1], sunColor[2]);
    gl.uniform3f(this.u("sky", "uSkyZenith"), skyZenith[0], skyZenith[1], skyZenith[2]);
    gl.uniform3f(this.u("sky", "uSkyHorizon"), skyHorizon[0], skyHorizon[1], skyHorizon[2]);
    gl.uniform3f(this.u("sky", "uFogColor"), fogColor[0], fogColor[1], fogColor[2]);
    gl.uniform1f(this.u("sky", "uMist"), mistAmt);
    gl.uniform1f(this.u("sky", "uSpaceMix"), spaceMix);
    gl.uniform1f(this.u("sky", "uTime"), timeS);
    gl.uniform1f(this.u("sky", "uCloudCover"), prm.cloudCover);
    gl.uniform2f(this.u("sky", "uWindDir"), windDir[0], windDir[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);

    // ============ 1.5) 全球球体（全瓦片拼接，升空可见行星；窗口内地形接管/逐片丢弃） ============
    const g = this.table.globe;
    const cover = this.scheduler.stats.cover;
    const frame: AnchorFrame | null = this.stream?.frame ?? null;
    gl.useProgram(this.progs.globe);
    gl.uniformMatrix4fv(this.u("globe", "uViewProj"), false, viewProj);
    gl.uniform3f(this.u("globe", "uGlobePole"), this.gb.pole[0], this.gb.pole[1], this.gb.pole[2]);
    gl.uniform3f(this.u("globe", "uGlobeEq"), this.gb.eq[0], this.gb.eq[1], this.gb.eq[2]);
    gl.uniform3f(this.u("globe", "uGlobeEast"), this.gb.east[0], this.gb.east[1], this.gb.east[2]);
    if (frame) {
      gl.uniformMatrix3fv(this.u("globe", "uActM"), false, new Float32Array(frame.m));
      gl.uniformMatrix3fv(this.u("globe", "uActMi"), false, new Float32Array(frame.mi));
      const fw = this.stream!.focusWorld(cam.fx, cam.fz);
      gl.uniform3f(this.u("globe", "uFocusW"), fw[0], fw[1], fw[2]);
    } else {
      gl.uniformMatrix3fv(this.u("globe", "uActM"), false, IDENT3);
      gl.uniformMatrix3fv(this.u("globe", "uActMi"), false, IDENT3);
      gl.uniform3f(this.u("globe", "uFocusW"), cam.fx, 0, cam.fz);
    }
    gl.uniform1f(this.u("globe", "uLam0"), REF_CENTER_LON);
    const bnd = this.table.meta.bounds;
    gl.uniform4f(this.u("globe", "uGlobeConf0"), bnd.latN, bnd.latS, bnd.lonW, bnd.lonE);
    gl.uniform4f(this.u("globe", "uGlobeConf1"), this.table.spanX, this.table.spanZ, prm.exagg, 0);
    gl.uniform2f(this.u("globe", "uGlobeSize"), g.w, g.h);
    gl.uniform4f(this.u("globe", "uClipRect"), cover[0], cover[1], cover[2], cover[3]);
    gl.uniform3f(this.u("globe", "uEyeRel"), eyeRel[0], eyeRel[1], eyeRel[2]);
    gl.uniform3f(this.u("globe", "uSunDir"), sunDir[0], sunDir[1], sunDir[2]);
    gl.uniform3f(this.u("globe", "uSunColor"), sunColor[0], sunColor[1], sunColor[2]);
    gl.uniform1f(this.u("globe", "uTime"), timeS);
    gl.uniform1f(this.u("globe", "uCloudCover"), prm.cloudCover);
    gl.uniform1f(this.u("globe", "uGlobeFogD"), fogD);
    gl.uniform3f(this.u("globe", "uFogColor"), fogColor[0], fogColor[1], fogColor[2]);
    gl.uniform2f(this.u("globe", "uWindDir"), windDir[0], windDir[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);
    gl.uniform1i(this.u("globe", "uHeights"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.globeTex);
    gl.uniform1i(this.u("globe", "uGlobeH"), 1);
    gl.bindVertexArray(this.vaoGlobe!);
    gl.depthMask(true);
    gl.drawElements(gl.TRIANGLES, this.globeIdxCount, gl.UNSIGNED_INT, 0);

    // ============ 2) 地形分块（7 级 LOD + 近景浮雕烘焙） ============
    const schedule = this.scheduler.schedule(cam.fx, cam.fz, frustum, prm.exagg, this.frameNo, detailAmp, this.dataRects);
    this.dataRects.length = 0;
    gl.useProgram(this.progs.terrain);
    gl.uniformMatrix4fv(this.u("terrain", "uViewProj"), false, viewProj);
    gl.uniform3f(this.u("terrain", "uFocus"), cam.fx, 0, cam.fz);
    gl.uniform3f(this.u("terrain", "uEyeRel"), eyeRel[0], eyeRel[1], eyeRel[2]);
    gl.uniform3f(this.u("terrain", "uSunDir"), sunDir[0], sunDir[1], sunDir[2]);
    gl.uniform3f(this.u("terrain", "uSunColor"), sunColor[0], sunColor[1], sunColor[2]);
    gl.uniform3f(this.u("terrain", "uAmbient"), ambient[0], ambient[1], ambient[2]);
    gl.uniform3f(this.u("terrain", "uFogColor"), fogColor[0], fogColor[1], fogColor[2]);
    gl.uniform1f(this.u("terrain", "uExagg"), prm.exagg);
    gl.uniform1f(this.u("terrain", "uSnowLine"), prm.snowLineM);
    gl.uniform1f(this.u("terrain", "uTreeLine"), prm.treeLineM);
    gl.uniform1f(this.u("terrain", "uFogDensity"), fogD);
    gl.uniform1f(this.u("terrain", "uCloudStrength"), 0.3 + prm.cloudCover * 0.45);
    gl.uniform1f(this.u("terrain", "uShadowOn"), prm.shadows ? 1 : 0);
    gl.uniform1f(this.u("terrain", "uMist"), mistAmt);
    gl.uniform1f(this.u("terrain", "uDetailAmp"), detailAmp);
    gl.uniform1f(this.u("terrain", "uTime"), timeS);
    gl.uniform2f(this.u("terrain", "uWindDir"), windDir[0], windDir[2]);
    gl.uniform2f(this.u("terrain", "uSpan"), this.table.spanX, this.table.spanZ);
    // 远景一致化：升空后窗口地形片元 → 全球球体同源色板（20..120km 渐变），
    // 消除窗口矩形与球体的材质边界；锚点 up 向量供纬度解算
    gl.uniform1f(this.u("terrain", "uGlobeBlend"), Math.min(1, Math.max(0, (eyeAlt - 20000) / 100000)));
    gl.uniform1f(this.u("terrain", "uCloudCover"), prm.cloudCover);
    if (frame) {
      gl.uniform3f(this.u("terrain", "uActUp"), frame.m[3], frame.m[4], frame.m[5]);
    } else {
      gl.uniform3f(this.u("terrain", "uActUp"), 0, 1, 0);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);
    gl.uniform1i(this.u("terrain", "uHeights"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.waterTex);
    gl.uniform1i(this.u("terrain", "uWater"), 1);

    let tris = 0;
    gl.bindVertexArray(this.vaoTerrain!);
    for (const item of schedule) {
      gl.bindBuffer(gl.ARRAY_BUFFER, item.mesh.vbo);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      const count = this.scheduler.bindIndices(item.level);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
      tris += count / 3;
    }

    // ============ 3) 植被实例（四向交叉个体） ============
    let vegCount = 0;
    let grassCount = 0;
    if (prm.showVeg && prm.vegDensity > 0.01) {
      const key = `${Math.round(cam.fx / 400)}_${Math.round(cam.fz / 400)}_${prm.vegDensity.toFixed(2)}_${prm.snowLineM}_${prm.exagg}_${detailAmp}_${this.table.version}`;
      if (key !== this.lastVegKey) {
        this.lastVegKey = key;
        const plan = planVegetation(this.table, cam.fx, cam.fz, prm.exagg, prm.vegDensity, prm.snowLineM, detailAmp);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.treeInst);
        gl.bufferData(gl.ARRAY_BUFFER, plan.instances, gl.DYNAMIC_DRAW);
        this.vegCountActual = plan.count;
      }
      vegCount = this.vegCountActual;
      if (vegCount > 0) {
        gl.useProgram(this.progs.tree);
        gl.uniformMatrix4fv(this.u("tree", "uViewProj"), false, viewProj);
        gl.uniform3f(this.u("tree", "uFocus"), cam.fx, 0, cam.fz);
        gl.uniform3f(this.u("tree", "uEyeRel"), eyeRel[0], eyeRel[1], eyeRel[2]);
        gl.uniform1f(this.u("tree", "uTime"), timeS);
        gl.uniform1f(this.u("tree", "uWind"), prm.wind);
        gl.uniform1f(this.u("tree", "uExagg"), prm.exagg);
        gl.uniform2f(this.u("tree", "uWindDir"), windDir[0], windDir[2]);
        gl.uniform3f(this.u("tree", "uSunDir"), sunDir[0], sunDir[1], sunDir[2]);
        gl.uniform3f(this.u("tree", "uSunColor"), sunColor[0], sunColor[1], sunColor[2]);
        gl.uniform3f(this.u("tree", "uAmbient"), ambient[0], ambient[1], ambient[2]);
        gl.uniform3f(this.u("tree", "uFogColor"), fogColor[0], fogColor[1], fogColor[2]);
        gl.uniform1f(this.u("tree", "uSnowLine"), prm.snowLineM);
        gl.uniform1f(this.u("tree", "uFogDensity"), fogD);
        gl.uniform1f(this.u("tree", "uShadowOn"), prm.shadows ? 1 : 0);
        gl.uniform1f(this.u("tree", "uMist"), mistAmt);
        gl.uniform2f(this.u("tree", "uSpan"), this.table.spanX, this.table.spanZ);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.treeTex);
        gl.uniform1i(this.u("tree", "uTreeTex"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);   // 树基点阴影步进用
        gl.uniform1i(this.u("tree", "uHeights"), 1);
        gl.bindVertexArray(this.vaoTree!);
        gl.disable(gl.CULL_FACE);
        gl.drawElementsInstanced(gl.TRIANGLES, 24, gl.UNSIGNED_SHORT, 0, vegCount);
        gl.enable(gl.CULL_FACE);
      }

      // ---- 近景草丛层（草甸带 750m 半径增殖） ----
      if (prm.grass) {
        const gkey = `${Math.round(cam.fx / 80)}_${Math.round(cam.fz / 80)}_${prm.vegDensity.toFixed(2)}_${prm.snowLineM}_${prm.exagg}_${detailAmp}_${this.table.version}`;
        if (gkey !== this.lastGrassKey) {
          this.lastGrassKey = gkey;
          const gplan = planGrass(this.table, cam.fx, cam.fz, prm.exagg, prm.vegDensity, prm.snowLineM, detailAmp);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.grassInst);
          gl.bufferData(gl.ARRAY_BUFFER, gplan.instances, gl.DYNAMIC_DRAW);
          this.grassCountActual = gplan.count;
        }
        grassCount = this.grassCountActual;
        if (grassCount > 0) {
          gl.useProgram(this.progs.grass);
          gl.uniformMatrix4fv(this.u("grass", "uViewProj"), false, viewProj);
          gl.uniform3f(this.u("grass", "uFocus"), cam.fx, 0, cam.fz);
          gl.uniform3f(this.u("grass", "uEyeRel"), eyeRel[0], eyeRel[1], eyeRel[2]);
          gl.uniform1f(this.u("grass", "uTime"), timeS);
          gl.uniform1f(this.u("grass", "uWind"), prm.wind);
          gl.uniform2f(this.u("grass", "uWindDir"), windDir[0], windDir[2]);
          gl.uniform3f(this.u("grass", "uSunDir"), sunDir[0], sunDir[1], sunDir[2]);
          gl.uniform3f(this.u("grass", "uSunColor"), sunColor[0], sunColor[1], sunColor[2]);
          gl.uniform3f(this.u("grass", "uAmbient"), ambient[0], ambient[1], ambient[2]);
          gl.uniform3f(this.u("grass", "uFogColor"), fogColor[0], fogColor[1], fogColor[2]);
          gl.uniform1f(this.u("grass", "uFogDensity"), fogD);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.grassTex);
          gl.uniform1i(this.u("grass", "uGrassTex"), 0);
          gl.bindVertexArray(this.vaoGrass!);
          gl.disable(gl.CULL_FACE);
          gl.drawElementsInstanced(gl.TRIANGLES, 12, gl.UNSIGNED_SHORT, 0, grassCount);
          gl.enable(gl.CULL_FACE);
        }
      }
    }

    // ============ 4) 水面 ============
    gl.useProgram(this.progs.water);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniformMatrix4fv(this.u("water", "uViewProj"), false, viewProj);
    gl.uniform3f(this.u("water", "uFocus"), cam.fx, 0, cam.fz);
    gl.uniform3f(this.u("water", "uEyeRel"), eyeRel[0], eyeRel[1], eyeRel[2]);
    gl.uniform3f(this.u("water", "uSunDir"), sunDir[0], sunDir[1], sunDir[2]);
    gl.uniform3f(this.u("water", "uSunColor"), sunColor[0], sunColor[1], sunColor[2]);
    gl.uniform3f(this.u("water", "uSkyZenith"), skyZenith[0], skyZenith[1], skyZenith[2]);
    gl.uniform3f(this.u("water", "uSkyHorizon"), skyHorizon[0], skyHorizon[1], skyHorizon[2]);
    gl.uniform3f(this.u("water", "uFogColor"), fogColor[0], fogColor[1], fogColor[2]);
    gl.uniform1f(this.u("water", "uTime"), timeS);
    gl.uniform1f(this.u("water", "uWind"), prm.wind);
    gl.uniform1f(this.u("water", "uFogDensity"), fogD);
    gl.uniform1f(this.u("water", "uExagg"), prm.exagg);
    gl.uniform1f(this.u("water", "uShadowOn"), prm.shadows ? 1 : 0);
    gl.uniform1f(this.u("water", "uMist"), mistAmt);
    gl.uniform1f(this.u("water", "uDetailAmp"), detailAmp);
    gl.uniform2f(this.u("water", "uSpan"), this.table.spanX, this.table.spanZ);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);
    gl.uniform1i(this.u("water", "uHeights"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.waterTex);
    gl.uniform1i(this.u("water", "uWater"), 1);
    gl.bindVertexArray(this.vaoWater!);
    gl.drawElements(gl.TRIANGLES, this.waterIdxCount, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // ============ 5) 拾取标记 ============
    if (this.markerRel) {
      gl.useProgram(this.progs.marker);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.uniformMatrix4fv(this.u("marker", "uViewProj"), false, viewProj);
      gl.uniform3f(
        this.u("marker", "uCenter"),
        this.markerRel[0] - cam.fx,
        this.markerRel[1],
        this.markerRel[2] - cam.fz,
      );
      const mdist = Math.hypot(this.markerRel[0] - cam.fx, this.markerRel[2] - cam.fz);
      gl.uniform1f(this.u("marker", "uSize"), Math.max(30, mdist * 0.012));
      gl.bindVertexArray(this.vaoMarker!);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    return {
      chunks: schedule.length,
      byLevel: [...this.scheduler.stats.byLevel],
      tris,
      vegCount,
      grassCount,
      meshCache: this.scheduler.stats.cached,
      built: this.scheduler.stats.builtThisFrame,
    };
  }

  /** 设置拾取标记（区域绝对坐标；随地表曲率同步下沉） */
  setMarker(x: number, z: number, elevM: number, exagg: number): void {
    this.markerRel = [x, elevM * exagg - curvatureDrop(x, z), z];
  }

  /** 重锚定/窗口尺寸变化：重建窗口纹理 + 失效块缓存与植被规划 + 水面网格随 span 重建 */
  onWindowChanged(): void {
    this.texW = -1; // 触发 syncWindow 整幅重建
    this.syncWindow([]);
    this.buildWaterMesh(this.table.spanX, this.table.spanZ);
    this.scheduler.invalidate();
    this.lastVegKey = "";
    this.lastGrassKey = "";
  }

  /** 水面网格：128² 顶点覆盖 span + 4km 余量（换层时 span 变化 → 重建覆盖全窗） */
  private buildWaterMesh(spanX: number, spanZ: number): void {
    const gl = this.gl;
    const halfX = spanX / 2 + 4000;
    const halfZ = spanZ / 2 + 4000;
    const WN = 128;
    const waterVerts = new Float32Array(WN * WN * 2);
    let wp = 0;
    for (let j = 0; j < WN; j++)
      for (let i = 0; i < WN; i++) {
        waterVerts[wp++] = -halfX + (i / (WN - 1)) * 2 * halfX;
        waterVerts[wp++] = -halfZ + (j / (WN - 1)) * 2 * halfZ;
      }
    const wIdx = new Uint32Array((WN - 1) * (WN - 1) * 6);
    let wi = 0;
    for (let j = 0; j < WN - 1; j++)
      for (let i = 0; i < WN - 1; i++) {
        const a = j * WN + i;
        wIdx[wi++] = a; wIdx[wi++] = a + WN; wIdx[wi++] = a + 1;
        wIdx[wi++] = a + 1; wIdx[wi++] = a + WN; wIdx[wi++] = a + WN + 1;
      }
    if (!this.waterVbo) this.waterVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.waterVbo);
    gl.bufferData(gl.ARRAY_BUFFER, waterVerts, gl.STATIC_DRAW);
    if (!this.waterIbo) this.waterIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.waterIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wIdx, gl.STATIC_DRAW);
    this.waterIdxCount = wIdx.length;
  }

  /** 植被/块缓存失效（数据版本变化时由 render() 自动触发，此处供外部强制） */
  invalidateTerrain(): void {
    this.scheduler.invalidate();
    this.lastVegKey = "";
    this.lastGrassKey = "";
  }

  /**
   * 流式镜像 → GPU 纹理增量上传（脏矩形按整行扩展，对齐 bytesPerRow）。
   * 尺寸不符时整幅重建（重锚定后首次）。
   */
  syncWindow(rects: DirtyRect[]): void {
    const gl = this.gl;
    const t = this.table;
    // 每个到达的镜像补丁都要喂给分块调度器（受影响网格陈旧 → 预算内重建）
    for (const r of rects) this.dataRects.push(r);
    if (this.texW !== t.w || this.texH !== t.h) {
      const w = t.w;
      const h = t.h;
      this.texW = w;
      this.texH = h;
      const f16 = new Uint16Array(w * h);
      for (let i = 0; i < w * h; i++) f16[i] = f32ToF16Bits(t.heights[i]);
      gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, f16);
      gl.bindTexture(gl.TEXTURE_2D, this.waterTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(t.water));
      this.dataRects.push({ x0: 0, y0: 0, x1: w, y1: h }); // 整幅重建 → 全部网格视为陈旧
      return;
    }
    if (rects.length === 0) return;
    // 整行扩展合并（y 范围去重）
    const rowMark = new Uint8Array(t.h);
    for (const r of rects) {
      for (let j = Math.max(0, Math.floor(r.y0)); j < Math.min(t.h, Math.ceil(r.y1)); j++) rowMark[j] = 1;
    }
    for (let j = 0; j < t.h; j++) {
      if (!rowMark[j]) continue;
      const f16row = new Uint16Array(t.w);
      for (let i = 0; i < t.w; i++) f16row[i] = f32ToF16Bits(t.heights[j * t.w + i]);
      gl.bindTexture(gl.TEXTURE_2D, this.heightsTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, j, t.w, 1, gl.RED, gl.HALF_FLOAT, f16row);
      const wrow = new Uint8Array(t.water.buffer, t.water.byteOffset + j * t.w, t.w);
      gl.bindTexture(gl.TEXTURE_2D, this.waterTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, j, t.w, 1, gl.RED, gl.UNSIGNED_BYTE, wrow);
    }
  }

  /** 分块构建预算（重锚定突发重建时调高） */
  setBurst(n: number): void {
    this.scheduler.budget = n;
  }

  clearMarker(): void {
    this.markerRel = null;
  }

  /** 空间交互求交（共享实现，与 WebGPU 路径严格一致） */
  pick(ndcX: number, ndcY: number, cam: CameraState, exagg: number, detailAmp = 0): PickResult | null {
    return pickSurface(this.table, cam, exagg, ndcX, ndcY, detailAmp);
  }

  destroy(): void {
    this.scheduler.destroy();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
