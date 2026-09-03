/**
 * Export finishing — CSS-filter-style color grading presets + watermark
 * overlay shared by every export pipeline (WebM / GIF / PNG sequence /
 * PNG frame). Presets are applied as a canvas post-process: the finished
 * frame is re-drawn onto itself with ctx.filter, then the watermark text
 * is stamped on top with a subtle shadow.
 */

export interface ExportFilter {
  id: string;
  label: string;
  /** canvas ctx.filter value (CSS filter syntax) */
  css: string;
  /** swatch gradient for the UI chips */
  swatch: string;
}

export const EXPORT_FILTERS: ExportFilter[] = [
  { id: "none", label: "原片", css: "none", swatch: "linear-gradient(135deg,#3f3f46,#a1a1aa)" },
  { id: "warm", label: "暖调", css: "sepia(0.28) saturate(1.35) hue-rotate(-8deg) brightness(1.03)", swatch: "linear-gradient(135deg,#f59e0b,#fb7185)" },
  { id: "cool", label: "冷调", css: "saturate(1.15) hue-rotate(14deg) brightness(1.02) contrast(1.02)", swatch: "linear-gradient(135deg,#22d3ee,#818cf8)" },
  { id: "mono", label: "黑白", css: "grayscale(1) contrast(1.12)", swatch: "linear-gradient(135deg,#e5e5e5,#171717)" },
  { id: "retro", label: "复古", css: "sepia(0.45) contrast(0.92) brightness(1.06) saturate(1.25)", swatch: "linear-gradient(135deg,#d6b98c,#a1512d)" },
  { id: "pop", label: "高饱和", css: "contrast(1.22) saturate(1.55)", swatch: "linear-gradient(135deg,#f43f5e,#22d3ee)" },
  { id: "fade", label: "褪色", css: "contrast(0.86) brightness(1.1) saturate(0.72)", swatch: "linear-gradient(135deg,#d4d4d8,#a78b6f)" },
];

export type WatermarkCorner = "tl" | "tr" | "bl" | "br";

export interface WatermarkOptions {
  text: string;
  corner: WatermarkCorner;
  opacity: number; // 0..1
}

/**
 * Apply a color-grade filter to the whole frame (post-process pass).
 * Drawing the canvas onto itself with ctx.filter is the cheapest way to
 * grade composited output without touching the scene pipeline.
 */
export function applyFilterPost(ctx: CanvasRenderingContext2D, w: number, h: number, css: string): void {
  if (!css || css === "none") return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = css;
  // self-blit (allowed in Canvas2D; snapshots the source before drawing)
  ctx.drawImage(ctx.canvas, 0, 0, w, h);
  ctx.filter = "none";
  ctx.restore();
}

/** Stamp the watermark text in the chosen corner with a soft shadow. */
export function applyWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, wm: WatermarkOptions): void {
  const text = wm.text.trim();
  if (!text) return;
  const size = Math.max(10, Math.round(w * 0.022));
  const pad = Math.round(w * 0.018);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.max(0.05, Math.min(1, wm.opacity));
  ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = size * 0.35;
  ctx.fillStyle = "#ffffff";
  const metrics = ctx.measureText(text);
  const x = wm.corner === "tl" || wm.corner === "bl" ? pad : w - metrics.width - pad;
  const y = wm.corner === "tl" || wm.corner === "tr" ? pad + size : h - pad;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export interface FinishOptions {
  filterCss?: string;
  watermark?: WatermarkOptions;
}

/** One-call finishing pass for the shared drawSceneFrame pipeline. */
export function applyFinish(ctx: CanvasRenderingContext2D, w: number, h: number, opts?: FinishOptions): void {
  if (opts?.filterCss) applyFilterPost(ctx, w, h, opts.filterCss);
  if (opts?.watermark && opts.watermark.text.trim()) applyWatermark(ctx, w, h, opts.watermark);
}
