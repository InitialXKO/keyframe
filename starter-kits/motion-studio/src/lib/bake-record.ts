/**
 * bake-record — secondary creation on distributed motion assets.
 *
 * The .kfbake player paints instances straight from the packed GPU ABI
 * (frame index + memcpy → Canvas2D). This module extracts that paint pass
 * into a resolution-independent helper so the SAME renderer can:
 *
 *  - draw the live preview (any DPR)
 *  - stamp a single frame at 2× resolution for PNG stills
 *  - record the WHOLE loop into an animated GIF (gifenc, global palette
 *    sampled from 5 representative frames — identical strategy to the
 *    scene GIF pipeline)
 *
 * Zero engine dependency: the input is a BakedReplayPlayer, i.e. the
 * distributable asset itself. Motion-as-a-Service payloads remain fully
 * self-contained — playable AND re-creatable anywhere.
 */

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { BakedReplayPlayer } from "./keyframe/bake-replay";

/** logical stage the bake player was designed for (PerfLab grid) */
export const BAKE_STAGE_W = 960;
export const BAKE_STAGE_H = 480;
/** particle size in logical stage px */
const PARTICLE = 14;

/**
 * Paint frame `fi` of the baked loop into `ctx` at any output size.
 * `w`/`h` are the canvas pixel dimensions — everything scales from the
 * logical 960×480 stage. The caller owns clearing the canvas first
 * (this function paints an opaque backdrop).
 */
export function paintBakeFrame(
  ctx: CanvasRenderingContext2D,
  player: BakedReplayPlayer,
  fps: number,
  fi: number,
  w: number,
  h: number
): void {
  const s = w / BAKE_STAGE_W;
  const t = fi * (1000 / Math.max(1, fps));
  const insts = player.getEvaluatedInstances(t);

  // stage backdrop (radial vignette — matches the on-screen player)
  const bg = ctx.createRadialGradient(w / 2, h / 2, 60 * s, w / 2, h / 2, w * 0.7);
  bg.addColorStop(0, "#101014");
  bg.addColorStop(1, "#050507");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    if (!inst.visible) continue;
    const m = inst.transformMatrix;
    // CSS matrix3d is column-major: a=m0 b=m1 c=m4 d=m5 e=m12 f=m13
    ctx.setTransform(s * m[0], s * m[1], s * m[4], s * m[5], s * m[12], s * m[13]);
    const hue = (i * 47) % 60 + 20;
    ctx.globalAlpha = Math.max(0, Math.min(1, inst.opacity));
    ctx.fillStyle = `hsl(${hue} 92% 58%)`;
    ctx.shadowColor = `hsl(${hue} 92% 58% / 0.5)`;
    ctx.shadowBlur = 6 * s;
    ctx.beginPath();
    const p = PARTICLE;
    ctx.roundRect(-p / 2, -p / 2, p, p, 5);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface BakeGifOptions {
  fps: number;
  onProgress?: (progress: number) => void;
  shouldCancel?: () => boolean;
}

/** hard cap shared with the scene pipeline — a 20s@30fps mis-click must not freeze the tab */
export const MAX_BAKE_GIF_FRAMES = 1200;

/**
 * Record the whole baked loop into an animated GIF.
 * Global 256-color palette merged from 5 sampled frames (same as the scene
 * pipeline) → stable colors, smallest files. Opaque (the player backdrop
 * is painted into every frame).
 */
export async function exportBakeGif(
  player: BakedReplayPlayer,
  fps: number,
  frames: number,
  width: number,
  opts: BakeGifOptions
): Promise<{ blob: Blob; frames: number; width: number; height: number }> {
  if (frames > MAX_BAKE_GIF_FRAMES) {
    throw new Error(`帧数超限（${frames} > ${MAX_BAKE_GIF_FRAMES}）`);
  }
  const height = Math.round((width * BAKE_STAGE_H) / BAKE_STAGE_W);
  const delay = Math.round(1000 / Math.max(1, fps));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("无法创建 2D 渲染上下文");

  // --- global palette: 5 representative frames merged -------------------
  const SAMPLES = 5;
  const merged = new Uint8ClampedArray(width * height * 4 * SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    if (opts.shouldCancel?.()) throw new Error("已取消");
    paintBakeFrame(ctx, player, fps, Math.floor((i / SAMPLES) * frames), width, height);
    merged.set(ctx.getImageData(0, 0, width, height).data, i * width * height * 4);
  }
  const palette = quantize(merged, 256);

  const gif = GIFEncoder();
  for (let f = 0; f < frames; f++) {
    if (opts.shouldCancel?.()) throw new Error("已取消");
    paintBakeFrame(ctx, player, fps, f, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, {
      palette: f === 0 ? palette : undefined,
      delay,
      repeat: 0,
    });
    opts.onProgress?.((f + 1) / frames);
    // yield EVERY frame so the browser can paint progress + serve input —
    // long encodes (1000-instance assets) must never wedge the main thread
    await nextTick();
  }

  gif.finish();
  const bytes = gif.bytes();
  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: "image/gif" }),
    frames,
    width,
    height,
  };
}

/** trigger a browser download for a rendered blob */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
