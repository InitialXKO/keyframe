/**
 * GIF + PNG-sequence export — offline frame-accurate renderers.
 *
 * Both pipelines compile the scene into ONE throwaway engine (identical to
 * thumbnails/WebM), render every frame with the shared Canvas2D pipeline
 * (drawSceneFrame), then:
 *
 *  - GIF : build a GLOBAL 256-color palette from 5 sampled frames, then
 *          quantize+LZW-encode each frame via gifenc (loop forever).
 *          Global palette keeps files small and colors stable across frames.
 *  - PNG : canvas.toBlob per frame, zipped with fflate (stored, level 0 —
 *          PNG payloads are already deflate-compressed, so re-compressing
 *          would only waste CPU).
 *
 * Rendering yields to the event loop between frames so progress UI stays
 * responsive, and honors a cancel hook checked before every frame.
 */

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { zipSync } from "fflate";
import type { SceneData } from "./scene";
import { buildEngineFromScene } from "./scene";
import { drawSceneFrame } from "./snapshot";
import type { FinishOptions } from "./export-filters";

export const STAGE_W = 960;
export const STAGE_H = 540;

export interface SequenceExportOptions {
  /** output width in px (height follows 16:9) */
  width: number;
  /** frames per second */
  fps: number;
  /** skip backdrop/vignette so alpha pixels survive (GIF 1-bit alpha / PNG alpha) */
  transparent?: boolean;
  /** color grade + watermark finishing pass */
  finish?: FinishOptions;
  /** GIF palette strategy: one global 256-color table (small, stable) or a
   *  per-frame local table (truer colors for high-color scenes, larger file) */
  gifPalette?: "global" | "local";
  onProgress?: (progress: number, frame: number, totalFrames: number) => void;
  shouldCancel?: () => boolean;
}

export interface GifExportResult {
  blob: Blob;
  frames: number;
  width: number;
  height: number;
}

export interface PngSeqExportResult {
  blob: Blob;
  frames: number;
  width: number;
  height: number;
}

/** hard cap so a 20s@30fps mis-click cannot freeze the tab for minutes */
export const MAX_SEQUENCE_FRAMES = 1200;

export function estimateSequenceFrames(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

/**
 * Render the scene loop to an animated GIF.
 *
 * Palette strategies:
 *  - global (default): 5 sampled frames merged into ONE 256-color table →
 *    consistent colors, smallest files.
 *  - local: each frame gets its own quantized 256-color table → noticeably
 *    truer gradients/skin tones on high-color scenes, ~15-30% larger.
 *
 * opts.transparent: renders with alpha and encodes 1-bit GIF transparency
 * (rgba4444 palette + oneBitAlpha quantize + transparent index + dispose=2,
 * so each frame restores the background before the next is composited).
 */
export async function exportSceneGif(
  scene: SceneData,
  canvas: HTMLCanvasElement,
  opts: SequenceExportOptions
): Promise<GifExportResult> {
  const width = Math.round(opts.width);
  const height = Math.round((opts.width * STAGE_H) / STAGE_W);
  const delay = Math.round(1000 / opts.fps);
  const total = estimateSequenceFrames(scene.durationMs, opts.fps);
  if (total > MAX_SEQUENCE_FRAMES) {
    throw new Error(`帧数超限（${total} > ${MAX_SEQUENCE_FRAMES}），请降低帧率或缩短时长`);
  }

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("无法创建 2D 渲染上下文");

  const engine = buildEngineFromScene(scene);
  const transparent = !!opts.transparent;
  const localPalette = opts.gifPalette === "local";

  // --- global palette: sample 5 representative frames, merge their pixels ---
  let palette: number[][] | null = null;
  if (!localPalette) {
    const SAMPLES = 5;
    const merged = new Uint8ClampedArray(width * height * 4 * SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      if (opts.shouldCancel?.()) throw new Error("已取消");
      const t = (i / SAMPLES) * (scene.durationMs - 1);
      drawSceneFrame(ctx, scene, engine, t, width, { transparent, finish: opts.finish });
      merged.set(ctx.getImageData(0, 0, width, height).data, i * width * height * 4);
    }
    palette = transparent
      ? quantize(merged, 256, { format: "rgba4444", oneBitAlpha: true })
      : quantize(merged, 256); // rgb565-friendly default
  }

  const gif = GIFEncoder();
  let lastPct = -1;

  for (let f = 0; f < total; f++) {
    if (opts.shouldCancel?.()) throw new Error("已取消");
    const t = Math.min((f * delay) % scene.durationMs, scene.durationMs - 1);
    drawSceneFrame(ctx, scene, engine, t, width, { transparent, finish: opts.finish });
    const { data } = ctx.getImageData(0, 0, width, height);

    let framePalette = palette;
    if (localPalette) {
      framePalette = transparent
        ? quantize(data, 256, { format: "rgba4444", oneBitAlpha: true })
        : quantize(data, 256);
    }
    // when 1-bit alpha is on, locate the fully-transparent palette entry
    const transparentIndex = transparent
      ? Math.max(0, framePalette.findIndex((c) => c.length > 3 && c[3] === 0))
      : 0;

    const index = transparent
      ? applyPalette(data, framePalette, "rgba4444")
      : applyPalette(data, framePalette);
    // global mode: palette only on the FIRST frame (becomes the global color
    // table, later frames omit it); local mode: every frame carries its own
    // local color table.
    gif.writeFrame(index, width, height, {
      palette: framePalette && (localPalette || f === 0) ? framePalette : undefined,
      delay,
      repeat: 0,
      // restore-to-background between frames, or ghosts of the previous
      // frame bleed through the transparent regions
      ...(transparent ? { transparent: true, transparentIndex, dispose: 2 } : {}),
    });

    const pct = Math.round(((f + 1) / total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      opts.onProgress?.(pct / 100, f + 1, total);
    }
    // yield so the browser can paint progress + keep the tab responsive
    if (f % 2 === 1) await nextTick();
  }

  gif.finish();
  const bytes = gif.bytes();
  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: "image/gif" }),
    frames: total,
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// PNG sequence (zip)
// ---------------------------------------------------------------------------

/** Render the scene loop to a ZIP of numbered PNG frames. */
export async function exportScenePngSequence(
  scene: SceneData,
  canvas: HTMLCanvasElement,
  opts: SequenceExportOptions
): Promise<PngSeqExportResult> {
  const width = Math.round(opts.width);
  const height = Math.round((opts.width * STAGE_H) / STAGE_W);
  const delay = Math.round(1000 / opts.fps);
  const total = estimateSequenceFrames(scene.durationMs, opts.fps);
  if (total > MAX_SEQUENCE_FRAMES) {
    throw new Error(`帧数超限（${total} > ${MAX_SEQUENCE_FRAMES}），请降低帧率或缩短时长`);
  }

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("无法创建 2D 渲染上下文");

  const engine = buildEngineFromScene(scene);
  const files: Record<string, Uint8Array> = {};
  const namePad = String(total).length;

  for (let f = 0; f < total; f++) {
    if (opts.shouldCancel?.()) throw new Error("已取消");
    const t = Math.min((f * delay) % scene.durationMs, scene.durationMs - 1);
    drawSceneFrame(ctx, scene, engine, t, width, { transparent: !!opts.transparent, finish: opts.finish });

    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("PNG 编码失败");
    files[`${scene.title || "scene"}_${String(f).padStart(namePad, "0")}.png`] = new Uint8Array(
      await blob.arrayBuffer()
    );

    opts.onProgress?.((f + 1) / total, f + 1, total);
    if (f % 2 === 1) await nextTick();
  }

  // PNGs are already compressed — store (level 0) is faster AND smaller CPU cost
  const zipped = zipSync(files, { level: 0 });
  return {
    blob: new Blob([zipped as unknown as BlobPart], { type: "application/zip" }),
    frames: total,
    width,
    height,
  };
}
