"use client";

/**
 * BakePlayerDialog — standalone player for .kfbake motion assets.
 *
 * Demonstrates the P0 "Motion-as-a-Service" distribution story end-to-end:
 * the file produced by engine.bakeChunk() is decoded and played back here
 * WITHOUT the Keyframe engine, without the scene, and without any easing
 * math — just frame indexing + 80B/instance memcpy (BakedReplayPlayer) and
 * a Canvas2D draw pass (no DOM batch binding involved).
 *
 * The baked ABI only carries transforms/opacity/visibility, so instance
 * colors are regenerated with the same deterministic hue formula the
 * PerfLab grid uses — the replay is visually identical to the source lab.
 *
 * v11: the player becomes a re-creation bench — the shared paint pass
 * (paintBakeFrame) also drives
 *  · 「导出当前帧」→ 2× resolution PNG still of the scrubbed frame
 *  · 「录制 GIF」→ whole-loop GIF via the same global-palette pipeline
 *    as the scene exporter, with live progress + auto download
 *
 * Structure: the transport body is a keyed sub-component (key = file
 * identity), so loading a different asset remounts it fresh (frame 0,
 * playing) without any effect-driven state resets.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Film, FileBox, ImageDown, Pause, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { BakedReplayPlayer } from "@/lib/keyframe/bake-replay";
import { fmtBytes, type KfbakeFile } from "@/lib/kfbake";
import {
  BAKE_STAGE_H,
  BAKE_STAGE_W,
  downloadBlob,
  exportBakeGif,
  paintBakeFrame,
} from "@/lib/bake-record";

export function BakePlayerDialog({ file, onClose }: { file: KfbakeFile | null; onClose: () => void }) {
  // space toggles playback while the dialog is open (owned here so it also
  // works over the dialog chrome, not just the canvas)
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, onClose]);

  return (
    <Dialog open={!!file} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-2xl" data-testid="bake-player">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileBox className="h-4 w-4 text-emerald-400" /> 烘焙资产播放器
            <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-400">
              零引擎依赖
            </Badge>
          </DialogTitle>
          <DialogDescription>
            解码 .kfbake 文件（80B/实例 GPU ABI）→ 帧索引 + memcpy → Canvas2D 直绘。无场景、无缓动数学、无 DOM 绑定 —— 分发格式的独立回放证明。
          </DialogDescription>
        </DialogHeader>

        {file && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-400">
              <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5">{file.meta.title || "未命名"}</span>
              <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5">{file.meta.instances} 实例</span>
              <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5">{file.meta.fps} fps</span>
              <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5">{file.meta.frames} 帧</span>
              <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5">{fmtBytes(file.meta.payloadBytes)}</span>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300" data-testid="bake-player-magic">
                magic KFBAKE1 ✓
              </span>
            </div>
            <BakePlayerBody key={`${file.meta.bakedAt}:${file.meta.payloadBytes}`} file={file} playing={playing} onPlayingChange={setPlaying} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** keyed by file identity — remounts fresh for every new asset */
function BakePlayerBody({
  file,
  playing,
  onPlayingChange,
}: {
  file: KfbakeFile;
  playing: boolean;
  onPlayingChange: (v: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const [uiFrame, setUiFrame] = useState(0);
  const playingRef = useRef(playing);
  const frameRef = useRef(0);
  // v11: GIF recording state (progress / rendering flag)
  const [recording, setRecording] = useState(false);
  const [gifPct, setGifPct] = useState(0);
  const cancelRecRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const { player, frames, fps } = useMemo(() => {
    const p = new BakedReplayPlayer(file.chunk, file.meta.instances, file.meta.fps, file.meta.endMs - file.meta.startMs);
    return { player: p, frames: p.stats.frames, fps: file.meta.fps };
  }, [file]);

  // render loop — pure decode + canvas draw, zero engine involvement
  // (paint pass shared with the PNG/GIF exporters via paintBakeFrame)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = BAKE_STAGE_W * dpr;
    canvas.height = BAKE_STAGE_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frameMs = 1000 / fps;
    let raf = 0;
    let last = performance.now();
    // v11 fix: skip redundant repaints — when paused (incl. during GIF
    // recording) the same frame is NOT repainted every rAF, so the encoder
    // gets a nearly idle main thread instead of fighting a 1000-instance
    // full-rate paint loop
    let lastPainted = -1;
    const draw = (now: number) => {
      if (playingRef.current) {
        frameRef.current = (frameRef.current + (now - last) / frameMs) % frames;
      }
      last = now;
      const fi = Math.floor(frameRef.current) % frames;
      if (playingRef.current || fi !== lastPainted) {
        paintBakeFrame(ctx, player, fps, fi, canvas.width, canvas.height);
        lastPainted = fi;
        if (timeLabelRef.current) {
          timeLabelRef.current.textContent = `${((fi * frameMs) / 1000).toFixed(2)}s / 帧 ${fi + 1}/${frames}`;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [player, frames, fps]);

  // low-frequency UI sync for the scrub slider (the render loop is ref-driven)
  useEffect(() => {
    const id = setInterval(() => setUiFrame(Math.floor(frameRef.current)), 200);
    return () => clearInterval(id);
  }, []);

  // v11: export the currently displayed frame as a 2× PNG still
  const exportFramePng = useCallback(() => {
    const fi = Math.floor(frameRef.current) % frames;
    const off = document.createElement("canvas");
    off.width = BAKE_STAGE_W * 2;
    off.height = BAKE_STAGE_H * 2;
    const ctx = off.getContext("2d");
    if (!ctx) {
      toast.error("无法创建离屏画布");
      return;
    }
    paintBakeFrame(ctx, player, fps, fi, off.width, off.height);
    off.toBlob((blob) => {
      if (!blob) {
        toast.error("PNG 编码失败");
        return;
      }
      const title = (file.meta.title || "bake").replace(/[\\/:*?"<>|\s]+/g, "-");
      downloadBlob(blob, `${title}-frame-${String(fi).padStart(3, "0")}.png`);
      toast.success("已导出当前帧 PNG", { description: `${BAKE_STAGE_W * 2}×${BAKE_STAGE_H * 2} · 帧 ${fi + 1}/${frames}` });
    }, "image/png");
  }, [player, fps, frames, file.meta.title]);

  // v11: record the whole loop into an animated GIF (auto-download)
  const recordGif = useCallback(async () => {
    if (recording) return;
    setRecording(true);
    setGifPct(0);
    cancelRecRef.current = false;
    onPlayingChange(false); // pause playback during capture
    try {
      const r = await exportBakeGif(player, fps, frames, BAKE_STAGE_W, {
        fps,
        onProgress: (p) => setGifPct(Math.round(p * 100)),
        shouldCancel: () => cancelRecRef.current,
      });
      const title = (file.meta.title || "bake").replace(/[\\/:*?"<>|\s]+/g, "-");
      downloadBlob(r.blob, `${title}-loop.gif`);
      toast.success("烘焙资产 GIF 录制完成", {
        description: `${r.width}×${r.height} · ${r.frames} 帧 · ${fmtBytes(r.blob.size)}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "已取消") toast.error("GIF 录制失败", { description: msg.slice(0, 120) });
    } finally {
      setRecording(false);
    }
  }, [player, fps, frames, recording, onPlayingChange, file.meta.title]);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-md border border-zinc-800 bg-black" style={{ aspectRatio: "2 / 1" }}>
        <canvas ref={canvasRef} className="h-full w-full" data-testid="bake-player-canvas" />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0 border-zinc-800 bg-zinc-950"
          onClick={() => onPlayingChange(!playing)}
          aria-label={playing ? "暂停" : "播放"}
          data-testid="bake-player-toggle"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0 border-zinc-800 bg-zinc-950"
          onClick={() => {
            frameRef.current = 0;
            setUiFrame(0);
          }}
          aria-label="回到开头"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <Slider
          className="flex-1"
          value={[Math.min(uiFrame, frames - 1)]}
          max={Math.max(0, frames - 1)}
          step={1}
          onValueChange={([v]) => {
            frameRef.current = v;
            setUiFrame(v);
            onPlayingChange(false);
          }}
          aria-label="帧位置"
          data-testid="bake-player-scrub"
        />
        <span ref={timeLabelRef} className="w-40 shrink-0 text-right font-mono text-[10px] text-zinc-400" />
      </div>

      {/* v11: re-creation bench — still frame + whole-loop GIF from the asset itself */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5">
        <Film className="h-3 w-3 shrink-0 text-emerald-400" />
        <span className="mr-1 shrink-0 text-[10px] text-emerald-300/90">资产二次创作</span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 border-emerald-500/30 bg-zinc-950 px-2 text-[10px] text-emerald-300 hover:border-emerald-300 hover:text-emerald-200"
          onClick={exportFramePng}
          disabled={recording}
          data-testid="bake-export-frame"
        >
          <ImageDown className="mr-1 h-3 w-3" /> 导出当前帧 PNG
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 border-emerald-500/30 bg-zinc-950 px-2 text-[10px] text-emerald-300 hover:border-emerald-300 hover:text-emerald-200"
          onClick={() => void recordGif()}
          disabled={recording}
          data-testid="bake-record-gif"
        >
          <Film className="mr-1 h-3 w-3" /> {recording ? `录制中 ${gifPct}%` : "录制 GIF"}
        </Button>
        {recording && (
          <>
            <Progress value={gifPct} className="h-1 min-w-24 flex-1" data-testid="bake-record-progress" />
            <button
              onClick={() => {
                cancelRecRef.current = true;
              }}
              className="shrink-0 rounded border border-red-500/30 px-1.5 py-0.5 text-[9px] text-red-300 hover:bg-red-500/10"
              data-testid="bake-record-cancel"
            >
              取消
            </button>
          </>
        )}
        <span className="ml-auto hidden shrink-0 font-mono text-[9px] text-zinc-600 sm:block">
          无引擎 · 直接消费 80B/实例 ABI
        </span>
      </div>
    </div>
  );
}
