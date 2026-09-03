"use client";

/**
 * BenchmarkCompare — KeyForge engine vs native WAAPI (element.animate).
 *
 * Same stage, same node count, same 2600ms wave keyframes — run SEQUENTIALLY
 * on an otherwise idle main loop (the parent suspends its own stress lab
 * while the bench runs, so both phases fight only for the same budget).
 *
 * Honest-reporting design: WAAPI animations can be promoted to the browser's
 * compositor thread, so at high instance counts it may out-render the engine's
 * JS evaluate + DOM write path. The verdict copy spells out the trade-off:
 * the engine's edge is programmability (per-instance retarget, scrubbing,
 * custom easing math), not raw compositor throughput.
 */

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Engine } from "@/lib/keyframe/builder/engine";
import { Clip, Instance, Keyframe, TransformBuilder, Easing } from "@/lib/keyframe";
import { domAdapter } from "@/lib/keyframe/dom_binder";

const STAGE_W = 960;
const STAGE_H = 220;
const LOOP_MS = 2600;
const BENCH_MS = 2500;

type Phase = "idle" | "engine" | "waapi";

interface BenchResult {
  n: number;
  engineFps: number;
  waapiFps: number;
  engineEvalMs: number;
  engineApplyMs: number;
}

export function BenchmarkCompare({ suspendMain }: { suspendMain: (v: boolean) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(250);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<BenchResult | null>(null);
  const cancelled = useRef(false);

  // responsive scale
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const inner = stageRef.current;
      if (inner) inner.style.transform = `scale(${el.clientWidth / STAGE_W})`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => { cancelled.current = true; }, []);

  const measureFps = (ms: number) =>
    new Promise<number>((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = (now: number) => {
        frames++;
        if (now - start >= ms) resolve((frames * 1000) / (now - start));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  /** engine phase — same wave clip as the main lab, returns accumulated timings */
  const runEnginePhase = (n: number) => {
    const host = stageRef.current;
    if (!host) return { stop: () => {}, stats: () => ({ evalMs: 0, applyMs: 0 }) };

    const engine = new Engine();
    (engine as unknown as { prepared: boolean }).prepared = true;
    const clip = new Clip("flow")
      .duration(LOOP_MS)
      .iterations(Infinity)
      .addKeyframe(
        new Keyframe(0)
          .transform(new TransformBuilder().translate(0, 0, 0).scale(0.7).rotateZ(0).origin(7, 7, 0).build())
          .opacity(0.25)
          .easing(Easing.EaseInOut)
      )
      .addKeyframe(
        new Keyframe(LOOP_MS / 2)
          .transform(new TransformBuilder().translate(150, -60, 0).scale(1.35).rotateZ(180).origin(7, 7, 0).build())
          .opacity(0.95)
          .easing(Easing.EaseInOut)
      )
      .addKeyframe(
        new Keyframe(LOOP_MS)
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
        new Instance("flow", `b_${i}`)
          .delay(-((c * 37 + r * 91) % LOOP_MS))
          .initialTransform(
            new TransformBuilder()
              .translate(24 + c * cellW + Math.max(0, (cellW - 14) / 2), 12 + r * cellH + Math.max(0, (cellH - 14) / 2), 0)
              .origin(7, 7, 0)
              .build()
          )
      );
    }
    engine.addInstances(insts);

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

    let raf = 0;
    let accEval = 0;
    let accApply = 0;
    let accFrames = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) % LOOP_MS;
      const e0 = performance.now();
      engine.evaluateFrame(t);
      const e1 = performance.now();
      domAdapter.batchApply(nodes, t, { engine });
      const e2 = performance.now();
      accEval += e1 - e0;
      accApply += e2 - e1;
      accFrames++;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return {
      stop: () => {
        cancelAnimationFrame(raf);
      },
      stats: () => ({
        evalMs: accEval / Math.max(1, accFrames),
        applyMs: accApply / Math.max(1, accFrames),
      }),
    };
  };

  /** WAAPI phase — identical keyframes/geometry via element.animate() */
  const runWaapiPhase = (n: number) => {
    const host = stageRef.current;
    if (!host) return () => {};
    host.innerHTML = "";
    const anims: Animation[] = [];
    const cols = Math.max(1, Math.ceil(Math.sqrt((n * STAGE_W) / STAGE_H)));
    const rows = Math.ceil(n / cols);
    const cellW = STAGE_W / cols;
    const cellH = STAGE_H / rows;

    const kf = [
      { transform: "translate(0px, 0px) scale(0.7) rotate(0deg)", opacity: 0.25, easing: "ease-in-out" },
      { transform: "translate(150px, -60px) scale(1.35) rotate(180deg)", opacity: 0.95, easing: "ease-in-out" },
      { transform: "translate(300px, 0px) scale(0.7) rotate(360deg)", opacity: 0.25 },
    ];

    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const d = document.createElement("div");
      const hue = (i * 47) % 60 + 20;
      d.style.cssText = `position:absolute;left:${24 + c * cellW + Math.max(0, (cellW - 14) / 2)}px;top:${12 + r * cellH + Math.max(0, (cellH - 14) / 2)}px;width:14px;height:14px;border-radius:5px;transform-origin:0 0;will-change:transform,opacity;background:hsl(${hue} 92% 58%);box-shadow:0 0 6px hsl(${hue} 92% 58% / 0.5)`;
      host.appendChild(d);
      anims.push(
        d.animate(kf, {
          duration: LOOP_MS,
          iterations: Infinity,
          delay: -((c * 37 + r * 91) % LOOP_MS),
        })
      );
    }
    return () => {
      anims.forEach((a) => a.cancel());
    };
  };

  const runBench = async () => {
    if (phase !== "idle") return;
    cancelled.current = false;
    setResult(null);
    suspendMain(true); // free the whole frame budget for the bench
    try {
      setPhase("engine");
      await new Promise((r) => setTimeout(r, 60)); // let the main loop actually stop
      const eng = runEnginePhase(count);
      const engineFps = await measureFps(BENCH_MS);
      const stats = eng.stats();
      eng.stop();

      if (cancelled.current) return;
      setPhase("waapi");
      if (stageRef.current) stageRef.current.innerHTML = "";
      await new Promise((r) => setTimeout(r, 60));
      const stopWaapi = runWaapiPhase(count);
      const waapiFps = await measureFps(BENCH_MS);
      stopWaapi();
      if (stageRef.current) stageRef.current.innerHTML = "";

      if (cancelled.current) return;
      setResult({
        n: count,
        engineFps,
        waapiFps,
        engineEvalMs: stats.evalMs,
        engineApplyMs: stats.applyMs,
      });
      setPhase("idle");
    } finally {
      suspendMain(false);
      if (cancelled.current) setPhase("idle");
    }
  };

  const maxFps = result ? Math.max(60, result.engineFps, result.waapiFps) : 60;
  const winner =
    result === null
      ? null
      : result.engineFps > result.waapiFps * 1.05
        ? "engine"
        : result.waapiFps > result.engineFps * 1.05
          ? "waapi"
          : "tie";
  const delta =
    result === null
      ? 0
      : Math.round(
          (Math.abs(result.engineFps - result.waapiFps) / Math.min(result.engineFps, result.waapiFps)) * 100
        );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" data-testid="bench-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FlaskConical className="h-4 w-4 text-sky-400" />
        <span className="text-sm font-semibold text-zinc-200">基准对比 · KeyForge 引擎 vs 浏览器 WAAPI</span>
        <span className="hidden text-[10px] text-zinc-600 sm:inline">
          同节点数 · 同关键帧 · 顺序各测 {(BENCH_MS / 1000).toFixed(1)}s
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {[100, 250, 500].map((n) => (
            <Button
              key={n}
              size="sm"
              variant={count === n ? "default" : "outline"}
              disabled={phase !== "idle"}
              onClick={() => setCount(n)}
              className={`h-7 px-2.5 text-xs ${count === n ? "bg-sky-500 text-black hover:bg-sky-400" : "border-zinc-800 bg-zinc-950"}`}
              data-testid={`bench-${n}`}
            >
              {n}
            </Button>
          ))}
          <Button
            size="sm"
            onClick={runBench}
            disabled={phase !== "idle"}
            className="h-7 bg-sky-500 px-2.5 text-xs text-black hover:bg-sky-400"
            data-testid="bench-run"
          >
            {phase === "idle" ? (
              <>
                <Play className="mr-1 h-3 w-3" /> 运行对比
              </>
            ) : (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                {phase === "engine" ? "引擎测试中…" : "WAAPI 测试中…"}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* bench stage */}
      <div
        ref={wrapRef}
        className="relative w-full overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-950"
        style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }}
        data-bench-stage
      >
        <div
          ref={stageRef}
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: STAGE_W, height: STAGE_H }}
        />
        {phase === "idle" && !result && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-zinc-600">
            点击「运行对比」— 先测引擎（JS 求值 + 批量 DOM 绑定），再测 WAAPI（可合成器加速）
          </div>
        )}
        <div
          className={`absolute left-2 top-2 rounded px-1.5 py-0.5 font-mono text-[10px] backdrop-blur transition-opacity ${
            phase !== "idle" ? "opacity-100" : "opacity-0"
          } ${phase === "engine" ? "bg-amber-500/20 text-amber-300" : "bg-sky-500/20 text-sky-300"}`}
          data-testid="bench-phase"
        >
          {phase === "engine" ? "PHASE A · KeyForge Engine" : phase === "waapi" ? "PHASE B · WAAPI" : ""}
        </div>
      </div>

      {/* results */}
      {result && (
        <div className="mt-3 space-y-2" data-testid="bench-result">
          <FpsBar
            label="KeyForge 引擎"
            fps={result.engineFps}
            maxFps={maxFps}
            colorClass="bg-amber-400"
            sub={`求值 ${result.engineEvalMs.toFixed(3)}ms + 绑定 ${result.engineApplyMs.toFixed(3)}ms / 帧`}
            testid="bench-engine-fps"
          />
          <FpsBar
            label="WAAPI element.animate"
            fps={result.waapiFps}
            maxFps={maxFps}
            colorClass="bg-sky-400"
            sub="浏览器原生动画（可合成器线程加速）"
            testid="bench-waapi-fps"
          />
          <p className="text-[11px] leading-relaxed text-zinc-500">
            {winner === "engine" && (
              <>
                <span className="font-medium text-amber-400">引擎领先 {delta}%</span>
                （{result.n} 实例）：JS 求值 + 批量 matrix3d 写入仍跑赢了原生动画。
              </>
            )}
            {winner === "tie" && (
              <>
                <span className="font-medium text-zinc-300">基本相当（差距 {delta}%）</span>
                ：{result.n} 实例时两条管线都能吃满垂直同步。
              </>
            )}
            {winner === "waapi" && (
              <>
                <span className="font-medium text-sky-400">WAAPI 领先 {delta}%</span>
                （{result.n} 实例）：纯回放场景浏览器合成器占优 —— 引擎的价值在于
                <span className="text-zinc-300">每实例可编程重定向</span>
                （逐帧改关键帧、自定义缓动、反向穿梭、批量烘焙），这是声明式动画给不了的。
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function FpsBar({
  label,
  fps,
  maxFps,
  colorClass,
  sub,
  testid,
}: {
  label: string;
  fps: number;
  maxFps: number;
  colorClass: string;
  sub: string;
  testid?: string;
}) {
  const pct = Math.min(100, (fps / maxFps) * 100);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className="font-mono text-xs text-zinc-200">
          <span className="text-base font-bold" data-testid={testid}>
            {fps.toFixed(0)}
          </span>{" "}
          fps
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full rounded ${colorClass} transition-[width] duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 text-[9px] text-zinc-600">{sub}</div>
    </div>
  );
}
