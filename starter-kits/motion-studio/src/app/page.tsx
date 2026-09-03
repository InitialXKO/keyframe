"use client";

/**
 * KeyForge Motion Studio — 杀手级应用主页
 * 基于 InitialXKO/keyframe 引擎构建的浏览器端动效设计工作台。
 *
 * Tabs: Studio（编辑器） / Performance Lab（性能实验室） / 战略评估报告
 */

import { useState } from "react";
import { Clapperboard, Compass, Gauge } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { StudioWorkspace } from "@/components/studio/StudioWorkspace";
import { PerfLab } from "@/components/studio/PerfLab";
import { ReportTab } from "@/components/studio/ReportTab";

export default function Home() {
  const [tab, setTab] = useState("studio");

  return (
    <div className="dark flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 font-black text-black shadow-lg shadow-amber-500/20">
            KF
            <span className="absolute -inset-px rounded-lg bg-gradient-to-br from-amber-400/60 to-orange-600/60 opacity-0 blur transition-opacity duration-500 hover:opacity-100" />
          </div>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-base font-bold leading-tight">
              KeyForge Motion Studio
              <Badge className="hidden border-amber-500/30 bg-amber-500/10 text-[9px] font-semibold text-amber-400 sm:inline-flex" variant="outline">
                Starter Kit
              </Badge>
            </h1>
            <p className="truncate text-[11px] text-zinc-500">
              Rust×WASM 关键帧内核驱动的 2D/3D 动效可视化设计工作台
            </p>
          </div>
          <div className="ml-auto hidden items-center gap-1.5 sm:flex">
            <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
              Zero-Copy Runtime
            </Badge>
            <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-400">
              MIT · InitialXKO/keyframe
            </Badge>
          </div>
        </div>
      </header>

      {/* main */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="mb-3 grid w-full max-w-xl grid-cols-3 bg-zinc-900">
            <TabsTrigger value="studio" className="gap-1.5 text-xs" data-testid="tab-studio">
              <Clapperboard className="h-3.5 w-3.5" /> 工作台
            </TabsTrigger>
            <TabsTrigger value="perf" className="gap-1.5 text-xs" data-testid="tab-perf">
              <Gauge className="h-3.5 w-3.5" /> 性能实验室
            </TabsTrigger>
            <TabsTrigger value="report" className="gap-1.5 text-xs" data-testid="tab-report">
              <Compass className="h-3.5 w-3.5" /> 评估报告
            </TabsTrigger>
          </TabsList>

          <TabsContent value="studio" className="mt-0">
            <StudioWorkspace />
          </TabsContent>

          <TabsContent value="perf" className="mt-0">
            <PerfLab />
          </TabsContent>

          <TabsContent value="report" className="mt-0">
            <ReportTab />
          </TabsContent>
        </Tabs>
      </main>

      {/* sticky footer */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-zinc-500">
          <span>
            KeyForge Motion Studio — 基于{" "}
            <a
              className="underline decoration-zinc-700 underline-offset-2 hover:text-amber-400"
              href="https://github.com/InitialXKO/keyframe"
              target="_blank"
              rel="noreferrer"
            >
              InitialXKO/keyframe
            </a>{" "}
            构建
          </span>
          <span className="hidden sm:inline">·</span>
          <span>空格播放 · ←→ 步进 · J/K/L 变速 · Ctrl+C/V 关键帧 ·</span>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("keyforge:shortcuts"))}
            className="inline-flex items-center gap-0.5 underline decoration-zinc-700 underline-offset-2 hover:text-amber-400"
            title="查看全部快捷键"
          >
            按 <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 font-mono text-[9px]">?</kbd> 查看全部快捷键
          </button>
          <span className="ml-auto font-mono">JS-Fallback Runtime · 80B/Instance Zero-Copy</span>
        </div>
      </footer>
    </div>
  );
}
