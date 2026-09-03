// ============================================================
// SDF 实体构造与渲染系统 —— GLSL ES 3.0 着色器（WebGL2 后端）
// 完整实现系统定义第二~八章的数学工作流。
// 注：系统定义与 API 无关；本沙盒无 Vulkan ICD（WebGPU 拿不到 adapter），
// 先以 WebGL2 落地，WGSL 移植为纯翻译工作（见 worklog Task 14）。
// ============================================================

export const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAG = `#version 300 es
precision highp float;
precision highp int;

out vec4 outColor;

uniform vec2  uRes;
uniform vec4  uCamQ;      // 相机姿态四元数（规则八：观察者固定原点）
uniform float uDist;      // 相机到逻辑原点的回撤距离（cam 系）
uniform float uScale;     // 世界缩放（变焦=缩放场输入坐标）
uniform vec3  uSunW;      // 太阳方向（世界系）
uniform vec3  uSunCol;
uniform vec4  uBound;     // 全局包围球 xyz,r（射线预剔除）
uniform int   uMode;      // 0 渲染 / 1 拾取-交点标签 / 2 拾取-法线曲率
uniform vec3  uProbeDir;  // 拾取射线（cam 系）
uniform int   uPrimCount;
uniform float uWaveMax;   // 波浪熔接最大 amp·freq（步长松弛补偿）
uniform vec4  uWear;      // x=服役时长(s) y=场景磨损种子（痕迹持久化层）
uniform vec4  uCluster;   // 集群增殖域重复实例层：x=on y=网格间距 z=散开幅度 w=动画时钟
uniform vec4  uP0[16];    // [type, label, hardness, -]
uniform vec4  uP1[16];    // [pos.xyz, -]
uniform vec4  uP2[16];    // 类型参数
uniform vec4  uP3[16];    // 位姿四元数
uniform vec4  uB0[16];    // [op, trans, radius, waveAmp]
uniform vec4  uB1[16];    // [waveFreq, chamAxis, k0, k1]

const float TANF = 0.3839;   // 垂直 fov 42°
const float PI = 3.14159265;

// ---------- 四元数 ----------
vec3 qrot(vec4 q, vec3 v){ return v + 2.0*cross(q.xyz, cross(q.xyz, v) + q.w*v); }
vec3 qrotInv(vec4 q, vec3 v){ return qrot(vec4(-q.xyz, q.w), v); }

// ---------- 哈希与噪声（微观质感/磨损的数据源，无任何贴图） ----------
float hash1(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise3(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash1(i), hash1(i+vec3(1,0,0)), f.x),
                 mix(hash1(i+vec3(0,1,0)), hash1(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash1(i+vec3(0,0,1)), hash1(i+vec3(1,0,1)), f.x),
                 mix(hash1(i+vec3(0,1,1)), hash1(i+vec3(1,1,1)), f.x), f.y), f.z);
}

// ---------- 基元 SDF（第二章：全部基元即时转换为闭式距离场） ----------
float primEval(int t, vec3 q, vec4 P2){
  if(t == 0){ // 立方体（P2=半长xyz）
    vec3 d = abs(q) - P2.xyz;
    return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
  } else if(t == 1){ // 球
    return length(q) - P2.x;
  } else if(t == 2){ // 圆柱（轴 Y，P2=r,halfH）
    vec2 d = vec2(length(q.xz) - P2.x, abs(q.y) - P2.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
  } else if(t == 3){ // 圆环（P2=R,r）
    return length(vec2(length(q.xz) - P2.x, q.y)) - P2.y;
  } else if(t == 4){ // 胶囊（轴 Y，P2=r,halfLen）
    return length(q - vec3(0.0, clamp(q.y, -P2.y, P2.y), 0.0)) - P2.x;
  } else { // 5 螺栓环：绕 Z 轴极坐标周期映射复用单一函数体（规则八）
    float n = max(P2.z, 2.0);
    float ang = atan(q.y, q.x);
    float sec = 2.0*PI/n;
    ang = mod(ang + sec*0.5, sec) - sec*0.5;
    float rr = length(q.xy);
    vec2 fold = vec2(cos(ang)*rr, sin(ang)*rr);
    vec3 qb = vec3(fold.x - P2.w, fold.y, q.z); // 径向偏置到环半径，轴 = Z
    vec2 d = vec2(length(qb.xy) - P2.x, abs(qb.z) - P2.y);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
  }
}

// ---------- 平滑集合运算（第二章：边界过渡的消融与隆起） ----------
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}
float smax(float a, float b, float k){
  float h = clamp(0.5 - 0.5*(b - a)/k, 0.0, 1.0);
  return mix(b, a, h) + k*h*(1.0 - h);
}

struct Hit { float d; float la; float slb; float sw; int ip; };

// 集群实例层辅助（rotY/hash31 先声明；域重复包装 mapScene 见 map 之后——GLSL 要求先声明后使用）
vec3 rotY(vec3 p, float a){
  float c = cos(a), s = sin(a);
  return vec3(c*p.x - s*p.z, p.y, s*p.x + c*p.z);
}
vec3 hash31(vec3 c) {
  return fract(sin(vec3(
    dot(c, vec3(127.1, 311.7, 74.7)),
    dot(c, vec3(269.5, 183.3, 246.1)),
    dot(c, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
}

// 全局有符号距离场：依结合描述表顺序折叠（单一连续场）
Hit map(vec3 p){
  float acc = 1e9; float la = 0.0; float slb = -1.0; float sw = 0.0; int ip = 0;
  for(int i = 0; i < 16; i++){
    if(i >= uPrimCount) break;
    vec3 q = qrotInv(uP3[i], p - uP1[i].xyz);
    float d = primEval(int(uP0[i].x + 0.5), q, uP2[i]);
    float lb = uP0[i].y;
    if(i == 0){ acc = d; la = lb; continue; }
    int op = int(uB0[i].x + 0.5);
    int tt = int(uB0[i].y + 0.5);
    float k = uB0[i].z;
    if(op == 1){
      // 差集：max 与取反结合；切面继承宿主标签
      acc = smax(acc, -d, max(k, 1e-4));
    } else if(op == 2){
      // 交集
      float kk = max(k, 1e-4);
      float h = clamp(0.5 + 0.5*(acc - d)/kk, 0.0, 1.0);
      acc = mix(d, acc, h) + kk*h*(1.0 - h);
      float pl = la;
      if(h < 0.5){ la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0*h*(1.0 - h);
    } else if(tt == 0){
      // 尖锐并（运动件独立体，不熔接）
      if(d < acc){ acc = d; la = lb; slb = -1.0; sw = 0.0; ip = i; }
    } else if(tt == 2){
      // 变半径倒角：k = k0 + k1·沿轴坐标（45° 斜面偏移）
      float ax = uB1[i].y;
      float s = ax < 0.5 ? p.x : (ax < 1.5 ? p.y : p.z);
      float kk = max(uB1[i].z + uB1[i].w*s, 1e-4);
      float c = 0.5*(acc + d) - kk;
      float r = min(min(acc, d), c);
      float h = clamp(0.5 + 0.5*(d - acc)/max(kk, 1e-3), 0.0, 1.0);
      float pl = la;
      if(h < 0.5){ la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0*h*(1.0 - h);
      acc = r;
    } else if(tt == 3){
      // 波浪熔接：smin 修正量上叠加空间正弦扰动（鱼鳞状焊接轨迹）
      float kk = max(k, 1e-4);
      float h = clamp(0.5 + 0.5*(d - acc)/kk, 0.0, 1.0);
      float r = smin(acc, d, kk);
      float wv = sin(uB1[i].x*(p.x + 0.7*p.z)) * sin(uB1[i].x*1.31*(p.y - 0.41*p.x));
      r -= uB0[i].w * (4.0*h*(1.0 - h)) * wv;
      float pl = la;
      if(h < 0.5){ la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0*h*(1.0 - h);
      acc = r;
    } else if(tt == 4){
      // 错位搭接：小半径熔接 + 焊珠（几何错位由基元位姿数据承担）
      float kk = max(k, 1e-4);
      float h = clamp(0.5 + 0.5*(d - acc)/kk, 0.0, 1.0);
      float r = smin(acc, d, kk) + kk*0.25*(4.0*h*(1.0 - h))*(0.5 + 0.5*sin(60.0*(acc - d)));
      float pl = la;
      if(h < 0.5){ la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0*h*(1.0 - h);
      acc = r;
    } else {
      // 恒定半径圆角：多项式 smin（负偏移使棱线内凹成圆弧）
      float kk = max(k, 1e-4);
      float h = clamp(0.5 + 0.5*(d - acc)/kk, 0.0, 1.0);
      float r = mix(d, acc, h) - kk*h*(1.0 - h);
      float pl = la;
      if(h < 0.5){ la = lb; slb = pl; ip = i; } else { slb = lb; }
      sw = 4.0*h*(1.0 - h);
      acc = r;
    }
  }
  Hit o; o.d = acc; o.la = la; o.slb = slb; o.sw = sw; o.ip = ip;
  return o;
}
// ---------- 集群增殖实例层（域重复；三端同构，取长补短移植自 solid-demo） ----------
// 空间平铺为 cellSize^3 网格（世界坐标锚定：本引擎 map 输入已是世界系，网格不随相机漂移），
// 每格一个完整构造体实例：哈希驱动相位差装配波 + 呼吸缩放 + 慢自转。
// Lipschitz 安全：旋转正交 / 均匀缩放 ×scl 补偿 / 平移不变。
Hit mapScene(vec3 p){
  if (uCluster.x < 0.5) { return map(p); }
  float cs = max(uCluster.y, 1.5);
  vec3 cell = floor(p / cs);
  vec3 h = hash31(cell);
  vec3 centerW = (cell + vec3(0.5)) * cs;   // 实例中心
  float pop = 0.5 - 0.5*cos(uCluster.w*0.55 - h.x*6.2832);
  vec3 dir = normalize(vec3(h.y - 0.5, h.z*0.55 + 0.15, h.x - 0.5));
  vec3 off = dir * uCluster.z * pop;
  float scl = 1.0 + 0.07*sin(uCluster.w*1.25 + h.y*6.2832);
  float ang = h.z*6.2832 + uCluster.w*0.12;
  // 实例逆变换（世界→spec 空间）：减 center+off → 旋回 -ang → 除 scl
  vec3 xSpec = rotY(p - centerW - off, -ang) / scl;
  Hit o = map(xSpec);
  o.d *= scl;                               // 均匀缩放距离补偿
  return o;
}
float mapSceneD(vec3 p){ return mapScene(p).d; }
// 距离便捷入口（经由集群实例层；法线/阴影/AO/追踪共用）
float mapD(vec3 p){ return mapSceneD(p); }

// ---------- 第三章：解析梯度法线 + 拉普拉斯曲率（同一组采样同时得出） ----------
vec4 normalCurv(vec3 p, float eps){
  vec2 e = vec2(1.0, -1.0)*0.5773;
  float m1 = mapD(p + e.xyy*eps);
  float m2 = mapD(p + e.yyx*eps);
  float m3 = mapD(p + e.yxy*eps);
  float m4 = mapD(p + e.xxx*eps);
  vec3 n = normalize(e.xyy*m1 + e.yyx*m2 + e.yxy*m3 + e.xxx*m4);
  float curv = 1.5*(m1 + m2 + m3 + m4 - 4.0*mapD(p))/(eps*eps);
  return vec4(n, curv);
}

// ---------- 第三章：球体追踪（亚像素收敛判据 = 1.5 像素足迹） ----------
// cap：单步步长上限（集群模式下实例层参数在格子边界跳变，限步防穿越薄结构）
float march(vec3 ro, vec3 rd, float t0, float tmax, float relax, float cap){
  float t = t0;
  for(int i = 0; i < 64; i++){
    float d = mapD(ro + rd*t);
    float eps = max(2.0e-6, t*3.0*TANF/(uRes.y*uScale*uScale));
    if(d < eps) return t;
    t += min(d*relax, cap);
    if(t > tmax) break;
  }
  return -1.0;
}

float softShadow(vec3 ro, vec3 rd, float tmax){
  float res = 1.0; float t = 0.012;
  for(int i = 0; i < 16; i++){
    float h = mapD(ro + rd*t);
    res = min(res, 9.0*h/t);
    if(res < 0.03 || t > tmax) break;
    t += clamp(h, 0.008, 0.15);
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n, float eps){
  float o = 0.0; float s = 1.0;
  for(int i = 0; i < 2; i++){
    float h = eps*(1.5 + 3.0*float(i));
    o += (h - mapD(p + n*h))*s;
    s *= 0.55;
  }
  return clamp(1.0 - 2.5*o/(3.0*max(eps, 1e-6)), 0.0, 1.0);
}

// ---------- 第四章：光学响应库（纯数学材质，无贴图） ----------
void matOf(int lbl, out vec3 alb, out float metal, out float rough, out vec3 f0, out float trans, out vec3 absorb){
  if(lbl == 0){ alb = vec3(0.62, 0.63, 0.65); metal = 1.0; rough = 0.22; f0 = vec3(0.56, 0.57, 0.58); trans = 0.0; absorb = vec3(0.0); }       // 结构钢
  else if(lbl == 1){ alb = vec3(0.42, 0.42, 0.43); metal = 1.0; rough = 0.52; f0 = vec3(0.36, 0.36, 0.37); trans = 0.0; absorb = vec3(0.0); } // 铸铁
  else if(lbl == 2){ alb = vec3(0.85, 0.55, 0.45); metal = 1.0; rough = 0.30; f0 = vec3(0.95, 0.64, 0.54); trans = 0.0; absorb = vec3(0.0); } // 紫铜
  else if(lbl == 3){ alb = vec3(1.0); metal = 0.0; rough = 0.04; f0 = vec3(0.04); trans = 1.0; absorb = vec3(0.10, 0.31, 0.33); }              // 光学玻璃
  else if(lbl == 4){ alb = vec3(0.045, 0.045, 0.05); metal = 0.0; rough = 0.86; f0 = vec3(0.04); trans = 0.0; absorb = vec3(0.0); }            // 橡胶
  else if(lbl == 5){ alb = vec3(0.55, 0.16, 0.12); metal = 0.0; rough = 0.38; f0 = vec3(0.04); trans = 0.0; absorb = vec3(0.0); }              // 信号涂层
  else { alb = vec3(0.60, 0.61, 0.63); metal = 1.0; rough = 0.30; f0 = vec3(0.56, 0.57, 0.58); trans = 0.0; absorb = vec3(0.0); }              // 滚花钢
}

vec3 sky(vec3 rd){
  float t = clamp(rd.y*0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.30, 0.30, 0.33), vec3(0.09, 0.12, 0.19), t);
  float s = max(dot(rd, normalize(uSunW)), 0.0);
  c += uSunCol*0.35*pow(s, 48.0);
  return c;
}

// ---------- 第五章：微观法线扰动（工艺质感，与宏观场完全正交） ----------
float microAmp(int lbl){
  if(lbl == 0) return 0.00035;  // 高光拉丝：强各向异性高频沟槽
  if(lbl == 1) return 0.00090;  // 铸造/喷砂：多频随机微坑
  if(lbl == 6) return 0.00120;  // 编织/滚花：周期网络，幅值随曲率增强
  if(lbl == 5) return 0.00040;  // 涂层橘皮：中频正弦畸变
  if(lbl == 4) return 0.00060;  // 橡胶细噪
  return 0.0;
}
float microH(vec3 q, int lbl, float curv){
  if(lbl == 0) return sin(q.x*720.0 + sin(q.z*37.0)*2.4)*0.7 + 0.3*sin(q.y*2600.0);
  if(lbl == 1) return noise3(q*260.0)*0.6 + noise3(q*900.0)*0.3 + noise3(q*2400.0)*0.1;
  if(lbl == 6){
    float g = abs(sin(q.x*430.0))*abs(sin(q.z*430.0));
    return g*(0.6 + min(max(curv, 0.0)*0.05, 2.5));
  }
  if(lbl == 5) return sin(q.x*95.0)*sin(q.y*88.0)*sin(q.z*91.0);
  if(lbl == 4) return noise3(q*1500.0);
  return 0.0;
}
vec3 bumpNormal(vec3 pw, vec3 n, int ip, float curv, float epsw, float extraAmp){
  int lbl = int(uP0[ip].y + 0.5);
  float amp = microAmp(lbl) + extraAmp;
  if(amp <= 0.0) return n;
  vec4 Q = uP3[ip];
  vec3 c = uP1[ip].xyz;
  vec3 t = normalize(cross(n, abs(n.y) < 0.98 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  vec3 b = cross(n, t);
  float h0 = microH(qrotInv(Q, pw - c), lbl, curv);
  float h1 = microH(qrotInv(Q, pw + t*epsw - c), lbl, curv);
  float h2 = microH(qrotInv(Q, pw + b*epsw - c), lbl, curv);
  return normalize(n - amp*((h1 - h0)/epsw*t + (h2 - h0)/epsw*b));
}

// ---------- 第六章：磨损增殖（侵蚀函数集：划痕群 + 撞击凹坑） ----------
float scratchN(vec3 p, float seed){
  vec3 cell = floor(p*130.0);
  float h1 = hash1(cell + seed);
  float ang = h1*6.2831;
  vec2 d = vec2(cos(ang), sin(ang));
  vec2 uv = vec2(dot(p.xz, d), dot(p.xz, vec2(-d.y, d.x)));
  float stripe = smoothstep(0.86, 1.0, sin(uv.y*700.0 + h1*50.0)*0.5 + 0.5);
  return stripe*step(0.6, h1)*(0.4 + 0.6*hash1(cell + 7.7));
}

void main(){
  vec2 ndc = (gl_FragCoord.xy/uRes)*2.0 - 1.0;
  float aspect = uRes.x/uRes.y;
  vec3 rdC = normalize(vec3(ndc.x*TANF*aspect, ndc.y*TANF, -1.0));
  vec3 probeRd = (uMode > 0) ? normalize(uProbeDir) : rdC;
  // 规则八：观察者固定逻辑原点，反向旋转+平移+缩放全局场的输入坐标
  vec3 rdW = qrotInv(uCamQ, probeRd);
  vec3 roW = qrotInv(uCamQ, vec3(0.0, 0.0, uDist))*uScale;
  vec3 sunN = normalize(uSunW);
  float relax = 0.85/(1.0 + 2.5*uWaveMax);

  vec3 skyBg = pow(max(sky(rdW), vec3(0.0)), vec3(0.4545));
  // 包围球预剔除：视外射线零场求值直达天空（集群模式下射线需命中任意实例，跳过剔除）
  float cap = 1e9;
  float s0 = 0.002;
  float s1 = 26.0;
  if (uCluster.x > 0.5) {
    cap = max(uCluster.y, 1.5)*0.45;
    s1 = 40.0;
  } else {
    vec3 oc = roW - uBound.xyz;
    float b = dot(rdW, oc);
    float disc = b*b - dot(oc, oc) + uBound.w*uBound.w;
    if(disc < 0.0){ outColor = vec4(skyBg, 1.0); return; }
    float sq = sqrt(disc);
    s0 = max(-b - sq, 0.0);
    s1 = -b + sq;
  }

  float sw2 = march(roW, rdW, s0, s1, relax, cap);
  if(sw2 < 0.0){ outColor = vec4(skyBg, 1.0); return; }
  vec3 pw = roW + rdW*sw2;
  float eps = max(2.0e-6, sw2*3.0*TANF/(uRes.y*uScale*uScale));

  if(uMode == 1){
    Hit h = map(pw);
    outColor = vec4(sw2/uScale, h.la, h.slb, h.sw);
    return;
  }
  if(uMode == 2){
    vec4 nc = normalCurv(pw, eps);
    outColor = vec4(qrot(uCamQ, nc.xyz), nc.w);
    return;
  }

  vec4 nc = normalCurv(pw, eps);
  vec3 n = nc.xyz;
  float curv = nc.w;
  Hit h = map(pw);

  // 第六章：易损区判定（凸棱曲率 × 材质硬度）与距离退化
  float hard = uP0[h.ip].z;
  float wear = smoothstep(8.0, 90.0, max(curv, 0.0))*(1.0 - 0.65*hard);
  // 痕迹持久化：磨损随服役时长累积（约 50s 趋于饱和），形态由场景种子锚定
  wear *= (0.35 + 0.65*min(uWear.x*0.02, 1.0));
  wear *= exp(-sw2*0.55);
  float scr = wear*(0.3 + 0.7*scratchN(pw, uWear.y));
  float pit = wear*step(0.982, hash1(floor(pw*260.0)));

  // 第五章：微观法线扰动（磨损细节只作用光照层，不改求交主路径）
  vec3 nb = bumpNormal(pw, n, h.ip, curv, eps, wear*0.0006);

  // 第四章：区域标签继承 + 过渡混合 + 强制边界自然化（空间扰动咬合）
  float w2 = clamp(h.sw + (noise3(pw*47.0) - 0.5)*0.35*smoothstep(0.0, 0.2, h.sw), 0.0, 1.0);
  int lbA = int(h.la + 0.5);
  int lbB = h.slb < 0.0 ? lbA : int(h.slb + 0.5);
  vec3 a1, a2, f01, f02, ab1, ab2; float m1, m2, r1, r2, t1, t2;
  matOf(lbA, a1, m1, r1, f01, t1, ab1);
  matOf(lbB, a2, m2, r2, f02, t2, ab2);
  vec3 alb = mix(a1, a2, w2);
  float metal = mix(m1, m2, w2);
  float rough = clamp(mix(r1, r2, w2) + scr*0.30 + pit*0.40, 0.04, 1.0);
  vec3 f0 = mix(f01, f02, w2);
  float trans = max(mix(t1, t2, w2), 0.0);
  vec3 absorb = mix(ab1, ab2, w2);
  // 磨损露底（漆膜剥落露出底材；取长补短移植自 solid-demo 的 worn 语义）
  float wornM = clamp(scr*2.4 + pit*1.8, 0.0, 1.0);

  float ao = calcAO(pw, nb, eps*3.0);
  float NdL = max(dot(nb, sunN), 0.0);
  float NdV = max(dot(nb, -rdW), 1e-3);
  float sh = (rough < 0.7) ? softShadow(pw + nb*eps*4.0, sunN, 3.0) : clamp(NdL*0.5 + 0.5, 0.0, 1.0);

  vec3 col;
  if(trans > 0.5){
    // 介质相：入射菲涅尔 + 多次内反射链（能量吞吐量衰减 + 逐段指数体吸收）
    vec3 refl = sky(reflect(rdW, nb));
    float Fr0 = 0.04 + 0.96*pow(1.0 - NdV, 5.0);
    vec3 lc = uP1[h.ip].xyz;
    float lr = uP2[h.ip].x;
    vec3 acc = vec3(0.0);
    vec3 rC = refract(rdW, nb, 1.0/1.48);
    if(dot(rC, rC) < 1e-6){ rC = reflect(rdW, nb); }
    if(int(uP0[h.ip].x + 0.5) == 1){
      // 球面介质：解析弦长内弹射链（最多 3 次出射尝试，全内反射继续传播）
      vec3 posI = pw; float E = 1.0; vec3 tintAcc = vec3(1.0);
      for(int bi = 0; bi < 3; bi++){
        vec3 pc = posI - lc;
        float bb = dot(rC, pc);
        float cc = dot(pc, pc) - lr*lr;
        float chord = max(-bb + sqrt(max(bb*bb - cc, 0.0)), 1e-4);
        vec3 exitP = posI + rC*chord;
        vec3 nEx = normalize(exitP - lc);
        tintAcc *= exp(-absorb*chord*7.0);
        float Frx = 0.04 + 0.96*pow(1.0 - max(dot(rC, nEx), 0.0), 5.0);
        vec3 rOut = refract(rC, -nEx, 1.48);
        if(dot(rOut, rOut) > 1e-6){
          acc += sky(rOut)*tintAcc*E*(1.0 - Frx);
          E *= Frx;
        }
        rC = reflect(rC, nEx);
        posI = exitP + rC*1e-4;
      }
      acc += uSunCol*0.5*tintAcc*E;   // 残余能量的内聚环境项
    } else {
      // 非球面介质：单次弦长路径（原始实现）
      vec3 pc = pw - lc;
      float bb = dot(rC, pc);
      float cc = dot(pc, pc) - lr*lr;
      float chord = max(-bb + sqrt(max(bb*bb - cc, 0.0)), 1e-4);
      vec3 exitP = pw + rC*chord;
      vec3 nEx = normalize(exitP - lc);
      vec3 rOut = refract(rC, -nEx, 1.48);
      if(dot(rOut, rOut) < 1e-6){ rOut = reflect(rC, -nEx); }
      acc = sky(rOut)*exp(-absorb*chord*7.0);
    }
    vec3 Hv = normalize(sunN - rdW);
    float spec = pow(max(dot(nb, Hv), 0.0), 900.0)*40.0;
    col = mix(acc, refl, Fr0) + uSunCol*spec*Fr0*sh + uSunCol*pow(max(dot(nb, Hv), 0.0), 60.0)*0.15;
  } else {
    // 金属相（复折射率特征的菲涅尔近似）+ 漫射有机相（朗伯 + 微表面）
    if (wornM > 0.01 && metal < 0.5) {
      alb = mix(alb, vec3(0.50, 0.48, 0.45), wornM*0.55); // 非金属磨损露底
    }
    vec3 Hv = normalize(sunN - rdW);
    float NdH = max(dot(nb, Hv), 0.0);
    float VdH = max(dot(-rdW, Hv), 0.0);
    float a = rough*rough, a2 = a*a;
    float D = a2/(PI*pow(NdH*NdH*(a2 - 1.0) + 1.0, 2.0));
    float kk = a*0.5;
    float G = (NdV/(NdV*(1.0 - kk) + kk))*(NdL/(NdL*(1.0 - kk) + kk));
    vec3 F = f0 + (vec3(1.0) - f0)*pow(1.0 - VdH, 5.0);
    vec3 spec = D*G*F/(4.0*NdV + 1e-4);
    vec3 diff = alb*(1.0 - metal)*(1.0 - F)*NdL/PI;
    vec3 env = sky(reflect(rdW, nb));
    col = (diff + spec*NdL)*uSunCol*sh;
    col += env*(metal*F*0.9 + (1.0 - metal)*f0*0.5)*ao;
    col += alb*(1.0 - metal)*0.10*(0.55 + 0.45*nb.y)*ao;
    col += vec3(0.10, 0.12, 0.16)*pow(1.0 - NdV, 3.0)*ao*(0.4 + 0.6*metal);
    col *= 1.0 + wornM*0.22; // 划痕高光提亮（微米级凹坑散射）
  }

  // 距离雾（远融天空；取长补短移植自 solid-demo，阈值随包围球/缩放/集群网格自适应）
  float fogF = max(9.0*uBound.w/max(uScale, 1e-3), 9.0);
  if (uCluster.x > 0.5) { fogF = max(fogF, max(uCluster.y, 1.5)*5.0); }
  col = mix(col, sky(rdW), smoothstep(fogF*0.35, fogF, sw2));

  col = col/(1.0 + col*0.7);
  col = pow(max(col, vec3(0.0)), vec3(0.4545));
  col *= 1.0 - 0.16*dot(ndc, ndc);
  outColor = vec4(col, 1.0);
}
`;
