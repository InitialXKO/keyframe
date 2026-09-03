"use client";

/**
 * OnionSkin — motion-trail overlay for the stage (onion skinning).
 *
 * Renders semi-transparent "ghosts" of the scene at N frames before/after the
 * playhead using a dedicated OFFLINE engine instance (never touches the live
 * engine or DOM binder). Past frames tinted rose, future frames tinted cyan,
 * alpha graded outward. Includes the floating control chip cluster.
 *
 * Settings live in the zustand store (hydrated from localStorage once).
 */

import { useEffect, useMemo, useRef } from "react";
import { Layers } from "lucide-react";
import { useStudio } from "@/store/studio";
import { buildEngineFromScene, type SceneData } from "@/lib/scene";
import type { Engine } from "@/lib/keyframe/builder/engine";
import { cn } from "@/lib/utils";

const W = 960;
const H = 540;
const PAST_TINT = "#f43f5e"; // rose
const FUTURE_TINT = "#22d3ee"; // cyan

const GAP_OPTIONS = [
  { ms: 100, label: "100ms" },
  { ms: 200, label: "200ms" },
  { ms: 333, label: "333ms" },
];

export interface OnionSettings {
  enabled: boolean;
  before: number;
  after: number;
  gap: number;
}

export const ONION_DEFAULTS: OnionSettings = { enabled: false, before: 1, after: 1, gap: 200 };

let onionHydrated = false;

export function OnionSkin() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useStudio((s) => s.scene);
  const engineVersion = useStudio((s) => s.engineVersion);
  const timeMs = useStudio((s) => s.timeMs);
  const settings = useStudio((s) => s.onion);

  // one-time hydration from localStorage (via the store, not component state)
  useEffect(() => {
    if (onionHydrated) return;
    onionHydrated = true;
    try {
      const raw = window.localStorage.getItem("kf-onion");
      if (raw) {
        useStudio.setState({ onion: { ...ONION_DEFAULTS, ...(JSON.parse(raw) as Partial<OnionSettings>) } });
      }
    } catch {
      /* ignore */
    }
  }, []);

  // dedicated offline engine — rebuilt only when the scene model changes
  const offlineEngine = useMemo<Engine | null>(() => {
    if (scene.elements.length === 0) return null;
    try {
      return buildEngineFromScene(scene as SceneData);
    } catch {
      return null;
    }
  }, [engineVersion, scene]);

  // redraw ghosts whenever time / settings / scene change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (!settings.enabled || !offlineEngine) return;

    const dur = scene.durationMs;
    const drawGhost = (t: number, tint: string, strength: number) => {
      if (t < 0 || t > dur) return;
      const inst = offlineEngine.getEvaluatedInstances(t, true);
      for (const el of scene.elements) {
        if (el.hidden) continue;
        const target = inst.find((i) => i.id === el.id);
        if (!target || !target.visible) continue;
        const m = target.transformMatrix;
        // column-major: m[0]=a m[1]=b m[4]=c m[5]=d m[12]=tx m[13]=ty
        const scale = Math.hypot(m[0], m[1]) || 0.0001;
        const rot = Math.atan2(m[1], m[0]);
        const alpha = Math.max(0.05, strength * (target.opacity ?? 1));

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(m[12] + el.size / 2, m[13] + el.size / 2);
        ctx.rotate(rot);
        ctx.scale(scale, scale);
        const half = el.size / 2;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = tint;
        ctx.fillStyle = tint;
        if (el.shape === "text") {
          ctx.font = `bold ${el.size}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(el.text || "文案", 0, 0);
        } else if (el.shape === "circle") {
          ctx.beginPath();
          ctx.arc(0, 0, half, 0, Math.PI * 2);
          ctx.globalAlpha = alpha * 0.28;
          ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.stroke();
        } else {
          const r = 14;
          ctx.beginPath();
          ctx.roundRect(-half, -half, el.size, el.size, r);
          ctx.globalAlpha = alpha * 0.28;
          ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.stroke();
        }
        ctx.restore();
      }
    };

    // past ghosts (nearest = strongest), then future ghosts
    for (let f = settings.before; f >= 1; f--) {
      drawGhost(timeMs - f * settings.gap, PAST_TINT, 0.34 - (f - 1) * 0.12);
    }
    for (let f = settings.after; f >= 1; f--) {
      drawGhost(timeMs + f * settings.gap, FUTURE_TINT, 0.34 - (f - 1) * 0.12);
    }
  }, [offlineEngine, timeMs, settings, scene, engineVersion]);

  const patch = (p: Partial<OnionSettings>) => {
    const next = { ...useStudio.getState().onion, ...p };
    useStudio.setState({ onion: next });
    try {
      window.localStorage.setItem("kf-onion", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      {/* ghost layer — behind the live elements */}
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ display: settings.enabled ? "block" : "none" }}
        aria-hidden="true"
        data-testid="onion-canvas"
      />

      {/* controls — floating top-left */}
      <div className="absolute left-2 top-2 z-10 flex items-center gap-1">
        <button
          onClick={() => patch({ enabled: !settings.enabled })}
          className={cn(
            "flex h-6 items-center gap-1 rounded border px-1.5 font-mono text-[10px] backdrop-blur transition-colors",
            settings.enabled
              ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-300"
              : "border-zinc-700/80 bg-black/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          )}
          title="洋葱皮：叠加播放头前后若干帧的运动轨迹"
          aria-pressed={settings.enabled}
          data-testid="onion-toggle"
        >
          <Layers className="h-3 w-3" />
          洋葱皮
        </button>
        {settings.enabled && (
          <div
            className="flex h-6 animate-kf-bar-in items-center gap-0.5 rounded border border-zinc-700/80 bg-black/60 px-1 font-mono text-[10px] text-zinc-300 backdrop-blur"
            data-testid="onion-controls"
          >
            <button
              onClick={() => patch({ before: Math.max(0, settings.before - 1) })}
              disabled={settings.before <= 0}
              className="flex h-4 w-4 items-center justify-center rounded text-rose-400/90 hover:bg-zinc-800 disabled:opacity-30"
              title="减少过去帧"
              aria-label="减少过去帧"
            >
              −
            </button>
            <span className="text-rose-400" title="过去帧数">
              ◀{settings.before}
            </span>
            <span className="mx-0.5 text-zinc-600">·</span>
            <span className="text-cyan-300" title="未来帧数">
              {settings.after}▶
            </span>
            <button
              onClick={() => patch({ after: Math.max(0, settings.after - 1) })}
              disabled={settings.after <= 0}
              className="flex h-4 w-4 items-center justify-center rounded text-cyan-300/90 hover:bg-zinc-800 disabled:opacity-30"
              title="减少未来帧"
              aria-label="减少未来帧"
            >
              −
            </button>
            <button
              onClick={() => patch({ before: Math.min(3, settings.before + 1) })}
              className="flex h-4 w-4 items-center justify-center rounded text-rose-400/90 hover:bg-zinc-800"
              title="增加过去帧（最多 3）"
              aria-label="增加过去帧"
            >
              +
            </button>
            <button
              onClick={() => patch({ after: Math.min(3, settings.after + 1) })}
              className="flex h-4 w-4 items-center justify-center rounded text-cyan-300/90 hover:bg-zinc-800"
              title="增加未来帧（最多 3）"
              aria-label="增加未来帧"
            >
              +
            </button>
            <span className="mx-0.5 text-zinc-600">|</span>
            {GAP_OPTIONS.map((g) => (
              <button
                key={g.ms}
                onClick={() => patch({ gap: g.ms })}
                className={cn(
                  "rounded px-1 leading-4 transition-colors",
                  settings.gap === g.ms ? "bg-zinc-700 text-amber-300" : "text-zinc-500 hover:text-zinc-300"
                )}
                title={`帧间隔 ${g.label}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* legend */}
      {settings.enabled && (
        <div className="pointer-events-none absolute bottom-6 right-2 z-10 flex items-center gap-2 rounded bg-black/50 px-2 py-0.5 font-mono text-[9px] backdrop-blur">
          <span className="flex items-center gap-1 text-rose-400">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> 过去
          </span>
          <span className="flex items-center gap-1 text-cyan-300">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> 未来
          </span>
        </div>
      )}
    </>
  );
}
