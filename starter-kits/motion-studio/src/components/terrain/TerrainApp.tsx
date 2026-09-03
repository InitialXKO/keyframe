"use client";

/**
 * 地形引擎 —— 数字表格 → 可交互三维空间景象
 *
 * 数据源：kylecorry31/Trail-Sense-Earth-Model dem-0.4.0-high
 * （BC 海岸山脉 · Mt. Waddington 冰原与峡湾，1024×1024 高程表格 + 水体掩膜）
 *
 * 渲染后端：WebGPU 主路径（VS 高程位移分块 + compute 植被增殖 + 间接绘制）
 * → WebGL2 回退（CPU 分块网格 + LRU 缓存）。两路共享相机与拾取数学。
 *
 * 交互：拖拽=环绕观察 · 滚轮/双指=推拉 · WASD=平移焦点 · 单击=射线求交拾取
 */

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ArrowDownToLine, Mountain, MousePointerClick, RotateCcw, Rocket } from "lucide-react";
import { loadTerrainTable, heightAt, type TerrainTable } from "@/lib/terrain/table";
import { curvatureDrop, latLonToPlanar, wrap180 } from "@/lib/terrain/planet";
import { cameraBasis } from "@/lib/terrain/camera";
import { TerrainStream } from "@/lib/terrain/stream";
import { TerrainRenderer, type CameraState, type PickResult } from "@/lib/terrain/renderer";
import { WebGPUTerrainRenderer } from "@/lib/terrain/renderer-wgpu";

/** 相机距离范围：150m 近距 → 22,000km 轨道（可看到完整全球） */
const DIST_MIN = 150;
const DIST_MAX = 22000000;

/** 升空/着陆平滑动画的对数插值目标 */
interface AscAnim {
  t0: number;
  d0: number;
  d1: number;
  p0: number;
  p1: number;
  dur: number;
}

interface Controls {
  hour: number;
  wind: number;
  vegDensity: number;
  exagg: number;
  snowShift: number;
  cloud: number;
  showVeg: boolean;
  shadows: boolean;
  mist: boolean;
  detail: boolean;
  grass: boolean;
}

const DEFAULTS: Controls = {
  hour: 10.5,
  wind: 0.35,
  vegDensity: 0.55,
  exagg: 1,
  snowShift: 0,
  cloud: 0.4,
  showVeg: true,
  shadows: true,
  mist: true,
  detail: true,
  grass: true,
};

function bandLabel(p: PickResult): string {
  if (p.waterDepthM !== null || p.water !== 0 || p.elevM <= 0.2) return "低洼水体";
  if (p.elevM >= 2200) return "永久积雪带";
  if (p.elevM >= 1500 || p.slopeDeg > 34) return "裸岩带";
  if (p.elevM >= 240 && p.slopeDeg <= 34) return "土壤草甸带";
  return "低洼水体";
}

function aspectLabel(deg: number): string {
  const names = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return names[Math.round(((deg % 360) / 45)) % 8];
}

type Backend = TerrainRenderer | WebGPUTerrainRenderer;

export function TerrainApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [backend, setBackend] = useState<"webgpu" | "webgl2">("webgl2");
  const [ctl, setCtl] = useState<Controls>(DEFAULTS);
  const [pick, setPick] = useState<{ result: PickResult; coord: string } | null>(null);
  const [metaInfo, setMetaInfo] = useState<{ span: string; peak: string; region: string; source: string } | null>(null);

  const ctlRef = useRef(ctl);
  useEffect(() => {
    ctlRef.current = ctl;
  }, [ctl]);
  const rendererRef = useRef<Backend | null>(null);
  const tableRef = useRef<TerrainTable | null>(null);
  const streamRef = useRef<TerrainStream | null>(null);
  const camRef = useRef<CameraState>({ fx: 0, fz: 0, yaw: Math.PI, pitch: 0.5, dist: 26000, fovY: 0.96, aspect: 1.6 });
  const keysRef = useRef(new Set<string>());
  const fpsRef = useRef({ fps: 0, ema: 16 });
  const statsRef = useRef<HTMLSpanElement[]>([]);
  const ascRef = useRef<AscAnim | null>(null);
  const burstRef = useRef(0);
  const reanchorFnRef = useRef<(lat: number, lon: number, lvl?: number) => void>(() => {});
  const backendRef = useRef(backend);
  useEffect(() => {
    backendRef.current = backend;
  }, [backend]);

  /* ---------------- 初始化 ---------------- */
  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let cleanupFns: Array<() => void> = [];

    (async () => {
      try {
        const table = await loadTerrainTable((f) => {
          if (!disposed) setProgress(f);
        });
        if (disposed) return;
        tableRef.current = table;
        // 流式引擎：全球高程金字塔 → 1536² 窗口镜像（重锚定 + 逐级细化）
        const stream = new TerrainStream(table);
        streamRef.current = stream;
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const activeCanvas = () => glCanvasRef.current ?? canvas;
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        const resize = () => {
          const el = containerRef.current;
          const cv = activeCanvas();
          if (!el || !cv) return;
          const w = Math.max(2, Math.round(el.clientWidth * dpr));
          const h = Math.max(2, Math.round(el.clientHeight * dpr));
          cv.width = w;
          cv.height = h;
          camRef.current.aspect = w / Math.max(1, h);
        };

        /** WebGL2 回退：GPU canvas 仅能绑定一种上下文 → 换新画布替换（事件在容器层，无需重绑） */
        const switchToGL = (reason: string) => {
          if (rendererRef.current instanceof TerrainRenderer) return;
          const prev = rendererRef.current;
          if (prev) {
            try { prev.destroy(); } catch { /* 已销毁 */ }
          }
          rendererRef.current = null;
          canvas.style.display = "none";
          const glCanvas = document.createElement("canvas");
          glCanvas.className = "absolute inset-0 h-full w-full";
          container.appendChild(glCanvas);
          glCanvasRef.current = glCanvas;
          const glr = TerrainRenderer.create(glCanvas, table, streamRef.current ?? undefined);
          if (!glr) {
            setErrMsg("WebGPU 与 WebGL2 均不可用（此演示需要硬件加速图形）");
            setPhase("error");
            return;
          }
          rendererRef.current = glr;
          setBackend("webgl2");
          resize();
          console.warn(`[terrain] 已回退 WebGL2（${reason}）`);
        };

        // ---- WebGPU 主路径优先；初始化失败 / 运行期故障均自动回退 WebGL2 ----
        const gpu = await WebGPUTerrainRenderer.create(canvas, table, (reason) => switchToGL(reason), streamRef.current);
        if (disposed) {
          gpu?.destroy();
          return;
        }
        if (gpu) {
          rendererRef.current = gpu;
          setBackend("webgpu");
        } else {
          console.info("[terrain] navigator.gpu 不可用，直接使用 WebGL2 回退");
          switchToGL("no-webgpu");
          if (rendererRef.current instanceof TerrainRenderer === false) return;
        }

        const spanKmX = (table.spanX / 1000).toFixed(0);
        const spanKmZ = (table.spanZ / 1000).toFixed(0);
        const refreshMeta = () => {
          const st = streamRef.current!;
          const t = st.table;
          const b = t.meta.bounds;
          setMetaInfo({
            span: `${t.w}×${t.h} 格 · 实地 ${(t.spanZ / 1000).toFixed(0)}km×${(t.spanX / 1000).toFixed(0)}km · ${b.latN.toFixed(1)}°~${b.latS.toFixed(1)}°`,
            peak: `${Math.round(t.maxH)} m`,
            region: t.meta.region,
            source: t.meta.source.slice(0, 58),
          });
        };
        refreshMeta();
        reanchorFnRef.current = (lat: number, lon: number, lvl?: number) => {
          const st = streamRef.current!;
          st.reanchor(lat, lon, lvl);
          if (lvl === undefined) {
            // 平移/预设重锚定：窗口中心移到焦点 → 新坐标系下焦点归位原点附近
            const [nfx, nfz] = latLonToPlanar(st.table.meta.bounds, st.table.spanX, st.table.spanZ, lat, lon);
            camRef.current.fx = nfx;
            camRef.current.fz = nfz;
          }
          // 层级切换（lvl 提供且窗口中心不变）：坐标语义不变，保持焦点 fx/fz 不跳变
          rendererRef.current?.onWindowChanged();
          rendererRef.current?.clearMarker();
          setPick(null);
          burstRef.current = 90;
          refreshMeta();
        };

        // ---- 尺寸自适应 ----
        resize();
        const ro = new ResizeObserver(resize);
        if (containerRef.current) ro.observe(containerRef.current);
        cleanupFns.push(() => ro.disconnect());

        // ---- 相机交互（绑定容器：后端画布替换时无需重绑） ----
        let dragging = false;
        let moved = 0;
        let lastX = 0;
        let lastY = 0;
        const pointers = new Map<number, { x: number; y: number }>();
        let pinchD0 = 0;
        let dist0 = 0;

        const onDown = (e: PointerEvent) => {
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          ascRef.current = null;
          if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinchD0 = Math.hypot(a.x - b.x, a.y - b.y);
            dist0 = camRef.current.dist;
          }
          dragging = true;
          moved = 0;
          lastX = e.clientX;
          lastY = e.clientY;
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            /* 合成事件（QA）无真实 pointerId，忽略 */
          }
        };
        const onMove = (e: PointerEvent) => {
          if (!pointers.has(e.pointerId)) return;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 2 && pinchD0 > 0) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            camRef.current.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, (dist0 * pinchD0) / Math.max(20, d)));
            ascRef.current = null;
            return;
          }
          if (!dragging) return;
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          moved += Math.abs(dx) + Math.abs(dy);
          lastX = e.clientX;
          lastY = e.clientY;
          camRef.current.yaw -= dx * 0.005;
          camRef.current.pitch = Math.min(1.56, Math.max(0.08, camRef.current.pitch + dy * 0.004));
          ascRef.current = null;
        };
        const onUp = (e: PointerEvent) => {
          pointers.delete(e.pointerId);
          if (pointers.size < 2) pinchD0 = 0;
          if (dragging && moved < 6) {
            // 单击 → 射线求交拾取
            const rect = container.getBoundingClientRect();
            const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
            const r = rendererRef.current;
            if (r) {
              const hit = r.pick(ndcX, ndcY, camRef.current, ctlRef.current.exagg, ctlRef.current.detail ? 1 : 0);
              if (hit) {
                r.setMarker(hit.x, hit.z, hit.elevM < 0 ? 0 : hit.elevM, ctlRef.current.exagg);
                setPick({ result: hit, coord: pickCoordLabel(tableRef.current, hit) });
              } else {
                r.clearMarker();
                setPick(null);
              }
            }
          }
          if (pointers.size === 0) dragging = false;
        };
        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          camRef.current.dist = Math.min(
            DIST_MAX,
            Math.max(DIST_MIN, camRef.current.dist * Math.exp(e.deltaY * 0.0016)),
          );
          ascRef.current = null;
        };
        const onKey = (e: KeyboardEvent, down: boolean) => {
          const tag = (e.target as HTMLElement)?.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA") return;
          const k = e.key.toLowerCase();
          if (down) keysRef.current.add(k);
          else keysRef.current.delete(k);
        };
        const kd = (e: KeyboardEvent) => onKey(e, true);
        const ku = (e: KeyboardEvent) => onKey(e, false);
        container.addEventListener("pointerdown", onDown);
        container.addEventListener("pointermove", onMove);
        container.addEventListener("pointerup", onUp);
        container.addEventListener("pointercancel", onUp);
        container.addEventListener("wheel", onWheel, { passive: false });
        window.addEventListener("keydown", kd);
        window.addEventListener("keyup", ku);
        cleanupFns.push(() => {
          container.removeEventListener("pointerdown", onDown);
          container.removeEventListener("pointermove", onMove);
          container.removeEventListener("pointerup", onUp);
          container.removeEventListener("pointercancel", onUp);
          container.removeEventListener("wheel", onWheel);
          window.removeEventListener("keydown", kd);
          window.removeEventListener("keyup", ku);
        });

        setPhase("ready");
        // QA 钩子（agent-browser 诊断用）
        (window as unknown as Record<string, unknown>).__terrain = {
          get renderer() { return rendererRef.current; },
          get stream() { return streamRef.current; },
          camRef,
          table,
          get backend() { return backendRef.current; },
        };

        // ---- 主循环 ----
        let last = performance.now();
        let hudT = 0;
        const loop = (now: number) => {
          if (disposed) return;
          raf = requestAnimationFrame(loop);
          const dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          fpsRef.current.ema = fpsRef.current.ema * 0.9 + dt * 1000 * 0.1;
          fpsRef.current.fps = 1000 / Math.max(1, fpsRef.current.ema);

          // WASD 平移焦点（浮动原点：世界反向移动；轨道尺度下平移速度钳制）
          const r = rendererRef.current;
          const cam = camRef.current;
          const keys = keysRef.current;
          const panSpeed = Math.min(cam.dist, 12000) * 0.55 * dt;
          const sy = Math.sin(cam.yaw);
          const cy = Math.cos(cam.yaw);
          let mx = 0;
          let mz = 0;
          if (keys.has("w")) mz -= 1;
          if (keys.has("s")) mz += 1;
          if (keys.has("a")) mx -= 1;
          if (keys.has("d")) mx += 1;
          if (mx || mz) {
            const len = Math.hypot(mx, mz);
            cam.fx += ((mx / len) * cy - (mz / len) * sy) * panSpeed;
            cam.fz += ((mx / len) * sy + (mz / len) * cy) * panSpeed;
            const t = tableRef.current!;
            cam.fx = Math.min(t.spanX / 2, Math.max(-t.spanX / 2, cam.fx));
            cam.fz = Math.min(t.spanZ / 2, Math.max(-t.spanZ / 2, cam.fz));
          }

          // ---- 流式引擎：海拔 → 层级窗口状态机（换层无缝）；焦点离窗 → 重锚定；
          //      瓦片泵 → 纹理增量上传；细化完成 → 重建缓存 ----
          const stream = streamRef.current;
          if (stream) {
            const tb0 = tableRef.current;
            if (tb0) {
              const cb0 = cameraBasis(cam, tb0, ctlRef.current.exagg);
              stream.setEyeAlt(
                Math.max(0, cb0.eye[1] - (heightAt(tb0, cb0.eye[0], cb0.eye[2]) * ctlRef.current.exagg - curvatureDrop(cb0.eye[0], cb0.eye[2]))),
              );
            }
            const lvlReq = stream.pollLevelSwitch();
            if (lvlReq) {
              // 层级切换：窗口中心不动，旧层镜像无缝拷贝 → 可视区域随海拔换用最高可用分辨率
              reanchorFnRef.current(lvlReq[0], lvlReq[1], lvlReq[2]);
            } else if (stream.needsReanchor(cam.fx, cam.fz)) {
              const [lat, lon] = stream.localToLatLon(cam.fx, cam.fz);
              reanchorFnRef.current(lat, lon);
            }
            const rects = stream.update();
            if (r && rects.length > 0) r.syncWindow(rects);
            // 全窗细化完成 → 数据版本递增（块缓存陈旧重建）：给突发预算加速自愈，
            // 期间陈旧网格续绘（同纪元）→ 无球体闪断、无精度悬崖
            if (stream.consumeRefine()) burstRef.current = 90;
          }
          if (r) {
            const b2 = burstRef.current;
            r.setBurst(b2 > 0 ? 16 : 3);
            if (b2 > 0) burstRef.current = b2 - 1;
          }

          // 升空/着陆平滑动画（对数距离插值 + 缓动俯仰）
          if (ascRef.current) {
            const a = ascRef.current;
            const p = Math.min(1, (now - a.t0) / a.dur);
            const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
            camRef.current.dist = Math.exp(Math.log(a.d0) * (1 - e) + Math.log(a.d1) * e);
            camRef.current.pitch = a.p0 + (a.p1 - a.p0) * e;
            if (p >= 1) ascRef.current = null;
          }

          const cv = activeCanvas();
          if (!r || !cv) return;
          const c = ctlRef.current;
          const stats = r.render(cam, {
            hour: c.hour,
            wind: c.wind,
            exagg: c.exagg,
            snowLineM: 2200 + c.snowShift,
            treeLineM: 1750 + c.snowShift * 0.7,
            vegDensity: c.vegDensity,
            cloudCover: c.cloud,
            showVeg: c.showVeg,
            shadows: c.shadows,
            mist: c.mist,
            detail: c.detail,
            grass: c.grass,
          }, cv.width, cv.height);

          hudT += dt;
          if (hudT > 0.3 && statsRef.current.length >= 8) {
            hudT = 0;
            const [fps, chunks, tris, veg, cache, built, altEl, modeEl] = statsRef.current;
            const isGPU = backendRef.current === "webgpu";
            fps.textContent = `${fpsRef.current.fps.toFixed(0)}`;
            chunks.textContent = `${stats.chunks}（${stats.byLevel.map((v, i) => `L${i - 3}:${v}`).join(" ")}）`;
            tris.textContent = `${(stats.tris / 1000).toFixed(0)}k`;
            veg.textContent = stats.grassCount > 0
              ? `${stats.vegCount.toLocaleString()}+${stats.grassCount.toLocaleString()}`
              : `${stats.vegCount.toLocaleString()}`;
            cache.textContent = isGPU ? "GPU直绘" : `${stats.meshCache}`;
            built.textContent = isGPU ? "—" : `${stats.built}`;
            if (statsRef.current[8]) {
              const st = streamRef.current;
              statsRef.current[8].textContent = st && st.l3Total > 0
                ? `L${st.winLvl} ${Math.min(100, Math.round((st.l3Ready / st.l3Total) * 100))}%`
                : "—";
            }
            // 海拔（高于弯曲地表）+ 观测模式
            const tb = tableRef.current;
            if (tb) {
              const b = cameraBasis(cam, tb, ctlRef.current.exagg);
              const alt = Math.max(0, b.eye[1] - (heightAt(tb, b.eye[0], b.eye[2]) * ctlRef.current.exagg - curvatureDrop(b.eye[0], b.eye[2])));
              altEl.textContent = alt >= 1000000
                ? `${(alt / 1000).toFixed(0)} km`
                : alt >= 10000
                  ? `${(alt / 1000).toFixed(1)} km`
                  : `${alt.toFixed(0)} m`;
              modeEl.textContent = alt < 30 ? "地面" : alt < 3000 ? "低空" : alt < 30000 ? "高空" : alt < 400000 ? "亚轨道" : "轨道";
            }
          }
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        console.error("[terrain] 初始化失败:", e);
        setErrMsg(String(e));
        setPhase("error");
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanupFns.forEach((f) => f());
      rendererRef.current?.destroy();
      rendererRef.current = null;
      glCanvasRef.current?.remove();
      glCanvasRef.current = null;
    };
  }, []);

  const presets: Array<{ name: string; anchor?: [number, number]; cam: Partial<CameraState>; hour?: number }> = [
    { name: "冰原峰顶", cam: { fx: -2000, fz: -3000, yaw: Math.PI * 0.85, pitch: 0.42, dist: 15000 } },
    { name: "峡湾深处", cam: { fx: -105000, fz: 150000, yaw: Math.PI * 0.75, pitch: 0.55, dist: 14000 } },
    { name: "清晨峡湾", cam: { fx: -105000, fz: 150000, yaw: Math.PI * 0.68, pitch: 0.5, dist: 16000 }, hour: 6.25 },
    { name: "海岸全景", cam: { fx: -90000, fz: -40000, yaw: Math.PI * 1.3, pitch: 0.9, dist: 52000 } },
    { name: "林间近景", cam: { fx: -26465, fz: -148028, yaw: Math.PI * 1.5, pitch: 0.26, dist: 850 } },
    { name: "珠峰北坡", anchor: [28.06, 86.95], cam: { fx: 0, fz: -9000, yaw: Math.PI * 0.95, pitch: 0.38, dist: 42000 } },
    { name: "马特洪峰", anchor: [45.93, 7.85], cam: { fx: 0, fz: -4000, yaw: Math.PI * 1.05, pitch: 0.42, dist: 30000 } },
    { name: "迪纳利", anchor: [63.06, -151.3], cam: { fx: 0, fz: -6000, yaw: Math.PI, pitch: 0.45, dist: 38000 } },
    { name: "轨道俯瞰", cam: { fx: 0, fz: 0, yaw: Math.PI, pitch: 1.25, dist: 9000000 } },
  ];

  const BC_ANCHOR: [number, number] = [51.37083, -125.2625];
  const applyPreset = (p: (typeof presets)[number]) => {
    const st = streamRef.current;
    if (st) {
      const target: [number, number] = p.anchor ?? BC_ANCHOR;
      const cur = st.table.meta.centerLatLon;
      if (Math.abs(cur[0] - target[0]) > 0.005 || Math.abs(wrap180(cur[1] - target[1])) > 0.005) {
        reanchorFnRef.current(target[0], target[1]);
      }
    }
    Object.assign(camRef.current, p.cam);
    if (p.hour !== undefined) setCtl((c) => ({ ...c, hour: p.hour! }));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]" data-testid="terrain-app">
      {/* 画布区 */}
      <div className="space-y-3">
        <div
          ref={containerRef}
          className="relative h-[420px] touch-none overflow-hidden rounded-xl border border-zinc-800 bg-black sm:h-[520px]"
          data-testid="terrain-viewport"
        >
          <canvas ref={canvasRef} className="h-full w-full" data-testid="terrain-canvas" />
          {phase === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/90 text-sm text-zinc-400">
              <Mountain className="h-8 w-8 animate-pulse text-amber-400" />
              <span>下载高程数值表格（bc-coast 3.0MB + earth 全球拼接 8.3MB）…</span>
              <span className="text-[10px] text-zinc-600">随后按相机位置流式细化全球金字塔瓦片（15″ ≈ 450m）</span>
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-amber-500 transition-[width] duration-200"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                  data-testid="terrain-progress"
                />
              </div>
              <span className="font-mono text-xs text-zinc-600">{Math.round(progress * 100)}%</span>
            </div>
          )}
          {phase === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/95 p-6 text-center text-sm text-rose-400">
              <span className="font-semibold">地形引擎初始化失败</span>
              <span className="text-xs text-zinc-500">{errMsg}</span>
            </div>
          )}
          {/* HUD 角标 */}
          {phase === "ready" && (
            <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5 text-[10px]">
              <span
                className={`rounded bg-black/60 px-1.5 py-0.5 font-mono backdrop-blur ${backend === "webgpu" ? "text-emerald-400" : "text-amber-400"}`}
                data-testid="terrain-backend"
              >
                {backend === "webgpu" ? "WebGPU · GPU直绘" : "WebGL2 回退"}
              </span>
              <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-amber-400 backdrop-blur">
                <span ref={(el) => { statsRef.current[0] = el!; }} data-testid="terrain-fps">60</span> FPS
              </span>
              <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-zinc-300 backdrop-blur">
                分块 <span ref={(el) => { statsRef.current[1] = el!; }} data-testid="terrain-chunks">—</span>
              </span>
              <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-zinc-300 backdrop-blur">
                △ <span ref={(el) => { statsRef.current[2] = el!; }} data-testid="terrain-tris">—</span>
              </span>
              <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-zinc-300 backdrop-blur">
                植被 <span ref={(el) => { statsRef.current[3] = el!; }} data-testid="terrain-veg">—</span>
              </span>
              <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-sky-300 backdrop-blur" data-testid="terrain-alt-wrap">
                高度 <span ref={(el) => { statsRef.current[6] = el!; }} data-testid="terrain-alt">—</span>
              </span>
              <span
                className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-amber-300 backdrop-blur"
                data-testid="terrain-mode"
              >
                <span ref={(el) => { statsRef.current[7] = el!; }}>—</span>
              </span>
              <span
                className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-violet-300 backdrop-blur"
                data-testid="terrain-region"
              >
                {metaInfo?.region ?? "—"}
              </span>
              <span className="hidden rounded bg-black/60 px-1.5 py-0.5 font-mono text-violet-300 backdrop-blur sm:inline">
                窗口流 <span ref={(el) => { statsRef.current[8] = el!; }} data-testid="terrain-stream">—</span>
              </span>
              <span className="hidden rounded bg-black/60 px-1.5 py-0.5 font-mono text-zinc-500 backdrop-blur sm:inline">
                缓存 <span ref={(el) => { statsRef.current[4] = el!; }}>—</span> · 新建/帧 <span ref={(el) => { statsRef.current[5] = el!; }}>—</span>
              </span>
            </div>
          )}
          {/* 拾取信息卡 */}
          {pick && (
            <div
              className="absolute bottom-3 left-3 rounded-lg border border-amber-500/30 bg-black/75 p-2.5 text-[11px] backdrop-blur"
              data-testid="terrain-pick-card"
            >
              <div className="mb-1 flex items-center gap-1 font-semibold text-amber-400">
                <MousePointerClick className="h-3 w-3" /> 射线求交 · 表面解析
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-zinc-300">
                <span className="text-zinc-500">海拔</span>
                <span data-testid="terrain-pick-elev">
                  {pick.result.waterDepthM !== null
                    ? `海面 0 m（海床 −${pick.result.waterDepthM.toFixed(0)} m）`
                    : `${pick.result.elevM.toFixed(0)} m`}
                </span>
                <span className="text-zinc-500">坡度/坡向</span>
                <span>
                  {pick.result.slopeDeg.toFixed(1)}° · {aspectLabel(pick.result.aspectDeg)}坡
                </span>
                <span className="text-zinc-500">物质带</span>
                <span className="text-emerald-400">{bandLabel(pick.result)}</span>
                <span className="text-zinc-500">经纬度</span>
                <span>{pick.coord}</span>
              </div>
            </div>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          拖拽环绕 · 滚轮/双指推拉（150m 近距 ↔ 22,000km 轨道） · <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 font-mono">W A S D</kbd> 平移焦点 ·
          单击任意位置进行射线-数字表面求交（返回真实海拔/坡向/物质带）。
          引擎支持全地形数据无缝拼接：全球 0.125° 底座 → 流式金字塔（60″/30″/15″ 瓦片）按相机位置逐级细化到 450m 分辨率，
          焦点移动时窗口自动重锚定（L0 瞬时预填充 → 高精度瓦片流入），任意地点均可展开近景细节体系（亚像元细分/浮雕带/实例树/草丛/射线拾取）；
          地形表面按真实地球曲率弯曲，与全球球体在覆盖边界逐点重合无缝衔接，升空可见行星星缘与星空。无任何预存形状或贴图。
        </p>
      </div>

      {/* 控制台 */}
      <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4" data-testid="terrain-console">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Mountain className="h-4 w-4 text-amber-400" /> 地形引擎控制台
          </h3>
          <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-400">
            DEM 0.4.0-high
          </Badge>
        </div>
        {metaInfo && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 text-[11px] leading-relaxed text-zinc-400">
            <div className="font-semibold text-zinc-300">{metaInfo.region}</div>
            <div className="font-mono text-[10px] text-zinc-500">{metaInfo.span} · 峰顶 {metaInfo.peak}</div>
            <div className="mt-1 font-mono text-[10px] text-zinc-600">
              {metaInfo.source}…
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-zinc-400">时刻（太阳弧线）</Label>
            <span className="font-mono text-amber-400" data-testid="terrain-hour-val">
              {fmtHour(ctl.hour)}
            </span>
          </div>
          <Slider
            value={[ctl.hour]}
            min={5}
            max={21}
            step={0.25}
            onValueChange={(v) => setCtl((c) => ({ ...c, hour: v[0] }))}
            data-testid="terrain-hour"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-zinc-400">风力（波浪/树摇/云速）</Label>
            <span className="font-mono text-amber-400">{(ctl.wind * 100).toFixed(0)}%</span>
          </div>
          <Slider value={[ctl.wind]} min={0} max={1} step={0.05} onValueChange={(v) => setCtl((c) => ({ ...c, wind: v[0] }))} />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-zinc-400">雪线季节偏移</Label>
            <span className="font-mono text-amber-400">{ctl.snowShift >= 0 ? "+" : ""}{ctl.snowShift} m</span>
          </div>
          <Slider
            value={[ctl.snowShift]}
            min={-500}
            max={400}
            step={25}
            onValueChange={(v) => setCtl((c) => ({ ...c, snowShift: v[0] }))}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-zinc-400">云量（含地表云影）</Label>
            <span className="font-mono text-amber-400">{(ctl.cloud * 100).toFixed(0)}%</span>
          </div>
          <Slider value={[ctl.cloud]} min={0} max={1} step={0.05} onValueChange={(v) => setCtl((c) => ({ ...c, cloud: v[0] }))} />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-zinc-400">植被密度</Label>
            <span className="font-mono text-amber-400">{(ctl.vegDensity * 100).toFixed(0)}%</span>
          </div>
          <Slider
            value={[ctl.vegDensity]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={(v) => setCtl((c) => ({ ...c, vegDensity: v[0] }))}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <Label className="text-zinc-400">垂直夸张</Label>
            <span className="font-mono text-amber-400">×{ctl.exagg.toFixed(1)}</span>
          </div>
          <Slider
            value={[ctl.exagg]}
            min={1}
            max={3}
            step={0.1}
            onValueChange={(v) => setCtl((c) => ({ ...c, exagg: v[0] }))}
          />
          <p className="text-[10px] text-zinc-600">×1.0 = 物理真实尺度（默认）</p>
        </div>

        <div className="flex items-center justify-between text-xs">
          <Label className="text-zinc-400">植被增殖</Label>
          <Switch checked={ctl.showVeg} onCheckedChange={(v) => setCtl((c) => ({ ...c, showVeg: v }))} />
        </div>

        <div className="flex items-center justify-between text-xs">
          <div>
            <Label className="text-zinc-400">近景浮雕</Label>
            <p className="text-[10px] text-zinc-600">几何位移 + 浮雕法线 + 凹腔 AO</p>
          </div>
          <Switch
            checked={ctl.detail}
            onCheckedChange={(v) => setCtl((c) => ({ ...c, detail: v }))}
            data-testid="terrain-detail"
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <div>
            <Label className="text-zinc-400">近景草丛</Label>
            <p className="text-[10px] text-zinc-600">草甸带 750m 增殖 · 风摇/逆光</p>
          </div>
          <Switch
            checked={ctl.grass}
            onCheckedChange={(v) => setCtl((c) => ({ ...c, grass: v }))}
            data-testid="terrain-grass"
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <div>
            <Label className="text-zinc-400">山体阴影</Label>
            <p className="text-[10px] text-zinc-600">高度场光线步进（山影落谷/落海）</p>
          </div>
          <Switch
            checked={ctl.shadows}
            onCheckedChange={(v) => setCtl((c) => ({ ...c, shadows: v }))}
            data-testid="terrain-shadows"
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <div>
            <Label className="text-zinc-400">谷地晨雾</Label>
            <p className="text-[10px] text-zinc-600">清晨自动聚集 · 日升消散</p>
          </div>
          <Switch
            checked={ctl.mist}
            onCheckedChange={(v) => setCtl((c) => ({ ...c, mist: v }))}
            data-testid="terrain-mist"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-zinc-400">升空 / 着陆（平滑过渡至轨道）</Label>
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-sky-700/60 px-1 text-[11px] text-sky-300 hover:border-sky-500/60 hover:text-sky-200"
              data-testid="terrain-ascend"
              onClick={() => {
                const cam = camRef.current;
                ascRef.current = { t0: performance.now(), d0: Math.max(cam.dist, 1500), d1: 22000000, p0: cam.pitch, p1: 1.35, dur: 9000 };
              }}
            >
              <Rocket className="mr-1 h-3 w-3" /> 升空至轨道
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 border-emerald-800/60 px-1 text-[11px] text-emerald-300 hover:border-emerald-500/60 hover:text-emerald-200"
              data-testid="terrain-land"
              onClick={() => {
                const cam = camRef.current;
                ascRef.current = { t0: performance.now(), d0: Math.max(cam.dist, 1500), d1: 2600, p0: cam.pitch, p1: 0.5, dur: 8000 };
              }}
            >
              <ArrowDownToLine className="mr-1 h-3 w-3" /> 着陆
            </Button>
          </div>
          <p className="text-[10px] text-zinc-600">从眼部高度平滑升至 22,000km 轨道俯瞰全球，全程连续无切换；任意拖拽/滚轮可随时接管。</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-zinc-400">视角预设</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {presets.map((p) => (
              <Button
                key={p.name}
                size="sm"
                variant="outline"
                className="h-7 border-zinc-700 px-1 text-[10px] hover:border-amber-500/50 hover:text-amber-400"
                data-testid={`terrain-preset-${p.name}`}
                onClick={() => applyPreset(p)}
              >
                {p.name}
              </Button>
            ))}
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="w-full border-zinc-700 text-[11px] hover:border-amber-500/50 hover:text-amber-400"
          data-testid="terrain-reset"
          onClick={() => {
            setCtl(DEFAULTS);
            Object.assign(camRef.current, { fx: 0, fz: 0, yaw: Math.PI, pitch: 0.5, dist: 26000 });
            rendererRef.current?.clearMarker();
            setPick(null);
          }}
        >
          <RotateCcw className="mr-1 h-3 w-3" /> 重置全部
        </Button>
      </div>
    </div>
  );
}

function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function pickCoordLabel(table: TerrainTable | null, p: PickResult): string {
  if (!table) return "—";
  const m = table.meta.bounds;
  const i = p.x / table.spanX + 0.5;
  const j = p.z / table.spanZ + 0.5;
  const lon = m.lonW + i * (m.lonE - m.lonW);
  const lat = m.latN + j * (m.latS - m.latN);
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? "E" : "W"}`;
}
