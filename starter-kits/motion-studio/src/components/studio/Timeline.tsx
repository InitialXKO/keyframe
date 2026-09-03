"use client";

/**
 * Timeline — scene ruler + per-element keyframe tracks.
 * The playhead is updated via direct DOM writes on every engine frame
 * (subscribes to engineHost.onFrame), scrubbing delegates to engineHost.seek.
 *
 * Zoom system: zoom=1 fits the container; >1 expands the lane horizontally
 * (shared vertical scroll with a sticky track-name column). Ruler tick
 * density adapts to pixels-per-millisecond so labels never collide.
 *
 * v4: multi-keyframe selection — marquee box on empty lane space,
 * Ctrl+click toggle, Shift+click track range, group drag retime with
 * collision guards, and a floating batch-action bar (delete / easing /
 * align-to-playhead / copy / cut).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Blend,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  GripVertical,
  Lock,
  Maximize2,
  Scissors,
  Trash2,
  Unlock,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { useStudio, kfKey } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import { DEFAULT_EASING } from "@/store/studio";
import { EASING_OPTIONS, segmentSpeeds, segsPeak, type Kf, type SegSpeed } from "@/lib/scene";
import { Easing as EasingName } from "@/lib/keyframe/builder/types";
import { cn } from "@/lib/utils";
import { SpeedGraph, SPEED_GRAPH_H } from "./SpeedGraph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 0..1 → two-digit alpha hex (for color+alpha gradients) */
function alphaHex(a: number): string {
  return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
}

/** per-segment velocity gradient — dim where motion is slow, hot where it's fast */
function heatGradient(color: string, seg: SegSpeed, gmax: number): string {
  const n = seg.samples.length - 1;
  const stops = seg.samples.map((v, i) => {
    const a = 0.1 + 0.78 * Math.min(1, v / gmax);
    return `${color}${alphaHex(a)} ${((i / n) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

interface HeatTrack {
  elId: string;
  t0: number;
  t1: number;
  /** global normalization peak (shared by every track) */
  gmax: number;
  segs: Array<{ seg: SegSpeed; grad: string }>;
}

const TICK_CANDIDATES = [50, 100, 200, 250, 500, 1000, 2000, 5000];

interface MarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function Timeline() {
  const playheadRef = useRef<HTMLDivElement>(null);
  const playheadLabelRef = useRef<HTMLSpanElement>(null);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null); // content-box time mapping (excludes lane padding)
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ elId: string; t: number } | null>(null);
  const lastReactUpdate = useRef(0);

  // speed graph visibility (store-backed; hydrated once from localStorage)
  const showGraph = useStudio((s) => s.speedGraph);
  const toggleGraph = useStudio((s) => s.toggleSpeedGraph);
  useEffect(() => {
    try {
      if (localStorage.getItem("keyforge.speedgraph") === "0") {
        useStudio.setState({ speedGraph: false });
      }
    } catch {
      /* ignore */
    }
  }, []);

  const scene = useStudio((s) => s.scene);
  const selection = useStudio((s) => s.selection);
  const kfSelection = useStudio((s) => s.kfSelection);
  const select = useStudio((s) => s.select);
  const addKeyframe = useStudio((s) => s.addKeyframe);
  const setTime = useStudio((s) => s.setTime);
  const engineVersion = useStudio((s) => s.engineVersion);

  // v9: per-track velocity heat — recomputed only on scene edits (memoized
  // gradient strings so plain re-renders (selection etc.) never re-sample)
  const heatMap = useMemo(() => {
    const list = scene.elements.map((el) => {
      const segs = segmentSpeeds(el.keyframes, scene.durationMs);
      return { elId: el.id, t0: segs[0]?.t0 ?? 0, t1: segs[segs.length - 1]?.t1 ?? 0, segs, peak: segsPeak(segs) };
    });
    const gmax = list.reduce((m, x) => Math.max(m, x.peak), 0);
    const g = gmax > 0 ? gmax : 1;
    const map = new Map<string, HeatTrack>();
    for (const el of scene.elements) {
      const entry = list.find((x) => x.elId === el.id);
      if (!entry) continue;
      map.set(el.id, {
        elId: el.id,
        t0: entry.t0,
        t1: entry.t1,
        gmax: g,
        segs: entry.segs.map((seg) => ({ seg, grad: heatGradient(el.color, seg, g) })),
      });
    }
    return map;
  }, [scene, engineVersion]);

  // v10: per-lane heat tooltip elements — written via direct DOM (zero React
  // churn on hover) so segment readouts never disturb the timeline render
  const heatTipRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // v11: magnetic snap guide — a dashed vertical line shown at the alignment
  // target (other tracks' keyframes / playhead / ruler ticks) while dragging
  // keyframes. Direct DOM writes only, so dragging stays allocation-free.
  const snapGuideRef = useRef<HTMLDivElement>(null);
  const snapLabelRef = useRef<HTMLSpanElement>(null);
  // adaptive ruler tick interval (computed per render) mirrored for the
  // drag closure — tick marks double as snap candidates
  const tickStepRef = useRef(200);

  // zoom: 1 = fit container, up to 8x
  const [zoom, setZoom] = useState(1);
  const [lanePx, setLanePx] = useState(900); // measured lane width in px (post-zoom)
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);

  // track drag-sort (HTML5 dnd on the name column; changes z-order)
  const dragElRef = useRef<string | null>(null);
  const dragOverRef = useRef<{ idx: number; before: boolean } | null>(null);
  const [dragOver, setDragOver] = useState<{ idx: number; before: boolean } | null>(null);
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const setDragOverBoth = (v: { idx: number; before: boolean } | null) => {
    dragOverRef.current = v;
    setDragOver(v);
  };

  // measure the lane pixel width (scroll content) for tick density
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setLanePx(Math.max(120, (el.clientWidth - 12) * zoom));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoom]);

  // per-frame playhead via direct DOM; React mirror ~10Hz
  // positioning: calc() against the padded lane's CONTENT box so the
  // playhead lines up exactly with ruler ticks & keyframe diamonds
  useEffect(() => {
    return engineHost.onFrame((t) => {
      const dur = useStudio.getState().scene.durationMs;
      const frac = Math.min(1, Math.max(0, t / dur));
      if (playheadRef.current) playheadRef.current.style.left = `calc(12px + (100% - 24px) * ${frac})`;
      const label = fmt(t);
      if (timeLabelRef.current) timeLabelRef.current.textContent = label;
      if (playheadLabelRef.current) playheadLabelRef.current.textContent = label;
      const now = performance.now();
      if (now - lastReactUpdate.current > 100) {
        lastReactUpdate.current = now;
        setTime(t);
      }
    });
  }, [setTime, engineVersion]);

  const seekFromEvent = (clientX: number) => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect(); // content box — no lane padding skew
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    engineHost.seek(ratio * scene.durationMs);
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    seekFromEvent(e.clientX);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic events / invalid pointer id — scrubbing still works via window listeners
    }
    const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const duration = scene.durationMs;

  // adaptive tick density: major ticks ≥64px apart, minor ticks at 1/4
  const pxPerMs = lanePx / Math.max(1, duration);
  const step = TICK_CANDIDATES.find((s) => s * pxPerMs >= 64) ?? 5000;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  const minorStep = step / 4;
  const minorTicks: number[] = [];
  if (minorStep * pxPerMs >= 10) {
    for (let t = minorStep; t <= duration; t += minorStep) {
      if (t % step !== 0) minorTicks.push(t);
    }
  }

  const zoomBy = (f: number) => setZoom((z) => Math.round(Math.max(1, Math.min(8, z * f)) * 100) / 100);

  // mirror the adaptive tick interval for the keyframe-drag snap closure
  // (declared here because `step` is computed above)
  useEffect(() => {
    tickStepRef.current = step;
  }, [step]);

  const addKfAt = (elId: string, t: number) => {
    // capture from the live canvas state when possible, otherwise defaults
    const captured = engineHost.captureKeyframe(elId, t);
    const kf: Kf =
      captured
        ? { ...captured, easing: DEFAULT_EASING }
        : { t: Math.round(t), dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: DEFAULT_EASING };
    addKeyframe(elId, kf);
  };

  // -------------------------------------------------------------------------
  // marquee multi-select (drag on empty lane space)
  // -------------------------------------------------------------------------
  const onLanePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const content = contentRef.current;
    if (!content) return;
    const contentRect = content.getBoundingClientRect();
    const start = { x: e.clientX - contentRect.left, y: e.clientY - contentRect.top };
    const last = { x: e.clientX, y: e.clientY };
    const addMode = e.shiftKey; // shift = add to current selection
    const baseSet = addMode ? new Set(useStudio.getState().kfSelection) : null;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const cx = ev.clientX - contentRect.left;
      const cy = ev.clientY - contentRect.top;
      if (!moved && Math.abs(cx - start.x) + Math.abs(cy - start.y) < 4) return;
      moved = true;
      last.x = ev.clientX;
      last.y = ev.clientY;
      setMarquee({
        x: Math.min(start.x, cx),
        y: Math.min(start.y, cy),
        w: Math.abs(cx - start.x),
        h: Math.abs(cy - start.y),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
      if (!moved) {
        // plain click on empty lane — collapse multi-selection
        if (!addMode) useStudio.getState().clearKfSelection();
        return;
      }
      // hit-test: every keyframe diamond whose center falls inside the marquee
      const x1 = contentRect.left + start.x;
      const y1 = contentRect.top + start.y;
      const mRect = {
        left: Math.min(x1, last.x),
        right: Math.max(x1, last.x),
        top: Math.min(y1, last.y),
        bottom: Math.max(y1, last.y),
      };
      const hits: string[] = [];
      content.querySelectorAll<HTMLButtonElement>("[data-kfkey]").forEach((btn) => {
        const r = btn.getBoundingClientRect();
        // rect-intersect test (forgiving, standard marquee semantics) — a
        // center-in-box test misses by subpixels on rotated diamonds
        const intersects =
          r.left + r.width / 2 >= mRect.left &&
          r.left + r.width / 2 <= mRect.right + 2 &&
          r.top + r.height / 2 >= mRect.top - 2 &&
          r.top + r.height / 2 <= mRect.bottom + 2;
        if (intersects) {
          hits.push(btn.dataset.kfkey!);
        }
      });
      const merged = baseSet ? Array.from(new Set([...baseSet, ...hits])) : hits;
      useStudio.getState().setKfSelection(merged);
      if (merged.length > 1) {
        toast.info(`已框选 ${merged.length} 个关键帧`, { description: "可批量删除 / 改缓动 / 对齐到播放头" });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // -------------------------------------------------------------------------
  // touch pinch-zoom (mobile): two fingers on the timeline scale the zoom,
  // anchored at the pinch midpoint so the time under the fingers stays put
  // -------------------------------------------------------------------------
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let pinch: { d0: number; zoom0: number; scroll0: number; mid0: number; rect: DOMRect } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midX = (t: TouchList) => (t[0].clientX + t[1].clientX) / 2;
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinch = {
          d0: dist(e.touches),
          zoom0: zoomRef.current,
          scroll0: el.scrollLeft,
          mid0: midX(e.touches),
          rect: el.getBoundingClientRect(),
        };
      }
    };
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault(); // take over from browser page-zoom
      const ratio = dist(e.touches) / Math.max(1, pinch.d0);
      const z = Math.round(Math.max(1, Math.min(8, pinch.zoom0 * ratio)) * 100) / 100;
      if (z === zoomRef.current) return;
      // anchor: keep the time under the pinch midpoint visually stable
      const cw0 = el.clientWidth * pinch.zoom0;
      const frac = (pinch.scroll0 + (pinch.mid0 - pinch.rect.left)) / Math.max(1, cw0);
      const cw1 = el.clientWidth * z;
      const nextScroll = frac * cw1 - (midX(e.touches) - pinch.rect.left);
      zoomRef.current = z;
      setZoom(z);
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, nextScroll);
      });
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [setZoom]);

  // -------------------------------------------------------------------------
  // keyframe pointer interactions: single drag, group drag, modifier select
  // -------------------------------------------------------------------------
  const onKfPointerDown = (e: React.PointerEvent, elId: string, kfT: number) => {
    e.stopPropagation();
    e.preventDefault();
    const st = useStudio.getState();
    const key = kfKey(elId, kfT);
    const mod = e.ctrlKey || e.metaKey || e.shiftKey;
    if (mod) return; // modifiers handled by click (no drag)

    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect(); // content box — no lane padding skew
    const groupMode = st.kfSelection.includes(key) && st.kfSelection.length > 1;
    select(groupMode ? { elId, kfT } : { elId, kfT }, { keepKfSelection: groupMode });

    // current time of every participating keyframe (updated as we drag)
    const cur = new Map<string, number>();
    if (groupMode) {
      for (const k of st.kfSelection) {
        const p = parseKey(k);
        cur.set(k, p.t);
      }
    } else {
      cur.set(key, kfT);
    }
    const pressedCur = kfT;

    st.pushHistory(groupMode ? "kfgroupdrag" : "kfdrag", groupMode ? `批量移动 ${st.kfSelection.length} 个关键帧` : "拖拽关键帧改时间");

    // v11: magnetic snap candidates — every keyframe on NON-moving tracks
    // (cross-track alignment is the whole point), the playhead, and the
    // ruler ticks. Positions occupied by a moved track's own keyframes are
    // excluded: the collision guard would silently drop the move.
    const dur0 = st.scene.durationMs;
    const elsMoving = new Set(Array.from(cur.keys()).map((k) => parseKey(k).elId));
    const snapCands: number[] = [];
    const candSeen = new Set<number>();
    const pushCand = (t: number) => {
      const r = Math.round(t);
      if (!candSeen.has(r)) {
        candSeen.add(r);
        snapCands.push(r);
      }
    };
    for (const el of st.scene.elements) {
      if (elsMoving.has(el.id)) continue;
      for (const kf of el.keyframes) pushCand(kf.t);
    }
    pushCand(useStudio.getState().timeMs);
    for (let t = 0; t <= dur0; t += tickStepRef.current) pushCand(t);
    const snapTolMs = (8 / Math.max(1, rect.width)) * dur0; // 8px tolerance, in ms

    const move = (ev: PointerEvent) => {
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      let rawT = Math.round((ratio * useStudio.getState().scene.durationMs) / 10) * 10; // snap 10ms

      // magnetic snap: nearest candidate within tolerance overrides raw time
      let snappedT = -1;
      let bestD = snapTolMs;
      for (const c of snapCands) {
        const d = Math.abs(c - rawT);
        if (d < bestD) {
          bestD = d;
          snappedT = c;
        }
      }
      if (snappedT >= 0) rawT = snappedT;

      // guide line via direct DOM (position space matches the playhead)
      const guide = snapGuideRef.current;
      if (guide) {
        if (snappedT >= 0) {
          guide.style.display = "block";
          guide.style.left = `calc(12px + (100% - 24px) * ${snappedT / dur0})`;
          if (snapLabelRef.current) snapLabelRef.current.textContent = fmt(snappedT);
        } else {
          guide.style.display = "none";
        }
      }

      const dt = rawT - pressedCur;
      if (dt === 0) return;

      const sceneNow = useStudio.getState().scene;
      const dur = sceneNow.durationMs;
      // collision guard per element: target occupied by a non-moving keyframe?
      const movingByEl = new Map<string, Set<number>>();
      for (const k of cur.keys()) {
        const p = parseKey(k);
        if (!movingByEl.has(p.elId)) movingByEl.set(p.elId, new Set());
        movingByEl.get(p.elId)!.add(cur.get(k)!);
      }
      const applied: Array<{ k: string; from: number; to: number }> = [];
      for (const [k, from] of cur) {
        const p = parseKey(k);
        const to = Math.max(0, Math.min(dur, from + dt));
        if (to === from) continue;
        const el = sceneNow.elements.find((x) => x.id === p.elId);
        if (!el) continue;
        const movingTs = movingByEl.get(p.elId)!;
        const blocked = el.keyframes.some((kk) => kk.t === to && !movingTs.has(kk.t));
        if (blocked) continue;
        applied.push({ k, from, to });
      }
      for (const a of applied) {
        const p = parseKey(a.k);
        st.updateKeyframe(p.elId, a.from, { t: a.to }, { history: false });
        cur.set(a.k, a.to);
      }
      // keys embed the keyframe time — rebuild them so the batch bar stays live
      if (groupMode) {
        st.setKfSelection(Array.from(cur.entries()).map(([k, t]) => kfKey(parseKey(k).elId, t)));
      }
      if (cur.has(key)) {
        select({ elId, kfT: cur.get(key)! }, { keepKfSelection: true });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (snapGuideRef.current) snapGuideRef.current.style.display = "none";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKfClick = (e: React.MouseEvent, elId: string, kfT: number) => {
    e.stopPropagation();
    const st = useStudio.getState();
    const key = kfKey(elId, kfT);
    if (e.ctrlKey || e.metaKey) {
      st.toggleKfSelection(key);
      st.select({ elId, kfT }, { keepKfSelection: true });
      anchorRef.current = { elId, t: kfT };
      return;
    }
    if (e.shiftKey) {
      const anchor = anchorRef.current;
      if (anchor && anchor.elId === elId) {
        const el = st.scene.elements.find((x) => x.id === elId);
        if (el) {
          const ts = el.keyframes.map((k) => k.t).filter((t) => t >= Math.min(anchor.t, kfT) && t <= Math.max(anchor.t, kfT));
          const merged = Array.from(new Set([...st.kfSelection, ...ts.map((t) => kfKey(elId, t))]));
          st.setKfSelection(merged);
          st.select({ elId, kfT }, { keepKfSelection: true });
          return;
        }
      }
      st.setKfSelection([key]);
      st.select({ elId, kfT }, { keepKfSelection: true });
      anchorRef.current = { elId, t: kfT };
      return;
    }
    anchorRef.current = { elId, t: kfT };
    select({ elId, kfT: kfT });
  };

  // -------------------------------------------------------------------------
  // batch bar actions
  // -------------------------------------------------------------------------
  const bulkDelete = () => {
    const n = kfSelection.length;
    useStudio.getState().removeKeyframesBulk(kfSelection);
    toast.success(`已删除 ${n} 个关键帧`, { description: "Ctrl+Z 可撤销" });
  };

  const bulkEasing = (easing: EasingName) => {
    useStudio.getState().patchKeyframesBulk(kfSelection, { easing });
    toast.success("已批量应用缓动", { description: `${kfSelection.length} 个关键帧 → ${easing}` });
  };

  const bulkAlign = () => {
    useStudio.getState().alignKeyframesToPlayhead(kfSelection);
    toast.success("已对齐到播放头", { description: "每组以最早的关键帧为基准" });
  };

  const bulkCopy = () => {
    const n = useStudio.getState().copySelectedKfs();
    if (n > 0) toast.success(`已复制 ${n} 个关键帧`, { description: "Ctrl+V 粘贴到播放头位置" });
  };

  const bulkCut = () => {
    const n = useStudio.getState().cutSelectedKfs();
    if (n > 0) toast.success(`已剪切 ${n} 个关键帧`, { description: "Ctrl+V 粘贴到播放头位置" });
  };

  return (
    <div className="relative rounded-lg border border-zinc-800 bg-zinc-900/60">
      {/* floating batch-action bar (visible when keyframes are multi-selected) */}
      {kfSelection.length > 1 && (
        <div
          className="absolute left-1/2 top-1 z-30 flex -translate-x-1/2 animate-kf-bar-in items-center gap-1 whitespace-nowrap rounded-lg border border-amber-500/40 bg-zinc-950/90 px-2 py-1 shadow-xl shadow-black/50 backdrop-blur"
          data-testid="kf-batch-bar"
        >
          <span className="shrink-0 rounded bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] font-bold text-black">
            {kfSelection.length}
          </span>
          <span className="mr-1 shrink-0 text-[10px] text-zinc-400">已选关键帧</span>
          <button
            onClick={bulkDelete}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-zinc-300 hover:bg-red-500/15 hover:text-red-400"
            title="批量删除（Delete）"
            data-testid="batch-delete"
          >
            <Trash2 className="h-3 w-3" /> 删除
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-zinc-300 hover:bg-amber-500/15 hover:text-amber-300"
                title="批量设置缓动"
              >
                <Blend className="h-3 w-3" /> 缓动
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              {EASING_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.value} onClick={() => bulkEasing(o.value)}>
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            onClick={bulkAlign}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-zinc-300 hover:bg-amber-500/15 hover:text-amber-300"
            title="组内最早关键帧对齐到播放头（保持相对间距）"
          >
            <Crosshair className="h-3 w-3" /> 对齐播放头
          </button>
          <button
            onClick={bulkCopy}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-zinc-300 hover:bg-amber-500/15 hover:text-amber-300"
            title="复制（Ctrl+C）"
          >
            <Copy className="h-3 w-3" /> 复制
          </button>
          <button
            onClick={bulkCut}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-zinc-300 hover:bg-amber-500/15 hover:text-amber-300"
            title="剪切（Ctrl+X）"
          >
            <Scissors className="h-3 w-3" /> 剪切
          </button>
          <button
            onClick={() => useStudio.getState().clearKfSelection()}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="取消多选（Esc）"
            aria-label="取消多选"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-medium text-zinc-400">时间轴 · Timeline</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-mono text-xs">
            <span ref={timeLabelRef} className="text-amber-400">0.00s</span>
            <span className="text-zinc-600">/ {fmt(duration)}</span>
          </div>
          {/* zoom controls */}
          <div
            className="flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950 p-0.5"
            role="group"
            aria-label="时间轴缩放"
            data-testid="timeline-zoom"
          >
            <button
              onClick={() => zoomBy(1 / 1.25)}
              disabled={zoom <= 1.01}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-amber-300 disabled:opacity-30"
              title="缩小（适应窗口）"
              aria-label="缩小时间轴"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <span
              className="min-w-[42px] text-center font-mono text-[10px] text-zinc-400"
              data-testid="zoom-level"
              title="缩放级别（100% = 适应窗口）"
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => zoomBy(1.25)}
              disabled={zoom >= 7.99}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-amber-300 disabled:opacity-30"
              title="放大时间轴"
              aria-label="放大时间轴"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
            <button
              onClick={() => setZoom(1)}
              disabled={zoom <= 1.01}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-amber-300 disabled:opacity-30"
              title="适应窗口"
              aria-label="适应窗口"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
            <span className="mx-0.5 h-4 w-px bg-zinc-800" />
            <button
              onClick={toggleGraph}
              aria-pressed={showGraph}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded transition-colors",
                showGraph
                  ? "bg-amber-500/15 text-amber-300 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.3)]"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-amber-300"
              )}
              title="速度图（缓动速度曲线可视化）"
              aria-label="速度图开关"
              data-testid="speedgraph-toggle"
            >
              <Activity className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      <div
        className={cn("overflow-y-auto", showGraph ? "max-h-[380px]" : "max-h-56")}
        data-testid="timeline-scroll"
      >
        <div className="flex">
          {/* ---- left: sticky track-name column ---- */}
          <div className="w-32 shrink-0 border-r border-zinc-800/80">
            <div className="flex h-7 items-center border-b border-zinc-800 bg-zinc-950/40 px-2 font-mono text-[9px] uppercase tracking-wider text-zinc-600">
              轨道
            </div>
            {scene.elements.map((el, idx) => {
              const isSel = selection?.elId === el.id;
              const isDragSrc = dragSrcId === el.id;
              const indicatorTop = dragOver?.idx === idx && dragOver.before;
              const indicatorBottom = dragOver?.idx === idx && !dragOver.before;
              return (
                <div
                  key={el.id}
                  draggable
                  onDragStart={(e) => {
                    dragElRef.current = el.id;
                    setDragSrcId(el.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", el.id);
                  }}
                  onDragEnd={() => {
                    dragElRef.current = null;
                    setDragSrcId(null);
                    setDragOverBoth(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragElRef.current || dragElRef.current === el.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDragOverBoth({ idx, before: e.clientY < rect.top + rect.height / 2 });
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget === e.target) setDragOverBoth(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const src = dragElRef.current;
                    const dropAt = dragOverRef.current;
                    dragElRef.current = null;
                    setDragOverBoth(null);
                    if (!src || src === el.id) return;
                    const from = scene.elements.findIndex((x) => x.id === src);
                    // removal shifts the target index when dragging downwards
                    let target = dropAt?.before ? idx : idx + 1;
                    if (from < target) target -= 1;
                    useStudio.getState().reorderElement(src, Math.max(0, target));
                  }}
                  className={cn(
                    "group/name relative flex h-8 items-center border-b border-zinc-800/60",
                    isSel ? "bg-amber-400/[0.06]" : "bg-zinc-900",
                    el.hidden && "opacity-50",
                    isDragSrc && "opacity-40"
                  )}
                >
                  {/* drop indicator */}
                  {(indicatorTop || indicatorBottom) && (
                    <div
                      className={`absolute inset-x-0 z-10 h-0.5 bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)] ${
                        indicatorTop ? "top-0" : "bottom-0"
                      }`}
                    />
                  )}
                  <span
                    className="flex h-4 w-3 shrink-0 cursor-grab items-center justify-center text-zinc-600 opacity-0 transition-opacity group-hover/name:opacity-100 active:cursor-grabbing"
                    title="拖拽排序（改变叠加层级）"
                    aria-hidden="true"
                  >
                    <GripVertical className="h-3 w-3" />
                  </span>
                  <button
                    onClick={() => {
                      if (el.locked) {
                        toast.info(`「${el.name}」已锁定`, { description: "点击轨道右侧锁图标解锁" });
                        return;
                      }
                      select({ elId: el.id, kfT: null });
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-xs",
                      isSel ? "text-amber-300" : "text-zinc-300 hover:text-amber-200"
                    )}
                    data-testid={`track-name-${el.id}`}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-sm"
                      style={{ background: el.color, boxShadow: isSel ? `0 0 6px ${el.color}` : undefined }}
                    />
                    <span className="truncate">{el.name}</span>
                  </button>
                  {/* visibility + lock toggles (appear on hover, persist when active) */}
                  <div className="flex shrink-0 items-center pr-1">
                    <button
                      onClick={() => useStudio.getState().toggleHidden(el.id)}
                      className={cn(
                        "flex h-5 w-5 items-center justify-center rounded hover:bg-zinc-800",
                        el.hidden ? "text-zinc-500" : "text-zinc-500 opacity-0 group-hover/name:opacity-100 hover:text-zinc-200"
                      )}
                      title={el.hidden ? "显示元素" : "隐藏元素（不影响动画）"}
                      aria-label={`${el.hidden ? "显示" : "隐藏"}元素 ${el.name}`}
                      data-testid={`eye-${el.id}`}
                    >
                      {el.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </button>
                    <button
                      onClick={() => useStudio.getState().toggleLocked(el.id)}
                      className={cn(
                        "flex h-5 w-5 items-center justify-center rounded hover:bg-zinc-800",
                        el.locked ? "text-amber-400" : "text-zinc-500 opacity-0 group-hover/name:opacity-100 hover:text-zinc-200"
                      )}
                      title={el.locked ? "解锁元素" : "锁定元素（防误拖）"}
                      aria-label={`${el.locked ? "解锁" : "锁定"}元素 ${el.name}`}
                      data-testid={`lock-${el.id}`}
                    >
                      {el.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                    </button>
                  </div>
                </div>
              );
            })}
            {scene.elements.length === 0 && (
              <div className="flex h-8 items-center border-b border-zinc-800/60 bg-zinc-900 px-2 text-[10px] text-zinc-600">
                空场景
              </div>
            )}
            {/* speed-graph label row — mirrors the graph row in the scroll content */}
            {showGraph && (
              <div
                className="flex flex-col justify-center gap-0.5 border-t border-zinc-800/60 bg-zinc-950/40 px-2"
                style={{ height: SPEED_GRAPH_H + 1 }}
              >
                <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">速度图</span>
                <span className="text-[9px] leading-tight text-zinc-600">
                  缓动速度曲线
                  <br />
                  选中轨道加亮
                </span>
              </div>
            )}
          </div>

          {/* ---- right: zoomable scroll area ---- */}
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
            <div
              ref={contentRef}
              className="relative"
              style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
            >
              <div className="relative px-3">
                {/* ruler */}
                <div
                  ref={rulerRef}
                  className="relative h-7 cursor-ew-resize border-b border-zinc-800"
                  onPointerDown={onRulerPointerDown}
                  data-testid="timeline-ruler"
                >
                  {/* minor ticks */}
                  {minorTicks.map((t) => (
                    <div
                      key={`m${t}`}
                      className="absolute bottom-0 h-1 w-px bg-zinc-700/50"
                      style={{ left: `${(t / duration) * 100}%` }}
                    />
                  ))}
                  {/* major ticks */}
                  {ticks.map((t) => (
                    <div key={t} className="absolute top-0 h-full" style={{ left: `${(t / duration) * 100}%` }}>
                      <div className="h-2 w-px bg-zinc-600" />
                      <span className="ml-1 font-mono text-[9px] text-zinc-500">{fmt(t)}</span>
                    </div>
                  ))}
                </div>

                {/* tracks */}
                {scene.elements.map((el) => {
                  const isSel = selection?.elId === el.id;
                  return (
                    <div
                      key={el.id}
                      className={cn(
                        "group/track relative flex h-8 items-center border-b border-zinc-800/60 transition-colors",
                        isSel ? "bg-amber-400/[0.06]" : "hover:bg-zinc-800/30"
                      )}
                    >
                      <div
                        className="relative h-full flex-1 cursor-copy touch-none"
                        onDoubleClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                          addKfAt(el.id, ratio * duration);
                        }}
                        onPointerDown={onLanePointerDown}
                        data-testid={`track-lane-${el.id}`}
                      >
                        {/* clip span — tinted with the element color */}
                        <div
                          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                          style={{
                            background: `linear-gradient(90deg, ${el.color}66, ${el.color}20)`,
                            boxShadow: isSel ? `0 0 8px ${el.color}30` : undefined,
                          }}
                        />
                        {/* v9 speed heat-strip — velocity rendered as a CSS gradient
                            (same easedFraction math as the engine; dim = slow, hot = fast)
                            v10: pointer-transparent readout — hovering the span shows the
                            segment under the cursor (time range / easing / peak+avg speed) */}
                        {(() => {
                          const heat = heatMap.get(el.id);
                          if (!heat || heat.segs.length === 0) return null;
                          const span = Math.max(1, heat.t1 - heat.t0);
                          const showTip = (e: React.PointerEvent<HTMLDivElement>) => {
                            const tipEl = heatTipRefs.current.get(el.id);
                            if (!tipEl) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                            const t = heat.t0 + frac * span;
                            const entry = heat.segs.find((s) => t >= s.seg.t0 && t <= s.seg.t1) ?? heat.segs[heat.segs.length - 1];
                            const seg = entry.seg;
                            const peak = segsPeak([seg]);
                            const avg = seg.samples.reduce((a, v) => a + v, 0) / Math.max(1, seg.samples.length);
                            const kf = el.keyframes.find((k) => k.t === seg.t0);
                            const elabel = kf ? (EASING_OPTIONS.find((o) => o.value === kf.easing)?.label ?? String(kf.easing)) : "—";
                            const tFrac = t / duration;
                            tipEl.innerHTML =
                              `<div class="whitespace-nowrap font-mono text-[10px] text-zinc-100">${el.name} · ${((seg.t0 / 1000)).toFixed(2)}→${((seg.t1 / 1000)).toFixed(2)}s</div>` +
                              `<div class="whitespace-nowrap text-[9px] text-zinc-400">${elabel} · 峰值 ${Math.round((peak / (heat.gmax || 1)) * 100)}% · 均速 ${Math.round((avg / (heat.gmax || 1)) * 100)}%</div>`;
                            tipEl.style.left = `${tFrac * 100}%`;
                            tipEl.style.transform = tFrac > 0.72 ? "translateX(-105%)" : "translateX(8px)";
                            tipEl.style.opacity = "1";
                          };
                          const hideTip = () => {
                            const tipEl = heatTipRefs.current.get(el.id);
                            if (tipEl) tipEl.style.opacity = "0";
                          };
                          return (
                            <>
                              <div
                                className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full"
                                style={{ left: `${(heat.t0 / duration) * 100}%`, width: `${((heat.t1 - heat.t0) / duration) * 100}%` }}
                                data-testid={`heat-${el.id}`}
                              >
                                {heat.segs.map(({ seg, grad }, i) => (
                                  <div
                                    key={i}
                                    className="absolute inset-y-0"
                                    style={{
                                      left: `${((seg.t0 - heat.t0) / span) * 100}%`,
                                      width: `${((seg.t1 - seg.t0) / span) * 100}%`,
                                      background: grad,
                                    }}
                                  />
                                ))}
                              </div>
                              {/* hover hit zone — spans the clip's full lane height; sits
                                  below the keyframe diamonds (rendered earlier) and lets
                                  pointerdown bubble to the lane so marquee/seek still work */}
                              <div
                                className="absolute inset-y-0 cursor-help"
                                style={{ left: `${(heat.t0 / duration) * 100}%`, width: `${((heat.t1 - heat.t0) / duration) * 100}%` }}
                                data-testid={`heat-hover-${el.id}`}
                                onPointerMove={showTip}
                                onPointerLeave={hideTip}
                              />
                              <div
                                ref={(elm) => {
                                  if (elm) heatTipRefs.current.set(el.id, elm);
                                  else heatTipRefs.current.delete(el.id);
                                }}
                                className="pointer-events-none absolute top-0 z-30 w-max max-w-[240px] rounded-md border border-zinc-700 bg-zinc-950/95 px-2 py-1 opacity-0 shadow-xl backdrop-blur transition-opacity"
                                data-testid={`heat-tip-${el.id}`}
                              />
                            </>
                          );
                        })()}
                        {/* keyframes */}
                        {el.keyframes.map((kf) => {
                          const key = kfKey(el.id, kf.t);
                          const selKf = isSel && selection?.kfT === kf.t;
                          const inMulti = kfSelection.includes(key);
                          // easing glyph: Step ■ · custom cubic ◎ · preset easing ● · Linear —
                          const easingLabel = EASING_OPTIONS.find((o) => o.value === kf.easing)?.label ?? String(kf.easing);
                          const glyph =
                            kf.easing === "Linear" ? null
                            : kf.easing === "Step" ? (
                                <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rotate-0 rounded-[0.5px] bg-zinc-900/90" />
                              )
                            : kf.easing === "CubicBezier" ? (
                                <span className="absolute left-1/2 top-1/2 h-[4px] w-[4px] -translate-x-1/2 -translate-y-1/2 rotate-0 rounded-full border border-zinc-900/90 bg-transparent" />
                              )
                            : (
                                <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rotate-0 rounded-full bg-zinc-900/80" />
                              );
                          return (
                            <button
                              key={kf.t}
                              onPointerDown={(e) => onKfPointerDown(e, el.id, kf.t)}
                              onClick={(e) => onKfClick(e, el.id, kf.t)}
                              title={`t=${kf.t}ms · ${easingLabel}${kf.cubic ? ` (${kf.cubic.p1x},${kf.cubic.p1y},${kf.cubic.p2x},${kf.cubic.p2y})` : ""}\nscale ${kf.scale} · opacity ${kf.opacity}\n拖拽改变时间 · Ctrl+点击多选`}
                              className={cn(
                                "group/kf absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border transition-transform hover:scale-125 cursor-ew-resize touch-none",
                                selKf
                                  ? "border-white bg-white shadow-[0_0_8px_rgba(255,255,255,0.7)]"
                                  : inMulti
                                    ? "border-white bg-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.95)]"
                                    : "border-amber-300/80 bg-amber-400 shadow-[0_1px_3px_rgba(0,0,0,0.6)]"
                              )}
                              style={{ left: `${(kf.t / duration) * 100}%` }}
                              data-testid={`kf-${el.id}-${kf.t}`}
                              data-kfkey={key}
                              data-easing={kf.easing}
                              aria-label={`关键帧 ${kf.t}ms，${easingLabel}`}
                            >
                              {glyph}
                            </button>
                          );
                        })}
                        {/* hover quick-add at playhead time */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            addKfAt(el.id, useStudio.getState().timeMs);
                          }}
                          className="absolute right-1 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded border border-zinc-700 bg-zinc-950 text-[11px] leading-none text-zinc-400 hover:border-amber-500/60 hover:text-amber-300 group-hover/track:flex"
                          title={`在播放头处添加关键帧`}
                          aria-label="添加关键帧"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}

                {scene.elements.length === 0 && (
                  <div className="py-6 text-center text-xs text-zinc-600">
                    空场景 — 从上方工具栏添加元素开始创作
                  </div>
                )}

                {/* v11: magnetic snap guide — dashed line at the alignment target */}
                <div
                  ref={snapGuideRef}
                  className="pointer-events-none absolute top-0 z-20 hidden h-full"
                  style={{ left: "0%" }}
                  data-testid="snap-guide"
                >
                  <div className="h-full border-l border-dashed border-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]" />
                  <span
                    ref={snapLabelRef}
                    className="absolute left-1.5 top-6 whitespace-nowrap rounded-sm bg-emerald-400 px-1 font-mono text-[9px] font-bold leading-[14px] text-black shadow"
                    data-testid="snap-guide-label"
                  />
                </div>

                {/* playhead */}
                <div
                  ref={playheadRef}
                  className="pointer-events-none absolute top-0 z-10 h-full w-px bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]"
                  style={{ left: "0%" }}
                >
                  <div className="absolute -left-[5px] top-[2px] h-2.5 w-2.5 rotate-45 rounded-[2px] bg-amber-400 shadow" />
                  <span
                    ref={playheadLabelRef}
                    className="absolute left-2 top-[13px] whitespace-nowrap rounded-sm bg-amber-400 px-1 font-mono text-[9px] font-bold leading-[14px] text-black shadow"
                  >
                    0.00s
                  </span>
                </div>

                {/* marquee selection box */}
                {marquee && (
                  <div
                    className="pointer-events-none absolute z-20 rounded-[2px] border border-dashed border-amber-400/90 bg-amber-400/10"
                    style={{
                      left: marquee.x,
                      top: marquee.y,
                      width: marquee.w,
                      height: marquee.h,
                    }}
                    data-testid="kf-marquee"
                  />
                )}
              </div>

              {/* speed graph — inside the zoom/scroll content so it stays in lockstep */}
              {showGraph && (
                <div className="border-t border-zinc-800/60 bg-zinc-950/30" data-testid="speed-graph-row">
                  <SpeedGraph />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="border-t border-zinc-800/60 px-3 py-1 text-[10px] text-zinc-600">
        双击轨道添加关键帧 · 空白处拖拽框选 · 拖拽关键帧磁吸对齐（其他轨道/播放头/刻度）· Ctrl+C/V 复制粘贴 · 速度图可点击跳转 · 触屏双指缩放时间轴
      </div>
    </div>
  );
}

/** parse composite key stored in the DOM dataset */
function parseKey(key: string): { elId: string; t: number } {
  const i = key.indexOf("|");
  return { elId: key.slice(0, i), t: Number(key.slice(i + 1)) };
}
