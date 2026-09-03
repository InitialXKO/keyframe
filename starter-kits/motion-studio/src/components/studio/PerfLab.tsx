"use client";

/**
 * PerfLab — mass-instance stress lab showcasing the engine's core strength:
 * one Engine evaluates hundreds of instances per frame into a reused
 * zero-copy Float32Array; domAdapter batch-writes matrix3d to DOM nodes.
 *
 * React renders nothing per frame — metrics are written to DOM directly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Database, Download, FileBox, Gauge, HardDriveDownload, Layers, MemoryStick, Timer, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Engine } from "@/lib/keyframe/builder/engine";
import { Clip, Instance, Keyframe, TransformBuilder, Easing } from "@/lib/keyframe";
import { BakedReplayPlayer } from "@/lib/keyframe/bake-replay";
import { clearBakeCache, loadBakeChunk, opfsAvailable, saveBakeChunk } from "@/lib/keyframe/bake-cache";
import { domAdapter } from "@/lib/keyframe/dom_binder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BenchmarkCompare } from "./BenchmarkCompare";
import { BakePlayerDialog } from "./BakePlayerDialog";
import { downloadKfbake, packKfbake, parseKfbake, type KfbakeFile } from "@/lib/kfbake";

const STAGE_W = 960;
const STAGE_H = 480;

type Metric = { fps: number; evalMs: number; applyMs: number; n: number };
type LabMode = "live" | "baked";

export function PerfLab() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const evalRef = useRef<HTMLSpanElement>(null);
  const applyRef = useRef<HTMLSpanElement>(null);
  const evalBarRef = useRef<HTMLDivElement>(null);
  const applyBarRef = useRef<HTMLDivElement>(null);
  const guardRef = useRef<HTMLSpanElement>(null);
  const bakeInfoRef = useRef<HTMLSpanElement>(null);
  // v11: memory pressure — JS heap + baked chunk size, written via direct DOM
  const memRef = useRef<HTMLSpanElement>(null);
  const memBarRef = useRef<HTMLDivElement>(null);
  const memSubRef = useRef<HTMLSpanElement>(null);

  const [count, setCount] = useState(250);
  const [mode, setMode] = useState<LabMode>("live");
  const [running, setRunning] = useState(true);
  const [metric, setMetric] = useState<Metric>({ fps: 0, evalMs: 0, applyMs: 0, n: 250 });
  // v9: where the current baked chunk came from — OPFS cache or fresh bake
  const [bakeSource, setBakeSource] = useState<"live" | "opfs" | null>(null);

  // v10: baked-chunk assetization — the chunk currently loaded (memory or
  // OPFS) can be exported as a distributable .kfbake file, and foreign files
  // can be imported into the standalone player
  const bakeChunkRef = useRef<{ chunk: Uint8Array; n: number } | null>(null);
  const [playerFile, setPlayerFile] = useState<KfbakeFile | null>(null);
  const kfbakeInputRef = useRef<HTMLInputElement>(null);

  // bench suspend: remember the user's own pause state and restore it afterwards
  const runningBeforeSuspend = useRef(true);
  const suspendForBench = useCallback((v: boolean) => {
    if (v) {
      runningBeforeSuspend.current = runningRef.current;
      setRunning(false);
    } else {
      setRunning(runningBeforeSuspend.current);
    }
  }, []);
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // responsive scale for the 960×480 inner stage
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const inner = gridRef.current;
      if (inner) inner.style.transform = `scale(${el.clientWidth / STAGE_W})`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The upstream guardrail warns on EVERY batchApply call with >200 elements,
  // which would spam the console at 60fps. Filter exactly that warning while
  // the lab is mounted — the badge below surfaces the guardrail state in-UI.
  useEffect(() => {
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = String(args[0] ?? "");
      if (msg.includes("Performance warning: batchApply bound")) return;
      origWarn(...args);
    };
    return () => {
      console.warn = origWarn;
    };
  }, []);

  const spawn = useCallback((n: number, labMode: LabMode) => {
    const host = gridRef.current;
    if (!host) return;

    // ---- engine setup -------------------------------------------------
    const engine = new Engine();
    (engine as unknown as { prepared: boolean }).prepared = true;

    // flowing wave clip: diagonal drift + sine bob + opacity pulse
    const clip = new Clip("flow")
      .duration(2600)
      .iterations(Infinity)
      .addKeyframe(
        new Keyframe(0)
          .transform(new TransformBuilder().translate(0, 0, 0).scale(0.7).rotateZ(0).origin(7, 7, 0).build())
          .opacity(0.25)
          .easing(Easing.EaseInOut)
      )
      .addKeyframe(
        new Keyframe(1300)
          .transform(new TransformBuilder().translate(150, -60, 0).scale(1.35).rotateZ(180).origin(7, 7, 0).build())
          .opacity(0.95)
          .easing(Easing.EaseInOut)
      )
      .addKeyframe(
        new Keyframe(2600)
          .transform(new TransformBuilder().translate(300, 0, 0).scale(0.7).rotateZ(360).origin(7, 7, 0).build())
          .opacity(0.25)
          .easing(Easing.EaseInOut)
      );
    engine.addClip(clip);

    const cols = Math.max(1, Math.ceil(Math.sqrt((n * STAGE_W) / STAGE_H)));
    const rows = Math.ceil(n / cols);
    const cellW = STAGE_W / cols;
    const cellH = STAGE_H / rows;

    const insts = [];
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      insts.push(
        new Instance("flow", `p_${i}`)
          .delay(-((c * 37 + r * 91) % 2600))
          .initialTransform(
            new TransformBuilder()
              .translate(24 + c * cellW + Math.max(0, (cellW - 14) / 2), 16 + r * cellH + Math.max(0, (cellH - 14) / 2), 0)
              .origin(7, 7, 0)
              .build()
          )
      );
    }
    engine.addInstances(insts);

    // ---- optional: bake the whole loop once, replay from memory ----------
    // v9: the chunk is content-derived, so it is cached in OPFS — a reload
    // streams it back (no math at all) instead of re-baking. Until the
    // (async) cache lookup settles, the rAF loop falls back to live eval.
    let player: BakedReplayPlayer | null = null;
    let disposed = false;
    if (labMode === "baked") {
      const cacheKey = `perflab-${n}`;
      if (opfsAvailable()) {
        const t0 = performance.now();
        void (async () => {
          const cached = await loadBakeChunk(cacheKey);
          if (disposed) return;
          if (cached && cached.byteLength > 0 && cached.byteLength % (80 * n) === 0) {
            const loadMs = performance.now() - t0;
            player = new BakedReplayPlayer(cached, n, 60, 2600);
            bakeChunkRef.current = { chunk: cached, n };
            const st = player.stats;
            if (bakeInfoRef.current) {
              bakeInfoRef.current.textContent = `OPFS 缓存命中 · ${(st.bytes / 1024).toFixed(0)}KB · ${st.frames}帧 · 加载 ${loadMs.toFixed(1)}ms`;
            }
            setBakeSource("opfs");
            return;
          }
          // cache miss → bake now, then persist for the next reload
          const bakeStart = performance.now();
          const chunk = engine.bakeChunk(0, 2600, 60);
          const bakeMs = performance.now() - bakeStart;
          if (disposed) return;
          player = new BakedReplayPlayer(chunk, n, 60, 2600);
          bakeChunkRef.current = { chunk, n };
          const st = player.stats;
          const label = () => `现场烘焙 ${(st.bytes / 1024).toFixed(0)}KB · ${st.frames}帧 · ${bakeMs.toFixed(0)}ms`;
          if (bakeInfoRef.current) bakeInfoRef.current.textContent = `${label()} · 正在写入 OPFS…`;
          setBakeSource("live");
          const ok = await saveBakeChunk(cacheKey, chunk);
          if (!disposed && bakeInfoRef.current) {
            bakeInfoRef.current.textContent = ok ? `${label()} · 已缓存至 OPFS` : label();
          }
        })();
      } else {
        const bakeStart = performance.now();
        const chunk = engine.bakeChunk(0, 2600, 60);
        const bakeMs = performance.now() - bakeStart;
        player = new BakedReplayPlayer(chunk, n, 60, 2600);
        bakeChunkRef.current = { chunk, n };
        const st = player.stats;
        if (bakeInfoRef.current) {
          bakeInfoRef.current.textContent = `${(st.bytes / 1024).toFixed(0)}KB · ${st.frames}帧 · 烘焙耗时 ${bakeMs.toFixed(0)}ms（OPFS 不可用，仅内存）`;
        }
        setBakeSource("live");
      }
    } else if (bakeInfoRef.current) {
      bakeInfoRef.current.textContent = "";
      setBakeSource(null);
      bakeChunkRef.current = null;
    }

    // ---- DOM nodes ----------------------------------------------------
    host.innerHTML = "";
    const nodes: HTMLDivElement[] = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      const hue = (i * 47) % 60 + 20;
      d.style.cssText = `position:absolute;left:0;top:0;width:14px;height:14px;border-radius:5px;transform-origin:0 0;opacity:0.001;will-change:transform,opacity;background:hsl(${hue} 92% 58%);box-shadow:0 0 6px hsl(${hue} 92% 58% / 0.5)`;
      frag.appendChild(d);
      nodes.push(d);
    }
    host.appendChild(frag);

    // ---- rAF loop -----------------------------------------------------
    let raf = 0;
    let fpsWindowStart = performance.now();
    let frames = 0;
    let accEval = 0;
    let accApply = 0;
    let accFrames = 0;
    const t0 = fpsWindowStart;

    const tick = (now: number) => {
      const t = (now - t0) % 2600;

      // data production (measured): live JS evaluation OR baked memory replay
      const e0 = performance.now();
      if (player) {
        player.getEvaluatedInstances(t); // pure memory indexing + 80B copies
      } else {
        engine.evaluateFrame(t); // full easing/clip/slerp math per instance
      }
      const e1 = performance.now();

      // DOM batch apply — measured (identical for both pipelines)
      domAdapter.batchApply(nodes, t, { engine: player ?? engine });
      const e2 = performance.now();

      accEval += e1 - e0;
      accApply += e2 - e1;
      accFrames++;
      frames++;

      if (now - fpsWindowStart >= 500) {
        const fps = (frames * 1000) / (now - fpsWindowStart);
        const avgEval = accEval / Math.max(1, accFrames);
        const avgApply = accApply / Math.max(1, accFrames);
        if (fpsRef.current) fpsRef.current.textContent = fps.toFixed(0);
        if (evalRef.current) evalRef.current.textContent = avgEval.toFixed(3);
        if (applyRef.current) applyRef.current.textContent = avgApply.toFixed(3);
        if (evalBarRef.current) evalBarRef.current.style.width = `${Math.min(100, (avgEval / 16.6) * 100)}%`;
        if (applyBarRef.current) applyBarRef.current.style.width = `${Math.min(100, (avgApply / 16.6) * 100)}%`;
        if (guardRef.current) {
          guardRef.current.textContent = n > 200 ? "性能护栏已触发 (>200)" : "性能护栏未触发 (≤200)";
        }
        // v11: memory pressure readout — JS heap (Chromium-only) + the baked
        // chunk footprint when replay mode is active (n × 157帧 × 80B)
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
        if (memRef.current) {
          memRef.current.textContent = mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)}` : "—";
        }
        if (memBarRef.current) {
          memBarRef.current.style.width = mem ? `${Math.min(100, (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1)}%` : "0%";
          memBarRef.current.style.background =
            mem && mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.8
              ? "rgb(248 113 113 / 0.9)" // red — heap pressure
              : mem && mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.5
                ? "rgb(251 191 36 / 0.8)" // amber
                : "rgb(52 211 153 / 0.8)"; // emerald
        }
        if (memSubRef.current) {
          const chunkMB = player ? (player.stats.bytes / 1048576).toFixed(2) : null;
          memSubRef.current.textContent = chunkMB
            ? `烘焙块 ${chunkMB} MB（${n}×${player.stats.frames}帧×80B）`
            : "实时求值 · 无烘焙块";
        }
        setMetric({ fps, evalMs: avgEval, applyMs: avgApply, n });
        frames = 0;
        fpsWindowStart = now;
        accEval = 0;
        accApply = 0;
        accFrames = 0;
      }

      raf = requestAnimationFrame(tick);
      void now;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const cleanup = spawn(count, mode);
    return cleanup;
  }, [count, running, mode, spawn]);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Layers className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-semibold text-zinc-200">批量实例压力测试</span>
          <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-400">
            Zero-Copy Float32Array · 80B/实例
          </Badge>
          <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
            <span ref={guardRef}>性能护栏未触发 (≤200)</span>
          </Badge>

          <div className="ml-auto flex items-center gap-1.5">
            {/* pipeline mode: live math vs baked memory replay */}
            <div className="flex overflow-hidden rounded-md border border-zinc-800" role="group" aria-label="数据管线模式">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMode("live")}
                className={`h-7 rounded-none px-2.5 text-[11px] ${
                  mode === "live"
                    ? "bg-amber-500/15 font-medium text-amber-300 hover:bg-amber-500/20"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                data-testid="perf-mode-live"
              >
                <Activity className="mr-1 h-3 w-3" /> 实时求值
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMode("baked")}
                className={`h-7 rounded-none px-2.5 text-[11px] ${
                  mode === "baked"
                    ? "bg-emerald-500/15 font-medium text-emerald-300 hover:bg-emerald-500/20"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                data-testid="perf-mode-baked"
              >
                <Database className="mr-1 h-3 w-3" /> 烘焙回放
              </Button>
            </div>
            {[100, 250, 500, 1000].map((n) => (
              <Button
                key={n}
                size="sm"
                variant={count === n ? "default" : "outline"}
                onClick={() => setCount(n)}
                className={`h-7 px-2.5 text-xs ${count === n ? "bg-amber-500 text-black hover:bg-amber-400" : "border-zinc-800 bg-zinc-950"}`}
                data-testid={`perf-${n}`}
              >
                {n} 实例
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRunning((r) => !r)}
              className="h-7 border-zinc-800 bg-zinc-950 text-xs"
            >
              {running ? "暂停" : "运行"}
            </Button>
          </div>
        </div>

        {mode === "baked" && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1 text-[10px] text-emerald-300/90">
            <Database className="h-3 w-3 shrink-0" />
            <span className="min-w-0">烘焙回放管线：启动时一次性 bakeChunk 打包整个循环，运行时零数学运算，只做内存索引 + 80B/实例拷贝（预分配对象池，零 GC）</span>
            {bakeSource === "opfs" && (
              <span
                className="flex shrink-0 items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/15 px-1 py-0.5 font-mono text-[9px] text-emerald-200"
                title="烘焙块由浏览器 OPFS 私有文件系统流式加载（刷新后无需重烘焙）"
                data-testid="bake-source-badge"
              >
                <HardDriveDownload className="h-2.5 w-2.5" /> OPFS 命中
              </span>
            )}
            <span ref={bakeInfoRef} className="ml-auto shrink-0 font-mono text-emerald-200/80" data-testid="bake-info" />
            {/* v10: baked-asset actions — export / import / standalone player */}
            <button
              onClick={() => {
                const cur = bakeChunkRef.current;
                if (!cur) {
                  toast.info("尚未烘焙完成，请稍候");
                  return;
                }
                const bytes = packKfbake(
                  {
                    title: `PerfLab ${cur.n} 实例 · 流动波浪`,
                    instances: cur.n,
                    fps: 60,
                    startMs: 0,
                    endMs: 2600,
                    bakedAt: new Date().toISOString(),
                  },
                  cur.chunk
                );
                downloadKfbake(bytes, `keyforge-perflab-${cur.n}inst`);
                toast.success("已导出 .kfbake 资产", { description: `PerfLab ${cur.n} 实例 · ${(bytes.byteLength / 1024).toFixed(0)}KB · 可在任意 BakePlayer 中回放` });
              }}
              className="flex h-5 shrink-0 items-center gap-1 rounded border border-emerald-500/30 px-1.5 text-[9px] text-emerald-300/80 transition-colors hover:border-emerald-300 hover:text-emerald-200"
              title="将当前烘焙块打包为 .kfbake 文件（KFBAKE1 二进制格式：JSON 头 + 80B/实例 GPU ABI 载荷）"
              data-testid="bake-export"
            >
              <Download className="h-2.5 w-2.5" /> 导出 .kfbake
            </button>
            <button
              onClick={() => kfbakeInputRef.current?.click()}
              className="flex h-5 shrink-0 items-center gap-1 rounded border border-emerald-500/30 px-1.5 text-[9px] text-emerald-300/80 transition-colors hover:border-emerald-300 hover:text-emerald-200"
              title="导入 .kfbake 文件并在独立播放器中回放（零引擎依赖）"
              data-testid="bake-import"
            >
              <Upload className="h-2.5 w-2.5" /> 导入
            </button>
            <button
              onClick={() => {
                const cur = bakeChunkRef.current;
                if (!cur) {
                  toast.info("尚未烘焙完成，请稍候");
                  return;
                }
                setPlayerFile({
                  meta: {
                    version: 1,
                    title: `PerfLab ${cur.n} 实例 · 流动波浪`,
                    instances: cur.n,
                    fps: 60,
                    frames: Math.floor(cur.chunk.byteLength / (80 * cur.n)),
                    startMs: 0,
                    endMs: 2600,
                    bakedAt: new Date().toISOString(),
                    payloadBytes: cur.chunk.byteLength,
                  },
                  chunk: cur.chunk,
                });
              }}
              className="flex h-5 shrink-0 items-center gap-1 rounded border border-emerald-500/30 px-1.5 text-[9px] text-emerald-300/80 transition-colors hover:border-emerald-300 hover:text-emerald-200"
              title="打开独立烘焙播放器（Canvas2D 直绘，不经过引擎与 DOM）"
              data-testid="bake-open-player"
            >
              <FileBox className="h-2.5 w-2.5" /> 播放器
            </button>
            <button
              onClick={async () => {
                const removed = await clearBakeCache();
                setBakeSource(null);
                if (bakeInfoRef.current) {
                  bakeInfoRef.current.textContent = removed > 0 ? "缓存已清除 · 重新切换到烘焙模式将现场重烘焙" : "无缓存可清除";
                }
                toast.info(removed > 0 ? `已清除 ${removed} 个烘焙缓存块` : "OPFS 中没有烘焙缓存");
              }}
              className="flex h-5 shrink-0 items-center gap-1 rounded border border-emerald-500/30 px-1.5 text-[9px] text-emerald-300/80 transition-colors hover:border-red-400/50 hover:text-red-300"
              title="清除 OPFS 中的烘焙缓存块（下次烘焙将现场重算）"
              data-testid="bake-cache-clear"
            >
              <Trash2 className="h-2.5 w-2.5" /> 清除缓存
            </button>
          </div>
        )}

        {/* stage */}
        <div
          ref={wrapRef}
          className="relative w-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950"
          style={{ aspectRatio: "2 / 1" }}
          data-perf-stage
        >
          <div
            ref={gridRef}
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: STAGE_W, height: STAGE_H }}
          />
        </div>
      </div>

      {/* metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <MetricCard
          icon={<Gauge className="h-4 w-4 text-emerald-400" />}
          label="渲染帧率"
          valueRef={fpsRef}
          value="—"
          unit="fps"
          testid="metric-fps"
        />
        <MetricCard
          icon={<Timer className={`h-4 w-4 ${mode === "baked" ? "text-emerald-400" : "text-amber-400"}`} />}
          label={mode === "baked" ? "回放解码 / 帧" : "引擎求值 / 帧"}
          valueRef={evalRef}
          value="—"
          unit="ms"
          barRef={evalBarRef}
          testid="metric-eval"
        />
        <MetricCard
          icon={<Activity className="h-4 w-4 text-pink-400" />}
          label="DOM 批量绑定 / 帧"
          valueRef={applyRef}
          value="—"
          unit="ms"
          barRef={applyBarRef}
          testid="metric-apply"
        />
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Layers className="h-4 w-4 text-sky-400" /> 活跃实例
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-zinc-100" data-testid="metric-count">
            {metric.n}
          </div>
          <div className="mt-1 text-[10px] text-zinc-600">
            吞吐 ≈ {metric.evalMs > 0 ? ((metric.n / metric.evalMs) / 1000).toFixed(1) : "—"} 万实例/秒
          </div>
        </div>
        {/* v11: memory pressure — JS heap + baked chunk footprint */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" data-testid="metric-memory">
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <MemoryStick className="h-4 w-4 text-violet-400" /> 内存压力
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-zinc-100">
            <span ref={memRef}>—</span>
            <span className="ml-1 text-xs font-normal text-zinc-500">MB 堆</span>
          </div>
          <div className="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-800">
            <div ref={memBarRef} className="h-full rounded bg-emerald-400/80 transition-all" style={{ width: "0%" }} />
          </div>
          <div className="mt-1 text-[10px] text-zinc-600">
            占堆上限 · <span ref={memSubRef}>实时求值 · 无烘焙块</span>
          </div>
        </div>
      </div>

      {/* engine vs WAAPI benchmark (suspends the main lab while running) */}
      <BenchmarkCompare suspendMain={suspendForBench} />

      <p className="text-xs leading-relaxed text-zinc-500">
        说明：单个 Engine 实例将全部粒子求值进一段复用的 <span className="text-zinc-300">Float32Array</span>（每实例 80 字节、20 个 float 的
        GPU 对齐布局），随后由 <span className="text-zinc-300">domAdapter.batchApply</span> 一次性批量写入
        DOM 的 <span className="text-zinc-300">matrix3d()</span>。全程零 React 状态更新、零 GC 分配，这是该引擎区别于主流方案的核心优势。
        切换到<span className="text-emerald-400/90">烘焙回放</span>模式可对比离线 bakeChunk 管线：数学运算全部前移到启动时的一次性烘焙，运行时只剩内存搬运 ——
        适合无法承担逐帧求值成本的终端（长序列播放 / 低端设备 / WebGPU 顶点缓冲直灌）。
        <span className="text-emerald-400/90"> 导出 .kfbake</span> 可把烘焙产物变成可分发的运动资产文件（KFBAKE1 二进制格式），导入或「播放器」均在
        <span className="text-emerald-400/90"> 无引擎依赖</span>的 Canvas2D 独立回放中验证其自包含性。
      </p>

      {/* v10: .kfbake import + standalone player */}
      <input
        ref={kfbakeInputRef}
        type="file"
        accept=".kfbake"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          void (async () => {
            try {
              const bytes = new Uint8Array(await f.arrayBuffer());
              const parsed = parseKfbake(bytes);
              if (!parsed) {
                toast.error("无效的 .kfbake 文件", { description: "缺少 KFBAKE1 魔数或头结构损坏" });
                return;
              }
              setPlayerFile(parsed);
              toast.success("已导入烘焙资产", { description: `${parsed.meta.title || "未命名"} · ${parsed.meta.instances} 实例 · ${parsed.meta.frames} 帧` });
            } catch (err) {
              toast.error("读取文件失败", { description: String(err).slice(0, 80) });
            }
          })();
        }}
      />
      <BakePlayerDialog file={playerFile} onClose={() => setPlayerFile(null)} />
    </div>
  );
}

function MetricCard({
  icon,
  label,
  valueRef,
  value,
  unit,
  barRef,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  valueRef: React.RefObject<HTMLSpanElement | null>;
  value: string;
  unit: string;
  barRef?: React.RefObject<HTMLDivElement | null>;
  testid?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-center gap-1.5 text-xs text-zinc-400">
        {icon} {label}
      </div>
      <div className="mt-1 font-mono text-2xl font-bold text-zinc-100">
        <span ref={valueRef} data-testid={testid}>
          {value}
        </span>
        <span className="ml-1 text-xs font-normal text-zinc-500">{unit}</span>
      </div>
      {barRef && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div ref={barRef} className="h-full rounded bg-amber-400/80 transition-all" style={{ width: "0%" }} />
        </div>
      )}
      {barRef && <div className="mt-1 text-[10px] text-zinc-600">占 16.6ms 帧预算比例</div>}
    </div>
  );
}
