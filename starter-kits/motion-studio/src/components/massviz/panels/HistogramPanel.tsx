"use client";

/**
 * HistogramPanel — 半径分布直方图（ECharts 柱状图，数据驱动聚合）。
 *
 * 32 个半径分布桶，柱色按桶索引从 amber-400 线性渐变到 cyan-400（跨桶色带）。
 * 坐标轴极简：x 轴仅保留淡 zinc 轴线与稀疏刻度，y 轴虚线网格。
 *
 * 规范与 PerfChartPanel 一致：useEffect 内 init、ref 持有实例、卸载 dispose、
 * ResizeObserver 响应尺寸、setOption { notMerge: false, lazyUpdate: true, silent: true }。
 *
 * 采样间隔读数：初始显示 "采样间隔 250ms"；updatedAt 连续两次到达后改为
 * 实测间隔（ref 直写 textContent，与 PerfLab 的零重渲染模式一致）。
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { BarChart3 } from "lucide-react";

export interface HistogramPanelProps {
  /** 32 个半径分布桶（数据驱动聚合） */
  bins: number[];
  /** 粒子总数 */
  total: number;
  /** 父组件最近一次聚合的 performance.now() 时间戳 */
  updatedAt: number;
}

type ChartInstance = ReturnType<typeof echarts.init>;

const AMBER_RGB: readonly [number, number, number] = [251, 191, 36]; // amber-400
const CYAN_RGB: readonly [number, number, number] = [34, 211, 238]; // cyan-400
const SAMPLING_FALLBACK_MS = 250;

const AXIS = "#27272a"; // zinc-800
const LABEL = "#52525b"; // zinc-600

function binColor(index: number, count: number): string {
  const f = count <= 1 ? 0 : index / (count - 1);
  const r = Math.round(AMBER_RGB[0] + (CYAN_RGB[0] - AMBER_RGB[0]) * f);
  const g = Math.round(AMBER_RGB[1] + (CYAN_RGB[1] - AMBER_RGB[1]) * f);
  const b = Math.round(AMBER_RGB[2] + (CYAN_RGB[2] - AMBER_RGB[2]) * f);
  return `rgb(${r},${g},${b})`;
}

function baseOption(): EChartsOption {
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 240,
    animationEasingUpdate: "linear",
    grid: { left: 4, right: 4, top: 10, bottom: 0, containLabel: true },
    xAxis: {
      type: "category",
      data: [],
      axisLine: { show: true, lineStyle: { color: AXIS } },
      axisTick: { show: false },
      axisLabel: { color: LABEL, fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: LABEL, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: AXIS, type: "dashed" } },
    },
    series: [
      {
        name: "粒子数",
        type: "bar",
        data: [],
        barCategoryGap: "18%",
        itemStyle: { borderRadius: [3, 3, 0, 0], borderWidth: 0 },
      },
    ],
  };
}

export function HistogramPanel({ bins, total, updatedAt }: HistogramPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);
  const lastUpdatedAtRef = useRef<number | null>(null);
  const intervalLabelRef = useRef<HTMLSpanElement>(null);

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

  // 桶数据流 —— 增量合并（含跨桶渐变色）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(
      {
        xAxis: { data: bins.map((_, i) => String(i)) },
        series: [
          {
            data: bins.map((v, i) => ({
              value: v,
              itemStyle: { color: binColor(i, bins.length) },
            })),
          },
        ],
      },
      { notMerge: false, lazyUpdate: true, silent: true }
    );
  }, [bins]);

  // 实测采样间隔 —— ref 直写文本，零 React 重渲染
  useEffect(() => {
    const prev = lastUpdatedAtRef.current;
    lastUpdatedAtRef.current = updatedAt;
    if (prev === null || !intervalLabelRef.current) return;
    const dt = Math.round(updatedAt - prev);
    if (dt > 0) intervalLabelRef.current.textContent = `采样间隔 ${dt}ms`;
  }, [updatedAt]);

  const empty = bins.length === 0 || total === 0;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <BarChart3 className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
        <span className="text-xs font-semibold text-zinc-200">半径分布 · 数据驱动聚合</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          {total.toLocaleString()} 粒子 ·{" "}
          <span ref={intervalLabelRef} data-testid="histogram-interval">
            采样间隔 {SAMPLING_FALLBACK_MS}ms
          </span>
        </span>
      </div>

      <div className="relative h-[220px] w-full" data-testid="histogram-panel">
        <div ref={containerRef} className="h-full w-full" />
        {empty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-zinc-900/40">
            <div className="flex h-14 items-end gap-1.5">
              {[10, 18, 26, 34, 26, 18, 10].map((h, i) => (
                <div
                  key={i}
                  className="w-2.5 animate-pulse rounded-t-sm bg-zinc-800"
                  style={{ height: `${h}px`, animationDelay: `${i * 90}ms` }}
                />
              ))}
            </div>
            <span className="text-[10px] text-zinc-600">等待半径聚合数据…</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default HistogramPanel;
