// ============================================================
// SDF 实体构造与渲染系统 —— 构造指令定义（输入规格）
// 对应系统定义第一章：几何基元列表 + 结合与过渡描述表
// 系统输出唯一且完全由本文件声明的指令数据与数学规则决定
// ============================================================

export type PrimType = 'box' | 'sphere' | 'cyl' | 'torus' | 'capsule' | 'boltring';
export type TransType = 'sharp' | 'fillet' | 'chamfer' | 'wave' | 'lap';
export type OpType = 'union' | 'sub' | 'inter';

/** 动画通道（运动学求解器按通道反算基元位姿） */
export type AnimKind = 'disc' | 'pin' | 'bolts' | 'rod' | 'piston' | 'none';

export interface SdfPrim {
  type: PrimType;
  /** 逻辑空间位姿（动画通道会在每帧覆写 _wp/_wq） */
  pos: [number, number, number];
  quat?: [number, number, number, number];
  /** 类型参数: box 半长xyz / sphere r / cyl r,halfH / torus R,r / capsule r,halfLen / boltring r,halfH,count,ringR */
  p: number[];
  /** 材质标签: 0结构钢 1铸铁 2紫铜 3光学玻璃 4密封橡胶 5信号涂层 6滚花钢 */
  label: number;
  /** 材质硬度 0..1（磨损增殖规则的易损判定输入） */
  hardness: number;
  anim?: AnimKind;
  /** 每帧求解出的世界位姿（solveKinematics 写入） */
  _wp?: [number, number, number];
  _wq?: [number, number, number, number];
}

export interface SdfBond {
  op: OpType;
  trans: TransType;
  /** 过渡半径（fillet/wave/lap 的 smin 宽度；sub/inter 的平滑宽） */
  radius?: number;
  /** 波浪熔接参数 */
  waveAmp?: number;
  waveFreq?: number;
  /** 变半径倒角: k = k0 + k1·(沿 chamAxis 的坐标) */
  chamAxis?: 0 | 1 | 2;
  k0?: number;
  k1?: number;
}

export interface SdfScene {
  name: string;
  prims: SdfPrim[];
  /** bonds[i] 描述基元 i 如何并入累加器（bonds[0] 占位） */
  bonds: SdfBond[];
  /** 全局包围球（射线预剔除） */
  boundC: [number, number, number];
  boundR: number;
  /** 曲柄滑块运动学参数（null = 无该机构） */
  kin: { c: [number, number, number]; R: number; L: number; freq: number } | null;
  /** 转台角速度 rad/s（整体绕 Y 慢转） */
  turntable: number;
  /** 集群增殖域重复实例层（on=false 或缺省 = 单物体） */
  cluster?: { on: boolean; cellSize: number; spreadAmp: number } | null;
}

export const LABELS = ['结构钢', '铸铁', '紫铜', '光学玻璃', '密封橡胶', '信号涂层', '滚花钢'];

// ---------- 四元数工具 ----------
type Q = [number, number, number, number];
export function axisAngle(ax: [number, number, number], a: number): Q {
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const s = Math.sin(a / 2);
  return [ax[0] / l * s, ax[1] / l * s, ax[2] / l * s, Math.cos(a / 2)];
}
export function qmul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
/** 将方向 d（无需单位化）旋转到 +Y 的四元数 */
function alignY(d: [number, number, number]): Q {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const y = d[1] / l;
  if (y < -0.9999) return axisAngle([0, 0, 1], Math.PI);
  const s = Math.hypot(d[0], d[2]) / l;
  if (s < 1e-8) return [0, 0, 0, 1];
  const ax: [number, number, number] = [-d[2] / l / s, 0, d[0] / l / s];
  return axisAngle(ax, Math.acos(Math.max(-1, Math.min(1, y))));
}

// ---------- 运动学求解（动画系统的每帧位姿反算） ----------
export function solveKinematics(sc: SdfScene, t: number) {
  const tt = sc.turntable > 0 ? t * sc.turntable : 0;
  const rotY = (p: [number, number, number]): [number, number, number] =>
    tt === 0 ? p : ([
      sc.boundC[0] + Math.cos(tt) * (p[0] - sc.boundC[0]) + Math.sin(tt) * (p[2] - sc.boundC[2]),
      p[1],
      sc.boundC[2] - Math.sin(tt) * (p[0] - sc.boundC[0]) + Math.cos(tt) * (p[2] - sc.boundC[2]),
    ] as [number, number, number]);
  const qy = tt === 0 ? null : axisAngle([0, 1, 0], tt);

  let phi = 0;
  if (sc.kin) phi = t * sc.kin.freq * Math.PI * 2;
  const c = sc.kin ? sc.kin.c : ([0, 0, 0] as [number, number, number]);
  const R = sc.kin ? sc.kin.R : 0;
  const L = sc.kin ? sc.kin.L : 1;
  // 曲柄销位置（曲柄平面 XY，轴 Z）
  const pin: [number, number, number] = [c[0] + R * Math.cos(phi), c[1] + R * Math.sin(phi), c[2]];
  // 滑块约束：x=c[0] 竖直线，销到滑块销距离恒 L（曲柄滑块闭环方程）
  const py = c[1] + R * Math.sin(phi) + Math.sqrt(Math.max(L * L - R * R * Math.cos(phi) ** 2, 1e-6));
  const piston: [number, number, number] = [c[0], py, c[2]];
  const rodDir: [number, number, number] = [piston[0] - pin[0], piston[1] - pin[1], piston[2] - pin[2]];

  for (const pr of sc.prims) {
    const q: Q = pr.quat ?? [0, 0, 0, 1];
    let p = pr.pos;
    switch (pr.anim) {
      case 'pin': p = pin; break;
      case 'bolts': {
        pr._wq = qmul(axisAngle([0, 0, 1], phi), q);
        pr._wp = rotY(pr.pos);
        continue;
      }
      case 'disc': {
        pr._wq = qmul(axisAngle([0, 0, 1], phi), q);
        pr._wp = rotY(pr.pos);
        continue;
      }
      case 'piston': p = piston; break;
      case 'rod': {
        p = [(pin[0] + piston[0]) / 2, (pin[1] + piston[1]) / 2, (pin[2] + piston[2]) / 2];
        pr._wq = alignY(rodDir);
        pr._wp = rotY(p as [number, number, number]);
        continue;
      }
      default: break;
    }
    pr._wp = rotY(p as [number, number, number]);
    pr._wq = qy ? qmul(qy, q) : q;
  }
}

// ---------- 预设 A：曲柄滑块演示机（16 基元，覆盖 圆角/变半径倒角/错位搭接/差集/滑动副动画） ----------
const RX90: [number, number, number, number] = axisAngle([1, 0, 0], Math.PI / 2);

function pistonAssembly(): SdfScene {
  const P = (o: SdfPrim): SdfPrim => o;
  const B = (op: OpType, trans: TransType, radius = 0, extra: Partial<SdfBond> = {}): SdfBond => ({ op, trans, radius, ...extra });
  const prims: SdfPrim[] = [
    P({ type: 'box', pos: [0.05, -0.45, 0.02], p: [0.92, 0.08, 0.42], label: 1, hardness: 0.35 }),            // 0 底座
    P({ type: 'box', pos: [-0.20, 0.055, 0.09], p: [0.04, 0.42, 0.04], label: 5, hardness: 0.25 }),           // 1 左立柱
    P({ type: 'box', pos: [0.40, 0.055, 0.09], p: [0.04, 0.42, 0.04], label: 5, hardness: 0.25 }),           // 2 右立柱
    P({ type: 'box', pos: [0.10, 0.415, 0.09], p: [0.30, 0.09, 0.09], label: 5, hardness: 0.25 }),            // 3 导架横梁
    P({ type: 'cyl', pos: [0.10, 0.415, 0.09], p: [0.098, 0.12], label: 0, hardness: 0.8 }),                  // 4 滑槽（差集刀具）
    P({ type: 'box', pos: [0.10, 0.0, 0.155], p: [0.13, 0.35, 0.045], label: 5, hardness: 0.25 }),            // 5 轴承座
    P({ type: 'cyl', pos: [0.10, 0.02, 0.155], quat: RX90, p: [0.275, 0.026], label: 0, hardness: 0.8 }),     // 6 轴承孔（差集刀具）
    P({ type: 'cyl', pos: [0.10, 0.02, 0.09], quat: RX90, p: [0.26, 0.025], label: 0, hardness: 0.8, anim: 'disc' }), // 7 曲柄盘
    P({ type: 'cyl', pos: [0, 0, 0], quat: RX90, p: [0.032, 0.08], label: 2, hardness: 0.55, anim: 'pin' }),  // 8 曲柄销
    P({ type: 'box', pos: [0.10, 0.0, -0.185], p: [0.14, 0.36, 0.05], label: 5, hardness: 0.25 }),            // 9 飞轮座
    P({ type: 'cyl', pos: [0.10, 0.02, -0.185], quat: RX90, p: [0.335, 0.024], label: 0, hardness: 0.8 }),    // 10 飞轮孔（差集刀具）
    P({ type: 'cyl', pos: [0.10, 0.02, -0.12], quat: RX90, p: [0.32, 0.0225], label: 5, hardness: 0.4, anim: 'disc' }), // 11 飞轮
    P({ type: 'boltring', pos: [0.10, 0.02, -0.093], p: [0.024, 0.0175, 6, 0.20], label: 0, hardness: 0.8, anim: 'bolts' }), // 12 轮毂螺栓环
    P({ type: 'capsule', pos: [0, 0, 0], p: [0.026, 0.21], label: 0, hardness: 0.8, anim: 'rod' }),           // 13 连杆
    P({ type: 'cyl', pos: [0, 0, 0], p: [0.085, 0.065], label: 2, hardness: 0.55, anim: 'piston' }),          // 14 活塞
    P({ type: 'sphere', pos: [0.72, -0.295, 0.20], p: [0.075], label: 3, hardness: 0.9 }),                    // 15 观察镜（介质相）
  ];
  const bonds: SdfBond[] = [
    B('union', 'sharp'),                                           // 0 占位
    B('union', 'fillet', 0.045),                                   // 1 左立柱-底座 圆角
    B('union', 'fillet', 0.045),                                   // 2 右立柱-底座
    B('union', 'fillet', 0.04),                                    // 3 横梁-立柱
    B('sub', 'fillet', 0.015),                                     // 4 滑槽
    B('union', 'chamfer', 0, { chamAxis: 1, k0: 0.03, k1: 0.05 }), // 5 轴承座-横梁 变半径倒角
    B('sub', 'fillet', 0.01),                                      // 6 轴承孔
    B('union', 'sharp'),                                           // 7 曲柄盘（运动件独立体，尖锐并）
    B('union', 'lap', 0.008),                                      // 8 曲柄销-曲柄盘 错位搭接
    B('union', 'fillet', 0.04),                                    // 9 飞轮座
    B('sub', 'sharp'),                                             // 10 飞轮孔
    B('union', 'sharp'),                                           // 11 飞轮
    B('union', 'sharp'),                                           // 12 螺栓环
    B('union', 'sharp'),                                           // 13 连杆
    B('union', 'sharp'),                                           // 14 活塞
    B('union', 'sharp'),                                           // 15 观察镜
  ];
  return { name: '曲柄滑块演示机', prims, bonds, boundC: [0.05, 0, 0], boundR: 1.25, kin: { c: [0.10, 0.02, 0.09], R: 0.15, L: 0.42, freq: 0.55 }, turntable: 0 };
}

// ---------- 预设 B：波浪熔接三通管件（8 基元，覆盖 波浪熔接/变半径倒角/转台动画/橡胶+滚花） ----------
function pipeJunction(): SdfScene {
  const P = (o: SdfPrim): SdfPrim => o;
  const B = (op: OpType, trans: TransType, radius = 0, extra: Partial<SdfBond> = {}): SdfBond => ({ op, trans, radius, ...extra });
  const prims: SdfPrim[] = [
    P({ type: 'cyl', pos: [0, -0.30, 0], p: [0.46, 0.0275], label: 1, hardness: 0.35 }),                      // 0 法兰盘
    P({ type: 'torus', pos: [0, -0.362, 0], p: [0.40, 0.025], label: 4, hardness: 0.15 }),                    // 1 密封圈
    P({ type: 'cyl', pos: [0, 0.10, 0], p: [0.15, 0.425], label: 0, hardness: 0.8 }),                         // 2 主管
    P({ type: 'cyl', pos: [0.30, 0.05, 0], quat: axisAngle([0, 0, 1], Math.PI / 2), p: [0.115, 0.225], label: 0, hardness: 0.8 }), // 3 侧支管
    P({ type: 'cyl', pos: [0.10, 0.42, 0], quat: axisAngle([0, 0, 1], 0.6), p: [0.09, 0.19], label: 2, hardness: 0.55 }), // 4 斜支管（紫铜）
    P({ type: 'torus', pos: [0, 0.50, 0], p: [0.165, 0.02], label: 2, hardness: 0.55 }),                      // 5 铜喉箍
    P({ type: 'boltring', pos: [0, -0.30, 0], quat: axisAngle([1, 0, 0], -Math.PI / 2), p: [0.028, 0.05, 6, 0.40], label: 0, hardness: 0.8 }), // 6 法兰螺栓环
    P({ type: 'torus', pos: [0.107, 0.60, 0], p: [0.09, 0.018], label: 6, hardness: 0.8 }),                   // 7 滚花手轮
  ];
  const bonds: SdfBond[] = [
    B('union', 'sharp'),
    B('union', 'fillet', 0.02),                                     // 密封圈-法兰
    B('union', 'wave', 0.05, { waveAmp: 0.012, waveFreq: 52 }),     // 主管-法兰 波浪熔接
    B('union', 'wave', 0.045, { waveAmp: 0.010, waveFreq: 44 }),    // 侧支管-主管 波浪熔接
    B('union', 'fillet', 0.03),                                     // 斜支管-主管
    B('union', 'fillet', 0.015),                                    // 喉箍
    B('union', 'chamfer', 0, { chamAxis: 1, k0: 0.012, k1: 0.06 }), // 螺栓环 变半径倒角
    B('union', 'lap', 0.012),                                       // 手轮-斜支管 搭接
  ];
  return { name: '波浪熔接三通管件', prims, bonds, boundC: [0, 0, 0], boundR: 0.95, kin: null, turntable: 0.3 };
}

export const PRESETS: SdfScene[] = [pistonAssembly(), pipeJunction()];

// ---------- 构造指令校验（编辑器 JSON → 引擎的安全入口） ----------
// 输入 = 几何基元列表 + 结合与过渡描述表；任何非法指令在进入引擎前被拦截并给出定位。
const PRIM_TYPES: PrimType[] = ['box', 'sphere', 'cyl', 'torus', 'capsule', 'boltring'];
const PRIM_ARITY: Record<PrimType, number> = { box: 3, sphere: 1, cyl: 2, torus: 2, capsule: 2, boltring: 4 };
const OP_TYPES: OpType[] = ['union', 'sub', 'inter'];
const TRANS_TYPES: TransType[] = ['sharp', 'fillet', 'chamfer', 'wave', 'lap'];
const ANIM_KINDS: AnimKind[] = ['disc', 'pin', 'bolts', 'rod', 'piston', 'none'];

export type ValidateResult =
  | { ok: true; scene: SdfScene }
  | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numArr = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(isNum);

export function validateScene(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '根节点必须是对象' };
  const o = raw as Record<string, unknown>;
  // 兼容中文别名键（包围球/运动学/转台/几何基元列表/结合与过渡描述表）
  const bb = (o.包围球 ?? null) as Record<string, unknown> | null;
  const primsRaw = o.prims ?? o.几何基元列表;
  const bondsRaw = o.bonds ?? o.结合与过渡描述表;
  const boundC = o.boundC ?? bb?.center;
  const boundR = o.boundR ?? bb?.radius;
  const kinRaw = o.kin === undefined ? o.运动学 : o.kin;
  const turntable = o.turntable === undefined ? o.转台 : o.turntable;
  const clusterRaw = (o.cluster ?? o.集群 ?? null) as Record<string, unknown> | null;
  if (typeof o.name !== 'string' || !o.name.trim()) return { ok: false, error: 'name 必须是非空字符串' };
  if (!Array.isArray(primsRaw) || primsRaw.length === 0) return { ok: false, error: 'prims 必须是非空数组' };
  if (primsRaw.length > 16) return { ok: false, error: `prims 数量 ${primsRaw.length} 超过上限 16` };
  const prims: SdfPrim[] = [];
  for (let i = 0; i < primsRaw.length; i++) {
    const p = primsRaw[i] as Record<string, unknown>;
    if (!p || typeof p !== 'object') return { ok: false, error: `prims[${i}] 必须是对象` };
    if (!PRIM_TYPES.includes(p.type as PrimType))
      return { ok: false, error: `prims[${i}].type "${String(p.type)}" 不在 ${PRIM_TYPES.join('/')}` };
    const tp = p.type as PrimType;
    if (!numArr(p.pos, 3)) return { ok: false, error: `prims[${i}].pos 必须是 3 个有限数字` };
    if (!Array.isArray(p.p) || p.p.length !== PRIM_ARITY[tp] || !p.p.every(isNum))
      return { ok: false, error: `prims[${i}].p 需 ${PRIM_ARITY[tp]} 个数字（${tp}）` };
    if (!isNum(p.label) || p.label !== Math.round(p.label) || p.label < 0 || p.label >= LABELS.length)
      return { ok: false, error: `prims[${i}].label 必须是 0..${LABELS.length - 1} 的整数` };
    if (!isNum(p.hardness) || p.hardness < 0 || p.hardness > 1)
      return { ok: false, error: `prims[${i}].hardness 必须在 0..1` };
    if (p.quat !== undefined && p.quat !== null && !numArr(p.quat, 4))
      return { ok: false, error: `prims[${i}].quat 必须是 4 个数字` };
    if (p.anim !== undefined && p.anim !== null && !ANIM_KINDS.includes(p.anim as AnimKind))
      return { ok: false, error: `prims[${i}].anim "${String(p.anim)}" 无效` };
    prims.push({
      type: tp,
      pos: [p.pos[0], p.pos[1], p.pos[2]],
      p: (p.p as number[]).slice(),
      label: p.label,
      hardness: p.hardness,
      ...(Array.isArray(p.quat)
        ? { quat: [p.quat[0], p.quat[1], p.quat[2], p.quat[3]] as [number, number, number, number] }
        : {}),
      ...(p.anim ? { anim: p.anim as AnimKind } : {}),
    });
  }
  if (!Array.isArray(bondsRaw) || bondsRaw.length !== primsRaw.length)
    return { ok: false, error: `bonds 长度必须等于 prims 数量（${primsRaw.length}，含 bonds[0] 占位）` };
  const bonds: SdfBond[] = [];
  for (let i = 0; i < bondsRaw.length; i++) {
    const b = bondsRaw[i] as Record<string, unknown>;
    if (!b || typeof b !== 'object') return { ok: false, error: `bonds[${i}] 必须是对象` };
    if (!OP_TYPES.includes(b.op as OpType)) return { ok: false, error: `bonds[${i}].op "${String(b.op)}" 无效` };
    if (!TRANS_TYPES.includes(b.trans as TransType))
      return { ok: false, error: `bonds[${i}].trans "${String(b.trans)}" 无效` };
    if (b.radius !== undefined && (!isNum(b.radius) || b.radius < 0))
      return { ok: false, error: `bonds[${i}].radius 必须 ≥ 0` };
    if (b.waveAmp !== undefined && (!isNum(b.waveAmp) || b.waveAmp < 0))
      return { ok: false, error: `bonds[${i}].waveAmp 必须 ≥ 0` };
    if (b.waveFreq !== undefined && (!isNum(b.waveFreq) || b.waveFreq < 0))
      return { ok: false, error: `bonds[${i}].waveFreq 必须 ≥ 0` };
    if (b.chamAxis !== undefined && (!isNum(b.chamAxis) || b.chamAxis < 0 || b.chamAxis > 2))
      return { ok: false, error: `bonds[${i}].chamAxis ∈ {0,1,2}` };
    if (b.k0 !== undefined && !isNum(b.k0)) return { ok: false, error: `bonds[${i}].k0 必须是数字` };
    if (b.k1 !== undefined && !isNum(b.k1)) return { ok: false, error: `bonds[${i}].k1 必须是数字` };
    bonds.push({
      op: b.op as OpType,
      trans: b.trans as TransType,
      radius: (b.radius as number) ?? 0,
      waveAmp: (b.waveAmp as number) ?? 0,
      waveFreq: (b.waveFreq as number) ?? 0,
      chamAxis: (b.chamAxis as 0 | 1 | 2) ?? 1,
      k0: (b.k0 as number) ?? 0,
      k1: (b.k1 as number) ?? 0,
    });
  }
  if (!numArr(boundC, 3)) return { ok: false, error: 'boundC 必须是 3 个数字' };
  if (!isNum(boundR) || boundR <= 0) return { ok: false, error: 'boundR 必须是正数' };
  let kin: SdfScene['kin'] = null;
  if (kinRaw !== null && kinRaw !== undefined) {
    const kk = kinRaw as Record<string, unknown>;
    if (!numArr(kk.c, 3) || !isNum(kk.R) || !isNum(kk.L) || !isNum(kk.freq) || kk.R <= 0 || kk.L <= 0)
      return { ok: false, error: 'kin 需 {c:[3], R>0, L>0, freq}' };
    kin = { c: [kk.c[0], kk.c[1], kk.c[2]], R: kk.R, L: kk.L, freq: kk.freq };
  }
  if (!isNum(turntable) || turntable < 0) return { ok: false, error: 'turntable 必须 ≥ 0' };
  let cluster: SdfScene['cluster'] = null;
  if (clusterRaw && typeof clusterRaw === 'object' && clusterRaw.on !== undefined) {
    if (!isNum(clusterRaw.cellSize) || clusterRaw.cellSize < 1.5)
      return { ok: false, error: 'cluster.cellSize 必须 ≥ 1.5（实例间距过小会相互穿插）' };
    if (!isNum(clusterRaw.spreadAmp) || clusterRaw.spreadAmp < 0 || clusterRaw.spreadAmp > 2)
      return { ok: false, error: 'cluster.spreadAmp 必须在 0..2' };
    cluster = { on: !!clusterRaw.on, cellSize: clusterRaw.cellSize, spreadAmp: clusterRaw.spreadAmp };
  }
  return {
    ok: true,
    scene: {
      name: o.name,
      prims,
      bonds,
      boundC: [boundC[0], boundC[1], boundC[2]],
      boundR,
      kin,
      turntable,
      cluster,
    },
  };
}
