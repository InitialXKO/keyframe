"use client";

/**
 * ReportSection — 大规模可视化专项报告（与 studio/ReportTab 的阶段一/二评估互补，内容不重复）：
 * 板块一：Phase 3 集成评估（正确场景 / 架构分层 / 实测基准）；
 * 板块二：Phase 4 战略转型指导（定位跃迁 / 产品化路径 / 风险对冲 / 下一步路线）。
 */

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Blocks,
  BookOpen,
  Boxes,
  Braces,
  ChartLine,
  ChevronDown,
  Compass,
  Cpu,
  Film,
  FlaskConical,
  Gauge,
  GitPullRequest,
  LayoutGrid,
  MemoryStick,
  MonitorPlay,
  MonitorSmartphone,
  MoveRight,
  Network,
  Newspaper,
  Orbit,
  SearchX,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Timer,
  TriangleAlert,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type * as React from "react";

/* ---------------------------------- 接口 ---------------------------------- */

export interface BenchRow {
  /** 求值路径名称，如「WASM fast-path（自研）」 */
  label: string;
  /** 单帧全量求值耗时（ms），未实测为 null */
  evalMs: number | null;
  /** 实测帧率（fps），未实测为 null */
  fps: number | null;
  /** 备注（基线说明 / 优化点 / 护栏） */
  note: string;
}

export interface ReportSectionProps {
  /** 实测基准行（默认三行：JS 回退 / WASM 原版 / WASM fast-path，数值待填） */
  benchRows?: BenchRow[];
  /** 压测实例规模（默认 25000） */
  particleCount?: number;
  /** 内核构建信息（显示于头部） */
  kernelInfo?: string;
}

const DEFAULT_BENCH_ROWS: BenchRow[] = [
  {
    label: "JS 回退（vendor 路径）",
    evalMs: null,
    fps: null,
    note: "基线 · evaluateJSFrame，与 WASM 内核数学同构",
  },
  {
    label: "WASM 原版 evaluate_frame",
    evalMs: null,
    fps: null,
    note: "上游内核默认路径 · 含逐帧分配与边界检查",
  },
  {
    label: "WASM fast-path（自研）",
    evalMs: null,
    fps: null,
    note: "逐帧零分配 · 预解析轨道 · 预绑定内存指针直写",
  },
];

/* --------------------------------- 格式化 --------------------------------- */

function fmtMs(v: number | null): string {
  if (v === null) return "—";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(3);
}

function fmtFps(v: number | null): string {
  if (v === null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 吞吐 = 由单帧全量求值耗时反推的每秒实例·帧处理量 */
function fmtThroughput(particleCount: number, evalMs: number | null): string {
  if (evalMs === null || evalMs <= 0) return "—";
  const perSec = (particleCount * 1000) / evalMs;
  if (perSec >= 1e8) return `${(perSec / 1e8).toFixed(1)} 亿/s`;
  if (perSec >= 1e4) return `${(perSec / 1e4).toFixed(1)} 万/s`;
  return `${Math.round(perSec)} /s`;
}

/* ---------------------------------- 主组件 --------------------------------- */

export function ReportSection({
  benchRows = DEFAULT_BENCH_ROWS,
  particleCount = 25000,
  kernelInfo = "rust → wasm32-unknown-unknown 自编译 · 含自研 fast-path（逐帧零分配求值）",
}: ReportSectionProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* ------------------------------- 头部 ------------------------------- */}
      <Card className="border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-900/40">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Waypoints className="h-5 w-5 text-amber-400" />
            <CardTitle className="text-lg">
              大规模可视化动效层 · 集成评估与战略转型报告
            </CardTitle>
          </div>
          <CardDescription>
            Phase 3/4 专项 — 25k 粒子 × 20 关键帧 × 60fps（WebGPU）大规模演示的集成结论与产品化路线；
            与工作台「战略评估」标签页（阶段一/二：试用评估与编辑器产品化）互补，不重复覆盖。
          </CardDescription>
          <p
            data-testid="kernel-info"
            className="font-mono text-[11px] leading-relaxed text-zinc-500"
          >
            kernel: <span className="text-zinc-300">{kernelInfo}</span>
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="压测规模" v={`${particleCount.toLocaleString("en-US")} 实例`} tone="amber" />
          <Stat k="渲染层" v="WebGPU · WebGL2 回退" tone="cyan" />
          <Stat k="实例 ABI" v="80 B / 实例（零拷贝）" tone="amber" />
          <Stat k="分析喂频" v="~10 Hz 聚合 → ECharts/D3" tone="cyan" />
        </CardContent>
      </Card>

      {/* ------------------------------- 两大板块 ------------------------------ */}
      <Tabs defaultValue="phase3" className="gap-4">
        <TabsList className="h-9 w-full justify-start border border-zinc-800 bg-zinc-900/60 sm:w-fit">
          <TabsTrigger
            value="phase3"
            className="gap-1.5 border border-transparent px-3 text-zinc-400 data-[state=active]:border-zinc-700 data-[state=active]:bg-zinc-800 data-[state=active]:text-amber-300"
          >
            <Gauge className="h-3.5 w-3.5" />
            Phase 3 · 集成评估
          </TabsTrigger>
          <TabsTrigger
            value="phase4"
            className="gap-1.5 border border-transparent px-3 text-zinc-400 data-[state=active]:border-zinc-700 data-[state=active]:bg-zinc-800 data-[state=active]:text-amber-300"
          >
            <Compass className="h-3.5 w-3.5" />
            Phase 4 · 战略转型
          </TabsTrigger>
        </TabsList>

        {/* ============================ 板块一：集成评估 ============================ */}
        <TabsContent value="phase3" className="space-y-4 outline-none">
          {/* 1. 正确应用场景 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Orbit className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">一、正确应用场景（万级并行 · GPU 直写）</CardTitle>
              </div>
              <CardDescription className="text-xs">
                共同特征：元素数量大、逐实例参数独立、更新频率等于或接近帧率 —— 这正是 80B/实例
                GPU ABI 求值底座的甜点区。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ScenarioCard
                icon={Orbit}
                title="数据可视化大屏 · 粒子/流向/星系层"
                body="大屏底层的粒子、流体、星系动画层：万级元素 60fps 直写 GPU，统计图表之上的一层「活」背景。"
                tag="25k 实例已验证"
              />
              <ScenarioCard
                icon={ChartLine}
                title="图表叙事 · 背景动效层"
                body="ECharts 画统计、WASM + WebGPU 画氛围层，二者共享同一时间轴时钟 —— 图表强调与背景涌动逐帧同源。"
                tag="同源时间轴"
              />
              <ScenarioCard
                icon={Network}
                title="地理 / 网络拓扑流动模拟"
                body="25k 条边的流动动画（物流、飞线、依赖拓扑）：每条边一个实例变换，求值吞吐与边数线性可扩展。"
                tag="25k 边动画"
              />
              <ScenarioCard
                icon={LayoutGrid}
                title="数字孪生 · 大规模状态点阵"
                body="产线/园区/电网的万级状态点阵：关键帧驱动状态迁移动画，聚合统计降频喂给分析面板。"
                tag="万级状态点"
              />
              <ScenarioCard
                icon={MonitorPlay}
                title="演出 / 大屏 LED 实时内容"
                body="现场演出与 LED 巨幕的实时生成内容：本机 GPU 渲染零网络延迟，bake 管线可兜底离线素材。"
                tag="现场低延迟"
              />
              <ScenarioCard
                icon={FlaskConical}
                title="性能实验室式基准演示"
                body="把引擎吞吐变成可度量的卖点：规模滑杆 + 三管线对比（JS/WASM/烘焙），先证明再集成。"
                tag="可度量卖点"
              />
            </CardContent>
          </Card>

          {/* 2. 不适用/慎用场景 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">二、不适用 / 慎用场景（选型护栏）</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <CautionItem
                icon={Sparkles}
                title="少量精细 UI 元素动效"
                body="按钮、卡片、表单微交互：CSS / Framer Motion 更合适 —— 引擎的批量求值优势在小数量下无法兑现，反增集成成本。"
              />
              <CautionItem
                icon={MonitorSmartphone}
                title="依赖 SSR 首屏的页面"
                body="WebGPU 不可用时需回退路径启动（异步 init），首帧渲染无法参与 SSR 水合 —— 动效层必须按「渐进增强」设计。"
              />
              <CautionItem
                icon={SearchX}
                title="强 SEO 内容承载"
                body="渲染发生在 canvas/GPU 位图，爬虫不可见 —— 文字与关键信息必须留在 DOM 层，GPU 层只承担纯视觉。"
              />
              <CautionItem
                icon={Smartphone}
                title="低端老旧设备"
                body="无 WebGPU 且无 WebGL2 的环境直接不可用 —— 上线前必须做能力探测与静态降级（首帧海报帧 + 关闭动效层）。"
              />
            </CardContent>
          </Card>

          {/* 3. 集成方式架构 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">三、集成方式 · 分层架构（本项目已跑通）</CardTitle>
              </div>
              <CardDescription className="text-xs">
                左侧主链路：每帧 80B/实例零拷贝进 GPU；右侧分析支路：聚合统计以 ~10Hz 喂给常规图表组件。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_236px]">
                {/* 主渲染链路 */}
                <div>
                  <ArchLayer
                    icon={Cpu}
                    title="Rust 内核"
                    sub="关键帧插值 · 四元数 Slerp · 时间重映射 · 加性混合"
                  />
                  <FlowArrow label="wasm-bindgen ABI" />
                  <ArchLayer
                    icon={Braces}
                    title="wasm-bindgen 胶水 + fast-path"
                    sub="逐帧零分配求值 · 关键帧预解析 · 内存指针预绑定"
                  />
                  <FlowArrow label="80B × N 实例 / 帧" />
                  <ArchLayer icon={MemoryStick} title="WebAssembly.Memory" sub="GpuInstanceData 连续缓冲（复用语义）">
                    <ByteBar />
                  </ArchLayer>
                  <FlowArrow label="queue.writeBuffer 零拷贝" />
                  <ArchLayer
                    icon={MonitorPlay}
                    title="WebGPU / WebGL2 渲染层"
                    sub={`${particleCount.toLocaleString("en-US")} 实例 · 60fps · 单批次实例化绘制`}
                    tone="cyan"
                  />
                </div>
                {/* 分析支路 */}
                <div className="flex flex-col rounded-xl border border-dashed border-cyan-500/30 bg-cyan-500/[0.03] p-3">
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-cyan-400/80">
                    sidecar · 分析支路
                  </div>
                  <ArchLayer
                    icon={Timer}
                    title="聚合统计采样"
                    sub="每 ~250ms（~10Hz）汇总均值/分布/热点"
                    tone="cyan"
                    dense
                  />
                  <FlowArrow label="降频喂送" cyan />
                  <ArchLayer
                    icon={ChartLine}
                    title="ECharts / D3 分析组件"
                    sub="千级元素 · 常规 DOM/SVG 渲染频率"
                    tone="cyan"
                    dense
                  />
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                    分频是关键：渲染层吃满 60fps 逐帧数据，分析层只拿 ~10Hz
                    聚合结果 —— 图表组件永远不会成为帧率瓶颈。
                  </p>
                </div>
              </div>

              {/* 上游陷阱标注 */}
              <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                <div className="flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    <b className="text-amber-300">要点 · buffer 指针当帧消费（上游陷阱）：</b>
                    求值返回的实例视图是复用缓冲的 subarray，跨帧持有会被下一帧覆写 ——
                    本项目全部消费者（GPU 上传 / DOM 直写 / 聚合采样）都在同帧内同步完成读写。
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 4. 实测基准 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">四、实测基准（三管线对比 · 待填入实测数字）</CardTitle>
              </div>
              <CardDescription className="text-xs" data-testid="bench-caption">
                基准规格：{particleCount.toLocaleString("en-US")} 实例 × 20 关键帧 @ 60fps 目标 ·
                evalMs = 单帧全量求值耗时（N 实例合计）
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table data-testid="bench-table">
                <TableHeader>
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-xs text-zinc-500">求值路径</TableHead>
                    <TableHead className="text-xs text-zinc-500">求值耗时 (ms/帧)</TableHead>
                    <TableHead className="text-xs text-zinc-500">帧率 (fps)</TableHead>
                    <TableHead className="text-xs text-zinc-500">吞吐（实例求值/s）</TableHead>
                    <TableHead className="text-xs text-zinc-500">备注</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {benchRows.map((r, i) => {
                    const isFast = r.label.toLowerCase().includes("fast");
                    return (
                      <TableRow
                        key={r.label}
                        data-testid={`bench-row-${i}`}
                        className={`border-zinc-800 ${isFast ? "bg-amber-500/[0.04]" : ""}`}
                      >
                        <TableCell data-testid={`bench-label-${i}`} className="text-xs">
                          <span className={isFast ? "font-semibold text-amber-300" : "text-zinc-200"}>
                            {r.label}
                          </span>
                        </TableCell>
                        <TableCell data-testid={`bench-evalms-${i}`} className="font-mono text-xs text-zinc-300">
                          {r.evalMs === null ? <PendingMark /> : fmtMs(r.evalMs)}
                        </TableCell>
                        <TableCell data-testid={`bench-fps-${i}`} className="font-mono text-xs text-zinc-300">
                          {r.fps === null ? <PendingMark /> : fmtFps(r.fps)}
                        </TableCell>
                        <TableCell data-testid={`bench-tps-${i}`} className="font-mono text-xs text-zinc-300">
                          {r.evalMs === null ? <PendingMark /> : fmtThroughput(particleCount, r.evalMs)}
                        </TableCell>
                        <TableCell
                          data-testid={`bench-note-${i}`}
                          className="max-w-[240px] whitespace-normal text-xs text-zinc-500"
                        >
                          {r.note}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                「— · 待实测」为占位：基准跑完后由调用方以 props 注入真实数字（吞吐列由 evalMs 与实例规模自动推算）。
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ============================ 板块二：战略转型 ============================ */}
        <TabsContent value="phase4" className="space-y-4 outline-none">
          {/* 1. 定位跃迁 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <MoveRight className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">一、定位跃迁：编辑器 → 动效底座</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-center">
                  <MonitorSmartphone className="mx-auto h-4 w-4 text-zinc-500" />
                  <div className="mt-1.5 text-sm font-semibold text-zinc-400">DOM 动效编辑器</div>
                  <div className="mt-0.5 text-xs text-zinc-500">绑定层视角 · 百级实例 · 工具形态</div>
                </div>
                <div className="flex flex-row items-center justify-center gap-1 sm:flex-col">
                  <MoveRight className="h-5 w-5 rotate-90 text-amber-400 sm:rotate-0" />
                  <span className="font-mono text-[10px] text-zinc-500">Phase 3/4</span>
                </div>
                <div className="flex-1 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-center shadow-[0_0_28px_-10px] shadow-amber-500/40">
                  <Waypoints className="mx-auto h-4 w-4 text-amber-400" />
                  <div className="mt-1.5 text-sm font-semibold text-amber-300">
                    大规模可视化动效底座（Animation Substrate）
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-400">万级实例 · GPU ABI · 同源时间轴 · 嵌入形态</div>
                </div>
              </div>
              <Separator className="bg-zinc-800" />
              <p className="text-xs leading-relaxed text-zinc-400">
                本轮把上游 Rust 内核真正编译成 WASM 后，结论进一步收敛：
                上游真正的壁垒不是 <span className="text-zinc-500">DOM 绑定层</span>
                （那是可替换的适配器），而是内核侧的三件硬资产 —
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 font-mono text-[11px] font-normal text-amber-300"
                >
                  80B GpuInstanceData GPU 实例 ABI
                </Badge>
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 font-mono text-[11px] font-normal text-amber-300"
                >
                  bakeChunk 二进制烘焙系统
                </Badge>
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 font-mono text-[11px] font-normal text-amber-300"
                >
                  时间线 / 重映射 / 混合内核数学
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* 2. 三条产品化路径 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">二、三条产品化路径</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-3">
              <PathCard
                rank="A"
                icon={Boxes}
                title="可视化大屏 / 数字孪生厂商的嵌入引擎"
                body="以 WASM 内核 + 80B GPU ABI 作为黑盒 SDK 嵌入厂商既有渲染栈，按实例规模/工控点位授权 —— 把「万级 60fps」直接卖给最缺它的客户。"
                foot="已有基础：25k@60fps 演示 · WebGL2 回退"
              />
              <PathCard
                rank="B"
                icon={Newspaper}
                title="数据新闻 / 展览交互叙事工具链"
                body="同源时间轴让 ECharts/D3 统计与 WASM 氛围层联动成片；配合 Remotion 导出（已有兼容层基础）把叙事作品直出视频。"
                foot="已有基础：Remotion 代码导出 · WebM/GIF 成片"
              />
              <PathCard
                rank="C"
                icon={GitPullRequest}
                title="上游开源贡献反向赋能"
                body="把 fast-path 求值与 WASM 构建链（wasm-pack 脚本化 + 多转译器 CI）作为 PR 回馈上游 —— 以不可替代的工程贡献建立生态位。"
                foot="已有基础：fast-path 实现 · vendor 补丁可审计"
              />
            </CardContent>
          </Card>

          {/* 3. 风险与对冲 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">三、风险与对冲</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <RiskRow
                risk="WebGPU 浏览器覆盖率不足"
                hedge="WebGL2 回退路径 —— 本次已实现：同一 80B ABI 双渲染后端，能力探测自动切换。"
              />
              <RiskRow
                risk="wasm-bindgen 版本锁死（胶水层与工具链强耦合）"
                hedge="构建链脚本化 —— wasm-pack 构建、绑定生成、体积校验全部一键可复现，工具链版本锁定。"
              />
              <RiskRow
                risk="上游维护活跃度低（单维护者 · 无版本发布）"
                hedge="已 vendor 化解 —— 源码进仓 + 集成补丁可审计，上游停更不阻塞本产品线。"
              />
            </CardContent>
          </Card>

          {/* 4. 下一步路线 */}
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Blocks className="h-4 w-4 text-amber-400" />
                <CardTitle className="text-sm">四、下一步路线（按投入产出排序）</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <StepRow
                n="01"
                icon={Blocks}
                title="多线程 WASM"
                body="SharedArrayBuffer + rayon 并行求值，从 2.5 万级冲击 10 万级实例规模。"
              />
              <StepRow
                n="02"
                icon={Sparkles}
                title="Compute Shader 下沉"
                body="蒙皮/插值迁移到 GPU compute：CPU 只发时间戳，求值成本与实例数近似脱钩。"
              />
              <StepRow
                n="03"
                icon={Film}
                title="Bake 离线导出 mp4"
                body="WebCodecs 硬编码：bakeChunk 产物直出 mp4 成片，烘焙分发格式延伸到专业视频交付。"
              />
              <StepRow
                n="04"
                icon={Server}
                title="集群版（服务端同内核）"
                body="服务端 Rust 复用同一内核做无头烘焙/渲染农场 —— 一次内核投资，客户端与服务端双端变现。"
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="flex items-center gap-1.5 pb-2 text-xs text-zinc-600">
        <BookOpen className="h-3.5 w-3.5" />
        本组件与 studio 战略评估报告互补：阶段一/二结论（试用评估 · 编辑器产品化）见「战略评估」标签页，本页聚焦 Phase 3/4 大规模可视化专项。
      </p>
    </div>
  );
}

/* --------------------------------- 子组件 --------------------------------- */

function Stat({ k, v, tone }: { k: string; v: string; tone: "amber" | "cyan" }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</div>
      <div
        className={`mt-0.5 text-sm font-semibold ${tone === "amber" ? "text-amber-400" : "text-cyan-400"}`}
      >
        {v}
      </div>
    </div>
  );
}

function ScenarioCard({
  icon: Icon,
  title,
  body,
  tag,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  tag: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 transition-colors hover:border-zinc-700">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-sm font-semibold text-zinc-200">{title}</span>
      </div>
      <p className="text-xs leading-relaxed text-zinc-400">{body}</p>
      <Badge
        variant="outline"
        className="w-fit border-cyan-500/30 bg-cyan-500/5 font-mono text-[10px] font-normal text-cyan-300"
      >
        {tag}
      </Badge>
    </div>
  );
}

function CautionItem({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div>
        <div className="text-sm font-semibold text-zinc-200">{title}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{body}</p>
      </div>
    </div>
  );
}

function ArchLayer({
  icon: Icon,
  title,
  sub,
  tone = "zinc",
  dense = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  sub: string;
  tone?: "zinc" | "amber" | "cyan";
  dense?: boolean;
  children?: React.ReactNode;
}) {
  const toneCls =
    tone === "amber"
      ? "border-amber-500/30 bg-amber-500/[0.04]"
      : tone === "cyan"
        ? "border-cyan-500/30 bg-cyan-500/[0.04]"
        : "border-zinc-800 bg-zinc-950/60";
  const iconCls =
    tone === "amber" ? "text-amber-400" : tone === "cyan" ? "text-cyan-400" : "text-zinc-400";
  return (
    <div className={`rounded-xl border ${dense ? "p-2.5" : "p-3"} ${toneCls}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 shrink-0 ${iconCls}`} />
        <span className="text-sm font-semibold text-zinc-200">{title}</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">{sub}</p>
      {children}
    </div>
  );
}

function FlowArrow({ label, cyan = false }: { label?: string; cyan?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-1" aria-hidden="true">
      <span
        className={`h-2.5 w-px ${cyan ? "bg-cyan-500/50" : "bg-gradient-to-b from-zinc-700 to-amber-500/60"}`}
      />
      {label ? (
        <span className="text-center font-mono text-[10px] leading-none text-zinc-500">{label}</span>
      ) : null}
      <ChevronDown className={`h-3.5 w-3.5 ${cyan ? "text-cyan-400/70" : "text-amber-500/70"}`} />
    </div>
  );
}

/** 80B GpuInstanceData 字节布局条（flex 分段 + 图例） */
function ByteBar() {
  const segs: { w: number; cls: string }[] = [
    { w: 64, cls: "bg-amber-500/30" },
    { w: 4, cls: "bg-cyan-500/40" },
    { w: 1, cls: "bg-zinc-500/70" },
    { w: 1, cls: "bg-zinc-500/70" },
    { w: 10, cls: "bg-zinc-800" },
  ];
  return (
    <div data-testid="abi-bytebar" className="mt-2">
      <div className="flex h-5 w-full overflow-hidden rounded-md border border-zinc-800">
        {segs.map((s, i) => (
          <div key={i} className={s.cls} style={{ flexGrow: s.w, flexBasis: 0 }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
        <LegendDot cls="bg-amber-500/60" text="mat4 × 16 × f32 = 64 B" />
        <LegendDot cls="bg-cyan-500/60" text="opacity f32 = 4 B" />
        <LegendDot cls="bg-zinc-500" text="visible u8 = 1 B" />
        <LegendDot cls="bg-zinc-500" text="clipIndex u8 = 1 B" />
        <LegendDot cls="bg-zinc-700" text="padding = 10 B" />
        <span className="font-mono text-zinc-400">Σ 80 B / 实例</span>
      </div>
    </div>
  );
}

function LegendDot({ cls, text }: { cls: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-2 w-2 rounded-sm ${cls}`} />
      {text}
    </span>
  );
}

function PendingMark() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-zinc-600">—</span>
      <Badge
        variant="outline"
        className="border-zinc-700 px-1.5 py-0 text-[9px] font-normal text-zinc-500"
      >
        待实测
      </Badge>
    </span>
  );
}

function PathCard({
  rank,
  icon: Icon,
  title,
  body,
  foot,
}: {
  rank: string;
  icon: LucideIcon;
  title: string;
  body: string;
  foot: string;
}) {
  const rankCls =
    rank === "A"
      ? "bg-amber-500 text-black"
      : rank === "B"
        ? "border border-amber-500/40 bg-amber-500/20 text-amber-300"
        : "border border-zinc-700 bg-zinc-800 text-zinc-300";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-center gap-2">
        <Badge className={`h-fit shrink-0 font-mono ${rankCls}`}>{rank}</Badge>
        <Icon className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-sm font-semibold text-zinc-200">{title}</span>
      </div>
      <p className="text-xs leading-relaxed text-zinc-400">{body}</p>
      <p className="mt-auto border-t border-zinc-800 pt-2 text-[11px] text-cyan-300/80">{foot}</p>
    </div>
  );
}

function RiskRow({ risk, hedge }: { risk: string; hedge: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex w-fit shrink-0 items-center gap-1.5 sm:w-[38%]">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="text-sm font-semibold text-zinc-200">{risk}</span>
      </div>
      <div className="flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400 sm:flex-1">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" />
        <span>{hedge}</span>
      </div>
    </div>
  );
}

function StepRow({
  n,
  icon: Icon,
  title,
  body,
}: {
  n: string;
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <span className="font-mono text-sm font-bold text-amber-500/70">{n}</span>
      <div>
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-sm font-semibold text-zinc-200">{title}</span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{body}</p>
      </div>
    </div>
  );
}
