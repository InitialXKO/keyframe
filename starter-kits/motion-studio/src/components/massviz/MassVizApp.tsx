"use client";

/**
 * MassViz —— 大规模数据可视化动效层
 *
 * Rust WASM 内核（InitialXKO/keyframe vendor + fast-path）× WebGPU/WebGL2
 * 25k 粒子 × 20 关键帧 × 60fps；聚合统计以 ~10Hz 喂给 ECharts/D3 面板。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Gauge,
  Layers,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  ZoomIn,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  loadKeyframeKernel,
  type Kernel,
  type KernelEngine,
} from "@/lib/mass/kernel";
import {
  buildGalaxyScene,
  evaluateClipLocal,
  type GalaxyScene,
} from "@/lib/mass/scene";
import {
  createRenderer,
  makeViewProj,
  type GalaxyRenderer,
  type RenderBackend,
} from "@/lib/mass/renderer";
import { PerfChartPanel, type PerfSample } from "./panels/PerfChartPanel";
import { HistogramPanel } from "./panels/HistogramPanel";
import { KeyframeInspector } from "./panels/KeyframeInspector";
import type { InspectorTrack } from "./panels/KeyframeInspector";
import { ReportSection, type BenchRow } from "./ReportSection";

const COUNT_OPTIONS = [1000, 5000, 10000, 25000, 40000];
const MAX_INSTANCES = 48000;
const HIST_BINS = 32;
const HIST_MAX_R = 1.3;

type Phase =
  | { kind: "loading"; step: string; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface HudState {
  fps: number;
  evalMs: number;
  gpuMs: number;
  memMB: number;
  selectedIdx: number;
}

export function MassVizApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const kernelRef = useRef<Kernel | null>(null);
  const engineRef = useRef<KernelEngine | null>(null);
  const rendererRef = useRef<GalaxyRenderer | null>(null);
  const sceneRef = useRef<GalaxyScene | null>(null);
  const memoryRef = useRef<WebAssembly.Memory | null>(null);

  const simTimeRef = useRef(0);
  const playingRef = useRef(true);
  const cameraRef = useRef({ zoom: 0.72, panX: 0, panY: 0, rot: 0 });
  const settingsRef = useRef({
    speed: 1,
    pointScale: 1,
    trails: true,
    colorMode: 0,
    autoRotate: true,
    kernelMode: "fast" as "fast" | "vanilla",
  });
  const rafRef = useRef(0);
  const selectedRef = useRef(-1);
  const sizeRef = useRef({ w: 0, h: 0 });

  const [phase, setPhase] = useState<Phase>({
    kind: "loading",
    step: "准备",
    progress: 0,
  });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [pointScale, setPointScale] = useState(1);
  const [trails, setTrails] = useState(true);
  const [colorMode, setColorMode] = useState("0");
  const [autoRotate, setAutoRotate] = useState(true);
  const [kernelMode, setKernelMode] = useState("fast");
  const kernelLabel = kernelMode === "fast" ? "Rust WASM · fast-path" : "Rust WASM · 原版路径";
  const [count, setCount] = useState(25000);
  const [backend, setBackend] = useState<RenderBackend | "未初始化">("未初始化");
  const [kernelInfo, setKernelInfo] = useState("rust → wasm32 自编译");
  const [hud, setHud] = useState<HudState>({
    fps: 0,
    evalMs: 0,
    gpuMs: 0,
    memMB: 0,
    selectedIdx: -1,
  });
  const [samples, setSamples] = useState<PerfSample[]>([]);
  const [bins, setBins] = useState<number[]>([]);
  const [binsAt, setBinsAt] = useState(0);
  const [track, setTrack] = useState<InspectorTrack | null>(null);
  const [tick, setTick] = useState<{
    playheadMs: number;
    relative: { x: number; y: number } | null;
    worldPos: { x: number; y: number } | null;
  }>({ playheadMs: 0, relative: null, worldPos: null });
  const [bench, setBench] = useState<{ vanilla: number; fast: number } | null>(null);

  const samplesRef = useRef<PerfSample[]>([]);

  /* ---------------- 场景构建与注入 ---------------- */

  const rebuild = useCallback(
    async (kernel: Kernel, n: number, seed: number) => {
      const t0 = performance.now();
      setPhase({ kind: "loading", step: "生成银河场景", progress: 0.3 });
      await new Promise((r) => setTimeout(r, 16));

      const scene = buildGalaxyScene(n, seed);
      sceneRef.current = scene;

      setPhase({ kind: "loading", step: `注入 ${n.toLocaleString()} 实例`, progress: 0.55 });
      await new Promise((r) => setTimeout(r, 16));

      const engine = kernel.createEngine();
      const ir = JSON.stringify({
        clips: scene.clips,
        instances: scene.instances,
        root_timeline: null,
      });
      engine.import_ir_json(ir);
      engine.prepare();
      engine.prepare_fast();

      const old = engineRef.current;
      engineRef.current = engine;

      setPhase({ kind: "loading", step: "初始化 GPU 缓冲", progress: 0.85 });
      rendererRef.current?.setColorBuffer(scene.colors, n);

      selectedRef.current = -1;
      setTrack(null);
      try {
        old?.free();
      } catch {
        /* noop */
      }
      void t0;
      setPhase({ kind: "ready" });
    },
    [],
  );

  /* ---------------- 主循环 ---------------- */

  const startLoop = useCallback(() => {
    let last = performance.now();
    let fpsEma = 60;
    let lastSample = 0;
    let lastHud = 0;
    let lastHist = 0;
    let lastTick = 0;

    const frame = (now: number) => {
      rafRef.current = requestAnimationFrame(frame);
      const engine = engineRef.current;
      const renderer = rendererRef.current;
      const memory = memoryRef.current;
      const scene = sceneRef.current;
      if (!engine || !renderer || !memory || !scene) return;

      const dt = Math.min(50, now - last);
      last = now;
      const st = settingsRef.current;

      if (playingRef.current) {
        simTimeRef.current += dt * st.speed;
      }
      if (st.autoRotate) {
        cameraRef.current.rot += dt * 0.00006;
      }
      const t = simTimeRef.current;

      // 内核求值
      const e0 = performance.now();
      const n =
        st.kernelMode === "fast"
          ? engine.evaluate_frame_fast(t)
          : engine.evaluate_frame(t);
      const evalMs = performance.now() - e0;

      const ptr =
        st.kernelMode === "fast"
          ? engine.fast_buffer_ptr()
          : engine.get_instance_buffer_ptr();
      const len =
        st.kernelMode === "fast"
          ? engine.fast_buffer_byte_length()
          : engine.get_instance_buffer_byte_length();

      // 渲染
      const aspect = Math.max(0.1, sizeRef.current.w / Math.max(1, sizeRef.current.h));
      const cam = cameraRef.current;
      const viewProj = makeViewProj(cam.zoom, cam.panX, cam.panY, cam.rot, aspect);
      const instView = len > 0 ? new Float32Array(memory.buffer, ptr, len >> 2) : null;
      const r0 = performance.now();
      renderer.render({
        instances: instView,
        instanceBuffer: memory.buffer,
        byteOffset: ptr,
        byteLength: len,
        count: n,
        viewProj,
        pointScale: st.pointScale,
        colorMode: Number(st.colorMode),
        selectedIdx: selectedRef.current,
        trails: st.trails,
      });
      const gpuMs = performance.now() - r0;

      // FPS EMA
      const fps = 1000 / Math.max(1, dt);
      fpsEma = fpsEma * 0.92 + fps * 0.08;

      // 性能采样 10Hz
      if (now - lastSample >= 100) {
        lastSample = now;
        const arr = samplesRef.current;
        arr.push({ t: now, fps: fpsEma, evalMs, gpuMs });
        if (arr.length > 240) arr.shift();
      }
      // HUD 5Hz
      if (now - lastHud >= 200) {
        lastHud = now;
        setHud({
          fps: fpsEma,
          evalMs,
          gpuMs,
          memMB: memory.buffer.byteLength / 1048576,
          selectedIdx: selectedRef.current,
        });
        setSamples([...samplesRef.current]);
      }
      // 直方图 250ms
      if (now - lastHist >= 250 && len > 0) {
        lastHist = now;
        const view = new Float32Array(memory.buffer, ptr, (n * 20) | 0);
        const b = new Array(HIST_BINS).fill(0);
        for (let i = 0; i < n; i++) {
          const x = view[i * 20 + 12];
          const y = view[i * 20 + 13];
          const r = Math.sqrt(x * x + y * y);
          const bi = Math.min(HIST_BINS - 1, Math.floor((r / HIST_MAX_R) * HIST_BINS));
          b[bi]++;
        }
        setBins(b);
        setBinsAt(now);
      }
      // 检查器 10Hz
      if (now - lastTick >= 100) {
        lastTick = now;
        const sel = selectedRef.current;
        if (sel >= 0 && scene && len > 0) {
          const inst = scene.instances[sel];
          const meta = scene.clipMetas[scene.patternOf[sel]];
          const elapsed = (t - inst.delay) * inst.time_remapping_speed;
          const local = elapsed / inst.duration_scale;
          const rel = evaluateClipLocal(meta, local);
          const view = new Float32Array(memory.buffer, ptr, (n * 20) | 0);
          const off = sel * 20;
          setTick({
            playheadMs: ((local % meta.durationMs) + meta.durationMs) % meta.durationMs,
            relative: { x: rel.dx, y: rel.dy },
            worldPos: { x: view[off + 12], y: view[off + 13] },
          });
        }
      }
    };
    rafRef.current = requestAnimationFrame(frame);
  }, []);

  /* ---------------- 基准测试 ---------------- */

  const runBench = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await new Promise((r) => setTimeout(r, 30));
    const N = 40;
    const base = simTimeRef.current;
    // 原版路径
    let v = 0;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      engine.evaluate_frame(base + i * 16.7);
      v += performance.now() - t0;
    }
    // fast-path
    let f = 0;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      engine.evaluate_frame_fast(base + i * 16.7);
      f += performance.now() - t0;
    }
    setBench({ vanilla: v / N, fast: f / N });
  }, []);

  /* ---------------- 交互（可重绑：WebGPU 自愈换 canvas 节点后需重接监听） ---------------- */

  const unbindRef = useRef<(() => void) | null>(null);

  const bindInteractions = useCallback((canvas: HTMLCanvasElement): (() => void) => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      cam.zoom = Math.min(8, Math.max(0.15, cam.zoom * Math.exp(-e.deltaY * 0.0011)));
    };
    let downX = 0;
    let downY = 0;
    let dragging = false;
    let moved = false;

    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      if (moved) {
        const cam = cameraRef.current;
        const pxToWorld = 2 / Math.max(1, sizeRef.current.h) / cam.zoom;
        cam.panX += dx * pxToWorld;
        cam.panY += dy * pxToWorld;
        downX = e.clientX;
        downY = e.clientY;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (dragging && !moved) pick(e);
      dragging = false;
    };
    const pick = (e: PointerEvent) => {
      const scene = sceneRef.current;
      const memory = memoryRef.current;
      const engine = engineRef.current;
      if (!scene || !memory || !engine) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      const cam = cameraRef.current;
      const aspect = Math.max(0.1, sizeRef.current.w / Math.max(1, sizeRef.current.h));
      // 逆视图变换
      const wx = nx * aspect / cam.zoom - cam.panX / cam.zoom;
      const wy = ny / cam.zoom - cam.panY / cam.zoom;
      const cosR = Math.cos(-cam.rot);
      const sinR = Math.sin(-cam.rot);
      const rx = wx * cosR - wy * sinR;
      const ry = wx * sinR + wy * cosR;

      const n =
        settingsRef.current.kernelMode === "fast"
          ? engine.fast_buffer_byte_length() >> 2
          : engine.get_instance_buffer_byte_length() >> 2;
      const count = (n / 20) | 0;
      const view = new Float32Array(
        memory.buffer,
        settingsRef.current.kernelMode === "fast"
          ? engine.fast_buffer_ptr()
          : engine.get_instance_buffer_ptr(),
        count * 20,
      );
      const threshold = 0.045 / cam.zoom;
      let best = -1;
      let bestD = threshold * threshold;
      for (let i = 0; i < count; i++) {
        const dx = view[i * 20 + 12] - rx;
        const dy = view[i * 20 + 13] - ry;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      selectedRef.current = best;
      if (best >= 0) {
        const meta = scene.clipMetas[scene.patternOf[best]];
        const inst = scene.instances[best];
        setTrack({
          instanceId: inst.id,
          clipId: meta.id,
          patternName: meta.name,
          clipDurationMs: meta.durationMs,
          keyframes: meta.keyframes,
        });
      } else {
        setTrack(null);
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
    };
  }, []);

  /* ---------------- WebGPU 运行期致命错误自愈：换 canvas 节点 → WebGL2 ---------------- */

  const mountedRef = useRef(true);
  const recoveringRef = useRef(false);

  const recoverToWebGL2 = useCallback(
    async (reason: string) => {
      if (recoveringRef.current || !mountedRef.current) return;
      recoveringRef.current = true;
      console.warn("[massviz] WebGPU 运行期致命错误，自愈回退 WebGL2:", reason);
      try {
        rendererRef.current?.destroy();
      } catch {
        /* noop */
      }
      rendererRef.current = null;
      // webgpu 已 configure 的 canvas 无法再取 webgl2 context —— 必须换节点
      const old = canvasRef.current;
      const container = containerRef.current;
      if (!old || !container || !mountedRef.current) {
        recoveringRef.current = false;
        return;
      }
      const fresh = document.createElement("canvas");
      fresh.className = old.className;
      fresh.setAttribute("data-testid", "mv-canvas-gl2");
      old.replaceWith(fresh);
      canvasRef.current = fresh;
      unbindRef.current?.();
      unbindRef.current = bindInteractions(fresh);

      const { renderer, error } = await createRenderer(fresh, MAX_INSTANCES);
      if (!mountedRef.current) return;
      if (!renderer) {
        recoveringRef.current = false;
        setPhase({ kind: "error", message: error ?? "WebGPU 失败且 WebGL2 不可用" });
        return;
      }
      rendererRef.current = renderer;
      setBackend(renderer.backend);
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(1.75, window.devicePixelRatio || 1);
      sizeRef.current = { w: rect.width, h: rect.height };
      renderer.resize(Math.round(rect.width * dpr), Math.round(rect.height * dpr));
      const scene = sceneRef.current;
      if (scene) renderer.setColorBuffer(scene.colors, scene.instances.length);
      recoveringRef.current = false;
    },
    [bindInteractions],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---------------- 初始化 ---------------- */

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        setPhase({ kind: "loading", step: "加载 Rust WASM 内核", progress: 0.1 });
        const kernel = await loadKeyframeKernel();
        if (disposed) return;
        kernelRef.current = kernel;
        memoryRef.current = kernel.memory;
        setKernelInfo(kernel.buildInfo);

        // 渲染器（WebGPU 运行期致命错误 → onFatal 自愈回退 WebGL2）
        setPhase({ kind: "loading", step: "初始化渲染后端", progress: 0.2 });
        const canvas = canvasRef.current!;
        const { renderer, error } = await createRenderer(
          canvas,
          MAX_INSTANCES,
          (reason) => void recoverToWebGL2(reason),
        );
        if (disposed) return;
        if (!renderer) {
          setPhase({
            kind: "error",
            message: error ?? "WebGPU / WebGL2 初始化失败",
          });
          return;
        }
        rendererRef.current = renderer;
        setBackend(renderer.backend);
        const rect = containerRef.current!.getBoundingClientRect();
        const dpr = Math.min(1.75, window.devicePixelRatio || 1);
        sizeRef.current = { w: rect.width, h: rect.height };
        renderer.resize(Math.round(rect.width * dpr), Math.round(rect.height * dpr));

        // 场景
        await rebuild(kernel, 25000, 20250828);
        if (disposed) return;

        startLoop();

        // 调试钩子：时间跳转（headless 节流环境下 QA 用）
        (window as unknown as Record<string, unknown>).__mvSeek = (t: number) => {
          simTimeRef.current = t;
        };

        // 后台基准测试（不阻塞首帧）
        setTimeout(() => void runBench(), 900);
      } catch (err) {
        console.error("[massviz] 初始化失败", err);
        (window as unknown as Record<string, unknown>).__mvInitError = {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : null,
        };
        if (!disposed) {
          setPhase({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      engineRef.current?.free();
      engineRef.current = null;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  /* ---------------- 交互 ---------------- */

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    settingsRef.current.speed = speed;
  }, [speed]);
  useEffect(() => {
    settingsRef.current.pointScale = pointScale;
  }, [pointScale]);
  useEffect(() => {
    settingsRef.current.trails = trails;
  }, [trails]);
  useEffect(() => {
    settingsRef.current.colorMode = Number(colorMode);
  }, [colorMode]);
  useEffect(() => {
    settingsRef.current.autoRotate = autoRotate;
  }, [autoRotate]);
  useEffect(() => {
    settingsRef.current.kernelMode = kernelMode as "fast" | "vanilla";
  }, [kernelMode]);

  // 画布交互挂载（滚轮缩放 / 拖拽平移 / 点击选中；自愈换 canvas 后经 bindInteractions 重绑）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    unbindRef.current = bindInteractions(canvas);
    return () => {
      unbindRef.current?.();
      unbindRef.current = null;
    };
  }, [bindInteractions]);

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      sizeRef.current = { w: rect.width, h: rect.height };
      const dpr = Math.min(1.75, window.devicePixelRatio || 1);
      rendererRef.current?.resize(
        Math.round(rect.width * dpr),
        Math.round(rect.height * dpr),
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const doRebuild = useCallback(
    (n: number) => {
      setCount(n);
      const kernel = kernelRef.current;
      if (!kernel) return;
      setPhase({ kind: "loading", step: "重建场景", progress: 0.2 });
      void rebuild(kernel, n, 20250828);
    },
    [rebuild],
  );

  const resetCamera = () => {
    cameraRef.current = { zoom: 0.72, panX: 0, panY: 0, rot: 0 };
  };

  const benchRows: BenchRow[] = [
    {
      label: "JS 回退引擎（vendored）",
      evalMs: 11.3,
      fps: 88,
      note: "Task 1 实测 500 实例 0.226ms/帧，线性外推至 25k（含 GC 压力会更差）",
    },
    {
      label: "WASM 原版 evaluate_frame",
      evalMs: bench ? bench.vanilla : null,
      fps: bench ? 1000 / bench.vanilla : null,
      note: "上游路径：逐帧 HashMap 重建 + String clone（本机 60 帧均值实测）",
    },
    {
      label: "WASM fast-path（自研补丁）",
      evalMs: bench ? bench.fast : null,
      fps: bench ? 1000 / bench.fast : null,
      note: "逐帧零分配 + 常量快照，输出缓冲地址稳定可零拷贝（本机实测）",
    },
  ];

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="space-y-4" data-testid="massviz-app">
      {/* 主区：画布 + 控制 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <div
            ref={containerRef}
            className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-zinc-800 bg-black"
          >
            <canvas ref={canvasRef} className="h-full w-full touch-none" />

            {/* HUD 左上 */}
            <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className={`border-cyan-500/40 bg-black/60 text-[10px] ${
                  backend === "webgpu" ? "text-cyan-300" : "text-amber-300"
                }`}
                data-testid="hud-backend"
              >
                {backend === "webgpu" ? "WebGPU" : backend === "webgl2" ? "WebGL2 回退" : "…"}
              </Badge>
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-black/60 text-[10px] text-amber-300"
              >
                {kernelLabel}
              </Badge>
              <Badge
                variant="outline"
                className="border-zinc-700 bg-black/60 font-mono text-[10px] text-zinc-300"
                data-testid="hud-count"
              >
                {count.toLocaleString()} 实例 × 20kf
              </Badge>
              <Badge
                variant="outline"
                className="border-zinc-700 bg-black/60 font-mono text-[10px] text-zinc-400"
              >
                内核 {hud.evalMs.toFixed(2)}ms · 提交 {hud.gpuMs.toFixed(2)}ms · WASM {hud.memMB.toFixed(1)}MB
              </Badge>
            </div>

            {/* FPS 右上 */}
            <div className="pointer-events-none absolute right-3 top-3 text-right">
              <div
                className="font-mono text-3xl font-black leading-none text-zinc-100 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]"
                data-testid="hud-fps"
              >
                {Math.round(hud.fps)}
              </div>
              <div className="text-[10px] tracking-widest text-zinc-500">FPS</div>
            </div>

            {/* 底部提示 */}
            <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-zinc-500">
              滚轮缩放 · 拖拽平移 · 点击粒子查看关键帧轨道
            </div>

            {/* 加载/错误覆盖层 */}
            {phase.kind === "loading" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm">
                <div className="flex items-center gap-2 text-sm text-amber-300">
                  <Sparkles className="h-4 w-4 animate-pulse" />
                  {phase.step}…
                </div>
                <div className="h-1.5 w-56 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-400 to-cyan-400 transition-all duration-500"
                    style={{ width: `${Math.round(phase.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {phase.kind === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-6 text-center">
                <AlertTriangle className="h-8 w-8 text-rose-400" />
                <p className="text-sm text-zinc-200">渲染器初始化失败</p>
                <p className="max-w-md text-xs text-zinc-500">{phase.message}</p>
                <p className="text-[10px] text-zinc-600">
                  本演示需要 WebGPU 或 WebGL2 支持；请使用新版 Chrome / Edge 访问
                </p>
              </div>
            )}
          </div>

          {/* 控制台 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={playing ? "secondary" : "default"}
                  className="min-w-[88px] gap-1.5"
                  onClick={() => setPlaying((p) => !p)}
                  data-testid="btn-play"
                >
                  {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {playing ? "暂停" : "播放"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 border-zinc-700"
                  onClick={resetCamera}
                  title="重置相机"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  视角
                </Button>
              </div>

              <div className="flex min-w-[150px] flex-1 items-center gap-2">
                <Label className="shrink-0 text-xs text-zinc-500">速度</Label>
                <Slider
                  value={[speed]}
                  min={0.1}
                  max={3}
                  step={0.1}
                  onValueChange={(v) => setSpeed(v[0])}
                  className="min-w-[90px]"
                  data-testid="slider-speed"
                />
                <span className="w-10 shrink-0 font-mono text-xs text-zinc-400">
                  {speed.toFixed(1)}x
                </span>
              </div>

              <div className="flex min-w-[150px] flex-1 items-center gap-2">
                <Label className="shrink-0 text-xs text-zinc-500">粒径</Label>
                <Slider
                  value={[pointScale]}
                  min={0.3}
                  max={3}
                  step={0.1}
                  onValueChange={(v) => setPointScale(v[0])}
                  className="min-w-[90px]"
                />
                <span className="w-10 shrink-0 font-mono text-xs text-zinc-400">
                  {pointScale.toFixed(1)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Label className="shrink-0 text-xs text-zinc-500">实例数</Label>
                <Select
                  value={String(count)}
                  onValueChange={(v) => doRebuild(Number(v))}
                >
                  <SelectTrigger size="sm" className="w-[110px]" data-testid="select-count">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNT_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n.toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Label className="shrink-0 text-xs text-zinc-500">内核路径</Label>
                <Select value={kernelMode} onValueChange={setKernelMode}>
                  <SelectTrigger size="sm" className="w-[150px]" data-testid="select-kernel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fast">fast-path（补丁）</SelectItem>
                    <SelectItem value="vanilla">原版（对照组）</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Label className="shrink-0 text-xs text-zinc-500">着色</Label>
                <Select value={colorMode} onValueChange={setColorMode}>
                  <SelectTrigger size="sm" className="w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">星系调色板</SelectItem>
                    <SelectItem value="1">母题色带</SelectItem>
                    <SelectItem value="2">单色琥珀</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Switch checked={trails} onCheckedChange={setTrails} id="trails" />
                <Label htmlFor="trails" className="text-xs text-zinc-400">
                  拖影
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={autoRotate} onCheckedChange={setAutoRotate} id="autorot" />
                <Label htmlFor="autorot" className="text-xs text-zinc-400">
                  旋转
                </Label>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右列面板 */}
        <div className="space-y-4">
          <PerfChartPanel
            samples={samples}
            kernelLabel={kernelLabel}
            backend={backend}
            particleCount={count}
          />
          <HistogramPanel bins={bins} total={count} updatedAt={binsAt} />
          <KeyframeInspector
            track={track}
            playheadMs={tick.playheadMs}
            relative={tick.relative}
            worldPos={tick.worldPos}
          />
        </div>
      </div>

      {/* 指标行 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            icon: Layers,
            label: "并行实例",
            value: count.toLocaleString(),
            hint: "80B/实例 GpuInstanceData",
          },
          {
            icon: Activity,
            label: "内核求值",
            value: `${hud.evalMs.toFixed(2)}ms`,
            hint: kernelMode === "fast" ? "fast-path · 零分配" : "原版 · 对照组",
          },
          {
            icon: Gauge,
            label: "帧预算余量",
            value: `${Math.max(0, 16.6 - hud.evalMs - hud.gpuMs).toFixed(1)}ms`,
            hint: "按 16.6ms@60fps 计",
          },
          {
            icon: ZoomIn,
            label: "吞吐",
            value: `${((count * 80 * hud.fps) / 1048576).toFixed(0)}MB/s`,
            hint: "实例缓冲上传带宽",
          },
        ].map((m) => (
          <Card key={m.label} className="border-zinc-800 bg-zinc-900/60 p-4">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <m.icon className="h-3.5 w-3.5 text-amber-400/80" />
              {m.label}
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-zinc-100">{m.value}</div>
            <div className="text-[10px] text-zinc-600">{m.hint}</div>
          </Card>
        ))}
      </div>

      {/* 报告 */}
      <ReportSection
        benchRows={benchRows}
        particleCount={count}
        kernelInfo={kernelInfo}
      />
    </div>
  );
}
