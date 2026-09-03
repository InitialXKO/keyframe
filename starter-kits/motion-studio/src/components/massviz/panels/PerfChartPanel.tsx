"use client";

/**
 * PerfChartPanel — 渲染性能流式遥测（ECharts 双轴折线）。
 *
 * 父组件以 ~10Hz 推入滚动窗口样本（最多 240 条），本组件职责边界：
 *  - useEffect 内 init ECharts；React ref 持有实例，卸载时 dispose
 *  - ResizeObserver 响应容器尺寸（0 尺寸时跳过 resize，防隐藏态告警）
 *  - setOption 增量合并 { notMerge: false, lazyUpdate: true, silent: true }
 *    —— silent 关闭整图鼠标命中检测，10Hz 流式更新零交互开销
 *    （因此不配置 tooltip：命中事件已被有意关闭）
 *
 * 左轴 ms：evalMs 实线 amber-400 / gpuMs 虚线 cyan-400；右轴 FPS：zinc-500 面积线。
 * 空数据时图表保持挂载，仅叠加骨架占位层（避免反复 init/dispose 抖动）。
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface PerfSample {
  /** 单调时间戳（ms，父组件语义：performance.now() 或演示起点偏移） */
  t: number;
  fps: number;
  evalMs: number;
  gpuMs: number;
}

export interface PerfChartPanelProps {
  /** 滚动窗口样本（父组件 ~10Hz 推入，最多 240 条） */
  samples: PerfSample[];
  /** 求值内核标签，如 "Rust WASM · fast-path" 或 "JS fallback" */
  kernelLabel: string;
  /** 渲染后端："WebGPU" | "WebGL2" | "未初始化" */
  backend: string;
  particleCount: number;
}

type ChartInstance = ReturnType<typeof echarts.init>;

const C = {
  evalLine: "#fbbf24", // amber-400
  gpuLine: "#22d3ee", // cyan-400
  fpsLine: "#71717a", // zinc-500
  fpsArea: "rgba(113, 113, 122, 0.14)",
  axis: "#27272a", // zinc-800
  name: "#52525b", // zinc-600
  label: "#71717a", // zinc-500
} as const;

function baseOption(): EChartsOption {
  return {
    animation: false,
    legend: {
      top: 0,
      right: 2,
      itemWidth: 14,
      itemHeight: 2,
      itemGap: 10,
      textStyle: { color: C.label, fontSize: 10 },
    },
    grid: { left: 4, right: 4, top: 24, bottom: 0, containLabel: true },
    xAxis: {
      type: "value",
      axisLine: { show: true, lineStyle: { color: C.axis } },
      axisTick: { show: false },
      axisLabel: {
        color: C.name,
        fontSize: 10,
        formatter: (v) => `${(Number(v) / 1000).toFixed(1)}s`,
      },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value",
        min: 0,
        name: "ms",
        nameTextStyle: { color: C.name, fontSize: 10, align: "left" },
        axisLabel: { color: C.name, fontSize: 10, formatter: (v) => `${Number(v)}` },
        splitLine: { show: true, lineStyle: { color: C.axis, type: "dashed" } },
      },
      {
        type: "value",
        min: 0,
        name: "fps",
        nameTextStyle: { color: C.name, fontSize: 10, align: "right" },
        axisLabel: { color: C.name, fontSize: 10, formatter: (v) => `${Number(v)}` },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "eval ms",
        type: "line",
        yAxisIndex: 0,
        data: [],
        showSymbol: false,
        lineStyle: { color: C.evalLine, width: 1.6 },
        itemStyle: { color: C.evalLine },
      },
      {
        name: "gpu ms",
        type: "line",
        yAxisIndex: 0,
        data: [],
        showSymbol: false,
        lineStyle: { color: C.gpuLine, width: 1.4, type: [4, 3] },
        itemStyle: { color: C.gpuLine },
      },
      {
        name: "FPS",
        type: "line",
        yAxisIndex: 1,
        data: [],
        showSymbol: false,
        lineStyle: { color: C.fpsLine, width: 1.2 },
        itemStyle: { color: C.fpsLine },
        areaStyle: { color: C.fpsArea },
      },
    ],
  };
}

export function PerfChartPanel({ samples, kernelLabel, backend, particleCount }: PerfChartPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);

  // init / dispose / resize —— 仅一次
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    chart.setOption(baseOption(), { notMerge: false, lazyUpdate: true, silent: true });

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) chart.resize();
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // 滚动窗口数据流 —— 增量合并，不重建坐标轴
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(
      {
        series: [
          { data: samples.map((s): [number, number] => [s.t, s.evalMs]) },
          { data: samples.map((s): [number, number] => [s.t, s.gpuMs]) },
          { data: samples.map((s): [number, number] => [s.t, s.fps]) },
        ],
      },
      { notMerge: false, lazyUpdate: true, silent: true }
    );
  }, [samples]);

  const backendTone =
    backend === "WebGPU"
      ? "border-cyan-500/40 text-cyan-300"
      : backend === "WebGL2"
        ? "border-amber-500/40 text-amber-300"
        : "border-zinc-700 text-zinc-500";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="text-xs font-semibold text-zinc-200">渲染性能 · 流式遥测</span>
        <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-300" title="当前求值内核">
          {kernelLabel}
        </Badge>
        <Badge variant="outline" className={`text-[10px] ${backendTone}`} title="渲染后端">
          {backend}
        </Badge>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400" title="渲染粒子规模">
          {particleCount.toLocaleString()} 粒子
        </Badge>
      </div>

      <div className="relative h-[220px] w-full" data-testid="perf-chart-panel">
        <div ref={containerRef} className="h-full w-full" />
        {samples.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-zinc-900/40">
            <div className="w-44 space-y-2">
              <div className="h-1.5 w-3/4 animate-pulse rounded bg-zinc-800" />
              <div className="h-1.5 w-full animate-pulse rounded bg-zinc-800/80 [animation-delay:150ms]" />
              <div className="h-1.5 w-1/2 animate-pulse rounded bg-zinc-800/60 [animation-delay:300ms]" />
            </div>
            <span className="text-[10px] text-zinc-600">等待性能采样流…</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default PerfChartPanel;
