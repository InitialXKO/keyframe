"use client";

/**
 * SpeedGraph — Graph-Editor style velocity visualization for the timeline.
 *
 * For every element, the instantaneous property speed inside a keyframe
 * segment is the derivative of its easing curve (d easedFraction / dτ)
 * divided by the segment length. Segments sample the same math the engine
 * uses (easedFraction → Newton-iterated cubic bezier), so what you see is
 * exactly what plays.
 *
 * Rendering: one Canvas2D layer (curves redrawn on scene/zoom/selection
 * changes) + DOM overlays for the playhead and hover crosshair (per-frame
 * direct writes, zero React churn). The graph lives inside the timeline
 * scroll content, so panning / zooming / vertical scrolling stay in
 * lockstep for free.
 *
 * Alignment: overlays use `calc(12px + (100% - 24px) * f)` so the position
 * is measured against the padded lane's CONTENT box — the exact coordinate
 * space the ruler ticks and keyframe diamonds live in.
 *
 * v9 interactivity: the graph is now an editor surface, not just a chart —
 *  · hover a curve → that element's polyline is emphasized and a tooltip
 *    shows the segment under the cursor (time range, easing, peak speed)
 *  · click a curve → the playhead jumps to the clicked instant and the
 *    segment's starting keyframe becomes selected (Inspector follows)
 *
 * v10: the graph becomes a full easing manipulation console — clicking a
 * segment opens an inline bezier editor (draggable P1/P2 + preset select)
 * that rewrites the segment's keyframe easing live. The speed curve, the
 * timeline heat strip and the Inspector curve all follow the same edit —
 * one source of truth, three synchronized views.
 *
 * v11: before/after ghost — while the easing editor is open, the segment's
 * ORIGINAL speed curve (captured at open time) is drawn as a dashed line
 * beneath the live curve, so every drag reads as a before/after diff.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { PencilRuler, X } from "lucide-react";
import { useStudio, kfKey } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import { segmentSpeeds, segsPeak, EASING_OPTIONS, type SegSpeed } from "@/lib/scene";
import { Easing as EasingName } from "@/lib/keyframe/builder/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EasingCurve } from "./EasingCurve";

export const SPEED_GRAPH_H = 88; // css px (exported so the timeline label row can match)

const PAD_Y = 10; // top/bottom padding inside the canvas

interface ElSegs {
  elId: string;
  name: string;
  color: string;
  segs: SegSpeed[];
}

export function SpeedGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const hoverLabelRef = useRef<HTMLSpanElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(600);

  // hover state — which element's curve is under the pointer (null = none)
  const [hoverElId, setHoverElId] = useState<string | null>(null);
  // tooltip content (segment the cursor is over) + pixel position
  const [tip, setTip] = useState<{ elId: string; x: number; title: string; sub: string } | null>(null);
  // v10: inline easing editor — the segment whose start keyframe is being edited
  const [editor, setEditor] = useState<{ elId: string; kfT: number; frac: number } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // v11: speed ghost — the edited segment's curve as captured when the editor
  // opened; drawn dashed under the live curve for a before/after comparison
  const [ghost, setGhost] = useState<{ elId: string; kfT: number; seg: SegSpeed } | null>(null);

  const closeEditor = () => {
    setEditor(null);
    setGhost(null);
  };

  const scene = useStudio((s) => s.scene);
  const engineVersion = useStudio((s) => s.engineVersion);
  const selection = useStudio((s) => s.selection);
  const durationMs = scene.durationMs;

  // measure the wrapper's content box so curves align 1:1 with the ruler
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setCanvasW(Math.max(120, wrap.clientWidth - 24)); // px-3 padding
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // speed data per element + global max (memoized per scene edit)
  const { perEl, max } = useMemo(() => {
    const perEl: ElSegs[] = scene.elements.map((el) => ({
      elId: el.id,
      name: el.name,
      color: el.color,
      segs: segmentSpeeds(el.keyframes, durationMs),
    }));
    let max = 0;
    for (const { segs } of perEl) {
      for (const seg of segs) {
        for (const v of seg.samples) {
          if (v > max) max = v;
        }
      }
    }
    if (max <= 0) max = 1;
    return { perEl, max };
  }, [scene, engineVersion, durationMs]);

  // redraw curves whenever the scene, selection, hover or canvas size changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvasW;
    const h = SPEED_GRAPH_H;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const innerH = h - PAD_Y * 2;
    const xOf = (t: number) => (t / durationMs) * w;

    // grid: quarter lines
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = PAD_Y + (innerH * i) / 4;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const drawEl = ({ elId, color, segs }: { elId: string; color: string; segs: SegSpeed[] }, level: "dim" | "hover" | "sel") => {
      ctx.lineWidth = level === "dim" ? 1 : 1.8;
      ctx.strokeStyle = color;
      ctx.globalAlpha = level === "dim" ? 0.22 : 1;
      ctx.shadowBlur = 0;

      ctx.beginPath();
      let started = false;
      let lastX = 0;
      for (const seg of segs) {
        const x0 = xOf(seg.t0);
        const x1 = xOf(seg.t1);
        const n = seg.samples.length - 1;
        for (let s = 0; s <= n; s++) {
          const x = x0 + ((x1 - x0) * s) / n;
          const y = PAD_Y + innerH - Math.min(1, seg.samples[s] / max) * innerH;
          if (!started || x < lastX) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
          lastX = x;
        }
      }
      if (level !== "dim") {
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // soft area fill under the emphasized curve
      if (level !== "dim" && segs.length > 0) {
        ctx.globalAlpha = level === "sel" ? 0.13 : 0.09;
        const grad = ctx.createLinearGradient(0, PAD_Y, 0, h);
        grad.addColorStop(0, color);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(xOf(segs[0].t0), h - PAD_Y);
        for (const seg of segs) {
          const x0 = xOf(seg.t0);
          const x1 = xOf(seg.t1);
          const n = seg.samples.length - 1;
          for (let s = 0; s <= n; s++) {
            const x = x0 + ((x1 - x0) * s) / n;
            const y = PAD_Y + innerH - Math.min(1, seg.samples[s] / max) * innerH;
            ctx.lineTo(x, y);
          }
        }
        ctx.lineTo(xOf(segs[segs.length - 1].t1), h - PAD_Y);
        ctx.closePath();
        ctx.fill();

        // keyframe boundary ticks along the bottom edge
        ctx.globalAlpha = 0.7;
        for (const seg of segs) {
          const x = xOf(seg.t0);
          ctx.beginPath();
          ctx.moveTo(x, h - PAD_Y - 4);
          ctx.lineTo(x, h - PAD_Y);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };

    for (const entry of perEl) {
      const isSel = selection?.elId === entry.elId;
      const isHover = hoverElId === entry.elId;
      if (isSel) drawEl(entry, "sel");
      else if (isHover) drawEl(entry, "hover");
      else drawEl(entry, "dim");
    }

    // v11: dashed ghost of the edited segment's ORIGINAL speed curve —
    // normalized by the live max so before/after stay on the same scale
    if (ghost) {
      const x0 = xOf(ghost.seg.t0);
      const x1 = xOf(ghost.seg.t1);
      const n = ghost.seg.samples.length - 1;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      for (let s = 0; s <= n; s++) {
        const x = x0 + ((x1 - x0) * s) / n;
        const y = PAD_Y + innerH - Math.min(1, ghost.seg.samples[s] / max) * innerH;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }, [perEl, max, durationMs, canvasW, selection, hoverElId, ghost]);

  // playhead mirror — synced per frame via direct DOM writes
  useEffect(() => {
    const dur = () => useStudio.getState().scene.durationMs;
    return engineHost.onFrame((t) => {
      if (playheadRef.current) {
        playheadRef.current.style.left = `calc(12px + (100% - 24px) * ${Math.min(1, t / dur())})`;
      }
    });
  }, []);

  // ---------------------------------------------------------------------------
  // hover probing: nearest curve at the pointer x (y-distance), then locate
  // the segment under the cursor for the tooltip / click-to-jump
  // ---------------------------------------------------------------------------
  const probe = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const contentX = clientX - rect.left - 12;
    const frac = Math.max(0, Math.min(1, contentX / Math.max(1, rect.width - 24)));
    const t = frac * durationMs;
    const innerH = SPEED_GRAPH_H - PAD_Y * 2;
    const yOf = (v: number) => PAD_Y + innerH - Math.min(1, v / max) * innerH;

    let best: { entry: ElSegs; dist: number } | null = null;
    for (const entry of perEl) {
      if (entry.segs.length === 0) continue;
      const seg = entry.segs.find((sg) => t >= sg.t0 && t <= sg.t1) ?? (t < entry.segs[0].t0 ? entry.segs[0] : entry.segs[entry.segs.length - 1]);
      // sample y at t (nearest sample in the segment)
      const n = seg.samples.length - 1;
      const idx = Math.max(0, Math.min(n, Math.round(((t - seg.t0) / Math.max(1, seg.t1 - seg.t0)) * n)));
      const d = Math.abs(yOf(seg.samples[idx]) - (clientY - rect.top));
      if (!best || d < best.dist) best = { entry, dist: d };
    }
    return { frac, t, best, rect };
  };

  const onHoverMove = (e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const contentX = e.clientX - rect.left - 12;
    const frac = Math.max(0, Math.min(1, contentX / Math.max(1, rect.width - 24)));
    if (crosshairRef.current) {
      crosshairRef.current.style.left = `calc(12px + (100% - 24px) * ${frac})`;
      crosshairRef.current.style.opacity = "1";
    }
    if (hoverLabelRef.current) hoverLabelRef.current.textContent = `${((frac * durationMs) / 1000).toFixed(2)}s`;

    const p = probe(e.clientX, e.clientY);
    const hit = p?.best && p.best.dist <= 18 ? p.best.entry : null;
    setHoverElId((prev) => (prev === (hit?.elId ?? null) ? prev : hit?.elId ?? null));

    if (hit && p) {
      const seg = hit.segs.find((sg) => p.t >= sg.t0 && p.t <= sg.t1) ?? hit.segs[hit.segs.length - 1];
      const peak = segsPeak([seg]);
      // resolve the segment's easing from the scene model
      const el = scene.elements.find((x) => x.id === hit.elId);
      const kf = el?.keyframes.find((k) => k.t === seg.t0);
      const elabel = kf ? (EASING_OPTIONS.find((o) => o.value === kf.easing)?.label ?? String(kf.easing)) : "—";
      const peakPct = Math.round((peak / max) * 100);
      setTip({
        elId: hit.elId,
        x: Math.min(Math.max(p.frac, 0), 1),
        title: `${hit.name} · ${((seg.t0 / 1000)).toFixed(2)}s → ${((seg.t1 / 1000)).toFixed(2)}s`,
        sub: `${elabel} · 峰值速度 ${peakPct}%${kf?.easing === "CubicBezier" && kf.cubic ? ` (${kf.cubic.p1x},${kf.cubic.p1y},${kf.cubic.p2x},${kf.cubic.p2y})` : ""}`,
      });
    } else {
      setTip((prev) => (prev ? null : prev));
    }
  };
  const onHoverLeave = () => {
    if (crosshairRef.current) crosshairRef.current.style.opacity = "0";
    if (hoverLabelRef.current) hoverLabelRef.current.textContent = "";
    setHoverElId((prev) => (prev === null ? prev : null));
    setTip((prev) => (prev ? null : prev));
  };

  // click-to-jump: seek to the clicked instant + select the segment's start
  // keyframe + open the inline easing editor for that segment (v10)
  const onClick = (e: React.MouseEvent) => {
    const p = probe(e.clientX, e.clientY);
    const hit = p?.best && p.best.dist <= 18 ? p.best.entry : null;
    if (!hit || !p) return;
    const st = useStudio.getState();
    const seg = hit.segs.find((sg) => p.t >= sg.t0 && p.t <= sg.t1) ?? hit.segs[hit.segs.length - 1];
    engineHost.seek(Math.max(0, Math.min(durationMs, p.t)));
    st.select({ elId: hit.elId, kfT: seg.t0 });
    st.setKfSelection([kfKey(hit.elId, seg.t0)]);
    setEditor({ elId: hit.elId, kfT: seg.t0, frac: Math.min(Math.max(p.frac, 0), 1) });
    // v11: capture the segment's CURRENT curve as the before/after ghost
    setGhost({ elId: hit.elId, kfT: seg.t0, seg });
  };

  // the keyframe currently being edited (looked up live so undo/deletion
  // simply unmounts the editor — JSX guards on editorKf)
  const editorEl = editor ? scene.elements.find((x) => x.id === editor.elId) : null;
  const editorKf = editorEl?.keyframes.find((k) => k.t === editor?.kfT);

  // close the editor on outside pointerdown / Escape
  useEffect(() => {
    if (!editor) return;
    const onDown = (e: PointerEvent) => {
      if (editorRef.current && !editorRef.current.contains(e.target as Node)) closeEditor();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditor();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [editor]);

  const selName = perEl.find(({ elId }) => elId === selection?.elId)?.name;

  return (
    <div
      ref={wrapRef}
      className="relative cursor-crosshair px-3"
      onPointerMove={onHoverMove}
      onPointerLeave={onHoverLeave}
      onClick={onClick}
      data-testid="speed-graph"
    >
      <canvas ref={canvasRef} className="block" data-testid="speed-graph-canvas" />
      {/* hover crosshair + time readout */}
      <div
        ref={crosshairRef}
        className="pointer-events-none absolute top-0 h-full w-px bg-zinc-500/40 opacity-0 transition-opacity"
        style={{ left: "0%" }}
      />
      <span
        ref={hoverLabelRef}
        className="pointer-events-none absolute right-2 top-1 rounded bg-zinc-950/80 px-1 font-mono text-[9px] text-zinc-400"
      />
      {/* segment tooltip — follows the crosshair, flips near the right edge */}
      {tip && (
        <div
          className="pointer-events-none absolute top-4 z-20 w-max max-w-[260px] rounded-md border border-zinc-700 bg-zinc-950/95 px-2 py-1 shadow-xl backdrop-blur"
          style={{
            left: `calc(12px + (100% - 24px) * ${tip.x})`,
            transform: tip.x > 0.72 ? "translateX(-105%)" : "translateX(8px)",
          }}
          data-testid="speed-graph-tip"
        >
          <div className="whitespace-nowrap font-mono text-[10px] text-zinc-100">{tip.title}</div>
          <div className="whitespace-nowrap text-[9px] text-zinc-500">{tip.sub}</div>
          <div className="mt-0.5 whitespace-nowrap text-[9px] text-amber-400/70">点击跳转并打开该段缓动编辑器</div>
        </div>
      )}
      {/* playhead mirror — synced per frame */}
      <div
        ref={playheadRef}
        className="pointer-events-none absolute top-0 z-10 h-full w-px bg-amber-400/80 shadow-[0_0_6px_rgba(251,191,36,0.7)]"
        style={{ left: "0%" }}
      />
      {selName && (
        <span className="pointer-events-none absolute left-2 top-1 font-mono text-[9px] text-zinc-600">
          <span className="text-amber-400/80">{selName}</span> 曲线加亮
        </span>
      )}
      {/* v10: inline easing editor — floats above the graph, anchored to the clicked segment */}
      {editor && editorKf && (
        <div
          ref={editorRef}
          className="absolute z-30 w-[286px] animate-kf-bar-in rounded-lg border border-amber-500/40 bg-zinc-950/97 p-2.5 shadow-2xl shadow-black/60 backdrop-blur"
          style={{
            left: `calc(12px + (100% - 24px) * ${editor.frac})`,
            bottom: SPEED_GRAPH_H + 10,
            transform: editor.frac > 0.68 ? "translateX(-100%)" : undefined,
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          data-testid="speed-graph-editor"
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            <PencilRuler className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span className="min-w-0 truncate text-[11px] font-semibold text-zinc-100">
              {editorEl?.name} · 段 {((editor.kfT) / 1000).toFixed(2)}s
            </span>
            <button
              onClick={() => closeEditor()}
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="关闭缓动编辑器"
              data-testid="speed-graph-editor-close"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <EasingCurve
            easing={editorKf.easing}
            cubic={editorKf.cubic}
            onChange={(cubic) => {
              useStudio.getState().updateKeyframe(editor.elId, editor.kfT, { easing: EasingName.CubicBezier, cubic }, { key: `sg-easing:${editor.elId}:${editor.kfT}` });
            }}
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="shrink-0 text-[9px] text-zinc-500">缓动预设</span>
            <Select
              value={editorKf.easing}
              onValueChange={(v) => {
                useStudio.getState().updateKeyframe(editor.elId, editor.kfT, { easing: v as EasingName, cubic: undefined }, { key: `sg-easing-preset:${editor.elId}:${editor.kfT}` });
              }}
            >
              <SelectTrigger className="h-6 flex-1 bg-zinc-950 text-[10px]" aria-label="段缓动预设" data-testid="speed-graph-editor-easing">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EASING_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-[11px]">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-1 flex items-center gap-3" data-testid="speed-graph-ghost-legend">
            <span className="flex items-center gap-1 text-[9px] text-zinc-500">
              <span className="inline-block w-4 border-t border-dashed border-zinc-300/70" /> 修改前速度
            </span>
            <span className="flex items-center gap-1 text-[9px] text-zinc-500">
              <span className="inline-block w-4" style={{ borderTop: `2px solid ${editorEl?.color ?? "#fbbf24"}` }} /> 当前速度
            </span>
          </div>
          <p className="mt-1 text-[9px] leading-relaxed text-zinc-500">
            拖拽圆点实时改写该段缓动 —— 速度曲线、时间轴热力条与 Inspector 曲线同步联动；<span className="text-amber-400/80">Esc 或点击空白关闭</span>
          </p>
        </div>
      )}
    </div>
  );
}
