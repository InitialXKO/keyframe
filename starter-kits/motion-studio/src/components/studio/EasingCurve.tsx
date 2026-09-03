"use client";

/**
 * EasingCurve — interactive cubic-bezier editor & preview.
 *
 * - Read-only mode: renders the preset curve for the selected easing name.
 * - Edit mode (onChange provided): P1/P2 handles become draggable; dragging
 *   emits custom control points and switches the keyframe to CubicBezier.
 *
 * Math notes: CSS cubic-bezier semantics — progress x(t) and eased value
 * y(t) are parametrized by an internal t∈[0,1]. For plotting we invert
 * x(t) numerically (bisection) so the horizontal axis is true time progress.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Easing as EasingName } from "@/lib/keyframe";
import { Easing } from "@/lib/keyframe";
import type { CubicControl } from "@/lib/scene";

/** control points mirroring the engine's evaluateEasing defaults */
export function controlsFor(easing: EasingName): [number, number, number, number] {
  switch (easing) {
    case Easing.Ease:
      return [0.25, 0.1, 0.25, 1.0];
    case Easing.EaseIn:
      return [0.42, 0.0, 1.0, 1.0];
    case Easing.EaseOut:
      return [0.0, 0.0, 0.58, 1.0];
    case Easing.EaseInOut:
      return [0.42, 0.0, 0.58, 1.0];
    case Easing.CubicBezier:
      return [0.34, 1.56, 0.64, 1.0]; // overshoot (back-out) profile
    default:
      return [0, 0, 1, 1]; // linear / step baseline
  }
}

/** cubic bezier along one axis */
function axis(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** solve t such that x(t) = x (bisection; x(t) monotonic for p1x,p2x∈[0,1]) */
function solveTForX(x: number, p1x: number, p2x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (axis(mid, p1x, p2x) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface Props {
  easing: EasingName;
  cubic?: CubicControl;
  /** when provided the curve becomes an interactive bezier editor */
  onChange?: (cubic: CubicControl) => void;
}

export function EasingCurve({ easing, cubic, onChange }: Props) {
  const S = 132; // svg size
  const P = 16; // padding
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<1 | 2 | null>(null);

  const editable = typeof onChange === "function" && easing !== Easing.Step;

  // effective control points: custom cubic > named preset
  const pts = useMemo<[number, number, number, number]>(() => {
    if (easing === Easing.CubicBezier && cubic) {
      return [cubic.p1x, cubic.p1y, cubic.p2x, cubic.p2y];
    }
    return controlsFor(easing);
  }, [easing, cubic]);

  const { path, areaPath, c1, c2, isStep, overshoot } = useMemo(() => {
    const toSvg = (x: number, y: number): [number, number] => [
      P + x * (S - 2 * P),
      S - P - y * (S - 2 * P),
    ];

    if (easing === Easing.Step) {
      const a = toSvg(0, 0);
      const b = toSvg(1, 0);
      const c = toSvg(1, 1);
      return {
        path: `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]} L ${c[0]} ${c[1]}`,
        areaPath: "",
        c1: null,
        c2: null,
        isStep: true,
        overshoot: false,
      };
    }

    const [p1x, p1y, p2x, p2y] = pts;
    const N = 48;
    const coords: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const t = solveTForX(x, p1x, p2x);
      const y = axis(t, p1y, p2y);
      coords.push(toSvg(x, y));
    }
    const path = coords.map(([sx, sy], i) => `${i === 0 ? "M" : "L"} ${sx.toFixed(2)} ${sy.toFixed(2)}`).join(" ");
    const base = toSvg(0, 0);
    const areaPath = `${path} L ${toSvg(1, 0)[0]} ${toSvg(1, 0)[1]} L ${base[0]} ${base[1]} Z`;
    const cc1 = toSvg(p1x, p1y);
    const cc2 = toSvg(p2x, p2y);
    return {
      path,
      areaPath,
      c1: { x: cc1[0], y: cc1[1], v: [p1x, p1y] as const },
      c2: { x: cc2[0], y: cc2[1], v: [p2x, p2y] as const },
      isStep: false,
      overshoot: p1y < 0 || p1y > 1 || p2y < 0 || p2y > 1,
    };
  }, [pts, easing]);

  /** map a pointer event into curve-space (0..1 x, -0.5..1.5 y) */
  const pointFromEvent = useCallback(
    (e: PointerEvent | React.PointerEvent): [number, number] => {
      const svg = svgRef.current;
      if (!svg) return [0, 0];
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * S;
      const py = ((e.clientY - rect.top) / rect.height) * S;
      const x = Math.max(0, Math.min(1, (px - P) / (S - 2 * P)));
      const y = Math.max(-0.5, Math.min(1.5, (S - P - py) / (S - 2 * P)));
      return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
    },
    []
  );

  // keep latest pts for window listeners without re-binding (sync after render)
  const usePtsRef = useRef(pts);
  useEffect(() => {
    usePtsRef.current = pts;
  }, [pts]);

  const onHandlePointerDown = (which: 1 | 2) => (e: React.PointerEvent) => {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    dragging.current = which;
    const emit = (w: 1 | 2, x: number, y: number, base: [number, number, number, number]) => {
      const next: CubicControl =
        w === 1
          ? { p1x: x, p1y: y, p2x: base[2], p2y: base[3] }
          : { p1x: base[0], p1y: base[1], p2x: x, p2y: y };
      onChange?.(next);
    };
    const [px, py] = pointFromEvent(e);
    const current = pts;
    emit(which, px, py, current);

    const move = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const [mx, my] = pointFromEvent(ev);
      emit(dragging.current, mx, my, usePtsRef.current);
    };
    const up = () => {
      dragging.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const isCustom = easing === Easing.CubicBezier && !!cubic;
  const label = isStep
    ? "阶跃插值"
    : easing === Easing.CubicBezier
      ? isCustom
        ? "自定义贝塞尔 · 可拖拽控制点"
        : "回弹曲线（带过冲）"
      : "贝塞尔插值";

  return (
    <div
      className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-2"
      data-testid="easing-preview"
    >
      <svg
        ref={svgRef}
        width={S}
        height={S}
        className={`shrink-0 ${editable ? "cursor-crosshair touch-none" : ""}`}
        role="img"
        aria-label="缓动曲线预览"
        style={{ background: "radial-gradient(circle at 50% 40%, rgba(251,191,36,0.04), transparent 70%)" }}
      >
        {/* overshoot guides */}
        {!isStep && overshoot && (
          <>
            <line x1={P} y1={P - (S - 2 * P) * 0.5 + (S - 2 * P)} x2={S - P} y2={P - (S - 2 * P) * 0.5 + (S - 2 * P)} stroke="#71717a" strokeWidth="1" strokeDasharray="2 4" opacity="0.6" />
            <line x1={P} y1={S - P + (S - 2 * P) * 0.5} x2={S - P} y2={S - P + (S - 2 * P) * 0.5} stroke="#71717a" strokeWidth="1" strokeDasharray="2 4" opacity="0.6" />
          </>
        )}
        {/* grid */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={`v${g}`} x1={P + g * (S - 2 * P)} y1={P} x2={P + g * (S - 2 * P)} y2={S - P} stroke="#27272a" strokeWidth="1" />
        ))}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={`h${g}`} x1={P} y1={S - P - g * (S - 2 * P)} x2={S - P} y2={S - P - g * (S - 2 * P)} stroke="#27272a" strokeWidth="1" />
        ))}
        {/* diagonal reference */}
        <line x1={P} y1={S - P} x2={S - P} y2={P} stroke="#3f3f46" strokeWidth="1" strokeDasharray="3 3" />
        {/* area under curve */}
        {!isStep && <path d={areaPath} fill="url(#kfEaseGrad)" opacity="0.5" />}
        <defs>
          <linearGradient id="kfEaseGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* curve */}
        <path d={path} fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
        {/* control handles + guide lines */}
        {!isStep && c1 && c2 && (
          <>
            <line x1={P} y1={S - P} x2={c1.x} y2={c1.y} stroke="#fbbf24" strokeWidth="1" opacity="0.4" />
            <line x1={S - P} y1={P} x2={c2.x} y2={c2.y} stroke="#fbbf24" strokeWidth="1" opacity="0.4" />
            <circle
              cx={c1.x}
              cy={c1.y}
              r={editable ? 6 : 3}
              fill={editable ? "#0a0a0a" : "#fbbf24"}
              stroke="#fbbf24"
              strokeWidth="2"
              opacity="0.95"
              style={editable ? { cursor: "grab" } : undefined}
              onPointerDown={onHandlePointerDown(1)}
              data-testid="easing-handle-p1"
            />
            <circle
              cx={c2.x}
              cy={c2.y}
              r={editable ? 6 : 3}
              fill={editable ? "#0a0a0a" : "#fbbf24"}
              stroke="#fbbf24"
              strokeWidth="2"
              opacity="0.95"
              style={editable ? { cursor: "grab" } : undefined}
              onPointerDown={onHandlePointerDown(2)}
              data-testid="easing-handle-p2"
            />
          </>
        )}
        {/* endpoints */}
        <circle cx={P} cy={S - P} r="3" fill="#a1a1aa" />
        <circle cx={S - P} cy={P} r="3" fill="#a1a1aa" />
      </svg>
      <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-zinc-500">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-zinc-300">
          {label}
          {editable && !isStep && (
            <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold text-amber-400">
              可编辑
            </span>
          )}
        </div>
        {isStep ? (
          <p>在区间终点瞬间跳变到目标值，适合打字机与逐帧效果。</p>
        ) : (
          <>
            <p className="font-mono">
              P1 ({pts[0]}, {pts[1]}) · P2 ({pts[2]}, {pts[3]})
            </p>
            <p className="mt-1">
              横轴 = 时间进度 · 纵轴 = 属性进度
              {editable && <span className="text-amber-500/80"> · 拖拽圆点调整节奏</span>}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Back-compat alias used by earlier call sites. */
export const EasingCurvePreview = EasingCurve;
