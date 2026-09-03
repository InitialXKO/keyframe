"use client";

/**
 * KeyframeInspector — 单粒子关键帧检查器（D3 + SVG，不使用 ECharts）。
 *
 * 布局（zinc-950 深色卡片）：
 *  - 顶部：instanceId / clipId / patternName 徽标行 + 缓动图例说明
 *  - 中部左：D3 SVG「轨道俯视图」— 20 个关键帧 (dx,dy) 以 curveCatmullRom 平滑连线，
 *    关键帧圆点按缓动着色（Linear=zinc-500 / EaseInOut=amber-400 / CubicBezier=cyan-400 /
 *    其他=rose-400）；当前 relative 位置为发光呼吸圆点
 *  - 中部右：D3 SVG「时间曲线」— dx(t) / dy(t) / scale(t)（逐段按缓动采样，x 轴 0..clipDurationMs），
 *    playheadMs 处琥珀色垂直游标线 —— transform 由父组件 ref 直写，10Hz 流畅更新不整图重绘
 *  - 底部：worldPos / relative / opacity 等宽数字读出
 *
 * 性能设计：轨道/曲线的 path 字符串与坐标全部在 useMemo 内按 track 预计算，
 * 两个 SVG 子组件 memo 化 —— playheadMs / relative 的 10Hz 更新只触发 ref 直写，
 * 不重渲染 SVG 子树。track 为 null 时显示「点击画布选择粒子」占位。
 * SVG viewBox 固定 340×200、preserveAspectRatio 缩放，容器 h-[220px] 自适应宽度。
 */

import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import * as d3 from "d3";
import { MousePointerClick, Orbit, Spline } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface InspectorKeyframe {
  timeMs: number;
  dx: number;
  dy: number;
  scale: number;
  opacity: number;
  easing: string;
}

export interface InspectorTrack {
  instanceId: string;
  clipId: string;
  /** 动效母题名，如 "涡旋臂" */
  patternName: string;
  clipDurationMs: number;
  /** 通常 20 个 */
  keyframes: InspectorKeyframe[];
}

export interface KeyframeInspectorProps {
  track: InspectorTrack | null;
  /** 当前 clip 内局部时间（~10Hz 更新） */
  playheadMs: number;
  /** 当前 clip 局部平移偏移 */
  relative: { x: number; y: number } | null;
  /** 当前世界坐标 */
  worldPos: { x: number; y: number } | null;
}

// ---- 调色板（仅 zinc / amber / cyan / rose）--------------------------------

const EASING_COLORS = {
  linear: "#71717a", // zinc-500
  easeinout: "#fbbf24", // amber-400
  cubicbezier: "#22d3ee", // cyan-400
  other: "#f43f5e", // rose-400
} as const;

type EaseKind = keyof typeof EASING_COLORS;

const EASING_LEGEND: { label: string; kind: EaseKind; note: string }[] = [
  { label: "Linear", kind: "linear", note: "匀速" },
  { label: "EaseInOut", kind: "easeinout", note: "缓入缓出" },
  { label: "CubicBezier", kind: "cubicbezier", note: "自定义贝塞尔" },
  { label: "其他", kind: "other", note: "EaseIn/Out、Step 等" },
];

const AMBER = "#fbbf24";
const CYAN = "#22d3ee";
const SCALE_CURVE = "#a1a1aa"; // zinc-400
const TRACK_LINE = "#52525b"; // zinc-600
const AXIS = "#27272a"; // zinc-800
const TICK_TEXT = "#52525b"; // zinc-600

// SVG viewBox —— 容器经 preserveAspectRatio 自适应
const VB_W = 340;
const VB_H = 200;
const PAD = 16; // 俯视图四边留白
const PAD_L = 22; // 时间曲线左留白（给 y 向曲线让位）
const PAD_R = 12;
const CURVE_TOP = 18; // 时间曲线顶部（图例行下方）

function easeKind(easing: string): EaseKind {
  const k = easing.trim().toLowerCase();
  if (k === "linear") return "linear";
  if (k === "easeinout") return "easeinout";
  if (k === "cubicbezier") return "cubicbezier";
  return "other";
}

/**
 * 近似缓动求值：Linear 1:1、EaseInOut smoothstep、CubicBezier 无控制点 payload
 * 以 smoothstep 逼近（形态预览用）；常见 EaseIn/Out/Step 按语义近似。
 */
function evalEasing(easing: string, f: number): number {
  const x = Math.min(1, Math.max(0, f));
  switch (easeKind(easing)) {
    case "linear":
      return x;
    case "easeinout":
      return x * x * (3 - 2 * x);
    case "cubicbezier":
      return x * x * (3 - 2 * x);
    case "other": {
      const n = easing.trim().toLowerCase();
      if (n.includes("easeinout")) return x * x * (3 - 2 * x);
      if (n.includes("easein")) return x * x;
      if (n.includes("easeout")) return 1 - (1 - x) * (1 - x);
      if (n.includes("step")) return x >= 1 ? 1 : 0;
      return x;
    }
  }
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

/** 播放头处的 opacity 读数：所在段按该段缓动插值，段外取端点值 */
function sampleOpacity(kfs: InspectorKeyframe[], t: number): number | null {
  if (kfs.length === 0) return null;
  if (kfs.length === 1 || t <= kfs[0].timeMs) return kfs[0].opacity;
  const last = kfs[kfs.length - 1];
  if (t >= last.timeMs) return last.opacity;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.timeMs && t <= b.timeMs) {
      const f = (t - a.timeMs) / Math.max(1e-6, b.timeMs - a.timeMs);
      return a.opacity + (b.opacity - a.opacity) * evalEasing(a.easing, f);
    }
  }
  return last.opacity;
}

// ---- 轨道俯视图（预计算）---------------------------------------------------

interface OrbitLayout {
  path: string;
  dots: { x: number; y: number; color: string; easing: string; timeMs: number }[];
  origin: { x: number; y: number };
  sx: (v: number) => number;
  sy: (v: number) => number;
}

function buildOrbit(kfs: InspectorKeyframe[]): OrbitLayout {
  // 包含原点锚（dx/dy 是相对锚点的偏移）
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const k of kfs) {
    if (k.dx < minX) minX = k.dx;
    if (k.dx > maxX) maxX = k.dx;
    if (k.dy < minY) minY = k.dy;
    if (k.dy > maxY) maxY = k.dy;
  }
  if (maxX - minX < 1e-6) {
    minX -= 1;
    maxX += 1;
  }
  if (maxY - minY < 1e-6) {
    minY -= 1;
    maxY += 1;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // 25% 外边距 —— 给可能越界的发光呼吸点留位（配合 clamp 不出画布）
  const half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.25;
  // 轨道俯视：dx → 右，dy → 下（与 CSS transform 屏幕语义一致）
  const sx = d3.scaleLinear().domain([cx - half, cx + half]).range([PAD, VB_W - PAD]).clamp(true);
  const sy = d3.scaleLinear().domain([cy - half, cy + half]).range([PAD, VB_H - PAD]).clamp(true);
  const lineGen = d3
    .line<{ dx: number; dy: number }>()
    .x((k) => sx(k.dx))
    .y((k) => sy(k.dy))
    .curve(d3.curveCatmullRom.alpha(0.5));
  return {
    path: lineGen(kfs) ?? "",
    dots: kfs.map((k) => ({
      x: sx(k.dx),
      y: sy(k.dy),
      color: EASING_COLORS[easeKind(k.easing)],
      easing: k.easing,
      timeMs: k.timeMs,
    })),
    origin: { x: sx(0), y: sy(0) },
    sx: (v) => sx(v),
    sy: (v) => sy(v),
  };
}

// ---- 时间曲线（预计算）-----------------------------------------------------

interface CurveSeries {
  path: string;
  label: string;
  color: string;
}

interface CurveLayout {
  xScale: (t: number) => number;
  series: CurveSeries[];
  ticks: { x: number; label: string }[];
}

function buildCurves(kfs: InspectorKeyframe[], durationMs: number): CurveLayout {
  const dur = Math.max(1, durationMs);
  const x = d3.scaleLinear().domain([0, dur]).range([PAD_L, VB_W - PAD_R]).clamp(true);

  // 逐段按该段缓动采样 —— 曲线形态与引擎求值语义一致（SpeedGraph 同思路）
  const build = (pick: (k: InspectorKeyframe) => number, label: string, color: string): CurveSeries => {
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const k of kfs) {
      const v = pick(k);
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    if (vmax - vmin < 1e-6) {
      vmin -= 1;
      vmax += 1;
    }
    const m = (vmax - vmin) * 0.14;
    const y = d3.scaleLinear().domain([vmin - m, vmax + m]).range([VB_H - PAD, CURVE_TOP]).clamp(true);
    const pts: [number, number][] = [];
    const SUB = 12;
    for (let i = 0; i < kfs.length; i++) {
      const k = kfs[i];
      if (i === kfs.length - 1) {
        pts.push([x(k.timeMs), y(pick(k))]);
        break;
      }
      const nk = kfs[i + 1];
      const segDur = Math.max(1e-6, nk.timeMs - k.timeMs);
      for (let s = 0; s < SUB; s++) {
        const f = s / SUB;
        const t = k.timeMs + segDur * f;
        const v = pick(k) + (pick(nk) - pick(k)) * evalEasing(k.easing, f);
        pts.push([x(t), y(v)]);
      }
    }
    return { path: d3.line<[number, number]>()(pts) ?? "", label, color };
  };

  return {
    xScale: (t: number) => x(Math.min(Math.max(t, 0), dur)),
    series: [
      build((k) => k.dx, "dx", AMBER),
      build((k) => k.dy, "dy", CYAN),
      build((k) => k.scale, "scale", SCALE_CURVE),
    ],
    ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      x: x(dur * f),
      label: `${((dur * f) / 1000).toFixed(2)}s`,
    })),
  };
}

// ---- memo 化 SVG 子组件（track 级静态，playhead/relative 走 ref 直写）-------

const OrbitView = memo(function OrbitView({
  layout,
  glowRef,
}: {
  layout: OrbitLayout;
  glowRef: RefObject<SVGGElement | null>;
}) {
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-full w-full" role="img" aria-label="轨道俯视图">
      {/* 原点锚十字 */}
      <g stroke={AXIS} strokeWidth={1}>
        <line x1={layout.origin.x - 5} x2={layout.origin.x + 5} y1={layout.origin.y} y2={layout.origin.y} />
        <line x1={layout.origin.x} x2={layout.origin.x} y1={layout.origin.y - 5} y2={layout.origin.y + 5} />
      </g>
      {/* Catmull-Rom 平滑轨迹：暗底 + 微光描边 */}
      <path d={layout.path} fill="none" stroke={TRACK_LINE} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
      <path d={layout.path} fill="none" stroke={AMBER} strokeWidth={0.6} opacity={0.32} strokeLinecap="round" />
      {/* 关键帧圆点（按缓动着色，原生 title 提示） */}
      {layout.dots.map((d, i) => (
        <g key={`kf-${i}`} transform={`translate(${d.x.toFixed(2)} ${d.y.toFixed(2)})`}>
          <circle r={3.2} fill={d.color} opacity={0.92}>
            <title>{`kf ${i} @ ${(d.timeMs / 1000).toFixed(2)}s · ${d.easing}`}</title>
          </circle>
        </g>
      ))}
      {/* 当前 relative 发光呼吸点 —— transform 由父组件 ref 直写 */}
      <g ref={glowRef} opacity={0}>
        <circle r={9} fill={AMBER} opacity={0.16} className="animate-pulse" />
        <circle
          r={3.4}
          fill="#fde68a"
          stroke={AMBER}
          strokeWidth={1}
          style={{ filter: "drop-shadow(0 0 5px rgba(251, 191, 36, 0.85))" }}
        />
      </g>
    </svg>
  );
});

const CurvesView = memo(function CurvesView({
  layout,
  playheadRef,
}: {
  layout: CurveLayout;
  playheadRef: RefObject<SVGGElement | null>;
}) {
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-full w-full" role="img" aria-label="时间曲线">
      {/* 底轴 + 时间刻度 */}
      <line x1={PAD_L} x2={VB_W - PAD_R} y1={VB_H - PAD} y2={VB_H - PAD} stroke={AXIS} strokeWidth={1} />
      {layout.ticks.map((t, i) => (
        <g key={`tick-${i}`}>
          <line x1={t.x} x2={t.x} y1={VB_H - PAD} y2={VB_H - PAD + 3} stroke={AXIS} strokeWidth={1} />
          <text x={t.x} y={VB_H - 4} textAnchor="middle" fontSize={8} fill={TICK_TEXT}>
            {t.label}
          </text>
        </g>
      ))}
      {/* 系列图例（每条曲线独立归一化，仅比较形态） */}
      {layout.series.map((s, i) => (
        <text
          key={`legend-${s.label}`}
          x={PAD_L + i * 46}
          y={11}
          fontSize={9}
          fill={s.color}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {s.label}
        </text>
      ))}
      {/* dx / dy / scale 曲线（逐段按缓动采样） */}
      {layout.series.map((s) => (
        <path
          key={`path-${s.label}`}
          d={s.path}
          fill="none"
          stroke={s.color}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.95}
        />
      ))}
      {/* 播放头游标 —— transform 由父组件 ref 直写（10Hz 流畅，免整图重绘） */}
      <g ref={playheadRef}>
        <line x1={0} x2={0} y1={CURVE_TOP} y2={VB_H - PAD} stroke={AMBER} strokeWidth={1} strokeDasharray="3 2" opacity={0.9} />
        <circle cx={0} cy={CURVE_TOP} r={2.2} fill={AMBER} />
      </g>
    </svg>
  );
});

function EmptyWell({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">{text}</div>;
}

// ---- 主组件 ----------------------------------------------------------------

export function KeyframeInspector({ track, playheadMs, relative, worldPos }: KeyframeInspectorProps) {
  const glowRef = useRef<SVGGElement | null>(null);
  const playheadRef = useRef<SVGGElement | null>(null);

  const sorted = useMemo(
    () => (track ? [...track.keyframes].sort((a, b) => a.timeMs - b.timeMs) : []),
    [track]
  );
  const orbit = useMemo(() => (sorted.length > 0 ? buildOrbit(sorted) : null), [sorted]);
  const curves = useMemo(
    () => (sorted.length > 0 ? buildCurves(sorted, track?.clipDurationMs ?? 0) : null),
    [sorted, track]
  );

  // relative 发光点 —— ref 直写，10Hz 不重渲染 SVG 子树
  useEffect(() => {
    const g = glowRef.current;
    if (!g) return;
    if (!orbit || !relative) {
      g.setAttribute("opacity", "0");
      return;
    }
    const x = orbit.sx(relative.x);
    const y = orbit.sy(relative.y);
    g.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    g.setAttribute("opacity", "1");
  }, [orbit, relative]);

  // 播放头游标 —— ref 直写 transform
  useEffect(() => {
    const g = playheadRef.current;
    if (!g || !curves) return;
    g.setAttribute("transform", `translate(${curves.xScale(playheadMs).toFixed(2)} 0)`);
  }, [curves, playheadMs]);

  // track 为 null：占位说明（hooks 已全部声明于上方，顺序稳定）
  if (!track) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3" data-testid="keyframe-inspector">
        <div className="mb-2 flex items-center gap-1.5">
          <Orbit className="h-3.5 w-3.5 text-zinc-600" />
          <span className="text-xs font-semibold text-zinc-400">关键帧检查器</span>
        </div>
        <div className="flex h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-4">
          <MousePointerClick className="h-5 w-5 text-zinc-600" />
          <p className="text-xs text-zinc-400">点击画布选择粒子</p>
          <p className="max-w-[260px] text-center text-[10px] leading-relaxed text-zinc-600">
            选中后在此检查该实例的轨道俯视图、dx/dy/scale 时间曲线与世界坐标读数
          </p>
        </div>
      </div>
    );
  }

  const opacity = sampleOpacity(sorted, playheadMs);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3" data-testid="keyframe-inspector">
      {/* 顶部：徽标行 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Orbit className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="text-xs font-semibold text-zinc-200">关键帧检查器</span>
        <Badge variant="outline" className="max-w-[130px] border-zinc-700 text-[10px] text-zinc-400" title="实例 ID">
          <span className="truncate font-mono">{track.instanceId}</span>
        </Badge>
        <Badge variant="outline" className="max-w-[130px] border-zinc-700 text-[10px] text-zinc-400" title="Clip ID">
          <span className="truncate font-mono">{track.clipId}</span>
        </Badge>
        <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-300" title="动效母题">
          {track.patternName}
        </Badge>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
          {track.keyframes.length} 关键帧 · {(track.clipDurationMs / 1000).toFixed(2)}s
        </span>
      </div>

      {/* 顶部：缓动说明（着色图例） */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
        <span className="text-zinc-600">缓动：</span>
        {EASING_LEGEND.map((e) => (
          <span key={e.label} className="flex items-center gap-1" title={e.note}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: EASING_COLORS[e.kind] }} />
            {e.label}
          </span>
        ))}
      </div>

      {/* 中部：俯视图 + 时间曲线 */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <figure className="min-w-0">
          <figcaption className="mb-1 flex items-center gap-1 text-[10px] text-zinc-600">
            <Orbit className="h-3 w-3" /> 轨道俯视图 · dx/dy（按缓动着色）
          </figcaption>
          <div className="h-[220px] rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-1" data-testid="inspector-orbit">
            {orbit ? <OrbitView layout={orbit} glowRef={glowRef} /> : <EmptyWell text="无关键帧数据" />}
          </div>
        </figure>
        <figure className="min-w-0">
          <figcaption className="mb-1 flex items-center gap-1 text-[10px] text-zinc-600">
            <Spline className="h-3 w-3" /> 时间曲线 · dx / dy / scale
          </figcaption>
          <div className="h-[220px] rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-1" data-testid="inspector-curves">
            {curves ? <CurvesView layout={curves} playheadRef={playheadRef} /> : <EmptyWell text="无关键帧数据" />}
          </div>
        </figure>
      </div>

      {/* 底部：数字读出（等宽） */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-2.5 py-1.5 font-mono text-[10px]">
        <span className="flex items-center gap-1.5">
          <span className="text-zinc-600">world</span>
          <span className="text-zinc-300">
            {fmtNum(worldPos?.x)}, {fmtNum(worldPos?.y)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-zinc-600">relative</span>
          <span className="text-zinc-300">
            {fmtNum(relative?.x)}, {fmtNum(relative?.y)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-zinc-600">opacity</span>
          <span className="text-amber-300">{opacity == null ? "—" : opacity.toFixed(2)}</span>
        </span>
        <span className="ml-auto text-zinc-600">
          t {(Math.min(Math.max(playheadMs, 0), track.clipDurationMs) / 1000).toFixed(2)}s /{" "}
          {(track.clipDurationMs / 1000).toFixed(2)}s
        </span>
      </div>
    </div>
  );
}

export default KeyframeInspector;
