"use client";

/**
 * MotionPathLayer — trajectory overlay that doubles as an EDITOR.
 *
 * Visuals (canvas): glowing path segments sampled through the offline engine
 * (honors per-keyframe easing incl. custom cubic), start/end markers.
 *
 * Editing (DOM, scale-aware): every keyframe position gets a draggable dot —
 * drag to retime the keyframe's x/y (trajectory-as-editor), double-click to
 * delete it. Every segment ≥120ms gets a midpoint "+" handle that inserts an
 * interpolated keyframe at the segment midpoint (both time & eased position).
 *
 * The playhead marker reads the live matrix per engine frame (direct DOM
 * write). Everything lives inside a scaled container so logical stage
 * coordinates map 1:1 regardless of the stage's responsive width.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useStudio, STAGE } from "@/store/studio";
import { buildEngineFromScene, easedFraction, type Kf } from "@/lib/scene";
import { Easing as EngineEasing } from "@/lib/keyframe";
import { engineHost } from "@/lib/engine-host";

const SAMPLES_PER_SEGMENT = 22;
/** segments shorter than this get no midpoint-insert handle */
const MID_HANDLE_MIN_MS = 120;
/** safety clamp for dragged offsets */
const DRAG_CLAMP = 2000;

interface DotInfo {
  t: number;
  x: number; // center coords in logical stage space
  y: number;
}

interface MidInfo {
  t: number;
  x: number;
  y: number;
  a: Kf;
  b: Kf;
}

/** active segment-bend drag (quadratic bezier shaping) */
interface BendState {
  elId: string;
  a: Kf;
  b: Kf;
  /** keyframe CENTER positions in logical stage coords */
  p0: [number, number];
  p1: [number, number];
  /** straight-segment midpoint (logical) */
  m: [number, number];
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

export function MotionPathLayer() {
  const scene = useStudio((s) => s.scene);
  const selection = useStudio((s) => s.selection);
  const engineVersion = useStudio((s) => s.engineVersion);
  const showPaths = useStudio((s) => s.showPaths);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const dragRef = useRef<{
    t: number;
    startClientX: number;
    startClientY: number;
    startDx: number;
    startDy: number;
  } | null>(null);
  const bendRef = useRef<BendState | null>(null);
  const lastBendMoved = useRef(false);
  /** live control polygon while bending (logical coords) */
  const [bendOverlay, setBendOverlay] = useState<{
    p0: [number, number];
    p1: [number, number];
    c: [number, number];
  } | null>(null);

  const el = useMemo(
    () => (selection ? scene.elements.find((e) => e.id === selection.elId) ?? null : null),
    [scene, selection]
  );

  // offline engine mirrors the live one, rebuilt only when the scene changes
  const engine = useMemo(
    () => buildEngineFromScene(scene),
    [engineVersion, scene]
  );

  // responsive scale — identical approach to StageCanvas
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      setScale(node.clientWidth / STAGE.w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const kfs = useMemo(() => (el ? [...el.keyframes].sort((a, b) => a.t - b.t) : []), [el]);

  // evaluate a logical center position at time t via the offline engine
  const posAt = useMemo(() => {
    if (!el) return null;
    return (t: number): [number, number] | null => {
      const inst = engine.getEvaluatedInstances(t);
      const item = inst.find((i) => i.id === el.id);
      if (!item || !item.visible) return null;
      const m = item.transformMatrix;
      return [m[12] + el.size / 2, m[13] + el.size / 2];
    };
  }, [el, engine]);

  // keyframe dots + midpoint handles (recomputed when scene/selection changes)
  const dots = useMemo<DotInfo[]>(() => {
    if (!el || !posAt) return [];
    return kfs
      .map((kf) => {
        const p = posAt(kf.t);
        return p ? { t: kf.t, x: p[0], y: p[1] } : null;
      })
      .filter((d): d is DotInfo => d !== null);
  }, [el, kfs, posAt]);

  const mids = useMemo<MidInfo[]>(() => {
    if (!el || !posAt) return [];
    const out: MidInfo[] = [];
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i];
      const b = kfs[i + 1];
      if (b.t - a.t < MID_HANDLE_MIN_MS) continue;
      const tMid = Math.round((a.t + b.t) / 2);
      const p = posAt(tMid);
      if (!p) continue;
      out.push({ t: tMid, x: p[0], y: p[1], a, b });
    }
    return out;
  }, [el, kfs, posAt]);

  // static path render (lines only — dots are DOM now)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, STAGE.w, STAGE.h);
    if (!showPaths || !el || kfs.length === 0 || el.hidden) {
      if (markerRef.current) markerRef.current.style.opacity = "0";
      return;
    }
    if (!posAt) return;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i];
      const b = kfs[i + 1];
      if (b.t - a.t < 8) continue;
      const pts: [number, number][] = [];
      for (let s = 0; s <= SAMPLES_PER_SEGMENT; s++) {
        const t = a.t + ((b.t - a.t) * s) / SAMPLES_PER_SEGMENT;
        const p = posAt(t);
        if (p) pts.push(p);
      }
      if (pts.length < 2) continue;

      for (const [width, alpha, blur] of [
        [5, 0.16, 10],
        [1.6, 0.75, 0],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
        ctx.strokeStyle = el.color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.shadowColor = el.color;
        ctx.shadowBlur = blur;
        if (blur === 0) ctx.setLineDash([]);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // start (hollow ring) & end (solid) markers
    const p0 = posAt(kfs[0].t);
    if (p0) {
      ctx.beginPath();
      ctx.arc(p0[0], p0[1], 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = el.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p0[0], p0[1], 2.2, 0, Math.PI * 2);
      ctx.fillStyle = el.color;
      ctx.fill();
    }
    const p1 = posAt(kfs[kfs.length - 1].t);
    if (p1 && kfs.length > 1) {
      ctx.beginPath();
      ctx.arc(p1[0], p1[1], 6.5, 0, Math.PI * 2);
      ctx.fillStyle = el.color;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }, [el, engine, showPaths, kfs, posAt]);

  // live playhead marker on the path (same-frame matrix read, direct DOM write)
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const marker = markerRef.current;
      if (!marker) return;
      if (!showPaths || !el || el.hidden || el.keyframes.length === 0) {
        marker.style.opacity = "0";
        return;
      }
      const live = engineHost.getLiveMatrix(el.id);
      if (!live) {
        marker.style.opacity = "0";
        return;
      }
      const m = live.m;
      marker.style.opacity = live.visible && live.opacity > 0.02 ? "1" : "0";
      marker.style.transform = `translate(${m[12] + el.size / 2}px, ${m[13] + el.size / 2}px)`;
    };
    update();
    return engineHost.onFrame(update);
  }, [el, showPaths, engineVersion]);

  // -------------------------------------------------------------------------
  // dot drag → retime keyframe x/y (trajectory-as-editor)
  // -------------------------------------------------------------------------
  const onDotPointerDown = (e: React.PointerEvent, t: number, kf: Kf) => {
    if (!el || el.locked) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer events (automation) — drag still works via move
    }
    useStudio.getState().select({ elId: el.id, kfT: t });
    useStudio.getState().pushHistory(`pathDot:${el.id}:${t}`, `轨迹拖拽关键帧 @ ${(t / 1000).toFixed(2)}s`);
    dragRef.current = {
      t,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startDx: kf.dx,
      startDy: kf.dy,
    };
  };

  const onDotPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !el) return;
    const dx = d.startDx + (e.clientX - d.startClientX) / scale;
    const dy = d.startDy + (e.clientY - d.startClientY) / scale;
    useStudio.getState().updateKeyframe(
      el.id,
      d.t,
      {
        dx: Math.max(-DRAG_CLAMP, Math.min(DRAG_CLAMP, Math.round(dx))),
        dy: Math.max(-DRAG_CLAMP, Math.min(DRAG_CLAMP, Math.round(dy))),
      },
      { history: false } // snapshot already taken at drag start
    );
  };

  const onDotPointerUp = () => {
    dragRef.current = null;
  };

  const onDotDoubleClick = (t: number) => {
    if (!el || el.locked) return;
    useStudio.getState().removeKeyframe(el.id, t);
  };

  // midpoint click → insert an interpolated keyframe (time + eased position)
  const insertMidKeyframe = (mid: MidInfo) => {
    if (!el) return;
    const lerp = (a: number, b: number) => Math.round(((a + b) / 2) * 100) / 100;
    const cx = mid.x - el.size / 2;
    const cy = mid.y - el.size / 2;
    const kf: Kf = {
      t: mid.t,
      dx: Math.round(cx - el.x),
      dy: Math.round(cy - el.y),
      scale: lerp(mid.a.scale, mid.b.scale),
      rot: lerp(mid.a.rot, mid.b.rot),
      opacity: lerp(mid.a.opacity, mid.b.opacity),
      easing: mid.a.easing,
      ...(mid.a.cubic && mid.a.easing === EngineEasing.CubicBezier ? { cubic: { ...mid.a.cubic } } : {}),
    };
    useStudio.getState().addKeyframe(el.id, kf);
  };

  // -----------------------------------------------------------------------
  // segment bend — drag the mid handle to shape a quadratic bezier arc;
  // the arc is baked live into ~55ms-spaced Linear keyframes
  // -----------------------------------------------------------------------
  const bakeBend = (bs: BendState, c: [number, number]) => {
    const elNow = useStudio.getState().scene.elements.find((e) => e.id === bs.elId);
    if (!elNow) return;
    const segMs = bs.b.t - bs.a.t;
    if (segMs <= 8) return;
    const n = Math.max(3, Math.min(28, Math.round(segMs / 55)));
    const baked: Kf[] = [];
    for (let i = 1; i <= n; i++) {
      const t = bs.a.t + (segMs * i) / (n + 1);
      const u = easedFraction(bs.a.easing, bs.a.cubic, (t - bs.a.t) / segMs);
      const omu = 1 - u;
      const bx = omu * omu * bs.p0[0] + 2 * omu * u * c[0] + u * u * bs.p1[0];
      const by = omu * omu * bs.p0[1] + 2 * omu * u * c[1] + u * u * bs.p1[1];
      baked.push({
        t: Math.round(t),
        dx: Math.max(-DRAG_CLAMP, Math.min(DRAG_CLAMP, Math.round(bx - elNow.size / 2 - elNow.x))),
        dy: Math.max(-DRAG_CLAMP, Math.min(DRAG_CLAMP, Math.round(by - elNow.size / 2 - elNow.y))),
        scale: Math.round((bs.a.scale + (bs.b.scale - bs.a.scale) * u) * 100) / 100,
        rot: Math.round((bs.a.rot + (bs.b.rot - bs.a.rot) * u) * 100) / 100,
        opacity: Math.round((bs.a.opacity + (bs.b.opacity - bs.a.opacity) * u) * 100) / 100,
        easing: EngineEasing.Linear,
      });
    }
    // start keyframe goes Linear (its easing governed the now-replaced segment)
    const { cubic: _drop, ...aRest } = bs.a;
    const aNew: Kf = { ...aRest, easing: EngineEasing.Linear };
    const rest = elNow.keyframes
      .filter((k) => k.t <= bs.a.t || k.t >= bs.b.t)
      .map((k) => (k.t === bs.a.t ? aNew : k));
    useStudio.getState().replaceElementKeyframes(bs.elId, [...rest, ...baked], { history: false });
  };

  const onMidPointerDown = (e: React.PointerEvent, mid: MidInfo) => {
    if (!el || el.locked || !posAt) return;
    e.stopPropagation();
    const p0 = posAt(mid.a.t);
    const p1 = posAt(mid.b.t);
    if (!p0 || !p1) return;
    lastBendMoved.current = false;
    bendRef.current = {
      elId: el.id,
      a: { ...mid.a },
      b: { ...mid.b },
      p0,
      p1,
      m: [mid.x, mid.y],
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };

    // window listeners: survive handle unmount when baking restructures the track
    const onMove = (ev: PointerEvent) => {
      const bs = bendRef.current;
      if (!bs) return;
      const d = Math.hypot(ev.clientX - bs.startClientX, ev.clientY - bs.startClientY);
      if (!bs.moved && d < 4) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      if (!bs.moved) {
        bs.moved = true;
        lastBendMoved.current = true;
        useStudio.getState().pushHistory(
          `bend:${bs.elId}:${bs.a.t}`,
          `轨迹整形 @ ${(bs.a.t / 1000).toFixed(2)}s`
        );
      }
      const lx = (ev.clientX - rect.left) / scale;
      const ly = (ev.clientY - rect.top) / scale;
      // C = 2·pointer − M  ⇒  the curve's apex (t=0.5) lands exactly at the pointer
      const c: [number, number] = [2 * lx - bs.m[0], 2 * ly - bs.m[1]];
      setBendOverlay({ p0: bs.p0, p1: bs.p1, c });
      bakeBend(bs, c);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      bendRef.current = null;
      setBendOverlay(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!selection || !el) return null;

  const visible = showPaths && !el.hidden && kfs.length > 0;

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0 z-[5]">
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: STAGE.w, height: STAGE.h, transform: `scale(${scale})` }}
      >
        <canvas
          ref={canvasRef}
          width={STAGE.w}
          height={STAGE.h}
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        />

        {visible && (
          <>
            {/* midpoint handles: click = insert keyframe · drag = bend the segment */}
            {mids.map((mid) => (
              <button
                key={`mid-${mid.t}`}
                className={`pointer-events-auto absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-dashed transition-all cursor-grab active:cursor-grabbing ${
                  hoverT === mid.t
                    ? "scale-125 border-amber-300 bg-amber-400/30 text-amber-200 shadow-[0_0_10px_rgba(251,191,36,0.6)]"
                    : "border-white/40 bg-black/40 text-white/50 hover:border-amber-300/80 hover:text-amber-200"
                }`}
                style={{ left: mid.x, top: mid.y }}
                title={`点击：在 ${(mid.t / 1000).toFixed(2)}s 插入关键帧\n拖拽：把轨迹弯曲为贝塞尔曲线`}
                aria-label={`轨迹中点 ${(mid.t / 1000).toFixed(2)}s：点击插入关键帧，拖拽弯曲轨迹`}
                onPointerDown={(e) => onMidPointerDown(e, mid)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (lastBendMoved.current) {
                    lastBendMoved.current = false;
                    return; // this click was the tail of a bend drag
                  }
                  insertMidKeyframe(mid);
                }}
                onMouseEnter={() => setHoverT(mid.t)}
                onMouseLeave={() => setHoverT(null)}
                data-testid={`mid-handle-${mid.t}`}
              >
                <Plus className="h-2.5 w-2.5" strokeWidth={3} />
              </button>
            ))}

            {/* draggable keyframe dots */}
            {kfs.map((kf) => {
              const dot = dots.find((d) => d.t === kf.t);
              if (!dot) return null;
              const selected = selection?.kfT === kf.t;
              return (
                <div
                  key={`dot-${kf.t}`}
                  role="button"
                  aria-label={`关键帧 ${(kf.t / 1000).toFixed(2)}s，位于 x ${Math.round(dot.x)} y ${Math.round(dot.y)}，可拖拽调整位置`}
                  tabIndex={el.locked ? -1 : 0}
                  className={`pointer-events-auto absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full transition-transform hover:scale-125 active:cursor-grabbing ${
                    selected ? "ring-2 ring-amber-300" : ""
                  } ${el.locked ? "cursor-not-allowed opacity-60" : ""}`}
                  style={{
                    left: dot.x,
                    top: dot.y,
                    background: el.color,
                    boxShadow: `0 0 0 1.5px rgba(255,255,255,0.92), 0 0 ${selected ? 14 : 8}px ${el.color}aa`,
                  }}
                  title={`关键帧 @ ${(kf.t / 1000).toFixed(2)}s\n拖拽移动位置 · 双击删除`}
                  onPointerDown={(e) => onDotPointerDown(e, kf.t, kf)}
                  onPointerMove={onDotPointerMove}
                  onPointerUp={onDotPointerUp}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onDotDoubleClick(kf.t);
                  }}
                  onMouseEnter={() => setHoverT(kf.t)}
                  onMouseLeave={() => setHoverT(null)}
                  data-testid={`path-dot-${kf.t}`}
                />
              );
            })}
          </>
        )}

        {/* bend control polygon (visible while dragging a mid handle) */}
        {bendOverlay && (
          <svg
            className="pointer-events-none absolute left-0 top-0 z-[6] overflow-visible"
            width={STAGE.w}
            height={STAGE.h}
            aria-hidden="true"
          >
            <line
              x1={bendOverlay.p0[0]} y1={bendOverlay.p0[1]}
              x2={bendOverlay.c[0]} y2={bendOverlay.c[1]}
              stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="4 4"
            />
            <line
              x1={bendOverlay.c[0]} y1={bendOverlay.c[1]}
              x2={bendOverlay.p1[0]} y2={bendOverlay.p1[1]}
              stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="4 4"
            />
            <rect
              x={bendOverlay.c[0] - 3.5} y={bendOverlay.c[1] - 3.5}
              width={7} height={7}
              fill="rgba(251,191,36,0.25)" stroke="#fbbf24" strokeWidth={1.4}
            />
            <text
              x={bendOverlay.c[0] + 9} y={bendOverlay.c[1] - 6}
              fill="rgba(251,191,36,0.9)" fontSize={9} fontFamily="ui-monospace, monospace"
            >
              弯曲中
            </text>
          </svg>
        )}

        {/* playhead position marker (transformed per frame) */}
        <div
          ref={markerRef}
          className="pointer-events-none absolute left-0 top-0 z-[7] opacity-0"
          style={{ willChange: "transform" }}
        >
          <div className="h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-white/90 bg-white/20 shadow-[0_0_8px_rgba(255,255,255,0.65)]" />
        </div>
      </div>
    </div>
  );
}
