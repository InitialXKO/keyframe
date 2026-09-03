/**
 * KeyForge Motion Studio — Scene Model Layer
 *
 * Bridges the vendored Keyframe Engine with the studio's scene format.
 * Scene data is plain JSON (serializable) and is compiled into engine
 * Clips/Instances on demand.
 */

import {
  Engine,
  Clip,
  Instance,
  Keyframe,
  TransformBuilder,
  Easing as EngineEasing,
} from "./keyframe";
import type { TransformData, Easing as EasingName, Easing } from "./keyframe/builder/types";

// ---------------------------------------------------------------------------
// Scene model
// ---------------------------------------------------------------------------

export type ShapeKind = "box" | "circle" | "text";

/** Custom cubic-bezier control points (used when easing = CubicBezier). */
export interface CubicControl {
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
}

/** One keyframe on an element's track. Motion is relative to the element base (x,y). */
export interface Kf {
  /** time in ms within the scene */
  t: number;
  /** horizontal offset from base x (px) */
  dx: number;
  /** vertical offset from base y (px) */
  dy: number;
  /** uniform scale */
  scale: number;
  /** rotation around Z (degrees) */
  rot: number;
  /** opacity 0..1 */
  opacity: number;
  /** easing applied from this keyframe to the NEXT one */
  easing: EasingName;
  /** custom bezier control points — honored when easing === CubicBezier */
  cubic?: CubicControl;
}

export interface SceneElement {
  id: string;
  name: string;
  shape: ShapeKind;
  color: string;
  /** edge size in px (box: w=h; circle: diameter; text: font size base) */
  size: number;
  text?: string;
  /** base position on stage (top-left of the element, pre-transform) */
  x: number;
  y: number;
  keyframes: Kf[];
  /** editor-only: hide from stage without touching animation */
  hidden?: boolean;
  /** editor-only: lock against drags & edits */
  locked?: boolean;
}

export interface SceneData {
  title: string;
  durationMs: number;
  elements: SceneElement[];
}

export const EASING_OPTIONS: { value: EasingName; label: string }[] = [
  { value: EngineEasing.Linear, label: "Linear 线性" },
  { value: EngineEasing.Ease, label: "Ease 缓和" },
  { value: EngineEasing.EaseIn, label: "Ease In 渐入" },
  { value: EngineEasing.EaseOut, label: "Ease Out 渐出" },
  { value: EngineEasing.EaseInOut, label: "Ease In Out 缓入缓出" },
  { value: EngineEasing.CubicBezier, label: "Cubic Bezier 回弹曲线" },
  { value: EngineEasing.Step, label: "Step 阶跃" },
];

export const SHAPE_OPTIONS: { value: ShapeKind; label: string }[] = [
  { value: "box", label: "方块" },
  { value: "circle", label: "圆形" },
  { value: "text", label: "文字" },
];

// ---------------------------------------------------------------------------
// Easing math — mirrors the vendored engine's evaluateEasing exactly
// ---------------------------------------------------------------------------

/** Solve cubic-bezier y at progress t (identical Newton iteration to the engine). */
export function solveBezierY(p1x: number, p1y: number, p2x: number, p2y: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const omu = 1 - u;
    const x = 3 * omu * omu * u * p1x + 3 * omu * u * u * p2x + u * u * u;
    const dx = 3 * omu * omu * p1x + 6 * omu * u * (p2x - p1x) + 3 * u * u * (1 - p2x);
    if (Math.abs(dx) < 1e-7) break;
    u -= (x - t) / dx;
    u = Math.max(0, Math.min(1, u));
  }
  const omu = 1 - u;
  return 3 * omu * omu * u * p1y + 3 * omu * u * u * p2y + u * u * u;
}

/**
 * Eased progress at linear time fraction t for a keyframe's easing.
 * Used by path baking / visualization wherever the engine's per-segment
 * easing semantics need to be reproduced outside the engine.
 */
export function easedFraction(easing: EasingName, cubic: CubicControl | undefined, t: number): number {
  const c = Math.max(0, Math.min(1, t));
  switch (easing) {
    case EngineEasing.Linear:
      return c;
    case EngineEasing.Ease:
      return solveBezierY(0.25, 0.1, 0.25, 1, c);
    case EngineEasing.EaseIn:
      return solveBezierY(0.42, 0, 1, 1, c);
    case EngineEasing.EaseOut:
      return solveBezierY(0, 0, 0.58, 1, c);
    case EngineEasing.CubicBezier:
      return cubic
        ? solveBezierY(cubic.p1x, cubic.p1y, cubic.p2x, cubic.p2y, c)
        : solveBezierY(0.42, 0, 0.58, 1, c);
    case EngineEasing.Step:
      return c >= 1 ? 1 : 0;
    default: // EaseInOut
      return solveBezierY(0.42, 0, 0.58, 1, c);
  }
}

// ---------------------------------------------------------------------------
// Motion analysis — per-segment velocity sampling (shared by SpeedGraph and
// the timeline's heat-strip rendering; same math as the engine's easing)
// ---------------------------------------------------------------------------

export interface SegSpeed {
  t0: number;
  t1: number;
  /** speed samples (1/ms) across the segment, τ from 0..1 */
  samples: number[];
}

/** numeric derivative of the eased progress, in 1/ms, sampled per segment */
export function segmentSpeeds(kfs: Kf[], durationMs: number): SegSpeed[] {
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return [];
  const segs: SegSpeed[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const segMs = Math.max(1, b.t - a.t);
    const N = Math.max(8, Math.min(40, Math.round(segMs / 25)));
    const samples: number[] = [];
    for (let s = 0; s <= N; s++) {
      const tau = s / N;
      let v: number;
      if (a.easing === EngineEasing.Step) {
        v = 0; // a held segment has zero velocity (the jump is instantaneous)
      } else {
        const eps = 1 / N / 8;
        const f1 = easedFraction(a.easing, a.cubic, Math.max(0, tau - eps));
        const f2 = easedFraction(a.easing, a.cubic, Math.min(1, tau + eps));
        v = (f2 - f1) / (2 * eps * segMs);
      }
      samples.push(Math.max(0, v));
    }
    segs.push({ t0: a.t, t1: Math.min(b.t, durationMs), samples });
  }
  return segs;
}

/** peak speed (1/ms) across a set of segments */
export function segsPeak(segs: SegSpeed[]): number {
  let m = 0;
  for (const seg of segs) for (const v of seg.samples) if (v > m) m = v;
  return m;
}

export const PALETTE = [
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#a855f7", // purple
  "#14b8a6", // teal
  "#84cc16", // lime
  "#eab308", // yellow
  "#f97316", // orange
  "#22c55e", // green
  "#f43f5e", // rose
];

// ---------------------------------------------------------------------------
// Engine compilation
// ---------------------------------------------------------------------------

/** Compile a scene into a live Keyframe Engine (pure-JS fallback mode). */
export function buildEngineFromScene(scene: SceneData): Engine {
  const engine = new Engine();

  for (const el of scene.elements) {
    const clip = new Clip(el.id).duration(Math.max(1, scene.durationMs)).iterations(Infinity);
    const kfs = [...el.keyframes].sort((a, b) => a.t - b.t);

    if (kfs.length === 0) {
      // identity clip so instance stays at base position
      clip.addKeyframe(
        new Keyframe(0)
          .transform(identityTransform(el.size))
          .opacity(1)
      );
    } else {
      for (const kf of kfs) {
        clip.addKeyframe(
          new Keyframe(kf.t)
            .transform(
              new TransformBuilder()
                .translate(kf.dx, kf.dy, 0)
                .scale(kf.scale)
                .rotateZ(kf.rot)
                .origin(el.size / 2, el.size / 2, 0)
                .build()
            )
            .opacity(kf.opacity)
            .easing(kf.easing as Easing, kf.easing === EngineEasing.CubicBezier && kf.cubic
              ? {
                  p1x: kf.cubic.p1x,
                  p1y: kf.cubic.p1y,
                  p2x: kf.cubic.p2x,
                  p2y: kf.cubic.p2y,
                }
              : undefined)
        );
      }
    }

    engine.addClip(clip);

    const inst = new Instance(el.id, el.id)
      .delay(0)
      .initialTransform(baseTransform(el));
    engine.addInstances([inst]);
  }

  // JS fallback mode: upstream WASM artifact is not published (CDN 404),
  // so we run the engine's pure-JS evaluation path, which implements the
  // identical math (cubic-bezier easing, quaternion slerp, zero-copy layout).
  (engine as unknown as { prepared: boolean }).prepared = true;
  return engine;
}

function baseTransform(el: SceneElement): TransformData {
  return new TransformBuilder()
    .translate(el.x, el.y, 0)
    .origin(el.size / 2, el.size / 2, 0)
    .build();
}

function identityTransform(size: number): TransformData {
  return new TransformBuilder()
    .translate(0, 0, 0)
    .origin(size / 2, size / 2, 0)
    .build();
}

// ---------------------------------------------------------------------------
// Animation presets — one-click motion recipes
// ---------------------------------------------------------------------------

export interface PresetDef {
  id: string;
  name: string;
  desc: string;
  /** keyframes relative to scene start (t=0) */
  build: (stage: { w: number; h: number }) => Kf[];
}

export const PRESETS: PresetDef[] = [
  {
    id: "fadeIn",
    name: "淡入 Fade In",
    desc: "透明度从 0 渐显",
    build: () => [
      { t: 0, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0, easing: EngineEasing.EaseOut },
      { t: 800, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
  {
    id: "bounceIn",
    name: "弹跳入场 Bounce",
    desc: "从下方带回弹跃入",
    build: () => [
      { t: 0, dx: 0, dy: 220, scale: 0.6, rot: 0, opacity: 0, easing: EngineEasing.EaseOut },
      { t: 520, dx: 0, dy: -26, scale: 1.06, rot: 0, opacity: 1, easing: EngineEasing.EaseInOut },
      { t: 760, dx: 0, dy: 10, scale: 0.98, rot: 0, opacity: 1, easing: EngineEasing.EaseOut },
      { t: 950, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
  {
    id: "slideLeft",
    name: "左侧滑入 Slide",
    desc: "从画面左侧滑入并减速",
    build: ({ w }) => [
      { t: 0, dx: -w * 0.6, dy: 0, scale: 1, rot: 0, opacity: 0, easing: EngineEasing.EaseOut },
      { t: 900, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
  {
    id: "popSpin",
    name: "缩放旋转 Pop Spin",
    desc: "放大旋转入场，带过冲",
    build: () => [
      { t: 0, dx: 0, dy: 0, scale: 0.1, rot: -180, opacity: 0, easing: EngineEasing.CubicBezier },
      { t: 1000, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
  {
    id: "pulse",
    name: "脉冲 Pulse",
    desc: "持续心跳缩放循环",
    build: () => [
      { t: 0, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.EaseInOut },
      { t: 500, dx: 0, dy: 0, scale: 1.25, rot: 0, opacity: 0.85, easing: EngineEasing.EaseInOut },
      { t: 1000, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
  {
    id: "floatY",
    name: "悬浮 Float",
    desc: "上下漂浮循环",
    build: () => [
      { t: 0, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.EaseInOut },
      { t: 1100, dx: 0, dy: -34, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.EaseInOut },
      { t: 2200, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
  {
    id: "orbit",
    name: "环绕 Orbit",
    desc: "8 点圆形环绕一圈",
    build: () => {
      const r = 140;
      const kfs: Kf[] = [];
      const steps = 8;
      for (let i = 0; i <= steps; i++) {
        const ang = (i / steps) * Math.PI * 2;
        kfs.push({
          t: (i / steps) * 2400,
          dx: Math.cos(ang) * r,
          dy: Math.sin(ang) * r,
          scale: 1,
          rot: (i / steps) * 360,
          opacity: 1,
          easing: EngineEasing.EaseInOut,
        });
      }
      return kfs;
    },
  },
  {
    id: "typewriter",
    name: "阶跃显现 Step",
    desc: "步进式闪烁出现",
    build: () => [
      { t: 0, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0.15, easing: EngineEasing.Step },
      { t: 150, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0.9, easing: EngineEasing.Step },
      { t: 300, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0.15, easing: EngineEasing.Step },
      { t: 450, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
    ],
  },
];

// ---------------------------------------------------------------------------
// Demo scene
// ---------------------------------------------------------------------------

let elSeq = 0;
export function nextElId(): string {
  return `el_${Date.now().toString(36)}_${(++elSeq).toString(36)}`;
}

export function makeDemoScene(stage: { w: number; h: number }): SceneData {
  const cx = stage.w / 2;
  const cy = stage.h / 2;
  return {
    title: "产品发布开场 Demo",
    durationMs: 4000,
    elements: [
      {
        id: nextElId(),
        name: "主标题",
        shape: "text",
        color: PALETTE[0],
        size: 44,
        text: "KEYFORGE",
        x: cx - 130,
        y: cy - 90,
        keyframes: PRESETS[1].build(stage).map((k) => ({ ...k })),
      },
      {
        id: nextElId(),
        name: "副标题",
        shape: "text",
        color: "#d4d4d8",
        size: 18,
        text: "Rust × WASM × WebGPU 动效引擎驱动的设计工作台",
        x: cx - 168,
        y: cy - 6,
        keyframes: [
          { t: 400, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0, easing: EngineEasing.EaseOut },
          { t: 1300, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: EngineEasing.Linear },
        ],
      },
      {
        id: nextElId(),
        name: "装饰球 L",
        shape: "circle",
        color: PALETTE[2],
        size: 56,
        x: cx - 300,
        y: cy + 40,
        keyframes: PRESETS[5].build(stage),
      },
      {
        id: nextElId(),
        name: "装饰球 R",
        shape: "circle",
        color: PALETTE[4],
        size: 40,
        x: cx + 250,
        y: cy - 30,
        keyframes: PRESETS[4].build(stage),
      },
      {
        id: nextElId(),
        name: "旋转卡片",
        shape: "box",
        color: PALETTE[8],
        size: 72,
        x: cx + 130,
        y: cy + 90,
        keyframes: PRESETS[3].build(stage),
      },
      {
        id: nextElId(),
        name: "CTA 按钮",
        shape: "box",
        color: PALETTE[7],
        size: 54,
        x: cx - 200,
        y: cy + 100,
        keyframes: PRESETS[2].build(stage),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Remotion code generation (leverages the engine's Remotion-compat semantics)
// ---------------------------------------------------------------------------

export function sceneToRemotionCode(scene: SceneData): string {
  const lines: string[] = [];
  lines.push(`// 由 KeyForge Motion Studio 生成 — 兼容 @keyframe/core Remotion 兼容层`);
  lines.push(`import { AbsoluteFill, Sequence, spring, interpolate, useCurrentFrame, useVideoConfig } from "@keyframe/core";`);
  lines.push("");
  lines.push(`export const durationInFrames = ${Math.ceil(scene.durationMs / (1000 / 30))}; // ${scene.durationMs}ms @30fps`);
  lines.push("");
  lines.push(`export default function ${toCompName(scene.title)}() {`);
  lines.push(`  const frame = useCurrentFrame();`);
  lines.push(`  const { fps } = useVideoConfig();`);
  lines.push(`  const els: React.ReactNode[] = [];`);
  lines.push("");
  for (const el of scene.elements) {
    const kfs = [...el.keyframes].sort((a, b) => a.t - b.t);
    if (kfs.length === 0) continue;
    const first = kfs[0];
    const last = kfs[kfs.length - 1];
    const startFrame = Math.round(first.t / (1000 / 30));
    const endFrame = Math.round(last.t / (1000 / 30));
    lines.push(`  // ── ${el.name} (${el.shape}) ──`);
    lines.push(`  {`);
    lines.push(`    const local = frame - ${startFrame};`);
    lines.push(`    const p = interpolate(local, [0, ${endFrame - startFrame}], [0, 1], { extrapolateRight: "clamp" });`);
    lines.push(`    const dx = interpolate(p, [0, 1], [${round2(first.dx)}, ${round2(last.dx)}]);`);
    lines.push(`    const dy = interpolate(p, [0, 1], [${round2(first.dy)}, ${round2(last.dy)}]);`);
    lines.push(`    const scale = interpolate(p, [0, 1], [${round2(first.scale)}, ${round2(last.scale)}]);`);
    lines.push(`    const opacity = interpolate(p, [0, 1], [${round2(first.opacity)}, ${round2(last.opacity)}], { extrapolateLeft: "clamp" });`);
    lines.push(`    els.push(`);
    lines.push(`      <div key="${el.id}" style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0",`);
    lines.push(`        transform: \`translate(\${${el.x} + dx}px, \${${el.y} + dy}px) scale(\${scale})\`,`);
    lines.push(`        opacity, width: ${el.size}, height: ${el.size}, borderRadius: "${el.shape === "circle" ? "9999px" : "12px"}", background: "${el.color}" }} />`);
    lines.push(`    );`);
    lines.push(`  }`);
    lines.push("");
  }
  lines.push(`  return <AbsoluteFill style={{ background: "#09090b" }}>{els}</AbsoluteFill>;`);
  lines.push(`}`);
  return lines.join("\n");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toCompName(title: string): string {
  const cleaned = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5 ]/g, "").trim();
  const ascii = cleaned.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  if (ascii.length >= 2) {
    return (
      "Scene" +
      ascii
        .split(/\s+/)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("")
    );
  }
  return "KeyforgeScene";
}
