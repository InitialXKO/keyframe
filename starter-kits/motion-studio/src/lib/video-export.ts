/**
 * WebM video export — records an offline-rendered loop of the scene.
 *
 * Pipeline: compile the scene into ONE throwaway engine, then render frames
 * with Canvas2D (same pipeline as thumbnails/PNG export) into an offscreen
 * canvas. The canvas is captured via captureStream(0) with manual
 * requestFrame() calls paced on wall-clock time, so MediaRecorder stamps
 * frames at true 1:1 realtime speed (a 4s scene yields a 4s video).
 *
 * Codec selection: VP9 → VP8 → default, whatever the browser supports.
 * Live progress + preview are surfaced through callbacks so the UI can show
 * a rendering preview dialog.
 */

import type { SceneData } from "./scene";
import { buildEngineFromScene } from "./scene";
import { drawSceneFrame } from "./snapshot";
import type { FinishOptions } from "./export-filters";

export const STAGE_W = 960;
export const STAGE_H = 540;

export interface WebMExportOptions {
  /** video bitrate in bits/second */
  bitrate?: number;
  /** color grade + watermark finishing pass */
  finish?: FinishOptions;
  /** v11: keep the backdrop transparent (VP9 alpha — only when the
   *  browser's encoder actually preserves alpha, see probeWebMAlpha) */
  alpha?: boolean;
  /** called every rAF with 0..1 progress and the elapsed scene time */
  onProgress?: (progress: number, timeMs: number) => void;
  /** return true to cancel the render */
  shouldCancel?: () => boolean;
}

export interface WebMExportResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  renderedFrames: number;
}

/** check whether the current browser supports MediaRecorder WebM capture */
export function isWebMExportSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

// ---------------------------------------------------------------------------
// v11: empirical VP9 alpha support probe — MediaRecorder.isTypeSupported lies
// about alpha (it validates the CODEC, not the alpha pipeline). The only
// honest test is: encode a half-transparent frame, decode it back, and read
// the pixel alpha. Result is cached module-level (the pipeline never changes
// within a session).
// ---------------------------------------------------------------------------
let alphaProbe: Promise<boolean> | null = null;

export function probeWebMAlpha(): Promise<boolean> {
  if (!alphaProbe) {
    alphaProbe = runAlphaProbe().catch(() => false);
  }
  return alphaProbe;
}

async function runAlphaProbe(): Promise<boolean> {
  if (
    typeof MediaRecorder === "undefined" ||
    !MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
  ) {
    return false;
  }
  // overall watchdog — a hung decode must not block the UI forever
  return Promise.race([probeOnce(), new Promise<boolean>((res) => setTimeout(() => res(false), 3000))]);
}

async function probeOnce(): Promise<boolean> {
  const W = 64;
  const H = 64;
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sctx = src.getContext("2d");
  if (!sctx) return false;

  const stream = src.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });

  // half-transparent red — alpha survives iff the decoded pixel reads back ~102
  sctx.clearRect(0, 0, W, H);
  sctx.fillStyle = "rgba(255,0,0,0.4)";
  sctx.fillRect(0, 0, W, H);
  rec.start();
  track.requestFrame();
  await new Promise((r) => setTimeout(r, 60));
  track.requestFrame();
  await new Promise((r) => setTimeout(r, 60));
  rec.stop();
  stream.getTracks().forEach((t) => t.stop());
  await done;

  const blob = new Blob(chunks, { type: "video/webm" });
  if (blob.size === 0) return false;

  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("decode failed"));
      setTimeout(() => reject(new Error("decode timeout")), 2000);
    });
    const dst = document.createElement("canvas");
    dst.width = W;
    dst.height = H;
    const dctx = dst.getContext("2d", { alpha: true });
    if (!dctx) return false;
    dctx.drawImage(video, 0, 0);
    const px = dctx.getImageData(W >> 1, H >> 1, 1, 1).data;
    return px[3] < 250; // alpha preserved → transparency-capable pipeline
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Render + record the scene loop to a WebM blob.
 * Resolves when recording completes; rejects on cancel or unsupported env.
 */
export function exportSceneWebM(
  scene: SceneData,
  canvas: HTMLCanvasElement,
  opts: WebMExportOptions = {}
): Promise<WebMExportResult> {
  return new Promise((resolve, reject) => {
    if (!isWebMExportSupported()) {
      reject(new Error("当前浏览器不支持 MediaRecorder 画布捕获"));
      return;
    }
    const alpha = !!opts.alpha;
    // alpha capture is VP9-only (Chrome's MediaRecorder drops alpha on VP8)
    let mimeType: string | null;
    if (alpha) {
      const vp9 = "video/webm;codecs=vp9";
      mimeType = MediaRecorder.isTypeSupported(vp9) ? vp9 : null;
      if (!mimeType) {
        reject(new Error("透明视频需要 VP9 编码（当前浏览器不可用）"));
        return;
      }
    } else {
      mimeType = pickMimeType();
    }
    if (!mimeType) {
      reject(new Error("浏览器不支持 WebM 编码（需要 VP9/VP8）"));
      return;
    }

    canvas.width = STAGE_W;
    canvas.height = STAGE_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("无法创建 2D 渲染上下文"));
      return;
    }

    let engine;
    try {
      engine = buildEngineFromScene(scene);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    const stream = canvas.captureStream(0);
    const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: opts.bitrate ?? 8_000_000,
    });

    const chunks: BlobPart[] = [];
    let renderedFrames = 0;
    let rafId = 0;
    let finished = false;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => {
      cancelAnimationFrame(rafId);
      reject(new Error("MediaRecorder 编码失败"));
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (finished) {
        resolve({
          blob: new Blob(chunks, { type: mimeType }),
          mimeType,
          durationMs: scene.durationMs,
          renderedFrames,
        });
      } else {
        reject(new Error("已取消"));
      }
    };

    // draw the very first frame BEFORE start() so frame 0 is never black
    drawSceneFrame(ctx, scene, engine, 0, STAGE_W, { transparent: alpha, finish: opts.finish });
    videoTrack.requestFrame();

    const startWall = performance.now();
    recorder.start();

    const tick = () => {
      if (opts.shouldCancel?.()) {
        finished = false;
        recorder.stop();
        return;
      }
      const elapsed = performance.now() - startWall;
      const t = Math.min(elapsed, scene.durationMs);
      drawSceneFrame(ctx, scene, engine, t, STAGE_W, { transparent: alpha, finish: opts.finish });
      videoTrack.requestFrame();
      renderedFrames++;
      opts.onProgress?.(t / scene.durationMs, t);

      if (elapsed >= scene.durationMs) {
        // let the encoder flush the final frame before stopping
        finished = true;
        setTimeout(() => {
          try {
            recorder.stop();
          } catch {
            /* already stopped */
          }
        }, 120);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  });
}

/** human-readable byte size */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
