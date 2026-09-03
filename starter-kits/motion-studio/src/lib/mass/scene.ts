/**
 * 银河场景生成器 —— 12 种动效母题 × 20 关键帧 × N 实例
 *
 * 生成与上游 Rust 内核 serde schema 完全对齐的 JSON：
 *   AnimationClipData { id, duration, iterations, keyframes[] }
 *   InstanceData      { id, clip_id, delay, duration_scale, ... }
 * 通过 kernel.import_ir_json 一次性注入（单次 JSON 边界穿越）。
 */

export interface TransformJSON {
  translation: [number, number, number];
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  origin: [number, number, number];
}

export interface KeyframeJSON {
  time: number;
  transform: TransformJSON;
  opacity: number;
  easing: string;
  cubic_params: {
    p1x: number;
    p1y: number;
    p2x: number;
    p2y: number;
  } | null;
}

export interface ClipJSON {
  id: string;
  duration: number;
  iterations: number | null;
  keyframes: KeyframeJSON[];
}

export interface InstanceJSON {
  id: string;
  clip_id: string;
  opacity: number;
  visible: boolean;
  delay: number;
  duration_scale: number;
  time_remapping_speed: number;
  blend_mode: "Override" | "Additive";
  initial_transform: TransformJSON;
}

export interface SceneClipMeta {
  id: string;
  name: string;
  durationMs: number;
  easingSummary: string;
  keyframes: {
    timeMs: number;
    dx: number;
    dy: number;
    scale: number;
    opacity: number;
    easing: string;
  }[];
}

export interface GalaxyScene {
  clips: ClipJSON[];
  instances: InstanceJSON[];
  /** N×4 RGBA，静态颜色（按银河半径调色板） */
  colors: Float32Array;
  patternOf: Uint32Array;
  radiusOf: Float32Array;
  clipMetas: SceneClipMeta[];
}

export const PATTERN_NAMES = [
  "环轨巡行",
  "花瓣摆",
  "呼吸核",
  "八分环",
  "闪点阵",
  "三叶缎带",
  "涟漪",
  "双子摆",
  "十字巡航",
  "螺旋下潜",
  "星尘闪烁",
  "涡旋臂",
] as const;

const KF_COUNT = 20;
const TAU = Math.PI * 2;

/* ---------------- 确定性随机 ---------------- */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGauss(rand: () => number) {
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
}

/* ---------------- 关键帧构造辅助 ---------------- */

interface KfSpec {
  dx: number;
  dy: number;
  rotZ?: number;
  scale?: number;
  opacity?: number;
  easing: string;
  cubic?: { p1x: number; p1y: number; p2x: number; p2y: number } | null;
}

const OVERSHOOT = { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1.0 };

function buildClip(
  id: string,
  name: string,
  durationMs: number,
  specs: KfSpec[],
  closedLoop: boolean,
): { clip: ClipJSON; meta: SceneClipMeta } {
  const keyframes: KeyframeJSON[] = [];
  const metaKfs: SceneClipMeta["keyframes"] = [];
  const span = closedLoop ? KF_COUNT : KF_COUNT - 1;
  for (let k = 0; k < KF_COUNT; k++) {
    const s = specs[k % specs.length];
    const time = (durationMs * k) / span;
    keyframes.push({
      time,
      transform: {
        translation: [s.dx, s.dy, 0],
        rotation_quat: [0, 0, Math.sin((s.rotZ ?? 0) / 2), Math.cos((s.rotZ ?? 0) / 2)],
        scale: [s.scale ?? 1, s.scale ?? 1, 1],
        origin: [0, 0, 0],
      },
      opacity: s.opacity ?? 1,
      easing: s.easing,
      cubic_params: s.cubic ?? null,
    });
    metaKfs.push({
      timeMs: time,
      dx: s.dx,
      dy: s.dy,
      scale: s.scale ?? 1,
      opacity: s.opacity ?? 1,
      easing: s.easing,
    });
  }
  return {
    clip: { id, duration: durationMs, iterations: null, keyframes },
    meta: {
      id,
      name,
      durationMs,
      easingSummary: summarize(specs.map((s) => s.easing)),
      keyframes: metaKfs,
    },
  };
}

function summarize(easings: string[]) {
  const counts = new Map<string, number>();
  for (const e of easings) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(" · ");
}

/** 生成 12 个动效母题 clip（各 20 关键帧） */
export function buildMotifClips(rand: () => number): {
  clips: ClipJSON[];
  metas: SceneClipMeta[];
} {
  const clips: ClipJSON[] = [];
  const metas: SceneClipMeta[] = [];
  const dur = (base: number) => Math.round(base * (0.85 + rand() * 0.4));
  const A = 0.055 + rand() * 0.03; // 母题运动包络（世界单位）

  const push = (r: { clip: ClipJSON; meta: SceneClipMeta }) => {
    clips.push(r.clip);
    metas.push(r.meta);
  };

  // 0 环轨巡行 — Linear 匀速圆
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      specs.push({
        dx: Math.cos(a) * A,
        dy: Math.sin(a) * A,
        rotZ: a,
        easing: "Linear",
      });
    }
    push(buildClip("motif-0", PATTERN_NAMES[0], dur(3200), specs, true));
  }
  // 1 花瓣摆 — EaseInOut + 旋转
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      specs.push({
        dx: Math.cos(a) * A,
        dy: Math.abs(Math.sin(2 * a)) * A * 0.55,
        rotZ: Math.sin(a) * 0.7,
        scale: 0.9 + 0.25 * Math.abs(Math.cos(a)),
        easing: "EaseInOut",
      });
    }
    push(buildClip("motif-1", PATTERN_NAMES[1], dur(3000), specs, true));
  }
  // 2 呼吸核 — CubicBezier 过冲缩放
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      const pulse = 0.45 + 0.55 * Math.abs(Math.cos(a));
      specs.push({
        dx: Math.cos(a) * A * 0.5 * pulse,
        dy: Math.sin(a) * A * 0.5 * pulse,
        scale: 0.55 + 0.95 * pulse,
        opacity: 0.5 + 0.5 * pulse,
        easing: "CubicBezier",
        cubic: OVERSHOOT,
      });
    }
    push(buildClip("motif-2", PATTERN_NAMES[2], dur(2600), specs, true));
  }
  // 3 八分环 — Lissajous 1:2
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      specs.push({
        dx: Math.sin(a + Math.PI / 2) * A,
        dy: Math.sin(2 * a) * A * 0.62,
        easing: "EaseInOut",
      });
    }
    push(buildClip("motif-3", PATTERN_NAMES[3], dur(3400), specs, true));
  }
  // 4 闪点阵 — Step 阶跃 + 微缩放
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const on = k % 4 < 2;
      specs.push({
        dx: ((k % 5) - 2) * A * 0.22,
        dy: (Math.floor(k / 5) - 1.5) * A * 0.22,
        scale: on ? 1.15 : 0.7,
        opacity: on ? 1 : 0.12,
        easing: "Step",
      });
    }
    push(buildClip("motif-4", PATTERN_NAMES[4], dur(2400), specs, false));
  }
  // 5 三叶缎带 — Lissajous 1:3, Ease
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      specs.push({
        dx: Math.cos(a) * A * 0.9,
        dy: Math.sin(3 * a) * A * 0.34,
        rotZ: Math.sin(a) * 0.5,
        easing: "Ease",
      });
    }
    push(buildClip("motif-5", PATTERN_NAMES[5], dur(3600), specs, true));
  }
  // 6 涟漪 — EaseOut 径向往返
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      const r = Math.abs(Math.sin(a / 2)) * A;
      specs.push({
        dx: Math.cos(a) * r,
        dy: Math.sin(a) * r,
        scale: 0.7 + 0.6 * (r / A),
        opacity: 1 - 0.55 * (r / A),
        easing: "EaseOut",
      });
    }
    push(buildClip("motif-6", PATTERN_NAMES[6], dur(3000), specs, true));
  }
  // 7 双子摆 — origin 枢轴旋转（四元数 Slerp 展示位）
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      specs.push({
        dx: 0,
        dy: 0,
        rotZ: Math.sin(a) * 1.1,
        scale: 1,
        easing: "EaseInOut",
      });
    }
    const r = buildClip("motif-7", PATTERN_NAMES[7], dur(2800), specs, true);
    // 摆的枢轴放在 (0, -A) —— 修改 origin
    for (const kf of r.clip.keyframes) kf.transform.origin = [0, -A, 0];
    push(r);
  }
  // 8 十字巡航 — 方形路径 EaseInOut
  {
    const square: [number, number][] = [
      [A * 0.8, 0],
      [A * 0.8, A * 0.8],
      [0, A * 0.8],
      [-A * 0.8, A * 0.8],
      [-A * 0.8, 0],
      [-A * 0.8, -A * 0.8],
      [0, -A * 0.8],
      [A * 0.8, -A * 0.8],
    ];
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const [dx, dy] = square[k % 8];
      specs.push({ dx, dy, rotZ: (k % 8) * (Math.PI / 4), easing: "EaseInOut" });
    }
    push(buildClip("motif-8", PATTERN_NAMES[8], dur(3800), specs, true));
  }
  // 9 螺旋下潜 — 半径中段鼓包
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const t = k / KF_COUNT;
      const a = t * 2 * TAU;
      const r = A * (0.22 + 0.78 * 4 * t * (1 - t));
      specs.push({
        dx: Math.cos(a) * r,
        dy: Math.sin(a) * r,
        scale: 0.7 + 0.5 * (1 - Math.abs(t - 0.5) * 2),
        easing: "Ease",
      });
    }
    push(buildClip("motif-9", PATTERN_NAMES[9], dur(3600), specs, true));
  }
  // 10 星尘闪烁 — 尖锐 opacity 脉冲
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const t = k / KF_COUNT;
      const a = t * TAU;
      const spark = Math.pow(Math.max(0, Math.sin(3 * a + 1.2)), 6);
      specs.push({
        dx: Math.cos(a) * A * 0.28,
        dy: Math.sin(a) * A * 0.28,
        scale: 0.75 + spark * 0.9,
        opacity: 0.18 + spark * 0.82,
        easing: "Ease",
      });
    }
    push(buildClip("motif-10", PATTERN_NAMES[10], dur(4200), specs, true));
  }
  // 11 涡旋臂 — 半径呼吸 + 切向对齐
  {
    const specs: KfSpec[] = [];
    for (let k = 0; k < KF_COUNT; k++) {
      const a = (k / KF_COUNT) * TAU;
      const r = A * (1 + 0.28 * Math.sin(2 * a));
      specs.push({
        dx: Math.cos(a) * r,
        dy: Math.sin(a) * r,
        rotZ: a + Math.PI / 2,
        easing: "EaseInOut",
      });
    }
    push(buildClip("motif-11", PATTERN_NAMES[11], dur(3200), specs, true));
  }

  return { clips, metas };
}

/* ---------------- 银河分布与实例 ---------------- */

function lerpColor(
  stops: [number, number, number][],
  t: number,
): [number, number, number] {
  const n = stops.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

const PALETTE: [number, number, number][] = [
  [1.0, 0.85, 0.63], // 暖核 #ffd9a0
  [1.0, 0.56, 0.64], // 玫瑰 #ff8fa3
  [0.4, 0.91, 0.98], // 青 cyan #67e8f9
  [0.65, 0.55, 0.98], // 软紫 #a78bfa
];

export function buildGalaxyScene(count: number, seed: number): GalaxyScene {
  const rand = mulberry32(seed);
  const gauss = makeGauss(rand);
  const { clips, metas } = buildMotifClips(rand);
  const MOTIFS = clips.length;

  const instances: InstanceJSON[] = [];
  const colors = new Float32Array(count * 4);
  const patternOf = new Uint32Array(count);
  const radiusOf = new Float32Array(count);

  const bulgeCount = Math.floor(count * 0.08);

  for (let i = 0; i < count; i++) {
    const pattern = i % MOTIFS;
    const isBulge = i < bulgeCount;

    let r: number;
    let theta: number;
    if (isBulge) {
      r = 0.24 * Math.pow(rand(), 0.8);
      theta = rand() * TAU;
    } else {
      r = 1.12 * Math.pow(rand(), 0.62);
      const arm = i % 3;
      theta = (arm * TAU) / 3 + r * 2.2 + gauss() * 0.3 * (1.25 - r);
      r += gauss() * 0.03;
      r = Math.min(1.25, Math.max(0.12, r));
    }

    const x = Math.cos(theta) * r;
    const y = Math.sin(theta) * r;
    const z = isBulge ? gauss() * 0.03 : gauss() * 0.05 * (1.15 - r / 1.3);

    const size = isBulge
      ? 0.0075 + rand() * 0.008
      : 0.004 + 0.012 * (1 - r) + rand() * 0.004;

    const clip = clips[pattern];
    const dscale = 0.75 + rand() * 0.7;
    const delay = rand() * clip.duration * dscale;

    instances.push({
      id: `p-${i}`,
      clip_id: clip.id,
      opacity: isBulge ? 0.75 + rand() * 0.25 : 0.28 + 0.62 * (1 - r) + rand() * 0.1,
      visible: true,
      delay,
      duration_scale: dscale,
      time_remapping_speed: 1,
      blend_mode: "Override",
      initial_transform: {
        translation: [x, y, z],
        rotation_quat: [0, 0, Math.sin((theta + Math.PI / 2) / 2), Math.cos((theta + Math.PI / 2) / 2)],
        scale: [size, size, size],
        origin: [0, 0, 0],
      },
    });

    patternOf[i] = pattern;
    radiusOf[i] = r;

    const [cr, cg, cb] = lerpColor(PALETTE, Math.min(1, r / 1.2));
    const warmBoost = isBulge ? 0.35 : 0;
    colors[i * 4] = Math.min(1, cr + warmBoost * 0.3);
    colors[i * 4 + 1] = Math.min(1, cg + warmBoost * 0.12);
    colors[i * 4 + 2] = Math.min(1, cb + warmBoost * 0.0);
    colors[i * 4 + 3] = 1;
  }

  return { clips, instances, colors, patternOf, radiusOf, clipMetas: metas };
}

/* ---------------- 检查器用 TS 本地求值（显示层，与内核同构） ---------------- */

function solveCubicBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  t: number,
): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const om = 1 - u;
    const x = 3 * om * om * u * p1x + 3 * om * u * u * p2x + u * u * u;
    const dx =
      3 * om * om * p1x + 6 * om * u * (p2x - p1x) + 3 * u * u * (1 - p2x);
    if (Math.abs(dx) < 1e-7) break;
    u -= (x - t) / dx;
    u = Math.min(1, Math.max(0, u));
  }
  const om = 1 - u;
  return 3 * om * om * u * p1y + 3 * om * u * u * p2y + u * u * u;
}

function easeTs(easing: string, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  switch (easing) {
    case "Linear":
      return c;
    case "Ease":
      return solveCubicBezier(0.25, 0.1, 0.25, 1, c);
    case "EaseIn":
      return solveCubicBezier(0.42, 0, 1, 1, c);
    case "EaseOut":
      return solveCubicBezier(0, 0, 0.58, 1, c);
    case "EaseInOut":
      return solveCubicBezier(0.42, 0, 0.58, 1, c);
    case "CubicBezier":
      return solveCubicBezier(0.34, 1.56, 0.64, 1, c);
    case "Step":
      return c >= 1 ? 1 : 0;
    default:
      return c;
  }
}

/** 检查器展示用：对 clip 局部时间求插值（与内核同构的显示层近似） */
export function evaluateClipLocal(
  meta: SceneClipMeta,
  localMs: number,
): { dx: number; dy: number; scale: number; opacity: number } {
  const kfs = meta.keyframes;
  if (kfs.length === 0) return { dx: 0, dy: 0, scale: 1, opacity: 1 };
  const dur = meta.durationMs;
  const t = dur > 0 ? ((localMs % dur) + dur) % dur : 0;
  if (t <= kfs[0].timeMs) {
    const k = kfs[0];
    return { dx: k.dx, dy: k.dy, scale: k.scale, opacity: k.opacity };
  }
  const last = kfs[kfs.length - 1];
  if (t >= last.timeMs) {
    return { dx: last.dx, dy: last.dy, scale: last.scale, opacity: last.opacity };
  }
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.timeMs && t <= b.timeMs) {
      const lt = (t - a.timeMs) / Math.max(1e-6, b.timeMs - a.timeMs);
      const e = easeTs(a.easing, lt);
      return {
        dx: a.dx + (b.dx - a.dx) * e,
        dy: a.dy + (b.dy - a.dy) * e,
        scale: a.scale + (b.scale - a.scale) * e,
        opacity: a.opacity + (b.opacity - a.opacity) * e,
      };
    }
  }
  return { dx: last.dx, dy: last.dy, scale: last.scale, opacity: last.opacity };
}
