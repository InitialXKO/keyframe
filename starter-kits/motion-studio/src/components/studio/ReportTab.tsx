"use client";

/**
 * ReportTab — 战略评估报告：keyframe 项目试用结论、正确集成方式与战略转型指导。
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  CheckCircle2,
  Compass,
  Cpu,
  Database,
  FlaskConical,
  Rocket,
  Wrench,
  XCircle,
} from "lucide-react";

export function ReportTab() {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* header */}
      <Card className="border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-900/40">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-amber-400" />
            <CardTitle className="text-lg">Keyframe Engine · 试用评估与战略转型报告</CardTitle>
          </div>
          <p className="text-sm text-zinc-400">
            评估对象：<span className="font-mono text-zinc-300">github.com/InitialXKO/keyframe</span>（MIT）—
            Rust + WASM 内核、WGSL Compute、Remotion 兼容层、多渲染适配器的关键帧动画引擎 Monorepo
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="试用结论" v="可用（JS 回退全功能）" tone="good" />
          <Stat k="实测性能" v="0.226ms / 500 实例帧" tone="good" />
          <Stat k="集成成本" v="低（vendor 源码即用）" tone="good" />
          <Stat k="WASM 内核" v="未发布（CDN 404）" tone="warn" />
        </CardContent>
      </Card>

      {/* section 1: 试用验证 */}
      <Card className="border-zinc-800">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-emerald-400" />
            <CardTitle className="text-base">一、真实试用验证（本工作台即为试点）</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-zinc-300">
          <CheckList
            items={[
              ["Builder API（Engine/Clip/Instance/Keyframe/TransformBuilder）完整可用，链式声明符合文档描述", true],
              ["纯 JS 回退路径与 WASM 内核同构：三次贝塞尔缓动、四元数 Slerp、时间重映射、加性混合全部落地", true],
              ["Zero-Copy 评估：evaluateFrame 返回 80 字节/实例（16 float 矩阵 + opacity + visible + clipIndex + padding）连续缓冲", true],
              ["bakeChunk / decodeBakedChunk 二进制烘焙往返验证通过（64KB ↔ 800 实例）", true],
              ["AnimationPlayer 60fps 帧事件稳定（300ms 实测 18 帧），音频主时钟自适应收敛逻辑完整", true],
              ["domAdapter.batchApply matrix3d 批量绑定 + GPU 合成层保护（opacity 0.001 保层）策略可直接投产", true],
            ]}
          />
          <Separator className="bg-zinc-800" />
          <CheckList
            items={[
              ["上游 WASM 产物未发布：jsDelivr CDN 404、npm 包不存在，prepare() 会抛错 — 必须走 JS 回退或自行编译", false],
              ["源码存在类型重导出缺陷：engine.ts 以运行时形式重导出 interface，SWC/esbuild/Bun 直接转译即崩（tsc 无感知）", false],
              ["零拷贝缓冲为复用语义：跨帧持有 getEvaluatedInstances 返回的 subarray 会被下一帧覆写 — 消费方必须当帧消费", false],
              ["OPFS 存储层依赖浏览器安全上下文，非安全环境静默降级（本次以同接口内存桩替换）", false],
            ]}
          />
        </CardContent>
      </Card>

      {/* section 2: 集成方式 */}
      <Card className="border-zinc-800">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-base">二、正确的应用与集成方式（本次已验证的路径）</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> 推荐路径：Vendor TS 源码 + JS 回退（本项目采用）
            </div>
            <ol className="ml-4 list-decimal space-y-1 text-zinc-300">
              <li>将 <span className="font-mono text-xs">js/</span> 源码 vendor 进工程，修复类型重导出（<span className="font-mono text-xs">export type</span>）与 <span className="font-mono text-xs">.js</span> 后缀导入</li>
              <li>编译场景 → <span className="font-mono text-xs">buildEngineFromScene()</span>，将 <span className="font-mono text-xs">prepared</span> 置真以启用 JS 回退（绕过 404 的 CDN 拉取）</li>
              <li>舞台元素 <span className="font-mono text-xs">transform-origin: 0 0</span>，用引擎 origin 字段（元素中心）做旋转/缩放轴 — 避免 CSS 与引擎双重原点冲突</li>
              <li>每帧只走 <span className="font-mono text-xs">renderAt() → batchApply()</span> 直写 DOM；React 状态仅保留 10Hz 镜像（本工作台实测架构）</li>
            </ol>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-zinc-200">
                <Cpu className="h-4 w-4 text-amber-400" /> 进阶路径：自编译 WASM 内核
              </div>
              <p className="text-zinc-400">
                安装 Rust + wasm-pack 后 <span className="font-mono text-xs">wasm-pack build --target web</span>，
                以 <span className="font-mono text-xs">WasmLoader.initWeb()</span> 挂载。收益：数千实例批求值进一步提速 + WGSL Compute 并行管线。
                适合离线烘焙、服务端渲染等重吞吐场景。
              </p>
            </div>
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-zinc-200">
                <Database className="h-4 w-4 text-amber-400" /> 二进制烘焙（bakeChunk）
              </div>
              <p className="text-zinc-400">
                场景定稿后 <span className="font-mono text-xs">bakeChunk(start, end, fps)</span> 导出 80 字节对齐二进制，
                可存 OPFS/服务端，播放端零解算直读。本工作台的 JSON 导出 + Remotion 代码生成展示了「可交换产物」思路。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* section 3: 杀手级应用定位 */}
      <Card className="border-zinc-800">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-base">三、杀手级应用定位：KeyForge Motion Studio（本项目）</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-zinc-300">
          <p className="mb-2">
            引擎最大的差异化是「<b className="text-amber-300">单引擎驱动数百实例 + 零拷贝 GPU 布局 + 直写 DOM/GPU</b>」，
            因此最能发挥其优势的形态不是又一个 tween 库 demo，而是把它做成<b className="text-amber-300">动效设计工作台（Motion Design Studio）</b>的运行时：
          </p>
          <ul className="ml-4 list-disc space-y-1 text-zinc-400">
            <li>所见即所得舞台 + 时间轴 + 关键帧 Inspector — 引擎做运行时，产品做增值</li>
            <li>「播放头捕获关键帧」— 直接从引擎求值矩阵反解 dx/dy/scale/rot/opacity，是只有矩阵引擎才能做到的功能</li>
            <li>性能实验室 — 把引擎吞吐能力变成可演示、可度量的卖点</li>
            <li>Remotion 兼容代码导出 — 打通「设计 → 视频化渲染」的迁移叙事</li>
          </ul>
          <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            <b className="text-amber-300">v6 产出物矩阵（浏览器内 create → edit → export 全闭环，零服务端渲染）：</b>
            JSON 工程 · PNG 帧 · WebM 成片 · <b className="text-zinc-200">GIF 动图（全局调色板）</b> ·{" "}
            <b className="text-zinc-200">PNG 序列帧 ZIP</b> · Remotion 代码 · SQLite 云端库 · localStorage 自动恢复；
            配套 <b className="text-zinc-200">轨迹点编辑</b>（拖拽路径关键帧/中点插入）、
            <b className="text-zinc-200">逐字标语生成器</b>、
            <b className="text-zinc-200">引擎 vs WAAPI 基准对比</b>（同节点数顺序实测，250–500 实例两者均贴近垂直同步 ——
            佐证引擎价值在「每实例可编程重定向」而非纯回放吞吐）。
          </p>
          <p className="mt-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            <b className="text-emerald-300">v7 专业交付与管线纵深：</b>
            <b className="text-zinc-200">轨迹贝塞尔整形</b>（拖拽轨迹中点把直线段实时烘焙为二次贝塞尔弧线，缓动速度剖面保留 ——
            「轨迹即编辑界面」范式的完整形态）·{" "}
            <b className="text-zinc-200">透明背景交付</b>（GIF 1-bit alpha（oneBitAlpha + dispose=2）与 PNG 序列 alpha，可直接合成进任何底图/视频）·{" "}
            <b className="text-zinc-200">烘焙回放管线</b>（bakeChunk 离线打包 → 运行时零数学内存回放，与实时求值管线 A/B 对照 ——
            直接演示 P0「Motion-as-a-Service」赛道的技术底座：烘焙产物即服务端分发格式）。
          </p>
          <p className="mt-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            <b className="text-sky-300">v8 图表级审视与成片精修：</b>
            <b className="text-zinc-200">速度图（Graph Editor）</b>（时间轴内嵌缓动速度曲线可视化 ——
            与引擎同一套 easedFraction 数学逐段采样，播放头跨图同步，选中轨道加亮）·{" "}
            <b className="text-zinc-200">导出成片精修</b>（7 款调色滤镜 + 自定义水印四角位/不透明度，全部走 Canvas filter 后处理管线，
            WebM/GIF/PNG 序列共用）·{" "}
            <b className="text-zinc-200">GIF 逐帧局部调色板</b>（大色域场景色彩保真选项）·{" "}
            <b className="text-zinc-200">场景收藏置顶</b>（数据库级 starred 元数据 + PATCH 轻量写）·{" "}
            <b className="text-zinc-200">触屏双指缩放时间轴</b>（中点锚定 pinch-zoom）。
          </p>
          <p className="mt-2 rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            <b className="text-violet-300">v9 图表交互化与烘焙资产化：</b>
            <b className="text-zinc-200">速度图交互化</b>（hover 曲线段高亮 + 段信息浮层（时间范围/缓动/峰值速度）+
            点击跳转播放头并选中起始关键帧 —— 图表从「可视」升级为「可操作」的编辑入口）·{" "}
            <b className="text-zinc-200">轨道速度热力条</b>（关键帧区间内嵌 CSS gradient 速度热力 ——
            与速度图同一套数学，慢段暗、快段亮，时间轴一眼读出能量分布）·{" "}
            <b className="text-zinc-200">滤镜视觉预览网格</b>（导出中心 7 款调色滤镜升级为真实场景帧渲染的预览卡，
            选中美检出）·{" "}
            <b className="text-zinc-200">烘焙 chunk OPFS 资产化</b>（bakeChunk 产物持久化到浏览器私有文件系统，
            刷新后流式加载免重烘焙 + 一键清除 —— P0「Motion-as-a-Service」分发格式的客户端原型闭环）·{" "}
            <b className="text-zinc-200">场景一键复制</b>（库内含缩略图整场景克隆）。
          </p>
          <p className="mt-2 rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            <b className="text-rose-300">v10 操纵台与资产文件化：</b>
            <b className="text-zinc-200">速度图缓动编辑器</b>（点击曲线段就地弹出可拖拽贝塞尔编辑器 + 预设下拉 ——
            速度曲线、轨道热力条、Inspector 曲线三视图同源联动，「图表即编辑界面」闭环）·{" "}
            <b className="text-zinc-200">.kfbake 资产文件化</b>（bakeChunk 产物打包为 KFBAKE1 二进制格式（JSON 头 + 80B/实例 GPU ABI 载荷），
            支持导出分享、导入回放 —— P0「Motion-as-a-Service」分发格式从内存/OPFS 资产升级为自包含文件）·{" "}
            <b className="text-zinc-200">独立烘焙播放器</b>（零引擎依赖、纯 Canvas2D 逐帧解码直绘，矩阵直接取自烘焙 ABI ——
            证明运动资产可在无引擎环境独立消费）·{" "}
            <b className="text-zinc-200">轨道热力条 hover 读数</b>（段级时间/缓动/峰值/均速浮层，直写 DOM 零重渲染）·{" "}
            <b className="text-zinc-200">导出元数据 chips</b>（渲染前规格预估 + 渲染后实测体积/耗时/码率）·{" "}
            <b className="text-zinc-200">场景库行内重命名</b>（双击标题就地编辑，PATCH 轻量写 + 当前场景实时同步）·{" "}
            <b className="text-zinc-200">移动端 Inspector 抽屉</b>（小屏属性面板滑出式，选择元素联动徽标）。
          </p>
          <p className="mt-2 rounded-md border border-teal-500/20 bg-teal-500/5 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            <b className="text-teal-300">v11 磁吸对齐与资产二次创作：</b>
            <b className="text-zinc-200">关键帧磁吸对齐</b>（拖拽关键帧自动吸附到其他轨道关键帧/播放头/标尺刻度，
            emerald 虚线指示 + 时间角标，8px 容差，碰撞位自动排除 —— 多轨同步点的手工对齐从此零误差）·{" "}
            <b className="text-zinc-200">速度图修改前虚影</b>（缓动编辑器打开期间，段原始速度曲线以虚线常驻 ——
            每次拖拽贝塞尔控制点都是 before/after 即时对比）·{" "}
            <b className="text-zinc-200">烘焙资产二次创作</b>（独立播放器新增导出当前帧 2× PNG 与整循环 GIF 录制
            （全局调色板 + 实时进度）—— .kfbake 分发资产在零引擎环境下既可播放也可再创作）·{" "}
            <b className="text-zinc-200">WebM VP9 alpha 能力探测</b>（真实编码半透明帧→解码回读像素 alpha 的经验探测，
            通过则解锁透明 WebM 开关（VP9 α ✓ 徽标），不通过则诚实降级提示 —— isTypeSupported 不撒谎的工程答案）·{" "}
            <b className="text-zinc-200">场景结构统计</b>（服务端解析 data JSON，库卡片显示元素/关键帧数）·{" "}
            <b className="text-zinc-200">内存压力指标</b>（PerfLab JS 堆占用/堆上限色阶条 + 烘焙块体积实时读数，
            1000 实例烘焙的 12.6MB 载荷一目了然）。
          </p>
        </CardContent>
      </Card>

      {/* section 4: 战略转型建议 */}
      <Card className="border-zinc-800">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-base">四、战略转型指导（赛道优先级排序）</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Pivot
            rank="P0"
            title="云/边缘批量烘焙渲染服务（Motion-as-a-Service）"
            body="bakeChunk 二进制 + OPFS 流式加载天然适合服务端预渲染动效资产，面向电商 Banner、直播贴片、广告个性化等大规模生成场景。该赛道把『高性能求值』直接变现，且不与 Rive/Lottie 正面竞争。"
          />
          <Pivot
            rank="P1"
            title="轻量动效设计工具（对标 Jitter/Rive 的轻量层）"
            body="以本工作台为骨架补齐图层系统、蒙版、导出视频（配合烘焙二进制 → WebCodecs/ffmpeg），主打『浏览器内 1000 实例不卡』的差异化。"
          />
          <Pivot
            rank="P2"
            title="Remotion 生态迁移入口"
            body="兼容层（spring/interpolate/Sequence）可作为 Remotion 项目的低摩擦替换件切入，吃『React 视频工程提速』的存量需求；同时反向把 Remotion 用户引导至 Keyframe 的运行时优势。"
          />
          <Pivot
            rank="P3"
            title="大规模数据可视化动效层"
            body="与 ECharts/D3 场景结合，承担『千级元素并行位移动画』的底层。需要补时间轴编排 API 与坐标系适配，工程量中等。"
          />
          <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-300">
              <AlertTriangle className="h-4 w-4" /> 风险与前置事项（90 天路线图建议）
            </div>
            <ul className="ml-4 list-disc space-y-1 text-zinc-400">
              <li>第 1 个月：用 Rust 工具链重建 WASM 产物并发布 npm/CDN（当前最大可信度缺口）；补 CI 矩阵（tsc/esbuild/swc 三转译器）</li>
              <li>第 2 个月：跨帧缓冲语义加文档与「冻结快照」API（decodeBakedChunk 已是范本）；OPFS 层补降级测试</li>
              <li>第 3 个月：按 P0 赛道发布烘焙渲染 MVP，收集 3–5 个种子客户工作流</li>
              <li>持续风险：单维护者仓库、无版本发布、API 契约未冻结 — 生产引入必须 vendor 锁定（本工作台已如此处理）</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <p className="flex items-center gap-1.5 pb-2 text-xs text-zinc-600">
        <BookOpen className="h-3.5 w-3.5" />
        本报告由真实试用产出：评估脚本、集成补丁与本工作台源码均为可复核证据。
      </p>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone: "good" | "warn" }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</div>
      <div className={`mt-0.5 text-sm font-semibold ${tone === "good" ? "text-emerald-400" : "text-amber-400"}`}>{v}</div>
    </div>
  );
}

function CheckList({ items }: { items: [string, boolean][] }) {
  return (
    <ul className="space-y-1.5">
      {items.map(([text, ok], i) => (
        <li key={i} className="flex items-start gap-2">
          {ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          )}
          <span className={ok ? "text-zinc-300" : "text-zinc-400"}>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function Pivot({ rank, title, body }: { rank: string; title: string; body: string }) {
  const tone =
    rank === "P0"
      ? "bg-amber-500 text-black"
      : rank === "P1"
        ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
        : "bg-zinc-800 text-zinc-300";
  return (
    <div className="flex gap-3 rounded-md border border-zinc-800 p-3">
      <Badge className={`h-fit shrink-0 font-mono ${tone}`}>{rank}</Badge>
      <div>
        <div className="font-medium text-zinc-200">{title}</div>
        <p className="mt-0.5 text-zinc-400">{body}</p>
      </div>
    </div>
  );
}
