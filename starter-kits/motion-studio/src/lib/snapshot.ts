/**
 * Scene snapshot — renders a scene to a JPEG/PNG image via Canvas2D.
 *
 * Approach: compile the scene into a throwaway Keyframe Engine instance,
 * evaluate the requested instant offline (getEvaluatedInstances), then redraw
 * with Canvas2D using the engine's own matrices (identical placement to the
 * live stage). Hidden elements are skipped.
 *
 * Note: the engine reuses a zero-copy buffer per evaluation, so every
 * candidate is fully consumed (scored) before the next evaluation — no
 * cross-evaluation references are kept.
 */

import type { SceneData } from "./scene";
import { buildEngineFromScene } from "./scene";
import type { Engine } from "./keyframe";
import { applyFinish, type FinishOptions } from "./export-filters";

const STAGE_W = 960;
const STAGE_H = 540;

/**
 * Draw one evaluated frame of the scene into a 2D context.
 * Shared pipeline: thumbnails (JPEG 320×180), PNG frame export (960×540),
 * and WebM video export (per-frame offline rendering).
 *
 * The engine is passed in so video export can compile ONCE and evaluate
 * every frame against the same instance (much cheaper than recompiling).
 *
 * opts.transparent: skip backdrop/grid/vignette so alpha pixels survive
 * (used by transparent GIF / transparent PNG-sequence exports).
 * opts.finish: post-process color grade (canvas filter) + watermark stamp,
 * applied after compositing — shared by every export pipeline.
 */
export function drawSceneFrame(
  ctx: CanvasRenderingContext2D,
  scene: SceneData,
  engine: Engine,
  timeMs: number,
  width: number,
  opts?: { vignette?: boolean; transparent?: boolean; finish?: FinishOptions }
): void {
  const height = Math.round((width * STAGE_H) / STAGE_W);
  const s = width / STAGE_W; // stage → output scale

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;

  if (!opts?.transparent) {
    // backdrop: dark stage + subtle grid
    ctx.fillStyle = "#0a0a0c";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    const grid = 48 * s;
    ctx.beginPath();
    for (let x = grid; x < width; x += grid) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = grid; y < height; y += grid) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  } else {
    // must explicitly clear: the shared canvas may hold pixels from a prior draw
    ctx.clearRect(0, 0, width, height);
  }

  const inst = engine.getEvaluatedInstances(timeMs);
  for (const item of inst) {
    const el = scene.elements.find((e) => e.id === item.id);
    if (!el || el.hidden || !item.visible || item.opacity <= 0.01) continue;

    const m = item.transformMatrix; // column-major, 2D-affine for our scenes
    ctx.setTransform(m[0] * s, m[1] * s, m[4] * s, m[5] * s, m[12] * s, m[13] * s);
    ctx.globalAlpha = Math.max(0, Math.min(1, item.opacity));

    if (el.shape === "circle") {
      const r = el.size / 2;
      const grad = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
      grad.addColorStop(0, el.color);
      grad.addColorStop(1, el.color + "55");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (el.shape === "text") {
      const text = el.text || "文案";
      ctx.fillStyle = el.color;
      ctx.font = `bold ${el.size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(text, 0, el.size * 0.55);
    } else {
      const grad = ctx.createLinearGradient(0, 0, el.size, el.size);
      grad.addColorStop(0, el.color);
      grad.addColorStop(1, el.color + "88");
      ctx.fillStyle = grad;
      const r = Math.min(14, el.size * 0.2);
      roundRect(ctx, 0, 0, el.size, el.size, r);
      ctx.fill();
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;

  // subtle vignette for a finished look
  if (opts?.vignette !== false && !opts?.transparent) {
    const vig = ctx.createRadialGradient(width / 2, height / 2, height * 0.4, width / 2, height / 2, width * 0.75);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }

  // color grade + watermark finishing pass (all export pipelines)
  if (opts?.finish) {
    applyFinish(ctx, width, height, opts.finish);
  }
}

function renderToDataUrl(
  scene: SceneData,
  timeMs: number,
  width: number,
  type: "image/jpeg" | "image/png",
  quality: number
): string | null {
  const height = Math.round((width * STAGE_H) / STAGE_W);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const engine = buildEngineFromScene(scene);
  drawSceneFrame(ctx, scene, engine, timeMs, width);

  return canvas.toDataURL(type, quality);
}

/** pick the instant with the most visible content between 25%–85% of the timeline */
function pickBestInstant(engine: ReturnType<typeof buildEngineFromScene>, durationMs: number): number {
  const candidates = [0.25, 0.4, 0.55, 0.7, 0.85].map((f) => Math.round(durationMs * f));
  let best = 0;
  let bestScore = -1;
  for (const t of candidates) {
    const inst = engine.getEvaluatedInstances(t);
    let score = 0;
    for (const i of inst) {
      if (!i.visible) continue;
      const op = Math.max(0, Math.min(1, i.opacity));
      score += op * op;
    }
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Render a small JPEG thumbnail at the visually richest instant.
 * Returns a data URL, or null when the canvas is unavailable (SSR/tests)
 * or the scene has no elements.
 */
export function renderSceneThumb(scene: SceneData): string | null {
  if (typeof document === "undefined") return null;
  if (scene.elements.length === 0) return null;
  try {
    const engine = buildEngineFromScene(scene);
    const bestT = pickBestInstant(engine, scene.durationMs);
    return renderToDataUrl(scene, bestT, 320, "image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/**
 * Render the full-resolution frame at a given instant (PNG, 960×540).
 * Used by the "export current frame" action.
 */
export function renderSceneFramePng(scene: SceneData, timeMs: number): string | null {
  if (typeof document === "undefined") return null;
  try {
    return renderToDataUrl(scene, Math.max(0, timeMs), 960, "image/png", 1);
  } catch {
    return null;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
