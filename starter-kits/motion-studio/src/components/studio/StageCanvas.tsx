"use client";

/**
 * StageCanvas — the live preview stage.
 *
 * Elements are plain DOM nodes positioned EXCLUSIVELY by the Keyframe Engine
 * through domAdapter.batchApply (matrix3d writes, zero React state per frame).
 * React only renders the element structure; the engine owns all motion.
 */

import { useEffect, useRef, useState } from "react";
import { Route, EyeOff } from "lucide-react";
import { useStudio, STAGE } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import type { SceneElement } from "@/lib/scene";
import { OnionSkin } from "./OnionSkin";
import { MotionPathLayer } from "./MotionPath";

export function StageCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    elId: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);

  const scene = useStudio((s) => s.scene);
  const selection = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const patchElement = useStudio((s) => s.patchElement);
  const engineVersion = useStudio((s) => s.engineVersion);
  const showPaths = useStudio((s) => s.showPaths);
  const setShowPaths = useStudio((s) => s.setShowPaths);

  const [scale, setScale] = useState(1);

  // responsive scale: stage logical size is 960×540
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setScale(el.clientWidth / STAGE.w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // selection ring follows the engine-evaluated matrix (same-frame read)
  useEffect(() => {
    const sel = useStudio.getState().selection;
    const update = () => {
      const ring = ringRef.current;
      if (!ring) return;
      if (!sel) {
        ring.style.opacity = "0";
        return;
      }
      const live = engineHost.getLiveMatrix(sel.elId);
      if (!live) {
        ring.style.opacity = "0";
        return;
      }
      const m = live.m;
      ring.style.transform = `matrix3d(${Array.from(m).join(",")})`;
      ring.style.opacity = "1";
    };
    update();
    return engineHost.onFrame(update);
  }, [selection, engineVersion, scene]);

  const onElementPointerDown = (e: React.PointerEvent, el: SceneElement) => {
    e.stopPropagation();
    if (el.locked) {
      // locked elements are not selectable/draggable (unlock from the track row)
      return;
    }
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer events (tests/automation) — drag still works via move handler
    }
    select({ elId: el.id, kfT: null });
    useStudio.getState().pushHistory("drag:" + el.id); // one snapshot per drag gesture
    dragState.current = {
      elId: el.id,
      startX: e.clientX,
      startY: e.clientY,
      baseX: el.x,
      baseY: el.y,
      moved: false,
    };
  };

  const onElementPointerMove = (e: React.PointerEvent) => {
    const d = dragState.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (d.moved) {
      patchElement(
        d.elId,
        {
          x: Math.round(d.baseX + dx),
          y: Math.round(d.baseY + dy),
        },
        { history: false } // snapshot already taken at drag start
      );
    }
  };

  const onElementPointerUp = () => {
    dragState.current = null;
  };

  const selectedEl = selection
    ? scene.elements.find((e) => e.id === selection.elId)
    : null;

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
      style={{ aspectRatio: "16 / 9" }}
      onPointerDown={() => select(null)}
      role="application"
      aria-label="动效舞台预览"
    >
      {/* radial spotlight backdrop */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 50% 42%, rgba(251,191,36,0.05), transparent 70%), radial-gradient(ellipse 120% 100% at 50% 110%, rgba(120,113,108,0.07), transparent 60%)",
        }}
      />
      {/* grid backdrop */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-zinc-700" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-zinc-700" />

      {/* onion-skin ghost layer + its controls (ghosts render behind live elements) */}
      <OnionSkin />

      {/* motion-path trajectory overlay for the selected element */}
      <MotionPathLayer />

      {/* corner marks + watermark */}
      {["left-2 top-2 border-l border-t", "right-2 top-2 border-r border-t", "bottom-2 left-2 border-b border-l", "bottom-2 right-2 border-b border-r"].map(
        (pos) => (
          <div key={pos} className={`pointer-events-none absolute h-3 w-3 border-zinc-600 ${pos}`} />
        )
      )}
      <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.3em] text-zinc-700">
        keyforge · motion stage
      </div>

      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: STAGE.w, height: STAGE.h, transform: `scale(${scale})` }}
      >
        {scene.elements.map((el) => (
          <div
            key={el.id}
            ref={(node) => {
              engineHost.registerNode(el.id, node);
            }}
            className="absolute left-0 top-0 cursor-grab active:cursor-grabbing"
            style={{
              transformOrigin: "0 0",
              willChange: "transform, opacity",
              opacity: 0.001,
              visibility: el.hidden ? "hidden" : "visible",
              cursor: el.locked ? "default" : undefined,
            }}
            onPointerDown={(e) => onElementPointerDown(e, el)}
            onPointerMove={onElementPointerMove}
            onPointerUp={onElementPointerUp}
            data-elid={el.id}
          >
            <ElementVisual el={el} />
          </div>
        ))}

        {/* selection ring — transformed by the engine matrix each frame */}
        <div
          ref={ringRef}
          className="pointer-events-none absolute left-0 top-0 border-2 border-amber-400 opacity-0 kf-ring-glow"
          style={{
            transformOrigin: "0 0",
            width: selectedEl ? selectedEl.size + 10 : 0,
            height: selectedEl ? selectedEl.size + 10 : 0,
            borderRadius: selectedEl?.shape === "circle" ? "9999px" : "12px",
            marginLeft: -5,
            marginTop: -5,
          }}
        />
      </div>

      {/* stage meta + motion-path toggle */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowPaths(!showPaths);
          }}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] backdrop-blur transition-colors ${
            showPaths
              ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
              : "bg-black/50 text-zinc-500 hover:text-zinc-300"
          }`}
          title={showPaths ? "隐藏运动路径（选中元素的关键帧轨迹）" : "显示运动路径"}
          aria-label={showPaths ? "隐藏运动路径" : "显示运动路径"}
          data-testid="motion-path-toggle"
        >
          {showPaths ? <Route className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
          路径
        </button>
        <div className="pointer-events-none rounded bg-black/50 px-2 py-0.5 font-mono text-[10px] text-zinc-400 backdrop-blur">
          960×540 · {scene.elements.length} 实例
        </div>
      </div>

      {/* cinematic vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 90% 80% at 50% 50%, transparent 62%, rgba(0,0,0,0.42) 100%)",
        }}
      />
    </div>
  );
}

function ElementVisual({ el }: { el: SceneElement }) {
  if (el.shape === "text") {
    return (
      <span
        className="whitespace-nowrap font-bold tracking-tight"
        style={{ color: el.color, fontSize: el.size, lineHeight: 1.2 }}
      >
        {el.text || "文案"}
      </span>
    );
  }
  if (el.shape === "circle") {
    return (
      <div
        style={{
          width: el.size,
          height: el.size,
          borderRadius: "9999px",
          background: `radial-gradient(circle at 32% 30%, ${el.color}f0, ${el.color}70 62%, ${el.color}30)`,
          boxShadow: `0 8px 24px ${el.color}40, inset 0 0 0 1px rgba(255,255,255,0.14)`,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: el.size,
        height: el.size,
        borderRadius: 14,
        background: `linear-gradient(135deg, ${el.color}, ${el.color}99)`,
        boxShadow: `0 10px 30px ${el.color}35, inset 0 0 0 1px rgba(255,255,255,0.16)`,
      }}
    />
  );
}
