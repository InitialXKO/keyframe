"use client";

/**
 * ExportCenter — unified export dialog for all rendered output formats.
 *
 *  - WebM video  : MediaRecorder canvas capture (VP9→VP8), 1:1 realtime loop
 *  - GIF         : gifenc, global 256-color palette, configurable size/fps
 *  - PNG sequence: numbered frames zipped via fflate (stored, level 0)
 *
 * All three share one preview canvas + progress bar + cancel flow; the render
 * loop pauses the live stage so the offline renderer gets full CPU.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Download, Droplets, FileArchive, Film, Images, Loader2, Stamp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStudio } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import { buildEngineFromScene, type SceneData } from "@/lib/scene";
import { drawSceneFrame } from "@/lib/snapshot";
import {
  exportSceneWebM,
  fmtBytes,
  isWebMExportSupported,
  probeWebMAlpha,
  STAGE_W as VIDEO_W,
  STAGE_H as VIDEO_H,
} from "@/lib/video-export";
import {
  estimateSequenceFrames,
  exportSceneGif,
  exportScenePngSequence,
  MAX_SEQUENCE_FRAMES,
} from "@/lib/gif-export";
import { EXPORT_FILTERS, type WatermarkCorner, type WatermarkOptions } from "@/lib/export-filters";
import { toast } from "sonner";

type ExportFormat = "webm" | "gif" | "pngseq";

/** persisted export preferences (localStorage) */
interface ExportPrefs {
  format: ExportFormat;
  bitrate: number;
  seqWidth: number;
  seqFps: number;
  transparent: boolean;
  filter: string;
  wmText: string;
  wmCorner: WatermarkCorner;
  wmOpacity: number;
  gifPalette: "global" | "local";
}
const PREFS_KEY = "keyforge.export.prefs";

function loadPrefs(): Partial<ExportPrefs> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ExportPrefs>;
  } catch {
    return {};
  }
}

function savePrefs(p: ExportPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // best-effort
  }
}

const FORMATS: { id: ExportFormat; label: string; icon: typeof Film; desc: string }[] = [
  { id: "webm", label: "WebM 视频", icon: Film, desc: "高清画布录制 · VP9" },
  { id: "gif", label: "GIF 动图", icon: Images, desc: "表情包 / 贴图 · 全局调色板" },
  { id: "pngseq", label: "PNG 序列", icon: FileArchive, desc: "逐帧 ZIP · 后期合成" },
];

interface ExportResult {
  url: string;
  size: number;
  frames: number;
  filename: string;
  /** wall-clock encode time (ms) */
  encodeMs: number;
  width: number;
  height: number;
}

export function ExportCenter({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const scene = useStudio((s) => s.scene);

  const cancelRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // restore last-used export parameters
  const saved = useRef(loadPrefs()).current;
  const [format, setFormatState] = useState<ExportFormat>(saved.format ?? "webm");
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [renderTime, setRenderTime] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [bitrate, setBitrate] = useState(saved.bitrate ?? 8_000_000);
  const [seqWidth, setSeqWidth] = useState(saved.seqWidth ?? 480);
  const [seqFps, setSeqFps] = useState(saved.seqFps ?? 12);
  const [transparent, setTransparent] = useState(saved.transparent ?? false);
  const [filterId, setFilterId] = useState(saved.filter ?? "none");
  const [wmText, setWmText] = useState(saved.wmText ?? "");
  const [wmCorner, setWmCorner] = useState<WatermarkCorner>(saved.wmCorner ?? "br");
  const [wmOpacity, setWmOpacity] = useState(saved.wmOpacity ?? 0.55);
  const [gifPalette, setGifPalette] = useState<"global" | "local">(saved.gifPalette ?? "global");
  // v11: empirical VP9-alpha capability (null = probing). Cached module-level;
  // the transparent switch for WebM only unlocks when the pipeline truly
  // preserves alpha (isTypeSupported alone lies about this).
  const [alphaOk, setAlphaOk] = useState<boolean | null>(null);

  const activeFilter = EXPORT_FILTERS.find((f) => f.id === filterId) ?? EXPORT_FILTERS[0];
  const finish = { filterCss: activeFilter.css, watermark: { text: wmText, corner: wmCorner, opacity: wmOpacity } as WatermarkOptions };

  // v9: filter preview thumbnails — the base frame is rendered ONCE at a
  // small size, then every filter card draws it with the CSS filter applied
  // at draw time (cheap: 7 × one drawImage)
  const filterCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const filterBaseRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!open || rendering || result) return;
    let attempt = 0;
    let rafId = 0;
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      // the Radix portal mounts the cards a frame after the effect runs —
      // poll until the first card canvas is registered
      if (filterCanvasRefs.current.size === 0) {
        if (attempt++ < 20) rafId = requestAnimationFrame(render);
        return;
      }
      try {
        const W = 168;
        const H = Math.round((W * 9) / 16);
        if (!filterBaseRef.current) filterBaseRef.current = document.createElement("canvas");
        const base = filterBaseRef.current;
        base.width = W;
        base.height = H;
        const bctx = base.getContext("2d");
        if (!bctx) return;
        const engine = buildEngineFromScene(previewScene.current);
        drawSceneFrame(bctx, previewScene.current, engine, useStudio.getState().timeMs, W, { vignette: false });
        for (const f of EXPORT_FILTERS) {
          const c = filterCanvasRefs.current.get(f.id);
          const cctx = c?.getContext("2d");
          if (!c || !cctx) continue;
          c.width = W;
          c.height = H;
          cctx.filter = f.css === "none" ? "none" : f.css;
          cctx.drawImage(base, 0, 0, W, H);
          cctx.filter = "none";
        }
      } catch {
        /* preview is best-effort */
      }
    };
    rafId = requestAnimationFrame(render);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [open, rendering, result, scene, transparent]);

  // persist whenever any parameter changes
  useEffect(() => {
    savePrefs({ format, bitrate, seqWidth, seqFps, transparent, filter: filterId, wmText, wmCorner, wmOpacity, gifPalette });
  }, [format, bitrate, seqWidth, seqFps, transparent, filterId, wmText, wmCorner, wmOpacity, gifPalette]);

  const setFormat = (f: ExportFormat) => {
    setFormatState(f);
    reset();
  };

  const seqFrames = estimateSequenceFrames(scene.durationMs, seqFps);
  const seqTooBig = seqFrames > MAX_SEQUENCE_FRAMES;

  // reset transient state when the dialog opens
  useEffect(() => {
    if (open) {
      setResult(null);
      setProgress(0);
      setRenderTime(0);
      cancelRef.current = false;
      // v11: probe VP9 alpha once per session (module-level cache) so the
      // WebM transparent switch can unlock as soon as the result arrives
      void probeWebMAlpha().then(setAlphaOk);
    }
  }, [open]);

  // live finishing preview — redraw one frame with the current grade+watermark
  // whenever the finishing parameters change while the dialog is idle
  const previewScene = useRef(scene);
  previewScene.current = scene;
  useEffect(() => {
    if (!open || rendering || result) return;
    // the Radix portal can mount the canvas a frame AFTER this effect runs,
    // so poll across a few animation frames until the canvas exists
    let attempt = 0;
    let rafId = 0;
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const c = canvasRef.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) {
        if (attempt++ < 12) rafId = requestAnimationFrame(draw);
        return;
      }
      try {
        c.dataset.previewed = "1";
        c.width = VIDEO_W;
        c.height = VIDEO_H;
        const engine = buildEngineFromScene(previewScene.current);
        drawSceneFrame(ctx, previewScene.current, engine, useStudio.getState().timeMs, VIDEO_W, {
          transparent: transparent && (format !== "webm" || !!alphaOk),
          finish: { filterCss: activeFilter.css, watermark: { text: wmText, corner: wmCorner, opacity: wmOpacity } },
        });
      } catch {
        /* preview is best-effort */
      }
    };
    rafId = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [open, rendering, result, scene, activeFilter.css, wmText, wmCorner, wmOpacity, transparent, format, alphaOk]);

  const reset = () => {
    setResult(null);
    setProgress(0);
    setRenderTime(0);
  };

  // ---------------------------------------------------------------------------
  // WebM
  // ---------------------------------------------------------------------------
  const startWebM = async () => {
    const canvas = canvasRef.current;
    if (!canvas || rendering) return;
    if (!isWebMExportSupported()) {
      toast.error("当前浏览器不支持视频导出", { description: "需要 Chrome / Edge 94+ 的 MediaRecorder" });
      return;
    }
    setRendering(true);
    reset();
    cancelRef.current = false;
    engineHost.pause();
    const encodeT0 = performance.now();
    let r: Awaited<ReturnType<typeof exportSceneWebM>>;
    try {
      try {
        r = await exportSceneWebM(scene, canvas, {
          bitrate,
          finish,
          alpha: transparent,
          onProgress: (p, t) => {
            setProgress(Math.round(p * 100));
            setRenderTime(t);
          },
          shouldCancel: () => cancelRef.current,
        });
      } catch (e) {
        // transparent webm requested but the browser dropped VP9 alpha mid-flight
        setRendering(false);
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("VP9")) {
          toast.error("透明 WebM 不可用", { description: "当前浏览器编码器不保留 alpha 通道，请改用 GIF / PNG 序列透明导出" });
          return;
        }
        throw e;
      }
      setResult({
        url: URL.createObjectURL(r.blob),
        size: r.blob.size,
        frames: r.renderedFrames,
        filename: `${scene.title || "scene"}-loop${transparent ? "-alpha" : ""}.webm`,
        encodeMs: performance.now() - encodeT0,
        width: VIDEO_W,
        height: VIDEO_H,
      });
      toast.success("WebM 渲染完成", {
        description: `${fmtBytes(r.blob.size)} · ${r.renderedFrames} 帧 · ${(scene.durationMs / 1000).toFixed(1)}s${transparent ? " · VP9 透明背景" : ""}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "已取消") toast.error("WebM 导出失败", { description: msg.slice(0, 120) });
    } finally {
      setRendering(false);
    }
  };

  // ---------------------------------------------------------------------------
  // GIF / PNG sequence (frame-stepped renderers)
  // ---------------------------------------------------------------------------
  const startSequence = async (kind: "gif" | "pngseq") => {
    const canvas = canvasRef.current;
    if (!canvas || rendering) return;
    if (seqTooBig) {
      toast.error("帧数超出上限", { description: `当前设置将渲染 ${seqFrames} 帧（上限 ${MAX_SEQUENCE_FRAMES}），请降低帧率或时长` });
      return;
    }
    setRendering(true);
    reset();
    cancelRef.current = false;
    engineHost.pause();
    const encodeT0 = performance.now();
    const opts = {
      width: seqWidth,
      fps: seqFps,
      transparent,
      finish,
      gifPalette,
      onProgress: (p: number, _f: number, _t: number) => setProgress(Math.round(p * 100)),
      shouldCancel: () => cancelRef.current,
    };
    try {
      if (kind === "gif") {
        const r = await exportSceneGif(scene as SceneData, canvas, opts);
        setResult({
          url: URL.createObjectURL(r.blob),
          size: r.blob.size,
          frames: r.frames,
          filename: `${scene.title || "scene"}-loop${transparent ? "-alpha" : ""}.gif`,
          encodeMs: performance.now() - encodeT0,
          width: seqWidth,
          height: r.height,
        });
        toast.success("GIF 渲染完成", {
          description: `${fmtBytes(r.blob.size)} · ${r.frames} 帧 · ${seqWidth}×${r.height} · ${seqFps}fps${transparent ? " · 透明背景" : ""}`,
        });
      } else {
        const r = await exportScenePngSequence(scene as SceneData, canvas, opts);
        setResult({
          url: URL.createObjectURL(r.blob),
          size: r.blob.size,
          frames: r.frames,
          filename: `${scene.title || "scene"}${transparent ? "-alpha" : ""}-frames.zip`,
          encodeMs: performance.now() - encodeT0,
          width: seqWidth,
          height: r.height,
        });
        toast.success("PNG 序列打包完成", {
          description: `${fmtBytes(r.blob.size)} · ${r.frames} 帧 · ${seqWidth}×${r.height}${transparent ? " · 透明背景" : ""}`,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "已取消") toast.error(kind === "gif" ? "GIF 导出失败" : "PNG 序列导出失败", { description: msg.slice(0, 120) });
    } finally {
      setRendering(false);
    }
  };

  const start = () => {
    if (format === "webm") void startWebM();
    else void startSequence(format);
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result.url;
    a.download = result.filename;
    a.click();
  };

  const activeFmt = FORMATS.find((f) => f.id === format)!;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!rendering) onOpenChange(v); }}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-xl" data-testid="export-center">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="h-4 w-4 text-amber-400" /> 导出中心
          </DialogTitle>
          <DialogDescription>
            离线逐帧渲染整个循环（{VIDEO_W}×{VIDEO_H} · {(scene.durationMs / 1000).toFixed(1)}s），与舞台画面完全一致
          </DialogDescription>
        </DialogHeader>

        {/* format segmented control */}
        <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/70 p-1" role="tablist" aria-label="导出格式" data-testid="export-formats">
          {FORMATS.map((f) => {
            const Icon = f.icon;
            const active = format === f.id;
            return (
              <button
                key={f.id}
                role="tab"
                aria-selected={active}
                disabled={rendering}
                onClick={() => {
                  setFormat(f.id);
                  reset();
                }}
                className={`flex flex-col items-center gap-0.5 rounded-md px-2 py-2 text-center transition-all ${
                  active
                    ? "bg-amber-500/15 text-amber-300 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.35)]"
                    : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
                } ${rendering && !active ? "opacity-40" : ""}`}
                data-testid={`export-format-${f.id}`}
              >
                <Icon className="h-4 w-4" />
                <span className="text-[11px] font-medium leading-none">{f.label}</span>
                <span className={`text-[9px] leading-none ${active ? "text-amber-500/70" : "text-zinc-600"}`}>{f.desc}</span>
              </button>
            );
          })}
        </div>

        {/* render preview canvas — checkerboard signals transparency */}
        <div
          className={`relative aspect-video w-full overflow-hidden rounded-md border border-zinc-800 ${
            transparent && (format !== "webm" || alphaOk) ? "export-checkerboard" : "bg-black"
          }`}
        >
          <canvas ref={canvasRef} width={VIDEO_W} height={VIDEO_H} className="h-full w-full" data-testid="export-canvas" />
          {!rendering && !result && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 text-center">
              <activeFmt.icon className="h-6 w-6 text-zinc-600" />
              <p className="text-xs text-zinc-400">点击「开始渲染」生成{activeFmt.label}</p>
              <p className="text-[10px] text-zinc-600">渲染期间请保持标签页前台</p>
            </div>
          )}
          {rendering && (
            <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-rose-300 backdrop-blur">
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
              {format === "webm" ? `REC ${((renderTime / 1000)).toFixed(2)}s` : `FRAME ${Math.round((progress / 100) * seqFrames)}/${seqFrames}`}
            </div>
          )}
          {result && (
            <div className="absolute right-2 top-2 rounded bg-emerald-500/90 px-2 py-1 font-mono text-[10px] font-bold text-black">
              DONE · {result.frames}f · {fmtBytes(result.size)}
            </div>
          )}
        </div>

        {/* v10: metadata chips — pre-render estimate + post-render actuals */}
        <div className="flex flex-wrap items-center gap-1.5" data-testid="export-meta">
          <span className="text-[9px] font-medium uppercase tracking-wider text-zinc-600">规格</span>
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
            {format === "webm" ? `${VIDEO_W}×${VIDEO_H}` : `${seqWidth}×${Math.round((seqWidth * 9) / 16)}`}
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
            {format === "webm" ? "实时 60fps 采集" : `${seqFps} fps`}
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
            ≈{format === "webm" ? Math.round(scene.durationMs / (1000 / 60)) : seqFrames} 帧
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
            {(scene.durationMs / 1000).toFixed(1)}s
          </span>
          <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
            {format === "webm" ? `VP9${transparent && alphaOk ? " α" : ""} · ${Math.round(bitrate / 1e6)}Mbps` : format === "gif" ? `GIF · ${gifPalette === "global" ? "全局" : "局部"}调色板` : "PNG · ZIP"}
          </span>
          {result && (
            <>
              <span className="ml-1 text-[9px] font-medium uppercase tracking-wider text-emerald-500/80">实测</span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                {result.width}×{result.height}
              </span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                {result.frames} 帧
              </span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                {fmtBytes(result.size)}
              </span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                编码 {(result.encodeMs / 1000).toFixed(1)}s
              </span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                {(result.size * 8) / 1000 / Math.max(1, result.encodeMs) > 0
                  ? `${((result.size * 8) / 1000 / Math.max(1, result.encodeMs)).toFixed(2)} Mbps`
                  : "—"}
              </span>
            </>
          )}
        </div>

        {/* finishing: color grade — v9 visual preview grid (each card renders
            the actual scene frame through that filter) */}
        <div className="space-y-1.5" data-testid="export-finish">
          <div className="flex items-center gap-1.5">
            <Droplets className="h-3 w-3 text-zinc-500" />
            <Label className="text-[10px] text-zinc-500">调色滤镜</Label>
            <span className="text-[9px] text-zinc-600">· 实时预览 · 作用于所有导出格式</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="调色滤镜">
            {EXPORT_FILTERS.map((f) => {
              const active = f.id === filterId;
              return (
                <button
                  key={f.id}
                  role="radio"
                  aria-checked={active}
                  disabled={rendering}
                  onClick={() => setFilterId(f.id)}
                  className={`group overflow-hidden rounded-md border transition-all disabled:opacity-50 ${
                    active
                      ? "border-amber-500/80 shadow-[0_0_10px_rgba(251,191,36,0.22)]"
                      : "border-zinc-800 hover:border-zinc-600"
                  }`}
                  data-testid={`filter-${f.id}`}
                >
                  <span className="relative block w-full bg-black" style={{ aspectRatio: "16 / 9" }}>
                    <canvas
                      ref={(el) => {
                        if (el) filterCanvasRefs.current.set(f.id, el);
                        else filterCanvasRefs.current.delete(f.id);
                      }}
                      className={`h-full w-full transition-transform duration-300 group-hover:scale-[1.06] ${active ? "" : "opacity-80"}`}
                      data-testid={`filter-canvas-${f.id}`}
                    />
                    {active && (
                      <span className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-black shadow-[0_0_6px_rgba(251,191,36,0.9)]">
                        <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                      </span>
                    )}
                  </span>
                  <span
                    className={`block py-1 text-center text-[9px] leading-none transition-colors ${
                      active ? "bg-amber-500/10 text-amber-300" : "bg-zinc-950 text-zinc-500 group-hover:text-zinc-300"
                    }`}
                  >
                    {f.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* watermark row */}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Stamp className="h-3 w-3 text-zinc-500" />
            <Label className="text-[10px] text-zinc-500">水印</Label>
            <Input
              className="h-7 w-36 bg-zinc-950 text-[11px]"
              placeholder="水印文字（留空关闭）"
              value={wmText}
              onChange={(e) => setWmText(e.target.value.slice(0, 24))}
              disabled={rendering}
              maxLength={24}
              data-testid="watermark-input"
            />
            <Select value={wmCorner} onValueChange={(v) => setWmCorner(v as WatermarkCorner)} disabled={rendering || !wmText.trim()}>
              <SelectTrigger className="h-7 w-24 bg-zinc-950 text-[11px]" aria-label="水印位置" data-testid="watermark-corner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tl">左上角</SelectItem>
                <SelectItem value="tr">右上角</SelectItem>
                <SelectItem value="bl">左下角</SelectItem>
                <SelectItem value="br">右下角</SelectItem>
              </SelectContent>
            </Select>
            <Slider
              className="w-24"
              value={[Math.round(wmOpacity * 100)]}
              onValueChange={([v]) => setWmOpacity(v / 100)}
              disabled={rendering || !wmText.trim()}
              min={10}
              max={100}
              step={5}
              aria-label="水印不透明度"
              data-testid="watermark-opacity"
            />
            <span className="font-mono text-[9px] text-zinc-600">{Math.round(wmOpacity * 100)}%</span>
          </div>
        </div>

        {/* per-format options */}
        <div className="flex flex-wrap items-center gap-3">
          {format === "webm" && (
            <div className="flex items-center gap-1.5">
              <Label className="text-[10px] text-zinc-500">画质</Label>
              <Select value={String(bitrate)} onValueChange={(v) => setBitrate(Number(v))} disabled={rendering}>
                <SelectTrigger className="h-7 w-28 bg-zinc-950 text-[11px]" data-testid="webm-quality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="4000000">标准 4 Mbps</SelectItem>
                  <SelectItem value="8000000">高清 8 Mbps</SelectItem>
                  <SelectItem value="16000000">极清 16 Mbps</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {format === "gif" && (
            <div className="flex items-center gap-1.5" data-testid="gif-palette-mode">
              <Label className="text-[10px] text-zinc-500">调色板</Label>
              <Select value={gifPalette} onValueChange={(v) => setGifPalette(v as "global" | "local")} disabled={rendering}>
                <SelectTrigger className="h-7 w-32 bg-zinc-950 text-[11px]" data-testid="gif-palette-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">全局 256 色 · 更小</SelectItem>
                  <SelectItem value="local">逐帧局部 · 更真</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {format !== "webm" && (
            <>
              <div className="flex items-center gap-1.5">
                <Label className="text-[10px] text-zinc-500">尺寸</Label>
                <Select value={String(seqWidth)} onValueChange={(v) => setSeqWidth(Number(v))} disabled={rendering}>
                  <SelectTrigger className="h-7 w-24 bg-zinc-950 text-[11px]" data-testid="seq-width">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="480">480p 预览</SelectItem>
                    <SelectItem value="640">640p 标准</SelectItem>
                    <SelectItem value="960">960p 原生</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-[10px] text-zinc-500">帧率</Label>
                <Select value={String(seqFps)} onValueChange={(v) => setSeqFps(Number(v))} disabled={rendering}>
                  <SelectTrigger className="h-7 w-24 bg-zinc-950 text-[11px]" data-testid="seq-fps">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="8">8 fps</SelectItem>
                    <SelectItem value="12">12 fps</SelectItem>
                    <SelectItem value="16">16 fps</SelectItem>
                    <SelectItem value="25">25 fps</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <span className={`font-mono text-[10px] ${seqTooBig ? "text-red-400" : "text-zinc-500"}`} data-testid="seq-estimate">
                {seqFrames} 帧{seqTooBig ? " · 超出上限" : ""}
              </span>
            </>
          )}
          {/* v11: transparent switch — always offered for GIF/PNG; for WebM it
              unlocks only when the empirical VP9-alpha probe passes */}
          {(format !== "webm" || alphaOk !== false) && (
            <div className="flex items-center gap-1.5" data-testid="transparent-toggle">
              <Switch
                id="export-transparent"
                checked={transparent && (format !== "webm" || alphaOk !== false)}
                onCheckedChange={(v) => setTransparent(v)}
                disabled={rendering || (format === "webm" && alphaOk === false)}
                className="data-[state=checked]:bg-emerald-500"
              />
              <Label htmlFor="export-transparent" className="cursor-pointer text-[10px] text-zinc-500">
                透明背景
              </Label>
              {format === "webm" && alphaOk === true && (
                <span
                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-0.5 font-mono text-[8px] text-emerald-300"
                  title="已通过 VP9 alpha 编码/解码回读验证（真实编码半透明帧并解码检查像素 alpha）"
                  data-testid="webm-alpha-badge"
                >
                  VP9 α ✓
                </span>
              )}
              {format === "webm" && alphaOk === null && (
                <span className="font-mono text-[8px] text-zinc-600" data-testid="webm-alpha-probing">
                  探测中…
                </span>
              )}
              {format === "webm" && alphaOk === false && (
                <span
                  className="font-mono text-[8px] text-zinc-600"
                  title="当前浏览器 MediaRecorder 编码不保留 alpha 通道（已实测验证），透明请用 GIF / PNG 序列"
                  data-testid="webm-alpha-unsupported"
                >
                  此浏览器不支持 VP9 α
                </span>
              )}
            </div>
          )}
          <div className="flex min-w-32 flex-1 items-center gap-2">
            <Progress value={progress} className="h-1.5 flex-1" data-testid="export-progress" />
            <span className="w-9 shrink-0 text-right font-mono text-[10px] text-zinc-400">{progress}%</span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          {rendering ? (
            <Button
              variant="outline"
              className="border-zinc-800 bg-zinc-950 text-xs hover:text-red-400"
              onClick={() => { cancelRef.current = true; }}
              data-testid="export-cancel"
            >
              取消渲染
            </Button>
          ) : (
            <Button
              variant="outline"
              className="border-zinc-800 bg-zinc-950 text-xs"
              onClick={start}
              disabled={scene.elements.length === 0 || seqTooBig}
              data-testid="export-start"
            >
              {result ? <><Loader2 className="mr-1 h-3.5 w-3.5" /> 重新渲染</> : "开始渲染"}
            </Button>
          )}
          <Button
            className="bg-amber-500 text-black hover:bg-amber-400"
            onClick={download}
            disabled={!result}
            data-testid="export-download"
          >
            <Download className="mr-1 h-4 w-4" /> 下载{format === "webm" ? " WebM" : format === "gif" ? " GIF" : " ZIP"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
