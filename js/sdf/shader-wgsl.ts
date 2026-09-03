// ============================================================
// SDF 实体构造与渲染系统 —— WGSL 着色器（WebGPU 后端）
// 由 shader.ts (GLSL ES 3.0) 逐条翻译；uniform 收敛为单一 block
// （struct Uni，全部 vec4，与 pack.ts packBlock 布局逐位对应）。
// 含：smin 族四类过渡 / 变半径倒角 / 波浪熔接 / 错位搭接 / 极坐标周期
// 基元 / 球体追踪 / 解析梯度+拉普拉斯曲率 / 三相光学 / 多次内反射玻璃 /
// 四类微观法线 / 磨损增殖+痕迹持久化 / 拾取探针双模式 / 包围球预剔除。
// ============================================================

export const WGSL = `
struct Uni {
  uRes: vec4<f32>,        // xy=res
  uCamQ: vec4<f32>,       // 相机姿态四元数（规则八：观察者固定原点）
  uDistScale: vec4<f32>,  // x=dist y=scale z=waveMax w=primCount
  uSunW: vec4<f32>,       // xyz=太阳方向 w=模式(0渲染/1标签/2法线)
  uSunCol: vec4<f32>,     // xyz=太阳颜色
  uBound: vec4<f32>,      // 包围球 xyz,r
  uProbeDir: vec4<f32>,   // 拾取射线（cam 系）
  uWear: vec4<f32>,       // x=服役时长(s) y=场景磨损种子
  uCluster: vec4<f32>,    // 集群增殖域重复实例层：x=on y=网格间距 z=散开幅度 w=动画时钟
  uP0: array<vec4<f32>, 16>,
  uP1: array<vec4<f32>, 16>,
  uP2: array<vec4<f32>, 16>,
  uP3: array<vec4<f32>, 16>,
  uB0: array<vec4<f32>, 16>,
  uB1: array<vec4<f32>, 16>,
};
@group(0) @binding(0) var<uniform> U: Uni;

const TANF: f32 = 0.3839;
const PI: f32 = 3.14159265;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(pos[vi], 0.0, 1.0);
}

// ---------- 四元数 ----------
fn qrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
fn qrotInv(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return qrot(vec4<f32>(-q.xyz, q.w), v);
}

// ---------- 哈希与噪声（微观质感/磨损数据源，无任何贴图） ----------
fn hash1(pIn: vec3<f32>) -> f32 {
  var p = fract(pIn * 0.3183099 + vec3<f32>(0.1));
  p = p * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
fn noise3(x: vec3<f32>) -> f32 {
  let iv = floor(x);
  let fv = fract(x);
  let fu = fv * fv * (3.0 - 2.0 * fv);
  return mix(
    mix(mix(hash1(iv), hash1(iv + vec3<f32>(1.0, 0.0, 0.0)), fu.x),
        mix(hash1(iv + vec3<f32>(0.0, 1.0, 0.0)), hash1(iv + vec3<f32>(1.0, 1.0, 0.0)), fu.x), fu.y),
    mix(mix(hash1(iv + vec3<f32>(0.0, 0.0, 1.0)), hash1(iv + vec3<f32>(1.0, 0.0, 1.0)), fu.x),
        mix(hash1(iv + vec3<f32>(0.0, 1.0, 1.0)), hash1(iv + vec3<f32>(1.0, 1.0, 1.0)), fu.x), fu.y),
    fu.z);
}

fn smod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }

// ---------- 集群增殖实例层（域重复；三端同构，取长补短移植自 solid-demo） ----------
fn rotY(p: vec3<f32>, a: f32) -> vec3<f32> {
  let c = cos(a); let s = sin(a);
  return vec3<f32>(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}
fn hash31(c: vec3<f32>) -> vec3<f32> {
  return fract(sin(vec3<f32>(
    dot(c, vec3<f32>(127.1, 311.7, 74.7)),
    dot(c, vec3<f32>(269.5, 183.3, 246.1)),
    dot(c, vec3<f32>(113.5, 271.9, 124.6)))) * 43758.5453);
}

// ---------- 基元 SDF（第二章：全部基元即时转换为闭式距离场） ----------
fn primEval(t: i32, q: vec3<f32>, P2: vec4<f32>) -> f32 {
  if (t == 0) {
    let d = abs(q) - P2.xyz;
    return length(max(d, vec3<f32>(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
  } else if (t == 1) {
    return length(q) - P2.x;
  } else if (t == 2) {
    let d = vec2<f32>(length(q.xz) - P2.x, abs(q.y) - P2.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0)));
  } else if (t == 3) {
    return length(vec2<f32>(length(q.xz) - P2.x, q.y)) - P2.y;
  } else if (t == 4) {
    return length(q - vec3<f32>(0.0, clamp(q.y, -P2.y, P2.y), 0.0)) - P2.x;
  } else {
    // 5 螺栓环：绕 Z 轴极坐标周期映射复用单一函数体（规则八）
    let n = max(P2.z, 2.0);
    var ang = atan2(q.y, q.x);
    let sec = 2.0 * PI / n;
    ang = smod(ang + sec * 0.5, sec) - sec * 0.5;
    let rr = length(q.xy);
    let fold = vec2<f32>(cos(ang) * rr, sin(ang) * rr);
    let qb = vec3<f32>(fold.x - P2.w, fold.y, q.z);
    let d = vec2<f32>(length(qb.xy) - P2.x, abs(qb.z) - P2.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0)));
  }
}

// ---------- 平滑集合运算（第二章：边界过渡的消融与隆起） ----------
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn smax(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 - 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}

struct Hit { d: f32, la: f32, slb: f32, sw: f32, ip: i32, };

// 全局有符号距离场：依结合描述表顺序折叠（单一连续场）
fn map(p: vec3<f32>) -> Hit {
  var acc: f32 = 1e9;
  var la: f32 = 0.0;
  var slb: f32 = -1.0;
  var sw: f32 = 0.0;
  var ip: i32 = 0;
  let pc = i32(U.uDistScale.w + 0.5);
  for (var i = 0; i < 16; i = i + 1) {
    if (i >= pc) { break; }
    let q = qrotInv(U.uP3[i], p - U.uP1[i].xyz);
    let d = primEval(i32(U.uP0[i].x + 0.5), q, U.uP2[i]);
    let lb = U.uP0[i].y;
    if (i == 0) { acc = d; la = lb; continue; }
    let op = i32(U.uB0[i].x + 0.5);
    let tt = i32(U.uB0[i].y + 0.5);
    let k = U.uB0[i].z;
    if (op == 1) {
      // 差集：max 与取反结合；切面继承宿主标签
      acc = smax(acc, -d, max(k, 1e-4));
    } else if (op == 2) {
      // 交集
      let kk = max(k, 1e-4);
      let h = clamp(0.5 + 0.5 * (acc - d) / kk, 0.0, 1.0);
      acc = mix(d, acc, h) + kk * h * (1.0 - h);
      let pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0 * h * (1.0 - h);
    } else if (tt == 0) {
      // 尖锐并（运动件独立体，不熔接）
      if (d < acc) { acc = d; la = lb; slb = -1.0; sw = 0.0; ip = i; }
    } else if (tt == 2) {
      // 变半径倒角：k = k0 + k1·沿轴坐标（45° 斜面偏移）
      let ax = U.uB1[i].y;
      var s = p.z;
      if (ax < 0.5) { s = p.x; } else if (ax < 1.5) { s = p.y; }
      let kk = max(U.uB1[i].z + U.uB1[i].w * s, 1e-4);
      let c = 0.5 * (acc + d) - kk;
      let r = min(min(acc, d), c);
      let h = clamp(0.5 + 0.5 * (d - acc) / max(kk, 1e-3), 0.0, 1.0);
      let pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0 * h * (1.0 - h);
      acc = r;
    } else if (tt == 3) {
      // 波浪熔接：smin 修正量上叠加空间正弦扰动（鱼鳞状焊接轨迹）
      let kk = max(k, 1e-4);
      let h = clamp(0.5 + 0.5 * (d - acc) / kk, 0.0, 1.0);
      var r = smin(acc, d, kk);
      let wv = sin(U.uB1[i].x * (p.x + 0.7 * p.z)) * sin(U.uB1[i].x * 1.31 * (p.y - 0.41 * p.x));
      r = r - U.uB0[i].w * (4.0 * h * (1.0 - h)) * wv;
      let pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0 * h * (1.0 - h);
      acc = r;
    } else if (tt == 4) {
      // 错位搭接：小半径熔接 + 焊珠
      let kk = max(k, 1e-4);
      let h = clamp(0.5 + 0.5 * (d - acc) / kk, 0.0, 1.0);
      let r = smin(acc, d, kk) + kk * 0.25 * (4.0 * h * (1.0 - h)) * (0.5 + 0.5 * sin(60.0 * (acc - d)));
      let pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0 * h * (1.0 - h);
      acc = r;
    } else {
      // 恒定半径圆角：多项式 smin（负偏移使棱线内凹成圆弧）
      let kk = max(k, 1e-4);
      let h = clamp(0.5 + 0.5 * (d - acc) / kk, 0.0, 1.0);
      let r = mix(d, acc, h) - kk * h * (1.0 - h);
      let pl = la;
      if (h < 0.5) { la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0 * h * (1.0 - h);
      acc = r;
    }
  }
  return Hit(acc, la, slb, sw, ip);
}
fn mapD(p: vec3<f32>) -> f32 { return map(p).d; }

/** 全局距离场入口：单物体直通；集群开启时包一层域重复实例层（实例层不改标签/工艺码） */
fn mapScene(pIn: vec3<f32>) -> Hit {
  if (U.uCluster.x < 0.5) { return map(pIn); }
  let cs = max(U.uCluster.y, 1.5);
  let cell = floor(pIn / cs);
  let h = hash31(cell);
  let centerW = (cell + vec3<f32>(0.5)) * cs;   // 实例中心
  let pop = 0.5 - 0.5 * cos(U.uCluster.w * 0.55 - h.x * 6.2832);
  let dir = normalize(vec3<f32>(h.y - 0.5, h.z * 0.55 + 0.15, h.x - 0.5));
  let off = dir * U.uCluster.z * pop;
  let scl = 1.0 + 0.07 * sin(U.uCluster.w * 1.25 + h.y * 6.2832);
  let ang = h.z * 6.2832 + U.uCluster.w * 0.12;
  // 实例逆变换（世界→spec 空间）：减 center+off → 旋回 -ang → 除 scl
  let xSpec = rotY(pIn - centerW - off, -ang) / scl;
  var o = map(xSpec);
  o.d = o.d * scl;                              // 均匀缩放距离补偿
  return o;
}
fn mapSceneD(p: vec3<f32>) -> f32 { return mapScene(p).d; }

// ---------- 第三章：解析梯度法线 + 拉普拉斯曲率（同一组采样同时得出） ----------
fn normalCurv(p: vec3<f32>, eps: f32) -> vec4<f32> {
  let e = vec2<f32>(1.0, -1.0) * 0.5773;
  let m1 = mapSceneD(p + e.xyy * eps);
  let m2 = mapSceneD(p + e.yyx * eps);
  let m3 = mapSceneD(p + e.yxy * eps);
  let m4 = mapSceneD(p + e.xxx * eps);
  let n = normalize(e.xyy * m1 + e.yyx * m2 + e.yxy * m3 + e.xxx * m4);
  let curv = 1.5 * (m1 + m2 + m3 + m4 - 4.0 * mapSceneD(p)) / (eps * eps);
  return vec4<f32>(n, curv);
}

// ---------- 第三章：球体追踪（亚像素收敛判据 = 1.5 像素足迹） ----------
// cap：单步步长上限（集群模式下实例层参数在格子边界跳变，限步防穿越薄结构）
fn march(ro: vec3<f32>, rd: vec3<f32>, t0: f32, tmax: f32, relax: f32, cap: f32) -> f32 {
  var t = t0;
  for (var i = 0; i < 64; i = i + 1) {
    let d = mapSceneD(ro + rd * t);
    let eps = max(2e-6, t * 3.0 * TANF / (U.uRes.y * U.uDistScale.y * U.uDistScale.y));
    if (d < eps) { return t; }
    t = t + min(d * relax, cap);
    if (t > tmax) { break; }
  }
  return -1.0;
}

fn softShadow(ro: vec3<f32>, rd: vec3<f32>, tmax: f32) -> f32 {
  var res: f32 = 1.0;
  var t: f32 = 0.012;
  for (var i = 0; i < 16; i = i + 1) {
    let h = mapSceneD(ro + rd * t);
    res = min(res, 9.0 * h / t);
    if (res < 0.03 || t > tmax) { break; }
    t = t + clamp(h, 0.008, 0.15);
  }
  return clamp(res, 0.0, 1.0);
}

fn calcAO(p: vec3<f32>, n: vec3<f32>, eps: f32) -> f32 {
  var o: f32 = 0.0;
  var s: f32 = 1.0;
  for (var i = 0; i < 2; i = i + 1) {
    let h = eps * (1.5 + 3.0 * f32(i));
    o = o + (h - mapSceneD(p + n * h)) * s;
    s = s * 0.55;
  }
  return clamp(1.0 - 2.5 * o / (3.0 * max(eps, 1e-6)), 0.0, 1.0);
}

// ---------- 第四章：光学响应库（纯数学材质，无贴图） ----------
struct Mat { alb: vec3<f32>, metal: f32, rough: f32, f0: vec3<f32>, trans: f32, absorb: vec3<f32>, };
fn matOf(lbl: i32) -> Mat {
  if (lbl == 0) { return Mat(vec3<f32>(0.62, 0.63, 0.65), 1.0, 0.22, vec3<f32>(0.56, 0.57, 0.58), 0.0, vec3<f32>(0.0)); }
  if (lbl == 1) { return Mat(vec3<f32>(0.42, 0.42, 0.43), 1.0, 0.52, vec3<f32>(0.36, 0.36, 0.37), 0.0, vec3<f32>(0.0)); }
  if (lbl == 2) { return Mat(vec3<f32>(0.85, 0.55, 0.45), 1.0, 0.30, vec3<f32>(0.95, 0.64, 0.54), 0.0, vec3<f32>(0.0)); }
  if (lbl == 3) { return Mat(vec3<f32>(1.0, 1.0, 1.0), 0.0, 0.04, vec3<f32>(0.04, 0.04, 0.04), 1.0, vec3<f32>(0.10, 0.31, 0.33)); }
  if (lbl == 4) { return Mat(vec3<f32>(0.045, 0.045, 0.05), 0.0, 0.86, vec3<f32>(0.04, 0.04, 0.04), 0.0, vec3<f32>(0.0)); }
  if (lbl == 5) { return Mat(vec3<f32>(0.55, 0.16, 0.12), 0.0, 0.38, vec3<f32>(0.04, 0.04, 0.04), 0.0, vec3<f32>(0.0)); }
  return Mat(vec3<f32>(0.60, 0.61, 0.63), 1.0, 0.30, vec3<f32>(0.56, 0.57, 0.58), 0.0, vec3<f32>(0.0));
}

fn sky(rd: vec3<f32>) -> vec3<f32> {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  var c = mix(vec3<f32>(0.30, 0.30, 0.33), vec3<f32>(0.09, 0.12, 0.19), t);
  let s = max(dot(rd, normalize(U.uSunW.xyz)), 0.0);
  c = c + U.uSunCol.xyz * 0.35 * pow(s, 48.0);
  return c;
}

// ---------- 第五章：微观法线扰动（工艺质感，与宏观场完全正交） ----------
fn microAmp(lbl: i32) -> f32 {
  if (lbl == 0) { return 0.00035; }
  if (lbl == 1) { return 0.00090; }
  if (lbl == 6) { return 0.00120; }
  if (lbl == 5) { return 0.00040; }
  if (lbl == 4) { return 0.00060; }
  return 0.0;
}
fn microH(q: vec3<f32>, lbl: i32, curv: f32) -> f32 {
  if (lbl == 0) { return sin(q.x * 720.0 + sin(q.z * 37.0) * 2.4) * 0.7 + 0.3 * sin(q.y * 2600.0); }
  if (lbl == 1) { return noise3(q * 260.0) * 0.6 + noise3(q * 900.0) * 0.3 + noise3(q * 2400.0) * 0.1; }
  if (lbl == 6) {
    let g = abs(sin(q.x * 430.0)) * abs(sin(q.z * 430.0));
    return g * (0.6 + min(max(curv, 0.0) * 0.05, 2.5));
  }
  if (lbl == 5) { return sin(q.x * 95.0) * sin(q.y * 88.0) * sin(q.z * 91.0); }
  if (lbl == 4) { return noise3(q * 1500.0); }
  return 0.0;
}
fn bumpNormal(pw: vec3<f32>, n: vec3<f32>, ip: i32, curv: f32, epsw: f32, extraAmp: f32) -> vec3<f32> {
  let lbl = i32(U.uP0[ip].y + 0.5);
  let amp = microAmp(lbl) + extraAmp;
  if (amp <= 0.0) { return n; }
  let Q = U.uP3[ip];
  let c = U.uP1[ip].xyz;
  let refv = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.y) < 0.98);
  let t = normalize(cross(n, refv));
  let b = cross(n, t);
  let h0 = microH(qrotInv(Q, pw - c), lbl, curv);
  let h1 = microH(qrotInv(Q, pw + t * epsw - c), lbl, curv);
  let h2 = microH(qrotInv(Q, pw + b * epsw - c), lbl, curv);
  return normalize(n - amp * ((h1 - h0) / epsw * t + (h2 - h0) / epsw * b));
}

// ---------- 第六章：磨损增殖（侵蚀函数集：划痕群 + 撞击凹坑） ----------
fn scratchN(p: vec3<f32>, seed: f32) -> f32 {
  let cell = floor(p * 130.0);
  let h1 = hash1(cell + vec3<f32>(seed));
  let ang = h1 * 6.2831;
  let d = vec2<f32>(cos(ang), sin(ang));
  let uv = vec2<f32>(dot(p.xz, d), dot(p.xz, vec2<f32>(-d.y, d.x)));
  let stripe = smoothstep(0.86, 1.0, sin(uv.y * 700.0 + h1 * 50.0) * 0.5 + 0.5);
  return stripe * step(0.6, h1) * (0.4 + 0.6 * hash1(cell + vec3<f32>(7.7)));
}

// ---------- 片段主程序 ----------
@fragment
fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.uRes.xy;
  // WebGPU 帧缓冲坐标 y 朝下（GLSL gl_FragCoord y 朝上）：翻转为 y-up NDC，
  // 与 CPU 侧拾取射线（ndcY 向上为正）及天空/太阳方向约定保持一致
  let ndc = vec2<f32>(fc.x / res.x * 2.0 - 1.0, 1.0 - fc.y / res.y * 2.0);
  let aspect = res.x / res.y;
  let mode = U.uSunW.w;
  var rdC = normalize(vec3<f32>(ndc.x * TANF * aspect, ndc.y * TANF, -1.0));
  if (mode > 0.5) { rdC = normalize(U.uProbeDir.xyz); }
  // 规则八：观察者固定逻辑原点，反向旋转+平移+缩放全局场的输入坐标
  let camQ = U.uCamQ;
  let rdW = qrotInv(camQ, rdC);
  let roW = qrotInv(camQ, vec3<f32>(0.0, 0.0, U.uDistScale.x)) * U.uDistScale.y;
  let sunN = normalize(U.uSunW.xyz);
  let relax = 0.85 / (1.0 + 2.5 * U.uDistScale.z);

  let skyBg = pow(max(sky(rdW), vec3<f32>(0.0)), vec3<f32>(0.4545));
  // 包围球预剔除：视外射线零场求值直达天空（集群模式下射线需命中任意实例，跳过剔除）
  var cap: f32 = 1e4;
  var s0: f32 = 0.002;
  var s1: f32 = 26.0;
  if (U.uCluster.x > 0.5) {
    cap = max(U.uCluster.y, 1.5) * 0.45;
    s1 = 40.0;
  } else {
    let oc = roW - U.uBound.xyz;
    let b = dot(rdW, oc);
    let disc = b * b - dot(oc, oc) + U.uBound.w * U.uBound.w;
    if (disc < 0.0) { return vec4<f32>(skyBg, 1.0); }
    let sq = sqrt(disc);
    s0 = max(-b - sq, 0.0);
    s1 = -b + sq;
  }

  let sw2 = march(roW, rdW, s0, s1, relax, cap);
  if (sw2 < 0.0) { return vec4<f32>(skyBg, 1.0); }
  let pw = roW + rdW * sw2;
  let eps = max(2e-6, sw2 * 3.0 * TANF / (res.y * U.uDistScale.y * U.uDistScale.y));

  if (mode > 1.5) {
    let nc2 = normalCurv(pw, eps);
    return vec4<f32>(qrot(camQ, nc2.xyz), nc2.w);
  }
  if (mode > 0.5) {
    let h1 = mapScene(pw);
    return vec4<f32>(sw2 / U.uDistScale.y, h1.la, h1.slb, h1.sw);
  }

  let nc = normalCurv(pw, eps);
  let n = nc.xyz;
  let curv = nc.w;
  let h = mapScene(pw);

  // 第六章：易损区判定（凸棱曲率 × 材质硬度）、距离退化与痕迹持久化
  let hard = U.uP0[h.ip].z;
  var wear = smoothstep(8.0, 90.0, max(curv, 0.0)) * (1.0 - 0.65 * hard);
  wear = wear * (0.35 + 0.65 * min(U.uWear.x * 0.02, 1.0));
  wear = wear * exp(-sw2 * 0.55);
  let scr = wear * (0.3 + 0.7 * scratchN(pw, U.uWear.y));
  let pit = wear * step(0.982, hash1(floor(pw * 260.0)));

  // 第五章：微观法线扰动（磨损细节只作用光照层，不改求交主路径）
  let nb = bumpNormal(pw, n, h.ip, curv, eps, wear * 0.0006);

  // 第四章：区域标签继承 + 过渡混合 + 强制边界自然化（空间扰动咬合）
  let w2 = clamp(h.sw + (noise3(pw * 47.0) - 0.5) * 0.35 * smoothstep(0.0, 0.2, h.sw), 0.0, 1.0);
  let lbA = i32(h.la + 0.5);
  let lbB = select(i32(h.slb + 0.5), lbA, h.slb < 0.0);
  let mA = matOf(lbA);
  let mB = matOf(lbB);
  let alb = mix(mA.alb, mB.alb, w2);
  let metal = mix(mA.metal, mB.metal, w2);
  let rough = clamp(mix(mA.rough, mB.rough, w2) + scr * 0.30 + pit * 0.40, 0.04, 1.0);
  let f0 = mix(mA.f0, mB.f0, w2);
  let trans = max(mix(mA.trans, mB.trans, w2), 0.0);
  let absorb = mix(mA.absorb, mB.absorb, w2);
  // 磨损露底（漆膜剥落露出底材；取长补短移植自 solid-demo 的 worn 语义）
  let wornM = clamp(scr * 2.4 + pit * 1.8, 0.0, 1.0);

  let ao = calcAO(pw, nb, eps * 3.0);
  let NdL = max(dot(nb, sunN), 0.0);
  let NdV = max(dot(nb, -rdW), 1e-3);
  var sh = clamp(NdL * 0.5 + 0.5, 0.0, 1.0);
  if (rough < 0.7) { sh = softShadow(pw + nb * eps * 4.0, sunN, 3.0); }

  var col: vec3<f32>;
  if (trans > 0.5) {
    // 介质相：入射菲涅尔 + 多次内反射链（能量吞吐量衰减 + 逐段指数体吸收）
    let refl = sky(reflect(rdW, nb));
    let Fr0 = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
    let lc = U.uP1[h.ip].xyz;
    let lr = U.uP2[h.ip].x;
    var acc = vec3<f32>(0.0);
    var rC = refract(rdW, nb, 1.0 / 1.48);
    if (dot(rC, rC) < 1e-6) { rC = reflect(rdW, nb); }
    if (i32(U.uP0[h.ip].x + 0.5) == 1) {
      // 球面介质：解析弦长内弹射链（最多 3 次出射尝试，全内反射继续传播）
      var posI = pw;
      var E: f32 = 1.0;
      var tintAcc = vec3<f32>(1.0);
      for (var bi = 0; bi < 3; bi = bi + 1) {
        let pc = posI - lc;
        let bb = dot(rC, pc);
        let cc = dot(pc, pc) - lr * lr;
        let chord = max(-bb + sqrt(max(bb * bb - cc, 0.0)), 1e-4);
        let exitP = posI + rC * chord;
        let nEx = normalize(exitP - lc);
        tintAcc = tintAcc * exp(-absorb * chord * 7.0);
        let Frx = 0.04 + 0.96 * pow(1.0 - max(dot(rC, nEx), 0.0), 5.0);
        let rOut = refract(rC, -nEx, 1.48);
        if (dot(rOut, rOut) > 1e-6) {
          acc = acc + sky(rOut) * tintAcc * E * (1.0 - Frx);
          E = E * Frx;
        }
        rC = reflect(rC, nEx);
        posI = exitP + rC * 1e-4;
      }
      acc = acc + U.uSunCol.xyz * 0.5 * tintAcc * E;
    } else {
      // 非球面介质：单次弦长路径（原始实现）
      let pc = pw - lc;
      let bb = dot(rC, pc);
      let cc = dot(pc, pc) - lr * lr;
      let chord = max(-bb + sqrt(max(bb * bb - cc, 0.0)), 1e-4);
      let exitP = pw + rC * chord;
      let nEx = normalize(exitP - lc);
      var rOut = refract(rC, -nEx, 1.48);
      if (dot(rOut, rOut) < 1e-6) { rOut = reflect(rC, -nEx); }
      acc = sky(rOut) * exp(-absorb * chord * 7.0);
    }
    let Hv = normalize(sunN - rdW);
    let spec = pow(max(dot(nb, Hv), 0.0), 900.0) * 40.0;
    col = mix(acc, refl, Fr0) + U.uSunCol.xyz * spec * Fr0 * sh + U.uSunCol.xyz * pow(max(dot(nb, Hv), 0.0), 60.0) * 0.15;
  } else {
    // 金属相（复折射率特征的菲涅尔近似）+ 漫射有机相（朗伯 + 微表面）
    var albL = alb;
    if (wornM > 0.01 && metal < 0.5) {
      albL = mix(albL, vec3<f32>(0.50, 0.48, 0.45), wornM * 0.55); // 非金属磨损露底
    }
    let Hv = normalize(sunN - rdW);
    let NdH = max(dot(nb, Hv), 0.0);
    let VdH = max(dot(-rdW, Hv), 0.0);
    let a = rough * rough;
    let a2 = a * a;
    let D = a2 / (PI * pow(NdH * NdH * (a2 - 1.0) + 1.0, 2.0));
    let kk = a * 0.5;
    let G = (NdV / (NdV * (1.0 - kk) + kk)) * (NdL / (NdL * (1.0 - kk) + kk));
    let F = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - VdH, 5.0);
    let spec = D * G * F / (4.0 * NdV + 1e-4);
    let diff = albL * (1.0 - metal) * (1.0 - F) * NdL / PI;
    let env = sky(reflect(rdW, nb));
    col = (diff + spec * NdL) * U.uSunCol.xyz * sh;
    col = col + env * (metal * F * 0.9 + (1.0 - metal) * f0 * 0.5) * ao;
    col = col + albL * (1.0 - metal) * 0.10 * (0.55 + 0.45 * nb.y) * ao;
    col = col + vec3<f32>(0.10, 0.12, 0.16) * pow(1.0 - NdV, 3.0) * ao * (0.4 + 0.6 * metal);
    col = col * (1.0 + wornM * 0.22); // 划痕高光提亮（微米级凹坑散射）
  }

  // 距离雾（远融天空；取长补短移植自 solid-demo，阈值随包围球/缩放/集群网格自适应）
  var fogF = max(9.0 * U.uBound.w / max(U.uDistScale.y, 1e-3), 9.0);
  if (U.uCluster.x > 0.5) { fogF = max(fogF, max(U.uCluster.y, 1.5) * 5.0); }
  col = mix(col, sky(rdW), smoothstep(fogF * 0.35, fogF, sw2));

  col = col / (1.0 + col * 0.7);
  col = pow(max(col, vec3<f32>(0.0)), vec3<f32>(0.4545));
  col = col * (1.0 - 0.16 * dot(ndc, ndc));
  return vec4<f32>(col, 1.0);
}
`;
