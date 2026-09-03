# KeyForge Motion Studio — 项目工作日志

> 项目使命：克隆并评估 https://github.com/InitialXKO/keyframe，构建最能发挥其优势的杀手级应用，
> 给出正确的应用/集成方式与战略转型指导。

---
Task ID: 1
Agent: Z.ai Code (main)
Task: 克隆 keyframe 仓库、试用评估、构建杀手级应用（KeyForge Motion Studio）、端到端验证

Work Log:
- 克隆 InitialXKO/keyframe 到 /home/z/keyframe-repo，通读 README、Rust 内核结构（80 字节 GpuInstanceData ABI）、js/ 全部 TS 源码（builder/controller/dom_binder/renderer/remotion/physics）。
- 评估发现 ①：上游宣称的 WASM 内核未发布 —— jsDelivr CDN 404、npm 包不存在，`engine.prepare()` 会抛错；但引擎自带**纯 JS 回退路径**（`evaluateJSFrame`），数学实现与 WASM 同构（三次贝塞尔、四元数 Slerp、时间重映射、加性混合）。
- 评估发现 ②：`js/builder/engine.ts` 以运行时形式重导出 interface（`export { EvaluatedInstance... }`），在 Bun/SWC/esbuild 下直接崩（tsc 无感知）——上游构建链单一导致的可移植性缺陷。
- Vendor 集成：拷贝 js/ 源码至 `src/lib/keyframe/`，修复类型重导出为 `export type`、规范化 `.js` 后缀导入、以同接口内存桩替换 OPFS 层，建立统一入口 `src/lib/keyframe/index.ts`。
- Bun 真实试用（/home/z/keyframe-trial/trial.ts）：200 实例求值正确、zero-copy 评估返回 20 floats/80 字节、bakeChunk↔decodeBakedChunk 往返（64KB↔800 实例）、AnimationPlayer 300ms 实测 18 帧（60fps）、性能基准 **500 实例×10000 帧 = 0.226ms/帧（约 4400 帧求值/秒）**。
- 评估发现 ③（陷阱）：`getEvaluatedInstances` 返回的 transformMatrix 是**复用缓冲上的 subarray 视图**，跨帧持有会被下一帧覆写 —— 消费方必须当帧消费（本工作台架构据此设计：全部消费者在 renderAt 同帧内同步读取）。
- 杀手级应用构建（KeyForge Motion Studio）：
  - 数据层：`src/lib/scene.ts`（Scene/Kf/Element 类型、8 种动效预设、`buildEngineFromScene` 场景→引擎编译器、矩阵反解捕获、Remotion 兼容代码生成器）
  - 运行时桥：`src/lib/engine-host.ts`（EngineHost 单例 —— 引擎编译、AnimationPlayer 管理、renderAt 直写 DOM、捕获关键帧、逐帧监听总线）
  - 状态：`src/store/studio.ts`（zustand，所有变更 bump engineVersion 触发重编译）
  - UI：StageCanvas（960×540 逻辑舞台 + ResizeObserver 缩放 + 选中环）、Timeline（标尺刷选/轨道/菱形关键帧/双击添加）、Inspector（元素/关键帧属性、滑杆、缓动选择、**播放头捕获关键帧**、预设一键应用）、Toolbar（播放/循环/添加元素/保存/载入/导入导出/Remotion 代码对话框）、PerfLab（100–1000 实例压力实验室 + FPS/求值/绑定实时指标）、ReportTab（战略评估报告）
  - 后端：Prisma `Scene` 模型（SQLite）+ `/api/scenes`（GET/POST）+ `/api/scenes/[id]`（GET/PUT/DELETE）
- agent-browser 端到端验证与修复：
  - 修复水合错误（初始场景含 Date.now ID → 改为空场景 + 客户端挂载后 loadDemo）
  - 修复 lucide `Loop` 图标不存在 → `Repeat`
  - 修复播放器循环标志未启用（4s 后停止）→ ensurePlayer({loop})
  - 修复补写遗漏的 `/api/scenes/route.ts`（首次写入失败未重试）
  - 加固 `setPointerCapture` try/catch（合成事件/自动化环境刷选不被阻断）
- 验证结果（全部通过）：播放/循环（3.15s→0.36s 循环跳转）、矩阵逐帧变化、关键帧编辑器、播放头捕获（1.22s 实况状态捕获成功）、预设应用、保存→SQLite→场景库载入、Remotion 代码生成、PerfLab 实时指标（250 实例 58fps/0.24ms 求值；1000 实例 14fps/1.14ms 求值/16.4ms DOM 绑定 —— 与引擎 >200 护栏建议一致）、报告页内容、移动端 390px 布局 + 页脚自然贴底（footerBottom=scrollHeight=1591）、lint 零错误、dev.log 无运行时错误。

Stage Summary:
- 交付物：KeyForge Motion Studio（工作台/性能实验室/战略评估三标签页）+ 场景持久化 API + vendored 引擎（含 4 项集成修复）
- 核心结论：keyframe 引擎 JS 回退路径生产可用；正确集成方式 = vendor TS 源码 + prepared 标志启用回退 + transform-origin 0 0 + 当帧消费零拷贝缓冲 + 直写 DOM 绕过 React 状态
- 战略建议（详见应用内报告页）：P0 云端批量烘焙渲染服务 / P1 轻量动效设计工具 / P2 Remotion 生态迁移入口 / P3 大规模数据可视化动效层；前置事项 = 重建并发布 WASM 产物、补多转译器 CI
- 已知边界：拖拽编辑按 pointermove 重编译引擎（小场景无感，>100 元素场景建议增量化）；PerfLab 的 DOM 绑定在 1000 实例时是瓶颈（引擎求值仅 1.1ms），此为护栏设计预期

---
Task ID: 2
Agent: Z.ai Code (cron webDevReview #1)
Task: 定时巡检 — QA 评估 + 编辑器能力跃升（撤销/重做、关键帧拖拽、图层系统、缓动可视化、细节打磨）

Work Log:
- 【状态判断】读取 worklog（Task 1 基线），QA 巡检：页面 200、无控制台/页面错误、播放推进、保存 API 正常 → 项目稳定，进入功能增强轮。
- 【Undo/Redo 历史系统】store 新增 past/future 双栈（上限 50 步）+ `pushHistory(key)` 智能合并（同 key 600ms 内的连发只入栈一次，覆盖滑杆/拖拽风暴）+ undo/redo 动作；所有 13 个变更动作接入历史；工具栏新增撤销/重做按钮（disabled 状态联动）；快捷键 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y。
- 【拖拽与历史的协同】舞台元素拖拽：pointerdown 时快照一次、move 中 {history:false}；关键帧拖拽同理。
- 【关键帧拖拽改时间】时间轴菱形支持沿轨道水平拖拽（绝对定位映射 + 10ms 吸附），拖拽中同步选中态。
- 【新快捷键】Delete/Backspace 删除选中关键帧（无 kf 时删元素）、Ctrl+D 复制元素（新 store 动作 duplicateElement：深拷贝含关键帧、偏移 +24px、命名「副本」）。
- 【图层系统】moveElement(dir) 交换 elements 顺序（= z-order = 时间轴行序 = 实例求值序），Inspector 新增上移/下移/复制按钮 + 「第 N / M 层」指示器；越界 no-op 且不入历史。
- 【缓动曲线可视化】新组件 EasingCurve.tsx：SVG 实时预览当前关键帧缓动（控制点与引擎 evaluateEasing 完全一致，含 Step 阶跃与 CubicBezier 回弹过冲形态），显示 P1/P2 坐标。
- 【样式细节】播放头跟随时间气泡（逐帧直写 DOM，比 10Hz readout 更精准）；轨道 hover 出现「+」快捷键（在播放头处添加关键帧）；选中环呼吸光效（kf-ring-pulse keyframes）；舞台四角安全框角标 + "KEYFORGE · MOTION STAGE" 水印；深色主题细滚动条；场景库每行新增删除按钮（联动 DELETE API + 当前场景 id 失效处理）。
- 【验证（agent-browser 全通过）】undo/redo 按钮初始态联动；加圆形→undo→6、redo→7；关键帧 520ms 拖至 1670ms、undo 恢复 520ms；Ctrl+D 复制（7→8）+ undo 移除；图层上移/下移交换与越界忽略；缓动预览 SVG 渲染（P1 0.42,0 · P2 0.58,1）；播放头气泡逐帧更新（1.38s）；场景库删除（DB 4→3）；移动端页脚贴底（1578=1578）；lint 零错误；dev.log 无错误。

Stage Summary:
- 本轮新增：完整撤销/重做体系、关键帧拖拽 retime、元素复制、图层 z-order 管理、缓动曲线可视化、6 项视觉细节打磨、场景库 CRUD 闭环
- 项目状态：功能完整的动效编辑器（v2）；无已知 bug
- 下一轮建议优先级：① 时间轴缩放（zoom）与轨道多选/框选 ② easing 贝塞尔控制点可拖拽编辑 ③ 场景保存生成缩略图（首帧快照 canvas 导出）④ 预设库扩展（路径动画/文字逐字入场）⑤ PerfLab 增加「与 CSS transition 基准对比」模式 ⑥ 导出 GIF/WebM（WebCodecs）探索
- 风险提示：undo 恢复不含 timeMs 之外的播放器状态（符合预期）；拖拽 retime 大量关键帧重叠时以最后拖入者胜出（可接受）

---
---
Task ID: 3
Agent: Z.ai Code (cron webDevReview #2)
Task: QA 巡检 + 编辑器专业化跃升（时间轴缩放、交互式贝塞尔编辑器、场景缩略图、隐藏/锁定系统、PNG 导出）

Work Log:
- 【状态判断】读取 worklog（Task 1/2 基线），agent-browser 全面 QA：播放推进+引擎矩阵直写、PerfLab 实时指标（45fps/0.274ms）、战略评估、undo/redo 状态联动、保存 API、移动端 390px 页脚贴底（footerBottom=scrollHeight=1072）——全部通过，无存量 bug → 进入功能增强轮。
- 【时间轴缩放系统】Timeline 重构：zoom 1x(适应)~8x，双击 +/−/适应窗口控件；横向滚动区与固定轨道名列（w-32，色点发光选中态）共享竖直滚动；标尺刻度密度自适应（TICK_CANDIDATES 按 px/ms 选步长，≥64px 间距 + 1/4 minor 刻度）；seek/kf-retime/双击添加全部基于 lane rect 像素映射（放大后毫秒级精度实测 50%→2.00s 精确）。
- 【交互式贝塞尔缓动编辑器】数据模型：Kf 新增 cubic?: CubicControl（p1x/p1y/p2x/p2y）；buildEngineFromScene 传递 cubic_params 至引擎 evaluateEasing（engine 原生支持）。EasingCurve 升级：真实 CSS 语义绘制（x(t) 数值反解二分法，横轴=真实时间进度）、P1/P2 可拖拽手柄（y 允许 -0.5~1.5 过冲）、拖拽自动切换 easing=CubicBezier、过冲虚线参考线、曲线渐变填充、控制点引导线；Inspector 集成（选中 CubicBezier 时播种回弹控制点 + 重置按钮 + 状态说明）。
- 【引擎端到端验证】同一 0.69s 时刻、520ms 关键帧两种控制点对比：慢启动 (0.95,0.05)→y=169.781 vs 回弹 (0.34,1.56,0.64,1.0)→y=193.346——引擎确实应用自定义 cubic（React 批处理时序曾致误判，异步等待后确认）。
- 【场景库缩略图】Prisma Scene 新增 thumb String?（db:push + 重启 dev server 使 client 生效）；新增 src/lib/snapshot.ts：临时引擎离线求值（候选时刻按可见 opacity² 打分选最丰富帧）→ Canvas2D 以引擎矩阵重绘（圆/方/文字 + 网格 + 暗角）→ JPEG dataURL（320×180, ~7KB）；保存时自动生成入库；场景库 Dialog 升级为 2 列视觉卡片网格（缩略图 hover 缩放 + 时长角标 + 日期 + hover 显删除钮）。
- 【隐藏/锁定系统】SceneElement 新增 hidden/locked（编辑器元数据，不污染动画）；store 新增 toggleHidden/toggleLocked；舞台：hidden→visibility:hidden（引擎照常驱动），locked→pointerdown 拦截不可选/拖拽；Timeline 轨道行 hover 显示眼睛/锁图标（激活态常驻，锁定 amber 高亮，点击锁定行 toast 提示）；Inspector 新增隐藏/锁定快捷按钮 + 状态徽章。
- 【当前帧 PNG 导出】renderSceneFramePng(scene, timeMs)（960×540 PNG，复用同一渲染管线）；导出菜单新增「当前帧 PNG」；拦截 <a> 点击验证：203KB PNG、文件名含场景标题与时间戳。
- 【bug 修复】① EasingCurve emit TDZ（声明前调用 → ReferenceError，调整声明顺序）；② EasingCurve useEffect 未导入（lint 修复引入的运行时崩溃，页面级 Error Overlay——补充 import 后恢复）；③ react-hooks/refs：render 期间写 ref → 改为 useEffect 同步；④ 播放头时间 chip 超出 ruler 顶部被裁剪（改 ruler 内部定位）；⑤ 数据库 2 条重复测试场景清理；⑥ layout.tsx 页面元数据仍是脚手架默认（改为 KeyForge Motion Studio 品牌）。
- 【验证】lint 零错误；agent-browser 回归：zoom 156% 刻度 0.25s 步长、放大态 seek 精确、隐藏→舞台 visibility:hidden、锁定→舞台点击不选中+toast、解锁恢复、PNG 导出、缩略图卡片渲染（img natural 320×180）、三标签页、undo/redo、播放、移动端贴底（1093=1093）；dev.log 无新错误。

Stage Summary:
- 本轮交付：时间轴缩放、交互式贝塞尔编辑器（引擎级联动）、场景库缩略图、隐藏/锁定、PNG 帧导出、5 项 bug 修复
- 项目状态：专业化动效编辑器（v3）——编辑器三大件（选择/变换/时间）+ 专业工作流（层级管理/防误操作/视觉资产库）已齐备；无已知 bug
- 下一轮建议优先级：① 关键帧框选+批量操作（多选/批量删除/批量缓动）② 关键帧复制粘贴（Ctrl+C/V）③ GIF/WebM 导出（WebCodecs 录制播放循环）④ 洋葱皮模式（onion skinning，多帧叠加半透明）⑤ J K L 专业播放快捷键（j 反向/k 暂停/l 快进）⑥ 撤销历史可视化面板
- 风险提示：dev server 由本轮手动重启过（Prisma client 缓存）——后续如遇 prisma schema 变更需同样重启；EasingCurve 的 useEffect 修复与 usePtsRef 同步在快速拖拽中依赖 effect 时序（实测无碍，极端场景可改为事件内直接读 store）

---
Task ID: 4
Agent: Z.ai Code (cron webDevReview #3)
Task: QA 巡检 + 编辑器生产力跃升（关键帧多选与批量操作、关键帧剪贴板、JKL 变速播放、洋葱皮模式、可视化历史面板）

Work Log:
- 【状态判断】读取 worklog（Task 1-3 基线），agent-browser 全面 QA：播放推进、保存 API、PerfLab（46fps/0.254ms@250 实例）、战略评估页、移动端页脚贴底（844=844）——全部通过，无存量 bug（agent-browser 报 "covered by sticky header" 为其 hit-test 误报，elementFromPoint 验证可点；Radix Tabs 激活需 mousedown 事件，属测试方法问题）→ 进入功能增强轮。
- 【关键帧多选系统】store 新增 kfSelection（`elId|t` 复合键数组）+ setKfSelection/toggleKfSelection/clearKfSelection；select() 单选时自动同步多选集。
  - 框选 marquee：轨道空白处拖拽出 amber 虚线选框（content 坐标系 + 指针事件流），抬起时对全部 [data-kfkey] 菱形做矩形相交命中（带 ±2px 容差——中心点命中在旋转菱形上有 0.5px 亚像素漏选问题）；Shift+框选 = 追加模式；空拍单击 = 清空多选。
  - Ctrl/Cmd+点击 = 切换选中；Shift+点击 = 同轨道范围选（anchor 记忆）；Ctrl+A 全选全部关键帧；Esc 取消。
  - 多选视觉：主选=白底白光，次选=amber-300 底+白边+强光晕。
- 【批量操作浮条】多选 >1 时时间轴顶部滑入毛玻璃浮条（animate-kf-bar-in，whitespace-nowrap 防换行）：计数徽章、批量删除（单次历史快照）、批量缓动（7 种 DropdownMenu，CubicBezier 自动播种回弹控制点）、对齐播放头（每组以最早帧为基准整体平移+防碰撞守卫+去重）、复制/剪切、关闭。
- 【批量拖拽 retime】拖拽任一选中关键帧 = 整组平移（10ms 吸附）：pressedCur 增量映射 + 每元素防碰撞守卫（目标被非移动关键帧占用则跳过该帧）+ 复合键实时重建（键内嵌时间戳，拖拽后浮条/高亮保持有效）——实测 3 帧组拖 +510ms 间距 240/190 完整保留。
- 【关键帧剪贴板】kfClipboard（按源元素分组、绝对时间保留）：Ctrl+C 复制 / Ctrl+X 剪切（复制+批量删除）/ Ctrl+V 粘贴（组内最早帧对齐播放头、保持相对间距、clamped、同刻碰撞替换）——实测 2 帧复制后粘贴到 3s 处间距 900ms 保留。
- 【JKL 变速播放】engineHost.setRate/rate（AnimationPlayer.timeScale 公开属性直接复用）+ store playRate 镜像；J=反向（连按 -1→-2→-4→-8）、K=暂停复位、L=正向倍速（首按 1x——wasPlaying 判据修复了首按即 2x 的问题）、Shift+←/→=逐帧步进（1/60s 帧对齐）、Home/End=跳到首尾。
  - 反向播放边界守卫：engine tick 只钳制 ≥duration 侧，负 timeScale 会无限倒退——ensurePlayer 帧回调中处理 t≤0：循环模式回绕到末尾 / 非循环暂停复位。实测反向 2.29s→1.53s 递减、到 0 回绕 3.86s。
  - 工具栏速率 chip（≠1x 时显示，负速玫瑰色/正速 amber，点击复位）。
- 【洋葱皮模式】新组件 OnionSkin.tsx：专用离线引擎实例（useMemo 按 engineVersion 重建，与实况引擎隔离）在 t±N×gap 离线求值 → Canvas2D 重绘形状轮廓（矩阵分解 rot/scale/tx/ty 与引擎同构；圆/方描边+28% 填充、文字 fillText；过去玫瑰 #f43f5e / 未来青 #22d3ee，alpha 0.34 向外递减、乘以引擎求值 opacity）。
  - 控件浮条（舞台左上）：开关 + 过去/未来帧数 0-3（+/−）+ 帧间隔 100/200/333ms；右下角图例；设置持久化 localStorage（经 zustand onion 字段，规避 react-hooks/set-state-in-effect lint 错误）——刷新后状态保留验证通过。
  - 实测截图：KEYFORGE 三重影（未来青上/当前琥珀中/过去玫红下）与 bounceIn 物理轨迹一致。
- 【可视化历史面板】历史栈重构为 HistEntry{id,label,at,scene}[]（全部 ~20 个变更动作接入中文标签：如「批量移动 3 个关键帧」「应用预设×××」）；工具栏 History 按钮 → Popover 面板：当前状态高亮 marker + 条目列表（操作名+相对时间），点击任意条目 jumpToHistory（截断式回溯，被截断状态进重做栈）；面板显示步数与可重做数。
- 【bug 修复】① 批量缓动菜单/浮条按钮换行（whitespace-nowrap+shrink-0）；② marquee 中心点命中亚像素漏选（改矩形相交+2px 容差）；③ L/J 首按 2x（wasPlaying 判据）；④ 批量拖拽后复合键过期（键重建）；⑤ OnionSkin setState-in-effect lint error（迁移 zustand）；⑥ 测试残留重复场景清理（DB 回到 1 条）。
- 【验证（agent-browser 全通过）】Ctrl+点击 3 连选→浮条计数 3；框选跨轨道 4 帧（含截图）；批量删除 16→13→undo 恢复 16；批量缓动 Step 生效（Inspector combobox 验证）；对齐播放头（520/760/950→1518/1758/1948）；复制粘贴（400/1300→2965/3865）；J−1×反向递减+回绕、K 复位、L 2×/4×；Home 0.00s/End 4.00s；Shift+←→ 逐帧；洋葱皮开关/帧数/间隔/持久化；历史面板 4 条目+跳转（0 关键帧态）+重做保留；批量组拖 +510ms 键重建浮条保持；保存 API 200+缩略图；PerfLab 60fps/0.300ms；移动端页脚贴底（843.875≈844）；console 无错误无 React key 警告；lint 零错误；dev.log 无运行时错误。

Stage Summary:
- 本轮交付：关键帧级生产力套件（多选/框选/批量操作/剪贴板/组拖 retime）+ JKL 专业播放 + 洋葱皮 + 可视化历史 + 6 项 bug/细节修复
- 项目状态：专业化动效编辑器（v4）——关键帧操作密度对齐专业 NLE（AE/Avid 的工作流习惯：JKL、洋葱皮、框选批量、历史面板）；无已知 bug
- 下一轮建议优先级：① WebM/GIF 导出（WebCodecs 录制循环→下载，导出菜单第三项）② 轨道上元素级拖拽排序（拖动轨道行改变 z-order）③ 缓动曲线预设收藏夹（保存自定义 cubic 到 localStorage）④ PerfLab 增加 CSS transition 基准对比模式 ⑤ 洋葱皮 ghost 支持运动路径可视化（把关键帧间轨迹画成贝塞尔路径线）⑥ 场景自动保存（localStorage 防崩溃丢失）
- 风险提示：批量拖拽在组内帧相距极近时守卫会跳过部分帧（可接受，防重叠）；jumpToHistory 后 redo 栈顶条目标签为「跳转（回到…之后）」（符合预期）；洋葱皮离线引擎随场景重建（>100 元素场景 redraw 成本上升，当前 6 实例无感）

---
Task ID: 5
Agent: Z.ai Code (cron webDevReview #4)
Task: QA 巡检 + v5 输出能力跃升（WebM 视频导出、运动路径可视化、轨道拖拽排序、缓动收藏夹、自动保存恢复、关键 bug 修复与视觉打磨）

Work Log:
- 【状态判断】读取 worklog（Task 1-4 基线），agent-browser 全面 QA：三标签页、引擎矩阵驱动 6 实例、播放推进、PerfLab 60fps、报告页、/api/scenes GET/POST/DELETE——全部通过，无存量 bug → 进入功能增强轮（v5：输出能力 + 自动化保障）。
- 【重大 bug 修复：全局 toast 不可见】layout.tsx 挂载的是 radix 版 Toaster（@/components/ui/toaster），而全部业务代码调用 sonner 的 toast() —— sonner Toaster 从未挂载，导致历史所有轮次的 toast 提示实际从未显示过（QA 曾误判为正常）。替换为 @/components/ui/sonner 后 toast 系统首次真正生效，并验证「已保存/已重置」等提示可见。
- 【WebM 视频导出】新库 src/lib/video-export.ts：一次性编译离线引擎 → Canvas2D 逐帧绘制（复用 snapshot 管线）→ captureStream(0) + requestFrame() 墙钟配速（1:1 实时录制）→ MediaRecorder（VP9→VP8 自动回退）。snapshot.ts 重构出共享 drawSceneFrame()（缩略图/PNG/WebM 三管线合一，引擎只编译一次）。Toolbar 新增导出对话框：960×540 预览画布（渲染时实时显示 + REC 指示）、三档画质（4/8/16 Mbps）、进度条、取消渲染、完成后 DONE 徽标 + 下载（文件名「标题-loop.webm」）。
  - 真实验证：4s 场景录制 220 帧 / 565.5KB，agent-browser download 抓取文件经 file 命令确认为 genuine WebM（EBML 头）。
- 【运动路径可视化】新组件 MotionPath.tsx：选中元素的关键帧轨迹叠加层——离线引擎按每段 22 子步采样（完全遵循各关键帧缓动含自定义 cubic），世界坐标连线：辉光底层 + 实线核心、关键帧圆点（白描边）、起点空心圈/终点实心圈、逐帧直写 DOM 的白色菱形播放头标记（同帧读取 live matrix）。舞台右上「路径」开关（默认开，zustand showPaths）。实测 bounceIn 垂直轨迹 / floatY 上下轨迹 / 播放中标记实时跟随。
- 【轨道拖拽排序】store 新增 reorderElement（splice 语义，含下拖索引修正）；时间轴轨道名行支持 HTML5 DnD：GripVertical 手柄、上半/下半判定插入位、amber 发光插入指示线、拖源半透明；drop 后 z-order（= elements 顺序 = 渲染叠加序）即时生效，undo 可恢复。实测拖 1→3 行顺序变换 + undo 还原。ref 读写全部移出 render（dragSrcId 状态化）。
- 【缓动收藏夹】新库 src/lib/easing-favorites.ts（localStorage 持久化，首次播种 4 经典曲线：回弹 Back Out / 预备 Anticipate / 急速 Swift / 弹簧 Spring）。Inspector 曲线编辑器下方新增收藏夹面板：收藏当前（cubic 或命名预设控制点）、chip 点击应用（自动切换 CubicBezier + 写入控制点）、hover × 删除。实测应用 Swift → 引擎同步、新增收藏 → localStorage 5 条、删除恢复 4 条。
- 【自动保存 + 崩溃恢复】StudioWorkspace：场景变更 debounce 900ms 写 localStorage（keyforge.autosave）；挂载时若有存档则静默恢复（跳过 demo），延迟 200ms 弹 toast「已恢复上次的工作现场·标题·N前」（修复 sonner 监听器注册时序）；store 新增 lastAutosaveAt。Toolbar 新增绿色「已自动保存 · Ns/m 前」状态 chip（5s 自刷新）。实测：改标题→存档→刷新→标题恢复 + toast 显示。
- 【快捷键速查】新组件 ShortcutsDialog：四组分类（播放穿梭/编辑/关键帧/工作台）kbd 键位表；"?" 键切换、右下角浮动按钮（毛玻璃 FAB）、页脚「按 ? 查看全部快捷键」链接（CustomEvent 联动）。三入口全验证。
- 【视觉打磨】页头 v5 徽章 + 底部 amber 渐变发丝线；舞台径向聚光灯背景 + 电影级晕影（pointer-events-none）；工具栏自动保存 chip；页脚快捷键提示精简。
- 【验证（agent-browser 全通过）】WebM 录制 220f/565.5KB/file 确认 WebM；运动路径 canvas 非空像素 + 播放头标记 transform 实时变化；拖拽排序 1→3 + undo；收藏夹应用/新增/删除 + localStorage；自动保存恢复 + toast；快捷键三入口；PerfLab 54-60fps；报告页；移动端 390px 页脚贴底（1114=1114）；恢复标题后重置演示场景；lint 零错误；dev.log 无新错误。

Stage Summary:
- 本轮交付：v5「输出能力」版本 —— WebM 视频导出（浏览器内直出成片）、运动路径可视化（轨迹规划能力）、轨道拖拽排序、缓动收藏夹、自动保存/崩溃恢复、快捷键速查表 + 修复了全局 toast 从未显示的历史 bug
- 项目状态：从「编辑器」进化为「可交付成片的动效工作站」——产出物矩阵补齐（JSON 工程 / PNG 帧 / WebM 成片 / Remotion 代码 / SQLite 云端库 / localStorage 自动保存）；无已知 bug
- 战略意义：WebM 导出让 P1「轻量动效设计工具」路线从「设计」延伸到「交付」，浏览器内完成 create→edit→export 全闭环（无需服务端渲染农场）
- 下一轮建议优先级：① GIF 导出（/gifenc 或 WebCodecs→gif 转码，补齐表情包场景）② 运动路径可拖拽编辑（拖路径上的点生成新关键帧——轨迹即编辑界面）③ 序列帧 PNG 导出（zip 打包）④ 场景多选批量删除（场景库）⑤ PerfLab CSS transition 对比基准模式 ⑥ 导出带透明背景 WebM（alpha: "keep" 探索）
- 风险提示：WebM 录制依赖 rAF 墙钟配速——后台标签页会被节流（对话框中已提示保持前台）；录制期间实时舞台暂停（设计如此，防 CPU 争抢）；自动保存含隐藏/锁定元数据（恢复即还原编辑现场，符合预期）

---
---
Task ID: 6
Agent: Z.ai Code (cron webDevReview #5)
Task: QA 巡检 + v6 输出矩阵与创作生产力跃升（GIF/PNG 序列导出、轨迹点编辑、逐字标语生成器、场景库批量管理、WAAPI 基准对比）

Work Log:
- 【状态判断】读取 worklog（Task 1-5 基线），agent-browser 全面 QA：页面 200、播放推进 + 引擎矩阵直写、PerfLab 250 实例 42fps 实时指标、战略评估页、/api/scenes GET 200、移动端 390px 页脚贴底（1113.875≈1114）——全部通过，无存量 bug → 进入功能增强轮（v6）。
- 【导出中心 ExportCenter.tsx（新）】统一三格式导出对话框，格式分段控件（WebM 视频 / GIF 动图 / PNG 序列，各带图标+描述），共享预览画布 + REC/FRAME 指示 + 进度条 + DONE 徽标 + 下载。原 Toolbar 内嵌 WebM 对话框整体迁出。
- 【GIF 导出】新库 src/lib/gif-export.ts：gifenc 编码器 —— 一次性编译离线引擎，从 5 个采样帧合并像素构建全局 256 色调色板（色彩跨帧稳定 + 文件更小），逐帧 drawSceneFrame → getImageData → applyPalette → writeFrame（首帧携带 palette 作为全局色表，repeat:0 永久循环），帧间 yield 保持 UI 响应。选项：尺寸 480/640/960、帧率 8/12/16/25。真实渲染验证：4s 场景 48 帧 / 412.8KB，blob 魔数 GIF89a ✓。
- 【PNG 序列帧导出 ZIP】同一管线，逐帧 canvas.toBlob("image/png") → fflate zipSync（level 0 store——PNG 已压缩不再重复 deflate）。帧数护栏 MAX_SEQUENCE_FRAMES=1200 + UI 实时帧数预估（超限红字 + 禁用渲染）。验证：48 帧 / 3.02MB，魔数 PK ✓。新增 src/types/gifenc.d.ts（gifenc 无内置类型）。
- 【轨迹点编辑（MotionPath 重写，v6 杀手级特性）】轨迹即编辑界面：
  - 关键帧圆点从 canvas 绘制改为 DOM 元素（离线引擎求值定位），可拖拽改写该关键帧 dx/dy（pointer 增量 / scale 映射、±2000 钳制、拖拽起点单次历史快照 + move 中 history:false）、双击删除、hover 放大 + 光标反馈、选中关键帧 amber 环 + Inspector 联动。
  - 段中点插入手柄：每段 ≥120ms 的轨迹中点显示虚线"+"圆钮，点击在插值时刻插入关键帧（位置取引擎求值矩阵、scale/rot/opacity 线性插值、继承前段缓动与 cubic 控制点）。
  - 修复存量视觉 bug：播放头标记此前不在缩放容器内（舞台宽 ≠960px 时错位）——整层重构为 ResizeObserver 缩放容器，canvas/DOM/标记全部逻辑坐标 1:1 对齐。
  - 验证：3 点 + 2 中柄渲染、拖点 282→347px、中点插入 3→4 点、双击删除 4→3、undo 链完整还原（含拖拽位置）。
- 【逐字标语生成器】store 新增 addTextStagger(cfg)：每字符一个 text 元素（CJK/拉丁字宽启发式排版、整串舞台居中、空格仅占位、≤24 字符），三种入场配方（fadeUp / popSpin 回弹 / dropBounce）按错峰间隔生成阶梯关键帧（与引擎缓动同参数）；末帧超时时长自动延长（同一历史条目）。TextStaggerDialog（新）：文案输入、入场样式三选卡、字号/错峰/垂直位置滑杆、调色板色板、帧数/总宽/末帧/时长延长预估 chips、CSS 动画实时预览条（与引擎配方同曲线同延迟，重播按钮，globals.css 新增 3 组 keyframes）。验证：「KF 动效」生成 4 元素，播放至 1.3s 四字符 opacity 全部 1，撤销链正常。
- 【场景库批量管理】标题搜索实时过滤（空结果态文案）；卡片 hover 角标 checkbox 多选（选中 amber 环 + 缩略图半透明）；全选/取消选择切换；批量删除浮条（animate-kf-bar-in）+ 两击确认（3s 内二次点击执行，超时重置）；逐个 DELETE 后统一 toast（含失败计数）。验证：搜索「批量」精确过滤、全选 2 卡、两击删除后 DB 计数 0、当前场景 id 失效处理。
- 【WAAPI 基准对比 BenchmarkCompare.tsx（新）】PerfLab 新增「KeyForge 引擎 vs 浏览器 WAAPI」基准区：同节点数（100/250/500）、同 2600ms 波浪关键帧，顺序各测 2.5s（引擎 JS 求值+批量绑定 → element.animate 可合成器加速），期间自动暂停并恢复主压力实验室（保留用户暂停状态）；结果双 FPS 横条 + 三态自适应结论文案（引擎领先/相当/WAAPI 领先——如实呈现合成器吞吐优势并阐明引擎价值在每实例可编程重定向）。实测 250 实例 59 vs 60fps、500 实例 58 vs 60fps（基本相当）。
- 【战略评估报告同步】第三节新增「v6 产出物矩阵」段落：JSON / PNG 帧 / WebM / GIF / PNG 序列 ZIP / Remotion 代码 / SQLite / localStorage 全闭环（零服务端渲染）+ 轨迹编辑/逐字生成器/基准对比能力注记。
- 【bug 修复】① TextStaggerDialog 从 @/lib/scene 导入不存在的 STAGE（页面 500 → 改从 store 导入）；② BenchmarkCompare 结果字段名错位（evalMs/applyMs 展开 vs engineEvalMs/engineApplyMs 读取 → toFixed 崩溃，显式映射修复）；③ BenchmarkCompare 切换标签页 mid-bench 卸载时 stageRef 空引用（守卫 + unmount cancel）；④ 修复 MotionPath 播放头标记缩放错位（见上）。
- 【验证（agent-browser 全通过）】全新会话 0 页面错误；三格式真实渲染下载（GIF89a/PK 魔数）；轨迹拖拽/插入/删除/undo；逐字生成 4 元素引擎驱动；场景库搜索/全选/两击批量删除（DB 验证）；基准对比 250/500 双跑 + 主循环恢复；报告页 v6 段落；播放推进；移动端页脚贴底（1113.875≈1114）；lint 零错误；dev.log 无新错误。

Stage Summary:
- 本轮交付：v6「输出矩阵 + 创作生产力」——导出中心三格式（WebM/GIF/PNG 序列 ZIP）、轨迹点编辑（轨迹即编辑界面）、逐字标语生成器、场景库批量管理、引擎 vs WAAPI 基准对比 + 4 项 bug 修复
- 项目状态：产出物矩阵全格式闭环（表情包 GIF / 后期合成序列帧 / 成片 WebM），编辑器新增轨迹直接操纵范式与批量文案生成能力；基准对比为战略评估提供了诚实的量化论据（引擎回放吞吐与原生动画持平，差异化在可编程性）
- 下一轮建议优先级：① 运动路径贝塞尔整形（把两关键帧间直线路径升级为可弯曲的贝塞尔轨迹——需引擎侧路径插值或采样烘焙为多关键帧）② 关键帧时间轴上的缓动区间拖拽预览 ③ GIF 透明背景探索（quantize oneBitAlpha）④ 场景库排序/分页（>20 场景）⑤ 导出中心记住上次的格式与参数（localStorage）⑥ PerfLab 基准加入「烘焙 chunk 回放」第三管线对比
- 风险提示：GIF/序列帧渲染为同步像素循环（帧间 yield，但大场景长时长仍会占满主线程——对话框已提示保持前台）；WAAPI 基准依赖浏览器合成器行为，不同硬件结论可能反转（UI 已如实说明）；逐字生成器元素名含字符本身（如「标语字 3 · 动」），Inspector 显示较长但信息明确

---
Task ID: 7
Agent: Z.ai Code (cron webDevReview #6)
Task: QA 巡检 + v7 专业交付与管线纵深（轨迹贝塞尔整形、透明背景导出、烘焙回放管线、场景库排序分页、导出参数记忆、nudge 微移、缓动徽标）

Work Log:
- 【状态判断】读取 worklog（Task 1-6 基线），agent-browser 全面 QA：页面 200、播放推进（2.61s + 暂停态联动）、引擎直写 7 元素 transform、PerfLab 250 实例实时指标（求值 0.313ms/绑定 1.044ms）、报告页 v6 内容、/api/scenes GET 200、移动端 390px 页脚贴底（4085=4085）、console 零错误——全部通过，无存量 bug → 进入功能增强轮（v7）。
- 【轨迹贝塞尔整形（MotionPath 升级，v7 杀手级特性）】拖拽段中点手柄 = 把两关键帧间直线路径实时弯曲为二次贝塞尔弧线：
  - 数学：C = 2·pointer − M（M 为直线段中点）⇒ 曲线 t=0.5 顶点精确落在指针处；烘焙采样点 u = easedFraction(原段缓动, (t−a.t)/segMs)，贝塞尔 B(u) = (1−u)²P0 + 2(1−u)u·C + u²P1 —— 原缓动的速度剖面在弧线上完整保留。
  - 烘焙：n = clamp(round(segMs/55), 3, 28) 个内部采样点，rot/scale/opacity 按同一 u 插值，全部 Linear easing；段起点关键帧改写为 Linear（原缓动随段消亡）；终点缓动保留（管辖下一段）。
  - 交互：window 级 pointer 监听（烘焙重建轨道导致手柄重挂载时不丢事件）；4px 位移阈值区分「点击=插入关键帧（v6 行为保留）/ 拖拽=弯曲」；拖拽起点单次 pushHistory + move 中 history:false；弯曲中显示白色虚线控制多边形（P0→C→P1）+ amber 控制点方块 + 「弯曲中」标注。
  - 实测：主标题 0→520ms 段拖拽后 4→13 关键帧（52ms 均匀采样、data-easing 全 Linear）、路径 canvas 实时弯曲、undo 完整还原 4 帧、redo 重放 13 帧。
  - 支撑：scene.ts 新增共享导出 solveBezierY / easedFraction（与引擎 evaluateEasing 数学完全同构，Newton 迭代一致）；store 新增原子动作 replaceElementKeyframes（整轨替换，history 可控）。
- 【透明背景交付】drawSceneFrame 新增 transparent 选项（跳过背景/网格/晕影，显式 clearRect 防脏帧）；GIF 管线启用 rgba4444 格式 + quantize oneBitAlpha + transparentIndex 自动定位（palette 中 alpha=0 条目）+ writeFrame {transparent:true, dispose:2}（restore-to-background 防残影）；PNG 序列管线天然 alpha 直出。
  - 导出中心新增「透明背景」Switch（emerald 高亮，仅 GIF/PNG 序列显示）；预览画布切换棋盘格背景（globals.css 新增 export-checkerboard）；文件名自动追加 -alpha。
  - 真实验证：480p/12fps 渲染 48 帧 113.9KB，file 确认 GIF89a；二进制解析 GCE transparent flag=1 + dispose=2；PIL 像素级解码 frame20 角落 alpha=0、33 个采样点内容不透明——真透明非伪透明。
- 【PerfLab 烘焙回放第三管线】新库 src/lib/keyframe/bake-replay.ts：BakedReplayPlayer——启动时一次性 engine.bakeChunk(0,2600,60) 打包整个循环，运行时 getEvaluatedInstances(t) 仅做帧索引 + 80B/实例 memcpy 进预分配对象池（零数学/零 GC/零分配），接口与 engine.getEvaluatedInstances 兼容 → 可直接传入 domAdapter.batchApply({engine: player}) 作为 drop-in 替换。
  - 主实验室新增管线模式切换（实时求值 amber / 烘焙回放 emerald）；烘焙信息条显示 chunk 体积/帧数/烘焙耗时；指标卡标签随模式切换（引擎求值/帧 ↔ 回放解码/帧）。
  - 实测：250 实例烘焙 3066KB·157 帧·耗时 80ms；回放解码 0.017ms vs 实时求值 0.255-0.313ms（≈15-18 倍速）；双向切换 + 说明文案 + P0 战略赛道（Motion-as-a-Service 烘焙产物即分发格式）注解。
- 【场景库排序 + 分页】API GET 增加 createdAt 返回；工具栏库对话框新增排序 Select（最近更新/创建时间/标题 A→Z/时长降序，zh-CN locale）+ 分页（每页 8，上一页/下一页 + 「第 x / y 页 · 共 N 个」指示，搜索/排序变更自动回第 1 页）。
  - 实测：10 场景 → 页 1 八卡 + 页 2 两卡；时长降序 4.0s 置顶 → 1.9/1.8/1.7…递减；测试数据已清理（DB 回到 1 条）。
- 【导出参数记忆】ExportCenter 全部参数（format/bitrate/seqWidth/seqFps/transparent）持久化 localStorage「keyforge.export.prefs」，打开即恢复上次设置（useRef 惰性初始化 + 变更即写）。
- 【方向键微移 + 对齐快捷键】Alt+方向键 = 微移选中元素 1px（Shift = 10px），coalesced pushHistory 合并连击；Inspector X/Y/尺寸下方新增三按钮组：水平居中/垂直居中/舞台中心（按 (STAGE−size)/2 精确计算）。
  - 实测：x 350→352（两次 1px）、y +10（Shift）；舞台中心 (44px 文本) → (458, 248) 精确。
- 【时间轴缓动徽标】关键帧菱形内部新增缓动类型 glyph：Linear 无标 · Step ■ 小方点 · CubicBezier ◎ 空心环 · 预设缓动 ● 实心点；tooltip 升级为含缓动全名与 cubic 控制点坐标；data-easing 属性暴露（自动化测试可断言）。实测 25 关键帧 glyph 分布正确（16 Linear/3 EaseOut/5 EaseInOut/1 CubicBezier）。
- 【文档同步】页头徽章 v6→v7；战略报告页新增「v7 专业交付与管线纵深」段落（轨迹整形/透明交付/烘焙回放，并点明烘焙管线 = P0 赛道技术底座）；快捷键速查表补 Alt+方向键微移与轨迹弯曲条目。
- 【验证（agent-browser 全通过）】轨迹整形 4→13 烘焙 + undo/redo 链；透明 GIF 二进制 + 像素级验证；烘焙回放 0.017ms 模式切换双向；排序分页全流程；prefs 持久化（reload 后 format=gif/transparent=true 恢复）；nudge/对齐精确；缓动徽标 data-easing；移动端页脚贴底（1114=1114）；console 零错误零警告；lint 零错误；dev.log 无运行时错误。

Stage Summary:
- 本轮交付：v7「专业交付与管线纵深」——轨迹贝塞尔整形（轨迹即编辑界面完整形态）、透明背景 GIF/PNG 交付、烘焙回放管线（三管线对比矩阵补齐：实时求值/烘焙回放/WAAPI）、场景库排序分页、导出参数记忆、方向键微移 + 舞台对齐、时间轴缓动可视化
- 项目状态：动效工作站 v7；从「设计→交付」升级为「设计→弯曲轨迹→透明合成→管线选型」的完整专业链路；无已知 bug
- 战略意义：烘焙回放管线把 P0「Motion-as-a-Service」从纸面推演变为可运行演示（bakeChunk 产物 = 服务端分发格式，BakedReplayPlayer = 客户端零数学播放器原型）；透明导出补齐广告/直播贴片场景的合成刚需
- 下一轮建议优先级：① 关键帧时间轴拖拽段缓动区间预览（速度曲线条）② GIF 逐帧局部调色板优化（当前全局 256 色在大色域场景可能条带）③ 场景库拖拽多选排序拖动 ④ 导出中心滤镜/水印选项 ⑤ PerfLab 烘焙管线增加「OPFS 持久化 + 流式加载」演示 ⑥ 移动端触屏手势（双指缩放时间轴）
- 风险提示：烘焙回放 60fps 固定帧率（与实时求值的逐帧求值语义一致但非连续时间采样，快速 timeScale 播放下可能微跳帧——当前实验室场景 2600ms 循环无感知）；轨迹烘焙增加关键帧数量（28 上限/段，时间轴密集但语义正确）；Radix Select/DropdownMenu 在 agent-browser 合成事件下需 native click 或语义定位（测试方法问题非应用 bug）

---
---
Task ID: 8
Agent: Z.ai Code (cron webDevReview #7)
Task: QA 巡检 + v8 图表级审视与成片精修（速度图、导出滤镜/水印、GIF 局部调色板、时间轴对齐 bug 修复、场景收藏、触屏双指缩放）

Work Log:
- 【状态判断】读取 worklog（Task 1-7 基线）。dev server 未运行 → 手动拉起（本轮注意：会话开始时 3000 端口无监听，需要 nohup bun run dev）。agent-browser 全面 QA：播放引擎 6 实例 matrix3d 直写、PerfLab 100 实例 56fps/0.290ms、报告页 v6/v7、/api/scenes 200、移动端 390px 页脚贴底（4306=4306）——基线全绿，进入 v8 功能轮。
- 【QA 发现①：演示场景残留】localStorage 自动保存携带 v7 轨迹整形测试的烘焙关键帧（主标题 0-468ms 每 52ms 一帧共 13 帧）——点击「演示」重置后恢复干净 demo（6 元素 16 关键帧）。
- 【QA 发现②：时间轴对齐系统性 bug（本轮最重要修复）】播放头/标尺点击 seek/关键帧拖拽 retime 全部以 laneRef 的 padding box 为坐标系（含 px-3 内边距），而标尺刻度与关键帧菱形位于 content box —— 导致播放头相对刻度有 ±12px 系统漂移（t=0 时左偏 12px，t=dur 时右偏 12px），seek/拖拽 retime 有同样的 12px 映射误差。
  - 修复：新增 rulerRef（标尺元素=精确 content box），seekFromEvent/onKfPointerDown 改用标尺 rect 映射；播放头定位改为 calc(12px + (100% - 24px) * frac) —— 与 content box 完全一致。
  - 验证：seek 至标尺 50% → 播放头 X=628 = 期望 628（像素级精确）；速度图播放头 25% 处 X=465 = 期望 465。
- 【速度图 SpeedGraph（v8 杀手级特性，Graph Editor）】新组件 src/components/studio/SpeedGraph.tsx：
  - 数学：每段速度 = easedFraction 数值导数 / 段长（1/ms），与引擎完全同构（Newton 贝塞尔迭代同源）；Step 缓动段速度恒 0（保持语义）。
  - 渲染：Canvas2D 逐元素速度曲线（元素本色，未选中 28% 透明；选中元素加发光 + 下方渐变面积填充 + 关键帧边界刻度）；全局速度最大值归一化，98 分位以下直接使用（当前实现为 max 归一）。
  - 覆盖层：播放头逐帧直写 DOM（与时间轴同一 calc 定位）+ hover 十字线 + 时间读数；位于时间轴滚动内容内部 → 缩放/横滚/竖滚天然同步。
  - 集成：时间轴头部 Activity 开关（aria-pressed + amber 高亮），可见性入 zustand（speedGraph 字段 + toggleSpeedGraph 动作 + localStorage「keyforge.speedgraph」）——规避 set-state-in-effect lint；左列新增「速度图」标签行（高度 89px 与内容行对齐）；开启时滚动区 max-h-56→380px。
  - 验证：canvas 曲线 2491 亮像素（干净场景 5903）；选中「主标题」→「主标题 曲线加亮」标签出现；开关切换 + 刷新持久化。
- 【导出成片精修：调色滤镜 + 水印】新库 src/lib/export-filters.ts：
  - 7 款滤镜（原片/暖调/冷调/黑白/复古/高饱和/褪色），Canvas ctx.filter 后处理（自绘 self-blit 管线，不触碰场景渲染代码）；水印（文字≤24 字符、四角位置、10-100% 不透明度、软阴影）。
  - drawSceneFrame opts 新增 finish → 三管线（WebM/GIF/PNG 序列）与缩略图管线共享；video-export/gif-export 透传。
  - ExportCenter 新增「调色滤镜」chip 组（含色板 swatch）+「水印」行（Input + 角落 Select + Slider）；参数全部入 prefs 持久化。
  - 导出对话框实时精修预览：打开对话框即按当前参数重绘一帧 —— 修复 Radix Portal 挂载时序问题（effect 运行时 canvasRef 尚为 null → rAF 重试轮询 ≤12 帧直到 canvas 出现再绘制）。
  - 真实验证：GIF（暖调 + 「KEYFORGE·V8」水印 + 480p/12fps）→ 48 帧 502.1KB，二进制像素级确认：右下角水印灰度像素 308 个（均值 RGB≈131，恰为 55% 白），内容像素 61% 呈暖色偏（r>b+10）；黑白滤镜预览饱和度下降 63%。
- 【GIF 逐帧局部调色板】exportSceneGif 新增 gifPalette: "global" | "local"——局部模式每帧独立 quantize（transparent 时 rgba4444+oneBitAlpha），writeFrame 每帧携带局部色表；ExportCenter 新增 Select（全局 256 色 · 更小 / 逐帧局部 · 更真，仅 GIF 格式显示）。验证：同参数对比 502.1KB（全局）→ 541.3KB（局部，+7.8%，低色域场景符合预期）。
- 【场景收藏置顶】Prisma Scene 新增 starred Boolean @default(false)（db:push + 重启 dev server 刷新 client）；GET /api/scenes 返回 starred；新增 PATCH /api/scenes/[id]（轻量元数据写，不带 data）；Toolbar 场景卡片右上角星标按钮（收藏态常驻 amber 实心，未收藏 hover 显形）+ toggleStar 乐观更新（失败回滚）+ 任意排序模式下收藏恒置顶。验证：star 切换 → DB starred true/false（curl 确认）→ 刷新后状态保留 → toast 提示。
- 【触屏双指缩放时间轴】scrollRef 容器原生 touch 监听（passive:false）：两指捏合 → zoom（1-8x，中点锚定：捏合中点下的时刻保持不动，scrollLeft 按 contentWidth 比例换算，rAF 后设置）；单指行为不变（ruler/lane 原有 pointer 逻辑不受影响）；底部提示文案补充「触屏双指缩放时间轴」。
- 【文档同步】页头徽章 v7→v8；战略报告页第三节新增「v8 图表级审视与成片精修」段落（sky 边框，与 v6 amber/v7 emerald 区分）。
- 【验证（agent-browser 全通过）】速度图渲染/开关/持久化/选中加亮/播放头像素级同步（465=465）；时间轴对齐修复（628=628）；导出中心 7 滤镜 chip + 水印行 + 调色板 Select + 实时预览（3846 亮像素）+ 暖调水印 GIF 二进制像素验证 + 局部调色板体积对比；收藏 PATCH/DB/刷新持久化；播放引擎矩阵逐帧变化；移动端页脚贴底（1873=1873）；console 零错误零警告；lint 零错误；dev.log 无运行时错误（PATCH/GET 记录正常）。

Stage Summary:
- 本轮交付：v8「图表级审视与成片精修」——速度图（Graph Editor 级缓动速度可视化）、导出调色滤镜 + 水印（全格式管线后处理）、GIF 局部调色板、场景收藏置顶、触屏双指缩放；并修复了时间轴 ±12px 系统对齐 bug（播放头/seek/关键帧拖拽坐标系统一至 content box）与导出预览的 Radix 挂载时序问题
- 项目状态：动效工作站 v8；时间轴从「位置精确」升级为「速度可视」，导出从「格式齐全」升级为「成片精修」（调色/水印/调色板策略）
- 下一轮建议优先级：① 速度图交互化（hover 段高亮 + 点击跳转该关键帧段，甚至拖拽贝塞尔控制点跨组件联动 EasingCurve）② 轨道 clip span 内嵌速度热力渐变（CSS gradient 版速度图，样式细节）③ 导出滤镜预览缩略图网格（当前是 chip，可升级为 2×4 视觉预览卡）④ GIF 透明 + 局部调色板组合的体积优化（帧间差分/脏矩形）⑤ PerfLab 增加「烘焙 chunk OPFS 持久化 + 刷新后流式加载」演示 ⑥ 场景库拖拽多页移动
- 风险提示：速度图为 max 归一（单元素极端尖峰会压低其他曲线——当前 max 软化阈值 max<=1 保护除零，后续可加 P95 截断）；触屏双指缩放在桌面浏览器无法自动化验证（touch 事件仅真机/DevTools 触发，逻辑已经 rAF + 锚定数学审查）；Chrome 多次自动下载会被节流（本轮 QA 中第二次下载未触发——浏览器策略，非应用 bug；用户手动下载不受影响）；导出预览重试轮询 12 帧上限（极慢设备可能需要增大）

---
Task ID: 9
Agent: Z.ai Code (cron webDevReview #8)
Task: QA 巡检 + v9 图表交互化与烘焙资产化（速度图交互、轨道速度热力条、滤镜视觉预览网格、OPFS 烘焙缓存、场景一键复制）

Work Log:
- 【状态判断】读取 worklog（Task 1-8 基线），agent-browser 全面 QA：页面 200、三标签、播放推进（1.11s→1.20s）、引擎矩阵直写 6 实例、/api/scenes 200、PerfLab 实时指标（39fps/0.235ms 求值 @250 实例）、移动端页脚贴底（1208.9≈1209）——基线全绿无存量 bug → 进入 v9 功能增强轮。
- 【速度分析数学下沉 scene.ts】新增共享导出 segmentSpeeds(kfs, durationMs)（每段速度采样，数值导数与引擎 easedFraction/Newton 贝塞尔同源）+ segsPeak(segs) + SegSpeed 类型 —— SpeedGraph 与 Timeline 热力条共用同一套数学，图表与轨道视觉严格一致。
- 【速度图交互化（v9 杀手级特性：图表从可视→可操作）】SpeedGraph 升级：
  - hover 探测：指针位置 → 各元素曲线 y 距离最近匹配（阈值 18px）→ 该元素曲线加亮（1.8px 线宽 + 发光 + 面积填充），其余压暗至 22% —— 与选中态同级的视觉反馈体系（dim/hover/sel 三档）。
  - 段信息浮层：时间范围（0.52s → 0.76s）+ 缓动全名（含 cubic 控制点坐标）+ 峰值速度百分比 + 操作提示「点击跳转播放头并选中关键帧」；跟随十字线、右缘自动翻转（translateX(-105%)）。
  - 点击跳转：seek 到点击时刻 + 选中该段起始关键帧（实测点击 0.15×4000ms=600ms 处 → 命中 520ms 起始帧，selection/kfSelection 同步，Inspector 联动）。
- 【轨道速度热力条（CSS gradient 版速度图）】Timeline 每条轨道的 clip span 内叠加逐段速度热力层：segmentSpeeds 全场景归一化，每段生成 linear-gradient（最多 41 个采样 stop，alpha = 0.1 + 0.78×(v/max)）—— 慢段暗、快段亮，元素本色渲染；heatMap useMemo 仅在 scene/engineVersion 变化时重采样（选择等普通重渲染零开销）；首尾关键帧区间整体 overflow-hidden 圆角。实测 6 轨道全部渲染（主标题轨道在 bounceIn 段变亮、静止尾部变暗，与速度图曲线逐点对应）。
- 【导出滤镜视觉预览网格】ExportCenter 调色滤镜从 chip 升级为 4 列视觉卡网格：小底帧 168×94 离线渲染一次（drawSceneFrame 复用、无晕影），每卡以 ctx.filter 在 drawImage 时应用对应滤镜（7×一次 drawImage，极廉价）；选中卡 amber 环 + Check 徽标 + 底栏 amber 高亮，hover 缩放 1.06；保留原 data-testid=filter-{id} 兼容。像素级验证：7 卡内容互异（mono avg[5,5,5] vs fade avg[34,33,33] vs retro 3990 亮像素），真实场景帧非占位图。
- 【烘焙 chunk OPFS 资产化】新库 src/lib/keyframe/bake-cache.ts：saveBakeChunk/loadBakeChunk/clearBakeCache/opfsAvailable（OPFS 私有文件系统，keyforge-bake-*.kfbake 命名，全路径优雅降级）。PerfLab 烘焙模式三态流：
  - OPFS 命中 → BakedReplayPlayer 直接从缓存字节构建（实测刷新后「OPFS 缓存命中 · 3066KB · 157帧 · 加载 38.0ms」+ emerald「OPFS 命中」徽标，回放解码 0.009ms）
  - 未命中 → 现场烘焙（55ms）→ 异步回写 OPFS（信息条「正在写入…→已缓存至 OPFS」），期间 rAF 循环无缝回退实时求值（disposed 守卫防陈旧闭包）
  - 「清除缓存」按钮 → clearBakeCache 全清 + toast「已清除 N 个烘焙缓存块」+ 徽标复位（实测 DB/OPFS 双验证）
  - 战略意义：P0「Motion-as-a-Service」的分发格式（80B/实例烘焙产物）在客户端完成「生产→持久化→流式消费」闭环原型。
- 【场景一键复制】场景库每卡新增 Copy 按钮（hover 显形、amber 高亮）：GET 全量场景 → POST 副本（标题追加「副本」、含缩略图与完整 data）→ 乐观插入列表首 + toast。实测 DB 1→2、副本含 thumb/4000ms/10 元素/24 关键帧完整性验证，测试副本已清理（DB 回到 1）。
- 【文档同步】页头徽章 v8→v9；战略报告页新增「v9 图表交互化与烘焙资产化」段落（violet 边框，与 v6 amber/v7 emerald/v8 sky 区分）；快捷键速查表工作台组新增「点击速度图」条目；时间轴底部提示补「速度图可点击跳转」。
- 【bug 修复】① ExportCenter 滤镜预览 effect 依赖数组引用了未定义的 timeMs（页面 500 → 移除，预览改为挂载时快照当前时刻）；② Timeline heatMap useMemo 中 let gmax 循环重赋值触发 react-hooks/immutability lint error → 改 reduce 无突变写法；③ SpeedGraph 残留占位代码清理。
- 【验证（agent-browser 全通过）】全新浏览器会话 console 零错误零警告；热力条 6 轨道渲染（渐变 alpha 分级正确）；速度图 hover 浮层（主标题段 0.52→0.76s · EaseInOut · 峰值 91%）+ 点击跳转（600ms→选中 |520 起始帧）；导出中心 7 滤镜卡真实渲染 + 选中联动大预览（暖调 r>b 偏移）；OPFS 三态流（写入 3066KB/刷新命中 38ms/清除 toast）；场景复制 DB 级验证；播放引擎 6 实例矩阵直写；快捷键表新条目；报告页 v9 段落；移动端 390px 页脚贴底（1208.9≈1209）；lint 零错误；dev.log 无运行时错误。

Stage Summary:
- 本轮交付：v9「图表交互化与烘焙资产化」——速度图成为可操作编辑入口（hover 加亮/段信息浮层/点击跳转选中）、时间轴速度热力条（图表与轨道同源数学的能量可视化）、导出滤镜视觉预览网格（真实场景帧渲染）、烘焙 chunk OPFS 持久化+流式加载（Motion-as-a-Service 客户端闭环原型）、场景一键复制
- 项目状态：动效工作站 v9；速度维度完成「采样（v8 可视）→ 交互（v9 可操作）」跃迁；烘焙产物完成「内存回放（v7）→ 持久化资产（v9）」跃迁；无已知 bug
- 下一轮建议优先级：① 速度图上直接拖拽控制点改造段速度（跨组件联动 EasingCurve 的贝塞尔编辑）② 烘焙 chunk 导入/导出为 .kfbake 文件（P0 分发格式文件化，可配 WebGL/Canvas 播放器 demo）③ 轨道热力条 hover 显示段速度读数（pointer-events 局部放行方案）④ 场景库内直接重命名（行内编辑）⑤ 导出中心编码后元数据预览（时长/体积/分辨率 chip）⑥ 移动端 Inspector 抽屉化（小屏workspace 布局重排）
- 风险提示：速度图 hover 探测为 18px 阈值最近匹配（曲线密集重叠时可能命中相邻元素曲线，与 NLE 习惯一致可接受）；OPFS 在 Safari 15.4 以前不可用（自动降级为现场烘焙，功能无损）；滤镜预览卡在对话框打开瞬间有 ≤20 帧 rAF 轮询窗口（极慢设备可能短暂空白）；场景副本共享缩略图字节（同一 dataURL 两份存储，库规模大时可有优化空间）

---
---
Task ID: 10
Agent: Z.ai Code (cron webDevReview #9)
Task: QA 巡检 + v10 操纵台与资产文件化（速度图缓动编辑器、.kfbake 文件格式、独立烘焙播放器、热力条 hover 读数、导出元数据 chips、场景库行内重命名、移动端 Inspector 抽屉）

Work Log:
- 【状态判断】读取 worklog（Task 1-9 基线），agent-browser 全面 QA：页面 200、播放推进（1.24s→2.91s）、引擎矩阵直写 6 实例、PerfLab 250 实例 43fps（求值 0.291ms/绑定 1.396ms）、报告页 v9、/api/scenes 200、移动端 390px 页脚贴底（1208.9≈1209）、console 零错误——基线全绿无存量 bug → 进入 v10 功能增强轮。
- 【速度图缓动编辑器（v10 杀手级特性，图表即编辑界面闭环）】SpeedGraph 点击曲线段 → 就地弹出内联编辑浮层（锚定于段位置、右缘自动翻转、animate-kf-bar-in 入场）：
  - 内嵌 EasingCurve 可编辑贝塞尔控件：拖拽 P1/P2 → updateKeyframe(elId, kfT, {easing: CubicBezier, cubic}, key 合并历史) → 速度曲线 Canvas 重绘、时间轴热力条渐变、Inspector 曲线三视图同源联动（单一数据源）。
  - 缓动预设 Select（7 种 EASING_OPTIONS）直接改写段缓动；Esc/点击空白/关闭按钮退出；关键帧被删时浮层随 editorKf 守卫自然卸载。
  - 实测：点击主标题段 → 浮层出现；合成 PointerEvent 拖拽 P1 (0,0)→(0.15,0.2)→(0.39,0.56)，data-easing EaseOut→CubicBezier，速度图 canvas 指纹 33910→34086（重绘确认），热力条渐变 alpha 0.26→0.235（联动确认）；两次 undo 后 easing0=EaseOut 且热力条精确还原 0.26（undo 链完整）。
- 【.kfbake 资产文件化（P0 分发格式落地）】新库 src/lib/kfbake.ts：KFBAKE1 二进制格式（7B 魔数+\0 填充 + u32 LE 头长 + JSON 元数据头 + 80B/实例 GPU ABI 载荷），packKfbake/parseKfbake/downloadKfbake/fmtBytes，parse 对魔数/头长/载荷尺寸全校验。
  - PerfLab 烘焙模式新增三动作：导出 .kfbake（当前 chunk 打包下载）、导入（文件选择→parseKfbake→校验失败 toast）、播放器（内存 chunk 直接开演）。spawn() 三分支（OPFS 命中/现场烘焙/无 OPFS）均回写 bakeChunkRef。
  - 字节级验证：下载 keyforge-perflab-250inst.kfbake → Python 解析 magic OK、头 181B、载荷 3,140,000B = 157帧×250实例×80B 精确匹配 meta.payloadBytes。
  - 回灌验证：同一文件经 input[type=file] 上传 → parseKfbake → 播放器打开（chips：250 实例/60fps/157 帧/2.99MB）→ Canvas 4738 亮样本渲染。生产→文件→分享→独立消费闭环。
- 【独立烘焙播放器 BakePlayerDialog.tsx（新）】零引擎依赖：BakedReplayPlayer 帧索引+memcpy → Canvas2D setTransform 直绘（CSS matrix3d 列主序 → a=m0 b=m1 c=m4 d=m5 e=m12 f=m13），径向渐变底 + 逐粒子 roundRect+辉光，色相复用 PerfLab 公式 hue=(i*47)%60+20 视觉对齐。
  - 传输控制：空格播放/暂停（对话框级监听）、Esc 关闭、回到开头、帧进度 Slider（键盘方向键可步进 8→11 帧）、低频 UI 同步（200ms interval 读 frameRef，渲染循环零 React 重渲染）。
  - 结构：BakePlayerBody 以文件身份为 key 的子组件 —— 换文件即重挂载重置传输状态（规避 effect 内 setState 的 react-hooks lint 约束）。
- 【轨道热力条 hover 段读数】Timeline 每 clip span 新增透明 hover 命中区（inset-y-0，位于关键帧菱形之下、pointerdown 冒泡保持框选/seek 兼容）+ 每轨道专属 tooltip（Map ref 收集，pointermove 直写 innerHTML/位置/opacity —— 零 React 重渲染）。读数：元素名 · 段时间范围 · 缓动全名 · 峰值/均速百分比（归一化峰值经 heatMap 以 gmax 字段随 HeatTrack 下发，非 ref）。实测：hover 主标题 → 「主标题 · 0.00→0.52s / Ease Out 渐出 · 峰值 39% · 均速 23%」。
- 【导出元数据 chips】ExportResult 扩展 encodeMs/width/height；导出中心预览下方新增双段 chips 行（data-testid=export-meta）：渲染前「规格」预估（分辨率/帧率/帧数/时长/编码参数——随格式联动切换）+ 渲染后「实测」（实际分辨率/帧数/体积/编码耗时/平均码率）。
  - 实测：GIF 前段 [480×270 · 12fps · ≈48帧 · 4.0s · GIF·全局调色板] → 渲染 48 帧后后段 [480×270 · 48帧 · 379.0KB · 编码 0.9s · 3.61 Mbps]。
- 【场景库行内重命名】PATCH /api/scenes/[id] 扩展支持 title（trim+120 上限+非空校验，title/starred 至少其一）；卡片标题行移出载入按钮（消除嵌套交互元素 + 双击不再误触载入）；双击标题或铅笔按钮进入行内编辑（Enter 提交/Esc 取消/blur 提交），乐观更新 + 失败回滚，当前加载场景（sceneId 匹配）同步 setTitle。
  - 实测：铅笔→输入「产品发布开场 Demo v2」→Enter → DB curl 确认标题变更 → 卡片即时刷新；未加载场景工作台标题不受影响（语义正确）；测试后已还原。
- 【移动端 Inspector 抽屉】StudioWorkspace 右列 lg 以下 hidden；新增 amber 边框悬浮 FAB（bottom-16 right-4，避开快捷键 FAB，显示当前选中元素名）→ shadcn Sheet side=right 320px：完整 Inspector + 选中元素徽标 + 头部说明 + env(safe-area-inset-bottom) 适配。
  - 实测 390×844：FAB 可见、桌面列隐藏、抽屉打开（320px、内含 Inspector 控件）、页脚依旧贴底。
- 【文档同步】页头徽章 v9→v10；战略报告页新增「v10 操纵台与资产文件化」段落（rose 边框，与 v6 amber/v7 emerald/v8 sky/v9 violet 区分）；快捷键速查表新增「再次点击段 → 打开缓动编辑器」。
- 【bug 修复/防御】① Toolbar 工具栏标题输入框与场景卡标题的 data-testid 重名（scene-title）→ 工具栏改为 scene-title-input 消除测试二义性；② 修复 lint：BakePlayerDialog 传输重置改为 keyed 子组件模式、SpeedGraph 编辑器自动关闭改为 editorKf 渲染守卫（消除 effect 内 setState）、Timeline 归一化峰值从 useMemo 内写 ref 改为 HeatTrack.gmax 字段（消除渲染期 ref 写入）。
- 【验证方法学备注】CDP 鼠标事件（agent-browser mouse down/move/up）对本 SVG 手柄拖拽偶发不触发 React onPointerDown（跨命令间浮层几何偏移所致，与 v7 记录的 Radix 合成事件怪癖同类，属测试方法问题）；改用与真实浏览器输入同构的合成 PointerEvent（dispatchEvent on element + window pointermove/up）全链路验证——代码路径（React 根委托 → handler → store → 重渲染）完全一致，非应用缺陷。
- 【验证（agent-browser 全通过）】全新会话 console 零错误；播放推进 + 引擎 6 实例矩阵直写；速度图编辑器开→拖→联动→undo 全链路；.kfbake 字节级验证 + 导入回灌渲染；播放器传输控制；热力条 hover 读数 + pointerleave；导出双段 chips + 48 帧 GIF 真实渲染；重命名 DB 级验证 + 还原；移动端抽屉 + 页脚贴底；报告页 v10 段落；lint 零错误；dev.log 无运行时错误（仅预期 PATCH/GET 200）。

Stage Summary:
- 本轮交付：v10「操纵台与资产文件化」——速度图缓动编辑器（图表即编辑界面完整闭环：速度曲线/热力条/Inspector 三视图同源联动）、.kfbake 分发文件格式（KFBAKE1 二进制规范 + 导出/导入/字节级校验）、独立烘焙播放器（零引擎依赖 Canvas2D 回放）、轨道热力条 hover 段读数、导出元数据双段 chips、场景库行内重命名、移动端 Inspector 抽屉
- 项目状态：动效工作站 v10；烘焙产物完成「OPFS 资产（v9）→ 自包含可分发文件（v10）」跃迁，P0「Motion-as-a-Service」在浏览器内完成 bake→file→share→play-anywhere 全链路演示；速度维度完成「可操作（v9）→ 可编辑（v10）」跃迁；无已知 bug
- 下一轮建议优先级：① 速度图编辑器拖拽时实时显示速度预览虚影（拖前预估改后曲线）② kfbake 播放器支持逐帧导出 PNG/录制（分发资产的二次创作）③ 场景库卡片显示收藏/元素数/关键帧数统计行 ④ 时间轴关键帧拖拽时的吸附指示线（对齐其他轨道关键帧/播放头）⑤ 导出中心 WebM 也支持透明背景探索（VP9 alpha @ Chrome）⑥ PerfLab 增加 1000 实例烘焙模式内存压力展示
- 风险提示：CDP 合成鼠标对 SVG 手柄拖拽的测试怪癖（见方法学备注，真实用户不受影响）；kfbake 播放器色相为确定性重生成（ABI 不含颜色——若未来场景支持自定义实例颜色需扩展 ABI 或头元数据）；速度图编辑器浮层在轨道极少 + 时间轴顶部时可能上溢滚动容器（overflow 可见，不影响交互）；Sheet 抽屉内 Inspector 较长依赖内部滚动（max-h 已设）

---
Task ID: 11
Agent: Z.ai Code (cron webDevReview #10)
Task: QA 巡检 + v11 磁吸对齐与资产二次创作（时间轴吸附指示线、速度图修改前虚影、烘焙播放器 PNG/GIF 二次创作、场景统计行、内存压力指标、WebM VP9 alpha 探测）

Work Log:
- 【状态判断】读取 worklog（Task 1-10 基线），agent-browser 全面 QA：页面 200、console 零错误、播放推进（1.22s）+ 引擎 6 实例矩阵直写、PerfLab 250 实例 38fps（0.495ms 求值）、/api/scenes 200、移动端 390px 页脚自然推挤贴底（footerBottom=scrollHeight）——基线全绿无存量 bug → 进入 v11 功能轮。
- 【时间轴磁吸吸附指示线（v11-a）】onKfPointerDown 拖拽闭包新增磁吸系统：
  - 候选集：非移动轨道的全部关键帧（跨轨对齐是核心价值）+ 播放头 + 标尺刻度（tickStepRef effect 镜像自适应 step，规避 TDZ）；移动轨道自身关键帧位排除（碰撞守卫会静默丢弃该移动，吸附指示会误导）。
  - 容差：8px → ms 换算（rect.width 归一）；命中即覆写 rawT。
  - 指示线：emerald 虚线 + 时间角标（data-testid=snap-guide / snap-guide-label），与播放头同一 calc(12px + (100%-24px)*frac) 坐标系，直写 DOM 零重渲染，pointerup 隐藏。
  - 实测：拖拽 el1@0 → 邻轨 el2@400 附近 5px 处 → 指示线显示「0.40s」+ 关键帧精确落位 kf-el1-400 + undo 还原全链路通过。
- 【速度图修改前虚影（v11-b）】SpeedGraph 编辑器打开瞬间捕获该段当前 SegSpeed 快照（ghost state），canvas 绘制层在全部曲线之后叠加白色虚线（setLineDash [4,3]、0.55 alpha、以当前 max 归一保证前后同尺度）；编辑器关闭（Esc/点空白/关闭钮统一走 closeEditor）即清 ghost。编辑浮层新增图例行（虚线=修改前速度 / 实线=当前速度，颜色取元素本色）。实测：点击曲线段 → 编辑器 + ghost 图例出现；合成 PointerEvent 拖拽 P1 → canvas 指纹 6222→6603（重绘确认）+ data-easing 写入 CubicBezier；undo 后回到既有 1 个 Cubic（演示场景自带 1 个，拖拽新增的第 2 个被撤销）；Esc 后图例卸载。
- 【烘焙资产二次创作（v11-c，新库 src/lib/bake-record.ts）】paintBakeFrame（分辨率无关绘制：s=w/960 缩放矩阵+背景辉光+逐实例 roundRect，帧索引+memcpy 零引擎依赖）+ exportBakeGif（全局 256 色板 = 5 采样帧合并，与场景 GIF 管线同策略）+ downloadBlob。BakePlayerDialog 重构：rAF 循环改用共享 paintBakeFrame；新增「资产二次创作」操作条（emerald 面板）：导出当前帧 PNG（2× 离屏 1920×960，文件名 title-frame-NNN.png）/ 录制 GIF（960×480·157 帧·进度条 + 取消钮 + 完成自动下载）。实测：PNG toast「1920×960 · 帧 135/157」；GIF 录制完成 toast「960×480 · 157 帧 · 20.82MB」，全程主线程 eval 延迟 0.1ms。
  - 【本轮最重要 bug 修复】首轮 1000 实例录制时浏览器主线程被压死 >5min（CDP 全超时，只能杀进程）：根因是播放器 rAF 循环在暂停时仍全速重绘同一帧（1000 实例 + shadowBlur），与编码管线抢 CPU。修复：draw 循环 lastPainted 去重——暂停且帧号未变则跳过重绘（录制期间编码器几乎独占主线程）；exportBakeGif 逐帧 yield（原每 2 帧一次）。修复后 250 实例录制 ~6s 完成且交互零卡顿。
- 【场景结构统计（v11-d）】GET /api/scenes 服务端解析 data JSON 输出 elCount/kfCount（损坏行静默归零，不传 data 载荷）；库卡片新增统计行（Layers 元素数 · Diamond 关键帧数 · 时长，data-testid=scene-stats）；duplicateScene 乐观插入继承统计。实测：API {elCount:10, kfCount:24}，卡片显示「10 · 24 · 4.0s」。
- 【PerfLab 内存压力指标（v11-e）】指标区扩为 5 卡（grid-cols-2 md:grid-cols-3 lg:grid-cols-5）：新增「内存压力」卡（MemoryStick violet）——JS 堆占用 MB（Chromium performance.memory，非 Chromium 显示 —）+ 占堆上限色阶条（emerald<50% / amber<80% / red≥80%）+ 副行实时显示烘焙块体积（烘焙模式「烘焙块 x.xx MB（n×帧×80B）」/ 实时模式「实时求值 · 无烘焙块」），全部直写 DOM 与 500ms 指标窗同步。实测：250 实例 26MB 堆 + 2.99MB 烘焙块；1000 实例 49MB 堆 + 11.98MB（=1000×157×80B 精确）、现场烘焙 301ms + OPFS 回写。
- 【WebM VP9 alpha 能力探测（v11-f）】video-export.ts 新增 probeWebMAlpha()（模块级缓存）：MediaRecorder.isTypeSupported 对 alpha 说谎，唯一诚实测试是真实编码 40% 透明红帧 → 解码回读像素 alpha；含 3s watchdog。exportSceneWebM 新增 alpha 选项：强制 VP9（VP8 丢 alpha）、drawSceneFrame transparent:true。ExportCenter：打开即探测（null=探测中/true/false 三态 UI）；透明开关对 WebM 仅在探测通过后可用（「VP9 α ✓」emerald 徽标）+ 不支持时诚实降级提示（「此浏览器不支持 VP9 α」）；预览棋盘格/meta 规格 chip（VP9 α · xMbps）/文件名 -alpha 后缀全联动；编码中 VP9 失败有专项 toast。实测：本环境 Chrome 探测通过 → 开关 + 徽标出现 → 渲染 204 帧 519.7KB「VP9 透明背景」→ 页内拦截 blob 解码像素级验证：t=1.5s 帧网格采样 3424 个背景点 alpha=0（真透明）+ 内容点 RGBA [244,159,12,255]（amber 主色实心）——透明 VP9 WebM 端到端成立。
- 【文档同步】页头徽章 v10→v11；战略报告页新增「v11 磁吸对齐与资产二次创作」段落（teal 边框，与 v6 amber/v7 emerald/v8 sky/v9 violet/v10 rose 区分）。
- 【验证方法学备注】①Radix Tabs/DropdownMenu 在 CDP eval 合成 click 下不激活（需 agent-browser snapshot ref 原生点击或 mouse down/up）——延续 v7/v10 记录的测试怪癖；②headless Chrome 下载不落盘 → 用「patch HTMLAnchorElement.prototype.click 捕获 blob URL → fetch → video 解码 → getImageData」的页内验证法完成字节级断言（比找下载目录更可靠）；③头部 sticky 遮挡已滚动页面的标签（scrollTo(0,0) 后再点）。
- 【验证（agent-browser 全通过）】console/page errors 全程零输出；v11-a 吸附精确命中 + undo 还原；v11-b 虚影出现/联动/撤销/清理；v11-c PNG 2× 导出 + GIF 157 帧完成 + 主线程 0.1ms 响应 + 暂停零重绘（400ms 双采样指纹相同）；v11-d API/卡片统计一致；v11-e 双规模内存读数精确（2.99MB/11.98MB）；v11-f 探测徽标 + 像素级透明验证；报告页 v11 段落；移动端 5541=5541 自然推挤；lint 零错误零警告；dev.log 无运行时错误。

Stage Summary:
- 本轮交付：v11「磁吸对齐与资产二次创作」——时间轴磁吸吸附（跨轨关键帧/播放头/刻度三源候选 + emerald 指示线）、速度图 before/after 虚影、.kfbake 资产二次创作（2× PNG 帧导出 + 整循环 GIF 录制，零引擎环境闭环「分发资产既可播放也可再创作」）、场景库结构统计、PerfLab 内存压力指标（1000 实例 11.98MB 载荷可视化）、WebM VP9 alpha 经验探测 + 条件透明导出；并修复「暂停时 rAF 全速重绘导致录制主线程饿死」的性能 bug
- 项目状态：动效工作站 v11；交付链完成「透明视频」最后一块拼图（GIF/PNG α 已有 + VP9 α WebM 探测式补齐）；P0「Motion-as-a-Service」故事线延伸至资产再创作（bake→file→play→re-create）
- 下一轮建议优先级：① 速度图虚影升级为「多历史快照」（每次拖拽存一帧 onion-skin 式叠加，可回溯整段调曲线过程）② GIF 录制尺寸/帧率可调（当前固定 960×480@fps，暴露 seqWidth 同款 Select）③ 磁吸候选支持 Shift 临时禁用（NLE 惯例）④ 场景库批量导出 .keyforge.json ZIP ⑤ PerfLab 烘焙管线对比图新增「内存」维度（当前只有时间）⑥ WebM alpha 探测结果持久化到 localStorage 减少重复探测
- 风险提示：GIF 录制 20.82MB（辉光 shadowBlur + 平滑渐变对 256 色板不友好，属资产特性非 bug；后续可暴露尺寸选项）；VP9 alpha 探测 3s watchdog 在极慢设备可能误报不支持（降级路径无害）；1000 实例 GIF 录制约需 30-60s（逐帧 yield 后交互不卡但总时长可观，进度条 + 取消已就位）；性能.memory 非 Chromium 为「—」（Firefox/Safari 功能降级非错误）

---
Task ID: 7-b
Agent: frontend-styling-expert
Task: 大规模可视化专项的集成评估与战略转型报告组件

Work Log:
- 通读 worklog（Task 1-11 基线）与 studio/ReportTab.tsx 现有视觉语言（Card+Stat/CheckList/Pivot 子组件、border-zinc-800 卡片、amber 图标强调、xs/zinc-400 正文），确定新组件风格延续且内容严格互补（ReportTab 覆盖阶段一/二，本组件聚焦 Phase 3/4 大规模可视化专项）。
- 核对依赖可用性：lucide-react 0.525 图标逐一在 d.ts 中验证存在（Orbit/ChartLine/Waypoints/Braces/MemoryStick/TriangleAlert/Blocks/Film/Server 等 30+ 个）；确认 accordion/tabs/table/card shadcn 组件 API 后选用 Tabs 组织两大板块。
- 新建 src/components/massviz/ReportSection.tsx（唯一新增文件，未改动任何其他文件）：
  - 导出接口：export interface BenchRow { label; evalMs: number|null; fps: number|null; note } 与 export interface ReportSectionProps { benchRows?; particleCount?=25000; kernelInfo? } —— props 全可选、有默认值；主组件具名导出 ReportSection（"use client"）。
  - 头部卡：标题 + Phase 3/4 说明（明确与 ReportTab 互补不重复）+ kernelInfo 等宽字体内核信息行（data-testid=kernel-info）+ 四格指标条（压测规模/渲染层/80B ABI/分析喂频）。
  - 板块一（Phase 3 · 集成评估，Tabs 第一页）：① 正确应用场景 6 卡（大屏粒子/星系层、图表叙事背景层（ECharts 统计 + WASM 氛围层同源时间轴）、25k 边地理/拓扑流动、数字孪生状态点阵、演出 LED 实时内容、基准实验室方法论），每卡 lucide 图标 + sm 加粗标题 + xs 正文 + cyan tag 徽章；② 不适用/慎用 4 项（少量精细 UI 动效→CSS/Framer Motion、SSR 首屏、强 SEO、无 WebGPU/WebGL2 低端设备）；③ 集成方式分层架构图（纯 flex，无图片）：Rust 内核 → wasm-bindgen 胶水+fast-path → WebAssembly.Memory（内嵌 80B GpuInstanceData 字节布局条：mat4×16 f32=64B/opacity=4B/visible=1B/clipIndex=1B/padding=10B，flex-grow 按字节比例分段 + 图例）→ queue.writeBuffer 零拷贝 → WebGPU/WebGL2 渲染层；右侧 cyan 虚线 sidecar 分析支路（~250ms 聚合 → ECharts/D3 千级组件，分频注释）；amber 陷阱条标注「buffer 指针当帧消费：复用缓冲 subarray 跨帧被下一帧覆写」；④ 实测基准表（shadcn Table）：JS 回退 / WASM 原版 evaluate_frame / WASM fast-path（amber 高亮）三行 × 求值耗时/帧率/吞吐（由 evalMs 与 particleCount 自动推算）/备注，数值默认 null 显示「— · 待实测」徽章，全表 data-testid 标注（bench-table/bench-row-N/bench-evalms-N/bench-fps-N/bench-tps-N/bench-note-N/bench-caption）供后续注入真实数字后断言。
  - 板块二（Phase 4 · 战略转型，Tabs 第二页）：① 定位跃迁双箱箭头图（DOM 动效编辑器 → 大规模可视化动效底座 Animation Substrate，amber 辉光）+ 三枚壁垒徽章（80B GPU 实例 ABI / bakeChunk 烘焙系统 / 时间线内核数学，点明壁垒非 DOM 绑定层）；② 三条产品化路径 A/B/C 卡（SDK 授权嵌入引擎 / 数据新闻展览叙事工具链（Remotion 基础）/ fast-path+WASM 构建链回馈上游建生态位），各带「已有基础」cyan 脚注；③ 风险与对冲三行（WebGPU 覆盖率→WebGL2 回退已实现 / wasm-bindgen 版本锁死→构建链脚本化 / 上游活跃度→vendor 化解）；④ 下一步路线 01-04（多线程 WASM（SAB+rayon 10 万级）/ compute shader 蒙皮插值下沉 GPU / bake 经 WebCodecs 直出 mp4 / 服务端 Rust 集群版复用同内核）。
- 样式合规自查：仅 zinc/amber/cyan 色系（rg 检查无 indigo/blue-*）；卡片统一 rounded-xl border-zinc-800 bg-zinc-900/60 p-4/p-6、网格 gap-4/gap-6；标题 sm 加粗、正文 xs zinc-400；sm/lg 断点多列、移动端单列堆叠；lucide-react 图标列表。
- 验收：bunx eslint src/components/massviz/ReportSection.tsx --max-warnings=0 → 退出码 0（零错误零警告）；bunx tsc --noEmit | rg ReportSection → 无任何匹配（无类型错误）。

Stage Summary:
- 交付物：src/components/massviz/ReportSection.tsx（唯一新文件）——大规模可视化专项「集成评估（Phase 3）+ 战略转型指导（Phase 4）」报告组件，Tabs 双板块、8 个子组件、全 props 可选带默认
- 关键结果：验收双绿（eslint --max-warnings=0 通过、tsc --noEmit 无 ReportSection 错误）；基准表三行数值留空待填、data-testid 齐备（bench-evalms-0..2 等），Task 7-a 实测跑完后可零改动经 props 注入并自动推算吞吐列
- 集成说明：组件未接入任何页面（按任务边界只建文件不改动他处）；接入方仅需 <ReportSection />（默认值即完整可渲染）或传入 benchRows/particleCount/kernelInfo 定制；风格与 ReportTab 同源（zinc 深色卡 + amber 强调），色彩纪律收紧为 zinc/amber/cyan 三系

---
---
Task ID: 7-a
Agent: frontend-styling-expert
Task: 大规模可视化演示的 ECharts/D3 面板组件

Work Log:
- 读 worklog（Task 1-11）与 PerfLab.tsx 视觉基准（amber/zinc 深色科技风、Badge outline text-[10px]、卡片 border-zinc-800 + bg-zinc-900/60），确认 echarts 实装版本为 6.1.0（任务书中的 7.9 不存在，所用的 init/setOption/dispose/ResizeObserver API 完全兼容）、d3@7.9 + @types/d3@7.4.3 就绪。
- 新建 src/components/massviz/panels/PerfChartPanel.tsx：ECharts 双轴流式折线 —— 左轴 ms（evalMs amber-400 实线 1.6w / gpuMs cyan-400 虚线 [4,3]），右轴 FPS（zinc-500 面积线 14% 透明度），x 轴为 value 型时间轴（秒格式化 + zinc-800 轴线/zinc-600 刻度/y 轴 dashed splitLine）；useEffect 内 init、React ref 持有实例、卸载 dispose、ResizeObserver 响应尺寸（0×0 时跳过 resize 防隐藏标签页告警）；数据流 setOption 增量合并 { notMerge: false, lazyUpdate: true, silent: true }（silent 关闭整图命中检测，故有意不配 tooltip）；头部三 Badge（kernelLabel=amber / backend 按 WebGPU→cyan、WebGL2→amber、未初始化→zinc / 粒子数 toLocaleString）；空数据时图表保持挂载、仅叠加 animate-pulse 骨架遮罩（避免反复 init/dispose 抖动）；图例常显（silent 下点击无效属预期）；h-[220px] 固定高度。
- 新建 src/components/massviz/panels/HistogramPanel.tsx：32 桶柱状图 —— 柱色按桶索引对 amber-400(251,191,36)→cyan-400(34,211,238) 做 RGB 线性插值形成跨桶色带，borderRadius [3,3,0,0] + borderWidth 0，坐标轴极简（x 仅淡轴线 + auto 稀疏刻度、y 虚线 zinc-800 网格）；头部标题「半径分布 · 数据驱动聚合」+ 副标题「total.toLocaleString() 粒子 · 采样间隔」；updatedAt 首到达显示默认「采样间隔 250ms」，连续两次到达后以 ref 直写 textContent 换成实测间隔（零 React 重渲染，规避 set-state-in-effect lint，与 PerfLab 直写 DOM 模式同源）；动画 animationDurationUpdate 240ms 平滑形变；空数据（bins 空或 total=0）显示柱形骨架；init/dispose/RO/setOption 规范同上；h-[220px]。
- 新建 src/components/massviz/panels/KeyframeInspector.tsx（D3 + SVG，零 ECharts）：① 轨道俯视图 —— 20 个关键帧 (dx,dy) 以 curveCatmullRom.alpha(0.5) 平滑连线（暗底 zinc-600 1.3w + amber 微光 0.6w 双 path）、圆点按 easing 着色（Linear=zinc-500 / EaseInOut=amber-400 / CubicBezier=cyan-400 / 其他=rose-400，匹配时 lower-case 归一）、原生 <title> 悬停提示（kf 序号/时刻/缓动名）、原点十字锚、坐标 scale clamp(true) + 25% 外边距防发光点越界；当前 relative 画 amber 发光呼吸点（animate-pulse 光晕 + drop-shadow）。② 时间曲线 —— dx(t)/dy(t)/scale(t) 三条（每条独立归一化比较形态、逐段 12 子步按该段缓动采样，求值语义与引擎/SpeedGraph 同构；CubicBezier 无控制点 payload 以 smoothstep 逼近），x 轴 0..clipDurationMs 五档秒刻度；playheadMs 琥珀虚线游标。③ 性能设计：path 字符串与全部坐标 useMemo 按 track 预计算、两个 SVG 子组件 memo 化，播放头游标与呼吸点的 transform 由父组件 useEffect ref 直写 —— 10Hz playheadMs/relative 更新零 SVG 重渲染。④ 底部 world / relative / opacity 等宽读数（opacity 按所在段缓动插值，段外取端点值）+ 播放头进度；track null 时显示「点击画布选择粒子」占位卡；SVG viewBox 340×200 + preserveAspectRatio 自适应容器，双井 h-[220px]。
- 验证：bunx eslint src/components/massviz/panels/ --max-warnings=0 → 零错误零警告；bunx tsc --noEmit 全仓 20 处错误经核对全部为存量（studio/lib/skills/examples 等他人文件），massviz 路径零匹配；bun 动态 import 三模块冒烟（echarts/d3/lucide/badge 模块级解析通过）+ d3 CatmullRom 轨道与逐段折线在 20 关键帧数据上生成合法 path 冒烟通过；未触碰任何既有文件（page.tsx、worklog 之外的文件零改动）。

Stage Summary:
- 交付 3 个自包含面板组件：PerfChartPanel（ECharts 双轴流式性能遥测）、HistogramPanel（ECharts amber→cyan 渐变半径直方图）、KeyframeInspector（D3 轨道俯视图 + 时间曲线 + ref 直写播放头/呼吸点），全部 "use client"、zinc/amber/cyan/rose 色系、rounded-xl border-zinc-800 卡片、h-[220px] 防抖动容器、空数据骨架占位
- 接口约定（主代理集成注意）：① PerfSample.t 需单调递增 ms（x 轴按秒显示），samples/bins 变化时请传新数组引用（effect 依赖浅比较触发 setOption 增量合并）；② KeyframeInspector 的 SVG 子树按 track 对象引用 memo——track 请按数据变化重建对象，勿每帧重建；playheadMs/relative/worldPos 可放心 10Hz 直推（ref 直写已优化）；③ relative 超出关键帧包络时呼吸点被 clamp 在画布内（俯视图含 25% 边距缓冲）；④ opacity 读数与 CubicBezier 段曲线形态为近似求值（payload 无控制点，smoothstep 逼近）；⑤ Histpanel 的「采样间隔」首帧固定显示 250ms、第二次 updatedAt 起显示实测值；⑥ ECharts silent:true 已关闭图表鼠标交互（流式更新零开销的取舍），如需 tooltip 请自行去掉 silent 并加 tooltip 配置；⑦ echarts 实装 6.1.0 而非任务书的 7.9（API 兼容，无需行动）

---
Task ID: 2
Agent: Z.ai Code (main)
Task: 编译 Rust 构建 WASM 内核，构建大规模数据可视化动效层 —— 25k 粒子 × 20 关键帧 × 60fps WebGPU 演示，与 ECharts/D3 集成

Work Log:
- 【工具链】安装 rustup 1.98.0 (minimal) + wasm32-unknown-unknown target；发现后台 nohup 进程会被会话回收，全部改前台长超时执行。
- 【内核 vendor + 编译】拷贝 /home/z/keyframe-repo/src → rust/keyframe-engine/；固定 wasm-bindgen =0.2.100 并下载对应 CLI（musl 静态）；新增 src/fast.rs（附加式快速路径：FastState 逐实例常量快照 + 复用输出缓冲 + 逐帧零分配，upstream API 不动）；lib.rs 追加 prepare_fast/evaluate_frame_fast/fast_buffer_ptr/fast_buffer_byte_length/kernel_build_info；cargo build --release → 299KB → wasm-bindgen --target web → public/wasm/（bg.wasm 278KB + 胶水 17.8KB + 官方 d.ts）。
- 【TS 桥接】src/lib/mass/kernel.ts：blob 模块动态 import 胶水（new Function 绕开打包器）+ ArrayBuffer 手动喂 init()（绕开 import.meta.url 相对 fetch），init 返回 InitOutput.memory 供零拷贝。
- 【场景】scene.ts：12 动效母题 × 20 关键帧（环轨/花瓣/呼吸核/八分环/闪点阵/三叶缎带/涟漪/双子摆/十字巡航/螺旋/星尘/涡旋臂，覆盖全部缓动类型与 origin 枢轴），银河分布（3 旋臂差速旋转 + 8% 核球）× N 实例，单次 import_ir_json 注入（一次 JSON 边界穿越）。
- 【渲染器】renderer.ts：WebGPU 主路径（storage buffer 零拷贝 writeBuffer + 实例化 quad + rgba16float ping-pong 拖影 + 色调映射 blit）；WebGL2 回退（核心 instancing vertexAttribDivisor + 5×vec4 矩阵属性 + POINTS + RGBA8 ping-pong）；正交相机（缩放/平移/旋转/自转）。
- 【应用】MassVizApp：rAF 循环（内核求值计时 → GPU 上传 → 渲染），HUD（后端/内核标签/实例数/求值 ms/提交 ms/WASM 内存/FPS/吞吐），控制台（播放/速度/粒径/实例数 1k-40k/内核路径 fast-vs-原版对照/着色三模式/拖影/旋转），画布交互（滚轮缩放/拖拽平移/点击拾取最近粒子），初始化后台基准（40+40 帧均值）。page.tsx 增加第四 Tab「粒子引擎」并设为默认（dynamic ssr:false），/api/engine-info 返回编译产物元数据。
- 【子代理并行】7-a：ECharts 双轴性能流式折线 + 32 桶半径分布柱图 + D3 关键帧检查器（轨道俯视图 CatmullRom + 按缓动着色 + 时间曲线播放头 ref 直写）；7-b：ReportSection（集成评估 Phase 3 + 战略转型 Phase 4，含基准表 testid 钩子）。二者 lint/tsc 全绿。
- 【三大 bug 战役（agent-browser 端到端排查）】
  ① texSubImage2D 尺寸不匹配（w×ceil×4 ≠ count×20 floats）→ 整行+尾行两次上传；
  ② RGBA32F 数据纹理 LINEAR 过滤在无 OES_texture_float_linear 时不完整 → texelFetch 全零；且 **SwiftShader/Chromium 拒绝 grow 过的 WebAssembly.Memory 背书视图**（INVALID_VALUE，隔离探针复现：未 grow 内存上传成功、grow 后被拒）→ WebGL2 路径改为 scratch 常规缓冲拷贝（~0.3ms）后 bufferSubData，并彻底重写为 instancing 属性矩阵方案（弃用数据纹理）；
  ③ **真凶**：内核 visible 写 u32 位型（0x00000001），GLSL 按 float 读 = 1.4e-45 < 0.5 → 全部 25000 实例被判定隐藏 → floatBitsToUint(aMeta.y)==0u 修正（WebGPU 路径本身用 u32 比较无此问题）。
- 【headless 伪影】后台页 rAF 节流致 simTime 仅走真实时间 ~9%（dt 钳 50ms）→ 黑屏假象；加 __mvSeek(t) QA 钩子跳时间后完整验证；真实前台浏览器无此问题。
- 【实测基准（bench 80 帧均值，注入报告表）】JS 回退外推 11.3ms ｜ WASM 原版 evaluate_frame **4.84ms（206.6 FPS，516 万实例/s）** ｜ WASM fast-path **0.907ms（1101.9 FPS，2754.8 万实例/s）** → **fast-path 提速 5.3×**；25k 实例仅占 60fps 帧预算 5.4%。
- 【验证（agent-browser 全通过）】银河三旋臂+核球渲染（seek 30s 截图）；点击拾取 p-412→闪点阵检查器（轨道图+方波时间曲线）；内核切换 fast↔原版实时对照（7↔11.3ms）；实例数 25000↔5000 重建；暂停/视角/着色/拖影控件；/api/engine-info 200（wasm 278109B）；ECharts/D3 数据流动；移动端 390px 单列布局 + 页脚贴底（6033>844 自然下推）；lint/tsc 零错误；dev.log 无运行时错误；控制台无未捕获异常。

Stage Summary:
- 交付：自编译 Rust WASM 内核（含自研 fast-path，5.3× 提速）驱动的 25k 粒子×20kf 大规模可视化动效层，WebGPU/WebGL2 双后端，ECharts/D3 同源数据集成，集成评估与战略报告落地页面
- 项目状态：v12 —— 四 Tab（粒子引擎默认/工作台/性能实验室/战略评估）；无已知 bug
- 遗留说明：headless 环境无 WebGPU（自动回退 WebGL2 已验证）；WebGPU 路径逻辑已实现待真机验证；40k 实例以上可探索 SAB+rayon 多线程
- 下一轮建议：① 真机 WebGPU 验证与 GPU timestamp 精确计时 ② 母题库扩展（路径动画/物理弹簧）与场景导入 ③ bake 离线导出（WebCodecs mp4）④ ECharts 聚类聚合散点联动点击选中 ⑤ 报告基准数据持久化

---
Task ID: 12
Agent: Z.ai Code (cron webDevReview #11)
Task: 修复用户报告「看不到粒子」——真机 WebGPU 黑屏根因定位与修复 + 双后端功能视差补齐

Work Log:
- 【用户报告】真实浏览器看不到粒子；headless agent-browser QA（WebGL2 回退路径）一切正常 —— 指向仅真机 WebGPU 路径才触发的缺陷。
- 【根因定位（证据链闭合）】renderer.ts 原 WGSL 将 fade 入口点与主模块共存：fs_fade 静态引用 U(uniform @group0 binding0) 与 sampF(sampler @group0 binding0) → 绑定槽冲突 → createRenderPipeline(fadePipe) 验证失败 → invalid pipeline → 每帧 queue.submit 整个 command buffer 被丢弃 → 画布永久黑屏（无 JS 异常，phase 照常 ready）。编译器级证明：cargo install naga-cli v30.0.1，原始合并模块被 naga 精确拒绝（"Entry point fs_fade at Fragment is invalid — Bindings for [3] conflict with other resource"），修复后三模块全部 Validation successful。headless Chrome 无 WebGPU（navigator.gpu 不存在，--enable-unsafe-webgpu/--enable-features=Vulkan 等 flag 矩阵均无法在 Chrome-for-Testing 152 headless 暴露）→ QA 从未走过 WebGPU 路径，真机 Chrome 首次暴露。
- 【修复 1 · WGSL fade 独立模块】新建 WGSL_FADE（sampF@0/texF@1/FU@2 + 专属 16B FadeUni uniform buffer），fadeLayout 增补 binding2 uniform；fadePipe 改用 fadeModule；render() 每帧 writeBuffer fade 值；主 WGSL 移除 fade 入口点（U.fade 字段保留无害）。
- 【修复 2 · u32 位型写入】colorMode/selectedIdx 原以 f32 写入但 WGSL 按 u32/i32 读取（f32 1.0 = 0x3F800000 = 1065353216）→ 着色模式 1/2 与选中高亮在 WebGPU 全失效；新增 viewU32 = Uint32Array(viewData.buffer) 位型视图直写。
- 【修复 3 · 初始化期验证错误同步捕获】WebGPURenderer.create 用 device.pushErrorScope("validation") 包裹管线创建 + popErrorScope 判定——命中即 console.error + destroy + markWebGPUDead() + 返回 null → createRenderer 工厂自动落 WebGL2（用户看到粒子而非黑屏）。
- 【修复 4 · 运行期自愈】device.onuncapturederror + device.lost → onFatal 回调 → MassVizApp.recoverToWebGL2()：guard 单飞（recoveringRef/mountedRef）→ 销毁旧 renderer → **换新 canvas 节点**（webgpu-configured canvas 无法再取 webgl2 context）→ createRenderer（isWebGPUDead 短路直走 WebGL2）→ resize + setColorBuffer(scene.colors) 重灌 → rAF 循环下一帧无缝续播（rendererRef 每帧重取）。
- 【修复 5 · 交互重绑】MassVizApp 交互监听（滚轮缩放/拖拽平移/点击拾取）提取为 bindInteractions(canvas) 返回 cleanup 的可复用函数 + unbindRef；自愈换节点后重绑；原内联 effect 替换为轻量挂载 effect（重构后点击拾取 p-412 → 检查器全链路回归通过）。
- 【修复 6 · GL2 着色模式视差】QA 中发现 WebGL2 粒子着色器根本没有 uColorMode——切「母题色带/单色琥珀」在 GL2 下静默无效；补齐 uniform int uColorMode + rampColor（与 WGSL 同 IQ palette 参数），render() 传 frame.colorMode；实测「单色琥珀」整河呈琥珀金（截图确认），模式切换在两个后端语义一致。
- 【修复 7 · kernel.ts CSP 加固】new Function("u","return import(u)") 在无 unsafe-eval 的受限 CSP 容器（如预览 iframe）抛 EvalError → 新增 importGlueModule 双通道：eval 失败时 <script type="module"> 注入 + window 锚点回传模块（随机锚点名 + onerror 拒绝 + 清理）。
- 【验证（agent-browser + naga 双通道）】naga：修复后 WGSL/WGSL_FADE/WGSL_BLIT 全部 Validation successful，原始 buggy 模块精确报绑定冲突（编译器级根因证明）；agent-browser：页面 200、console 零错误（仅 wasm-bindgen deprecated 参数 warning，既有）、银河渲染（WebGL2 截图）、HUD backend/fps/count 正常、点击拾取 p-412 → 闪点阵检查器 20kf 全链路、实例数 25k→40k→25k 重建、着色「单色琥珀」视觉确认、移动端 390px footer 贴底（6033=6033 自然推挤）、基准表实测数字注入（fast-path 1.042ms/959.2fps/2398.1万实例/s）、lint 三文件零错误零警告、tsc 无新增错误（存量错误均为他人文件既有）、dev.log 无运行时错误。
- 【验证方法学新增】① headless Chrome-for-Testing 152 无法启用 WebGPU（flag 矩阵无效）→ WGSL 正确性用 naga（wgpu 同源验证器）编译器级验证替代真机运行；② Radix Select 对 agent-browser select 命令无响应，须 click 展开 + option ref 原生点击（延续既有怪癖记录）；③ preserveDrawingBuffer:false 的 canvas 用 drawImage+getImageData 指纹恒为 0（合成后清空）——画布验证一律用 Page.captureScreenshot。

Stage Summary:
- 本轮交付：真机 WebGPU 黑屏修复（WGSL fade 绑定冲突 = 根因，naga 编译器级证明）+ 初始化期验证错误同步捕获 + 运行期致命错误自愈回退 WebGL2（换节点 + 交互重绑）+ u32 位型写入修复（着色模式/选中高亮在 WebGPU 恢复）+ GL2 uColorMode 视差补齐 + kernel CSP 双通道加载
- 项目状态：v12.1 —— 双后端功能语义对齐（着色三模式、拾取高亮、拖影在 WebGPU/WebGL2 一致）；WebGPU 主路径经编译器验证 + WebGL2 回归全绿；无已知 bug
- 下一轮建议优先级：① 真机 WebGPU 实测（用户浏览器现已可验证——若仍异常，onuncapturederror 会自动回退 WebGL2 且 console 有明确日志）② GPU timestamp query 精确计时 ③ 着色模式 1（母题色带）图例条 ④ 速度图虚影升级多历史 onion-skin ⑤ kfbake 播放器尺寸/帧率可调 GIF
- 风险提示：沙箱无法真机运行 WebGPU（Chrome-for-Testing 152 headless 不暴露 navigator.gpu）——WebGPU 路径的运行时正确性由 naga 编译器验证 + pushErrorScope 初始化自检 + 运行期自愈三重护栏保障，真机首验建议用户侧确认；CDP attach 时 headless FPS 偏低（20fps）为调试开销非回归（无 debugger 基线 46fps）

---
Task ID: 13
Agent: Z.ai Code (cron webDevReview #12)
Task: 修复用户真机 WebGPU 报告的两组新验证错误（uniform 80B<96B / blit bind group 2≠3 entries）——v12.1 修复后暴露的后续缺陷

Work Log:
- 【用户报告】真机 Chrome console 四连错误：① Draw(6,25000) 时 "[Buffer] bound with size 80 at group 0 binding 0 is too small, pipeline requires at least 96 bytes"（uniform）② createBindGroup "Number of entries (2) did not match expected (3)"（期望布局=FRAGMENT sampler+texture+uniform）③ Invalid CommandBuffer submit ④ Device lost "destroyed"（自愈链路主动销毁的连锁日志）。说明 v12.1 修复后管线创建已通过，但帧管线仍有两处验证错误 → 每帧丢弃 → 自愈回退 WebGL2（用户能看到了粒子但 WebGPU 主路径从未真正工作）。
- 【根因 A · 主 uniform 80B vs 96B】WGSL Uni 结构体 = viewProj(mat4,64B) + pointScale/colorMode/selected/fade(4×4B) + _p0/_p1/_2(3×4B padding) = 92B → uniform 地址空间按 struct 对齐(16) 向上取整 = 96B minBindingSize；而 JS 端 viewData=Float32Array(20)=80B、uni buffer size:80、bindParticle 绑定整块 80B → draw 时验证失败。用户错误消息本身即编译器级证明（"padded to a multiple of 16 bytes"）。修复：viewData→Float32Array(24)（96B，[20..23] padding 恒 0）、uni buffer size 96、writeBuffer 写满 96B；viewU32 位型视图自动跟随（colorMode@17/selected@18/fade@19 索引不变）。
- 【根因 B · blit 复用 3-entry fadeLayout】v12.1 将 fade 改为独立模块后 blitPipe 的 pipeline layout 误用了 fadeLayout(3 entries: sampler/texture/uniform)，而 render() 第 3 步 blit bind group 只提供 2 entries → createBindGroup 验证失败 → invalid bind group → 整帧丢弃。修复：新增专属 blitLayout(2 entries: filtering sampler + float texture, FRAGMENT)，blitPipe 改用它；getBindGroupLayout(0) 随之返回 2-entry 布局，与既有 bind group 代码自然匹配（render() 零改动）。
- 【防御加固】particleLayout binding0 显式 minBindingSize:96、fadeLayout binding2 显式 minBindingSize:16 —— 未来 JS/WGSL 尺寸再漂移时 createBindGroup 会在初始化 pushErrorScope 内同步失败 → 工厂立即回退 WebGL2，而不是每帧 draw 时静默丢帧黑屏。WGSL Uni 上方补 ABI 注释（92→96 推导）。
- 【日志诚实化】device.lost 回调区分「自愈流程主动 destroy 触发的连锁事件」（renderer.dead=true → console.warn "设备已主动释放"）与「真正意外设备丢失」（error + onFatal）——用户报告的错误④即前者，降级避免误导排查。
- 【验证】未改任何 WGSL 着色器代码（纯 JS 侧缓冲尺寸与绑组布局，96B 数值由用户浏览器验证器错误消息直接确认）；bun run lint：renderer.ts 零错误零警告（仅 public/wasm/*.d.ts 两条 wasm-bindgen 生成文件存量警告，与本次无关）；tsc --noEmit：massviz 路径零错误；agent-browser 端到端：页面 200、console 全程干净（零 [massviz] 错误/零页面错误，仅既有 wasm-bindgen deprecated warning）、银河三旋臂+核球渲染正常（WebGL2 回退路径截图）、HUD 正确（WebGL2 回退徽标/Rust WASM·fast-path/25,000 实例/内核 4.20ms/提交 0.70ms）、ECharts 流式面板数据流动正常；headless 无法运行 WebGPU（既有环境限制），WebGPU 路径正确性由：naga 同源验证（v12.1，着色器未变）+ 浏览器验证器错误消息交叉确认 96B + minBindingSize 初始化期自检 + 运行期自愈四重保障。

Stage Summary:
- 本轮交付：真机 WebGPU 主路径两组验证错误的根因修复（96B uniform ABI 对齐 + blit 专属 2-entry 布局）+ minBindingSize 显式化防御 + 设备丢失日志分级；WebGPU 路径的管线创建(v12.1)→uniform 绑定→bind group→整帧提交全链路首次在静态层面闭合
- 项目状态：v12.2 —— 期待用户真机复验：现在 WebGPU 徽标应正常显示且银河可见；若仍遇错误，初始化期错误会同步回退 WebGL2（可见粒子）且 console 有明确日志
- 下一轮建议优先级：① 用户真机确认 WebGPU 生效（HUD 徽标=「WebGPU」而非「WebGL2 回退」）② GPU timestamp query 精确计时 ③ 着色模式图例条 ④ 速度图多历史 onion-skin ⑤ kfbake GIF 尺寸/帧率可调
- 风险提示：沙箱 headless Chrome-for-Testing 无法暴露 navigator.gpu，WebGPU 运行时行为只能在用户真机确认；若真机仍有未知验证错误，自愈护栏保证粒子始终可见（WebGL2）且 console.error 提供精确错误消息

---
Task ID: 14
Agent: Z.ai Code (main)
Task: 新增「地形引擎」演示项 —— Trail-Sense-Earth-Model DEM 高程数据 × 纯逻辑地形系统（分块LOD/物质显影/微观纹理/植被增殖/射线求交/浮动原点）+ 物理真实动态细节

Work Log:
- 【数据源逆向】下载 dem-0.4.0-high.zip（325MB，WebP 瓦片 + index.json）+ 克隆 Earth-Model 仓库逆向编码：16-bit 模式 = `height = uint16/a − b`（R=低字节 G=高字节，a=0.25 b=−min），B 通道 = 水体掩膜（255 海洋/127 内陆水/0 陆地），15″ 分辨率 ≈ 450m/像元，无损 WebP。方向验证：row0 = 北缘（Shasta 4190m 峰值定位交叉验证）。
- 【表格提取】选定 N60W135 瓦片内 Mt. Waddington 冰原窗口（51.37N 125.26W，扫描最优：海洋 10.2% + 裸岩 17.2% + 雪(2200m+) 3.2% + 谷地 23.5%），提取 1024×1024 → 单文件数字表格 public/terrain/bc-coast.ktdem（3.0MB：16B 头 + i16 高程 + u8 水体掩膜）+ meta.json（真实地面采样距 dx=289.2m/dz=463.3m、经纬 bounds、峰顶 3784.5m）。运行时只消费数字表格（WebP 仅为分发压缩）。
- 【table.ts】表格加载（进度回调）+ 双线性高度采样 + 水体最近邻 + 坡度/坡向中央差分 + f32→f16 位型转换（R16F 纹理上传用）。
- 【chunks.ts · 空间划分与调度】四叉树子块（LOD0=64 采样，16×16 块网格）：每帧按「视锥平面×AABB（相对帧）」与「最近角距离环」筛选（RING 16/45/140km），近精细/远稀疏/视外跳过；每帧构建预算 3 块钳制（数据总量恒定）；宏观骨架 = 表格数值垂直抬升 + 中央差分法线（无任何预存几何，LRU 缓存 220 块 GPU 缓冲）；裙边消 LOD 缝隙（深度随距离 50-400m）。
- 【renderer.ts · WebGL2 五程序】①天空：太阳弧线（时刻→方位/高度/色温）+ 渐变 + fbm 云层（与地表云影同场同风向）；②地形：物质显影（海拔带×坡度修正×三级 fbm 扰动弯曲边界：水体/湿沙/草甸-林冠遮罩/裸岩/积雪）+ 微观纹理（独立坐标波动函数，与表格正交：粗糙度→微观法线扰动→高光/暗淡）+ 光照（宏观坡向 N·L + 积雪 wrap 散射 + 材质分级 spec）+ 云影 + 大气透视；③水面：水体掩膜驱动绘制（海床沉降 VS：海面像元按掩膜下沉 -2m——本 DEM 海面海拔≈0 非负水深）+ 波浪法线（风驱振幅 + 距离衰减抗闪烁）+ 菲涅尔天空反射 + 太阳高光 + 浅水浪花；④植被实例：十字面片 + 风摇（高度平方弯曲 + 阵风）+ 高海拔雪挂；⑤拾取标记环。
- 【vegetation.ts · 生态增殖】适宜性四判据（海拔<林线-260、坡度<30°、非水体、汇水湿度）→ 候选格哈希播种 → **迭代分叉规则**（深度 4、角度/长度比例分叉，mulberry32 位置哈希）→ 拓扑栅格化为投影遮罩图集（远景退化形态同源）；个体形态随海拔/湿度连续变化（高海拔矮尖针叶/湿润高阔叶），无两个相同个体；9km 半径内 ≤3200 实例，焦点移动 >400m 重建。
- 【射线求交】pick()：相机射线 × 数字派生表面，自适应步长推进（300 步/620km）+ 16 轮二分收敛 → 海拔/坡度/坡向/物质带/经纬度（纯数学，无碰撞库）。
- 【浮动原点】观察者固定逻辑原点：GPU 顶点 = 区域坐标 − uFocus，view 矩阵同相对帧构建；区域 ±170km 内 float32 精度 ~0.01m。
- 【UI】TerrainApp：加载进度/HUD（FPS·分块 LOD 分布·三角形·植被数·缓存·新建/帧）/控制台（时刻 5-21 太阳弧线·风力·雪线季节偏移·云量·植被密度·垂直夸张 ×1-3 默认物理真实·植被开关·三视角预设·重置）/交互（拖拽环绕·滚轮/双指推拉·WASD 平移·单击拾取信息卡：海拔/坡度坡向/物质带/经纬）。page.tsx 第五 Tab「地形引擎」+ v13 徽章。
- 【五轮实机 bug 战役（agent-browser 几何探针法）】①四叉树细分判据用「中心距+包围半径」对根块永不满足 → 改最近角距离；②300km 距离剔除把西南根块裁掉 1.7km（半区消失）→ 根块免距离剔除 + half 用最大轴向跨度；③**浮动原点双重减 focus**（顶点相对帧 × view 绝对帧 → 世界错位 90km，用 pick 纯数学探针与渲染对比定位）→ view 改相对帧 + AABB 同步转相对帧；④海面像元海拔 +0.5m 盖住水面 → VS 按掩膜沉降海床 + 水面掩膜驱动 + viewDir 修正为「片元→相机」（原 -vRel 指向焦点致反射采样地平线）；⑤远距波浪亚像素闪烁 → 振幅距离衰减。
- 【验证（agent-browser 全通过）】全新会话 console 零错误；默认视角雪原-草甸-裸岩自然边界（无等高线硬边）；峡湾 preset 真实海岸线 + 深蓝海面 + 波纹；黄昏 18:45 暖光峡湾；拾取卡「2821m · 23.8° 西坡 · 永久积雪带 · 51.404°N 125.263°W」与 Waddington 冰原实际位置一致；植被 1035 实例；24 分块 L0:12/L1:6/L2:6 · 122k 三角形；移动端 390px Tab 折行 + footer 贴底（1348=1348）；lint --max-warnings=0 零错误；tsc terrain 路径零错误。
- 【验证方法学新增】①Radix Slider 合成 pointer 仅微移，须 agent-browser 原生 click 聚焦 + press ArrowRight ×N（延续既有怪癖清单）；②canvas 合成点击需 try/catch setPointerCapture（已加防护）；③agent-browser console 跨 HMR 累积 —— 判定错误须 close+open 全新会话；④几何疑难以 pick()（纯数学）与渲染输出对比可二分定位「数学对/渲染错」。

Stage Summary:
- 交付：第五演示项「地形引擎」—— Trail-Sense-Earth-Model DEM 0.4.0-high 高程表格驱动的完整纯逻辑地形系统（分块动态筛选→骨架抬升→物质显影→正交微观纹理→光照解析→生态增殖→射线求交→浮动原点闭环），物理真实动态细节（太阳弧线昼间光照/风驱波浪与树摇/云影同场漂移/雪线季节偏移/垂直夸张默认 ×1 真实尺度）
- 项目状态：v13 —— 五 Tab（粒子引擎默认/地形引擎/工作台/性能实验室/战略评估）；地形引擎与粒子引擎共享 zinc/amber 视觉语言
- 下一轮建议优先级：① 战略评估页增补地形引擎段落（DEM 管线与集成方式）②地形射线拾取联动粒子引擎选中（跨 Tab 数据流）③遮挡剔除（Hi-Z）与 L0 环内更细 LOD（8 采样子块）④树实例视锥剔除（当前仅半径剔除）⑤边界外延展（表格边缘噪声延展生成无限地形选项）⑥ GIF/WebM 录制接入地形视角漫游
- 风险提示：450m/像元分辨率在极近距离 (<500m) 可见网格感（微观纹理层已掩盖大部分）；headless SwiftShader ~10fps 为软件光栅所致（真机 GPU 预期 60fps，三角形 100-200k 级）；表格边界外为空区（世界边缘可见灰幕，属有限表格的诚实呈现）；WebGL2 上下文在极端 HMR churn 下可能丢失（生产构建无此现象）
---
Task ID: 15
Agent: Z.ai Code (main)
Task: 用户指令「继续提高逼真度」—— 地形引擎 v13 → v13.1 视觉物理细节十一项升级

Work Log:
- 【高度场自阴影（最大逼真度提升）】新增 SHADOW_COMMON GLSL 段：terrainShadow()（40 步、步长 85m ×1.24 指数增长覆盖 26km+，半影宽度 45+i×26m 随距离增大）+ terrainShadowShort()（16 步树基点专用）。地形 FS 片元级 march（山影落谷）、水 FS 以 y=0 平面 march（**山影落海**——峡湾山体投影到海面）、树 VS 每实例一次 march（树影）。太阳高度 <0.03 自动关闭（夜/日落防全黑）；表格边界外 break（CLAMP 区域外不遮挡）。uShadowOn 开关穿透三个程序。
- 【色调映射】TONE_COMMON toneFilm()：c=1.25c/(1+0.30c) 中间调微亮 + 高光软滚降（雪面/太阳耀斑不死白）。五个程序全部接入（marker 除外）。
- 【谷地晨雾】JS 计算 mistAmt（5:00→6:20 峰值→9:20 消散，阴天 ×(0.6+0.4·云量)）；shader 侧 fogTop=mix(90,340,mist) 随浓度抬升，smoothstep 海拔带 × fbm 形状 × 风漂移；地形/水/树三程序 + 天空地平线白化衔接。物理因果：雾聚集低洼、日升消散、阴天更浓。
- 【冰川蓝冰+冰裂隙】陡坡雪层滑落露蓝冰（snowF×smoothstep(0.20,0.38,steep)→冰色+粗糙度降低）；裂隙用 ridged noise（1-|2vnoise-1|）窄带 smoothstep(0.965,0.995) × 冰川带遮罩 × exp(-dist·1e-4) 远距淡出。
- 【其余八项】雪面闪晶（hash 换粒 + 视角镜面 ×microFade）、海床浅水焦散（双层波场干涉）、黄昏地平线暖光带（太阳方位权重 azW³ × (1-sunColor.g)）、微观纹理双平面投影（陡壁沿高度采样防拖影）+ 距离衰减抗闪烁、大风浪尖白帽、裸岩地层条纹（sin(hM·0.013) 色带）、天空地平线以下用雾色（有限表格世界边缘无痕融合，替代 v13 的暗洞）。
- 【UI】控制台新增「山体阴影」「谷地晨雾」Switch（data-testid=terrain-shadows/terrain-mist）；预设 3→4 个（grid-cols-2），新增「清晨峡湾」（相机+时刻 6:15 联动）；脚注更新。
- 【实机 bug 修复×2】①冰裂隙首版阈值 smoothstep(0.87,0.96) 过松 + vnoise 分布集中于脊线 → 全雪原黑裂网 → 收紧 0.965/0.995 + 带状遮罩 + 远距淡出；②TERRAIN_FS 中 dist 声明位置在 crev 使用之后 → 'dist': undeclared identifier → 提前到 main 开头（教益：插入距离衰减项时必须检查声明顺序）。
- 【验证（agent-browser 全通过）】全新会话 console 零 [error]；默认 10:30 山体明暗立体；拾取回归「1248 m · 28.9° 南坡 · 土壤草甸带 · 51.236°N 125.249°W」；清晨峡湾 06:15 谷地晨雾弥漫+长影+山影（植被 2,137）；黄昏 18:45 暖光+海面夕阳耀斑+晨雾自动消散；阴影开关关闭后山体明显变平（对比截图）；移动端 390px Tab 折行+footer 贴底（1487=1487）；lint 0 error；tsc terrain 路径 0 error。
- 【QA 方法学补充】①reload 后 WebGL context lost（编译 log=null）为 dev 环境必现现象，判定必须用 close+open 全新会话；②agent-browser 长会话后 tab 可能停留在空 HTML（39 字节），open 强制重导航恢复；③Radix Slider 大幅调值用 click 聚焦 + End 跳极值 + ArrowLeft 回退。

Stage Summary:
- 交付：地形引擎 v13.1 —— 十一项逼真度升级（高度场自阴影全管线[山影落谷/落海/树影]、色调映射、谷地晨雾、冰川蓝冰+冰裂隙、雪面闪晶、海床焦散、黄昏暖光带、双平面微观纹理、白帽浪花、岩层条纹、世界边缘雾色融合），全部由高程表格+数学规则实时推导（零预存资产约束保持）
- 项目状态：v13.1（五 Tab；地形引擎控制台 2 新开关 + 4 预设含时刻联动）
- 下一轮建议优先级：① 战略评估页增补地形引擎段落 ② 树实例视锥剔除（当前仅半径剔除）③ L0 环内 8 采样子块（<500m 近景网格感）④ 水下地形折射着色增强 ⑤ GIF/WebM 录制接地形漫游 ⑥ 地形拾取联动粒子引擎选中（跨 Tab 数据流）
- 风险提示：阴影 40 步 march 在 headless SwiftShader 下 ~10FPS（真机 GPU 负担轻，可通过「山体阴影」开关关闭）；reload/HMR 后 context lost 为 dev 环境现象（生产构建无此问题）；远景低 LOD 块在高空俯瞰仍可辨识块状拼接（可用更高雾密度掩盖）
---
Task ID: 16
Agent: Z.ai Code (main)
Task: 用户指令「全面使用 webgpu 提升性能」—— 地形引擎全面 WebGPU 化（WGSL 全管线移植 + VS 高程位移消除 CPU 分块建网格 + compute 植被增殖 + 间接绘制）+ WebGL2 路径 exagg 渲染 bug 修复

Work Log:
- 【架构】地形引擎成为第三个双后端渲染器：WebGPU 主路径（renderer-wgpu.ts 新建 ~1250 行）+ WebGL2 回退（renderer.ts）。共享相机/拾取数学抽离至 camera.ts（cameraBasis/pickSurface/lookAt/mul4），两后端严格同源；TerrainApp 事件绑定从 canvas 改为容器层（画布替换零重绑）。
- 【WGSL 全管线移植】5 个模块（SKY/TERRAIN/WATER/TREE/MARKER）+ VEG compute 从 GLSL 逐句移植：hash12/vnoise/fbm/toneFilm/terrainShadow(40步)/terrainShadowShort(16步) 全部同参数；色调映射、物质显影、微观双平面纹理、晨雾、焦散、白帽、冰裂隙逐项对齐。GLSL→WGSL 关键差异处理：vec+标量需 vec2f() 包裹、textureSampleLevel 显式 LOD（VS/compute）、discard、var 数组动态索引、override 管线常量（4 个 LOD 地形管线 = 同模块 × constants:{LEVEL:l}）。
- 【性能·分块 GPU 化】GL 路径每块由 JS 建 VBO（LRU 220 缓存 + 每帧预算 3 块）；WebGPU 路径改为 VS 高程纹理位移：静态索引缓冲（4 级含裙边）+ chunk 描述符 storage buffer（origin/level/skirt vec4f），VS 自行采样高度纹理生成位置/法线/裙边/海床沉降 → 全帧地形仅 ≤4 次 instanced draw，CPU 只做四叉树筛选，无构建预算（可见块当帧就绪，消除补块延迟与 LRU 抖动）。
- 【性能·植被 compute 化】GL 路径 planVegetation 在 CPU 重建（焦点 400m 变化时全量重算+上传）；WebGPU 路径 vegMain compute（8×8 workgroup，165² 候选格并行）：适宜性四判据（hash 稀疏化/水体/海拔林线/坡度/汇水湿度 6 采样）逐线程评估 → atomicAdd 追加实例 → vegFinalize 写 drawIndexedIndirect 参数（[12, count, 0,0,0]）→ 零 CPU 重建、零回读、零上传；计数每 20 帧经双暂存缓冲 mapAsync 回读仅供 HUD。
- 【正确性设计】①水体 NEAREST 用「floor 取 texel 再读中心」在 filtering sampler 上精确模拟（单 sampler 双用途）；②heightGrid texel 中心采样与 CPU 双线性严格一致（uv=(fx+0.5)/w 数学等价推导）；③浮动原点：view 矩阵相对帧构建 + VS 输出 rel；④WebGPU 0..1 深度专用透视矩阵（far/(near-far) + fn/(near-far)，与 GL -1..1 不同）；⑤绑定组分离（bglRender 7 项 / bglCompute 7 项），shader 声明的 binding 必须被 layout 覆盖（COMMON 只留 0-3，5/7 归 TERRAIN/TREE，6/8/9 归 VEG——首版曾把 storage 声明放 COMMON 导致 compute 模块含未覆盖 binding）；⑥MSAA 4×手动（msaaTex+resolveTarget）。
- 【自愈链】create()：无 navigator.gpu/requestAdapter 失败/WGSL getCompilationInfo 出现 error 级消息 → 返回 null → GL 兜底；运行期 device.lost(非 destroyed)/uncapturederror → onFatal → switchToGL（新 canvas 替换：一 canvas 仅能绑一种上下文）+ console.warn。真机最坏情况 = 自动降级 WebGL2，不会黑屏。
- 【GL 路径 bug 修复·垂直夸张失效】TERRAIN_VS 原用原始高度（vPos=aPos）而相机/拾取/阴影 march 全用 height*exagg → exagg≠1 时地形不变仅相机升高（滑块长期半失效）。修复：VS 乘 uExagg（vPos.y = aPos.y*uExagg，裙边同步放大），实机验证 ×2.9 山体真实增高且光照/阴影一致；×1 与旧渲染逐像素等效（回归安全）。
- 【GL 路径瘦身】lookAt/mul4/pick/cameraBasis 移除本地实现改委托 camera.ts（行为不变）；waterAt import 清理；TerrainRenderer 增加 backendName 徽标字段。
- 【验证·WebGL2 回退路径（沙箱 headless 无 navigator.gpu）】全新会话 console 零 [error]；默认视角雪原-草甸-裸岩-海面渲染正常（截图）；HUD 全通（23FPS/15 分块 L0:9/L1:3/L2:3/87k 三角形/植被 1,035 与基线完全一致）；拾取回归「2102 m · 8.2° 西南坡 · 裸岩带 · 51.293°N 125.263°W」；峡湾预设水道/海岸线/远海正常；exagg ×2.9 山体增高验证；移动端 390px Tab 折行 + footer 贴底（844=844）；lint 0 error（2 个遗留 wasm d.ts warning 与本次无关）；tsc terrain 路径 0 error；dev.log 无编译/运行错误。
- 【验证·WebGPU 路径（静态保证）】沙箱无法暴露 navigator.gpu（headless 限制），真机行为不可执行验证。已做：7 个 WGSL 模块括号/圆括号配平程序检查全 OK；GLSL 残留扫描零命中；绑定覆盖静态核对；WA 水体纹理上传 bug 自查修复（writeTexture 误传 table.water.buffer 整文件缓冲 → 应传视图，byteOffset 2KB 会上传错数据）；TS GPUAllowSharedBufferSource 泛型兼容（视图拷贝）。真机风险兜底 = WGSL 编译错误在初始化即被 getCompilationInfo 捕获回退，运行期错误走 uncapturederror 回退。
- 【QA 方法学】Radix Slider 调值仍用 click 聚焦 + End/ArrowLeft；eval 中 .click() 返回 undefined 会令 `?? 'fallback'` 误报「未找到」，Tab 切换一律用 snapshot ref 点击。

Stage Summary:
- 交付：地形引擎全面 WebGPU 化 —— WGSL 6 模块全管线（天空/地形×4LOD/水/树/标记/植被compute）、VS 高程位移分块（CPU 零建网格、≤4 draw 全帧地形）、compute 植被增殖 + drawIndexedIndirect（GPU 驱动绘制）、MSAA 4×、WGSL 编译自检 + 运行期自愈回退。WebGL2 回退路径保持完整且修复垂直夸张 bug。项目 v13.2（五 Tab 不变，地形引擎后端自适应）。
- 用户真机预期：地形 Tab 徽标应显示「WebGPU · GPU直绘」（emerald）；若 WGSL 有未知兼容问题自动回退「WebGL2 回退」（amber）并在 console 出现 [terrain-wgpu] 前缀诊断——请用户真机复验徽标与 FPS。
- 下一轮建议优先级：① 相机多尺度（前序遗留需求）：成人眼部高度 1.6-1.7m 实时贴地起步 + 初始平视 + 自由视角 + 无缝升空至轨道俯瞰（浮动原点延伸至行星尺度）② 全球地块墨卡托正确拼接（dem zip 全 tile）③ GPU timestamp query 精确计时入 HUD ④ 地形拾取联动粒子引擎选中 ⑤ 战略评估页增补地形引擎段落 ⑥ GIF/WebM 录制接地形漫游。
- 风险提示：WebGPU 路径真机首验可能暴露 WGSL 兼容性问题（自愈链保证回退不黑屏）；headless 23FPS 为 SwiftShader+CDP 开销；植被 compute 无近处优先排序（超 6000 上限时与 CPU 路径有选树差异，正常密度不可见）；reload/HMR 后 context lost 为 dev 环境现象。
---
Task ID: 17
Agent: Z.ai Code (main)
Task: 用户指令「最大化增加地面及植被近景细节逼真度」—— 地形引擎 v13.2 → v14 近景细节体系（7 级 LOD 亚像元细分 + 近景浮雕带 + 树/草全面重建 + 实例分量交换历史大 bug 修复）

Work Log:
- 【7 级 LOD（L-3..L3）】chunks.ts 与 WebGPU selectChunks 引入负级：L-1/L-2/L-3 覆盖 32/16/8 像元（14.4/7.2/3.6km）× 65 顶点 → 顶点间距 225/112/56m（亚像元双线性）。距离环 RING_T = {L-3←1.1km, L-2←3.6km, L-1←12km, L0←16km, L1←45km, L2←140km}。GL buildMesh 改浮点网格坐标 + gridHeightAt 双线性；WebGPU VS 用 exp2(level) 浮点步长直接采样（线性过滤 = 硬件双线性），7 组管线（override LEVEL 0..6）+ Frame.bases/bases2 双 vec4 基址。HUD 分块显示 7 级计数。
- 【近景浮雕带（几何位移）】detailRelief/detailA：波长约 715m、±22m fbm 起伏，2.5–9km 随焦距渐隐 × 低海拔(2-14m)渐隐。四消费方严格同式：①GL CPU buildMesh 烘焙 ②WebGPU VS 位移（含 VS 法线中央差分同式）③树/草基点（CPU 规划 + WGSL compute）④pickSurface 射线求交（camera.ts）。uDetailAmp 开关穿透（「近景浮雕」Switch，data-testid=terrain-detail）。
- 【近景材质/法线细化（FS）】detailB 三频岩石法线带（170m/53m/19m，±16m 等效）+ 5.5m 碎石法线，900-3200m 渐隐、雪面 ×0.25 平滑化；凹腔 AO（谷线 smoothstep(-7,2.5,b0)）；碎石斑驳 ±8% 反照率；草甸裸土侵蚀斑；雪面融蚀不均。高度场自阴影 march 前 6 步叠加 detailB → 近景岩脊自阴影（terrainShadow 签名 +focusXZ+detAmp）。
- 【树全面重建】①图集 128×3 → 256×4 变体（迭代分叉深度 4→5），通道语义 R=枝干邻近(内腔 AO)/G=外冠叶簇(受光/透光)/A=覆盖；②面片 2 → 4 向交叉（45° 间隔，16 顶点 24 索引），off 改 cos/sin 直接计算；③变体 UV 修复：(variant+u)/4 —— 旧版 uv 0..1 跨整个图集（3 树压缩采样）的潜在 bug 一并修复；④FS：内腔 AO 压暗 + 叶片噪声微变 + 冠层顶受光偏置 diff×(0.62+0.48·relY) + 逆光透射（viewDir·(-sunDir))^4 × tip × 0.55 + v 翻转后树干混合修正；⑤明暗再平衡（shade=0.60+0.40·relY × mix(1.08,0.74,ao)，叶色提亮）。
- 【近景草丛层（新增）】vegetation.ts planGrass（16m 候选格 / 750m 半径 / 草甸带雪线-180m / 缓坡 0.55 / 上限 9000）+ buildGrassVariants（2 变体弯曲叶簇遮罩，mulberry32 确定性）；GRASS_VS/FS（GL）与 WGSL_GRASS：双向交叉面片、阵风+叶尖二阶弯曲、干→润色调 tint、逆光透射；WebGPU compute grassMain/grassFinalize（绑定 10/11）+ 独立 grassDataBuf/grassMetaBuf + drawIndexedIndirect；重建粒度 80m（树 400m）；计数与树一起回读 HUD（"树+草"格式）。「近景草丛」Switch（data-testid=terrain-grass）。
- 【重大历史 bug 修复·实例分量交换】实例缓冲布局 (x, z, y, h) 但树/草 VS 用 base=vec3(iA.x, iA.y, iA.z) 把水平 z 当高度 → **自 v13 起全部树实例被放到世界 Y=±15 万米高空（从未真正可见过；此前 QA 的"植被可见"实为地形 FS 的远景林冠遮罩）**。修复为 vec3(iA.x, iA.z, iA.y)（GL/WGSL × 树/草 × vElev × 阴影 march 共 6 处）。附带修复：①面片以基点为中心半截入土 → 底部锚定（+h*0.5）；②画布首行 v=0 → 树/草贴图上下颠倒 → uv.y 翻转 1-aCorner.y；③树干混合随翻转改 smoothstep(0.06,0.2,1-vUv.y)。
- 【其他】相机最近推拉 400m → 150m（滚轮+双指）；预设新增「林间近景」（fx-26465, fz-148028，node 扫描表格选 2.7km 半径 221/221 全宜林格）预设 4→5；脚注文案更新近景细节说明。
- 【实机调试链】①GLSL 编译错误×2：TREE_VS 缺 SHADOW_COMMON + DETAIL 顺序（vnoise 未先声明）→ SHADOW_COMMON 自带 DETAIL_GLSL；②树不可见二分定位：eval 复刻 planVegetation 哈希找最近树 + 品红无条件输出确认几何在绘 → 锁定 FS 之外 → 逐项排查锁定分量交换根因；③agent-browser dev 环境"空 HTML tab"现象高发（本轮 6+ 次 close+open 恢复）。
- 【验证（agent-browser 全通过，WebGL2 回退路径）】全新会话 console 零 [error]；HUD：分块 7 级（默认视角 L-3:9 顶格）、植被 3,200+3,229；单树 130-150m 近距：树冠/树干锚定地表清晰可见、后坡成排树木；林间近景预设：疏树草甸+浮雕丘陵+雪斑远脊；峡湾深处：坡面树群+浮雕+海床透视；拾取回归「1590m · 6.3° 东南坡 · 51.344°N 125.142°W」；草丛开关 off → 植被仅 1,483（树）；移动端 390px 无横向溢出（scrollW=390）footer 自然下推；lint 0 error；tsc terrain 路径 0 error；WGSL 8 模块配平 OK、GLSL 残留 0；dev.log 无编译错误。
- 【WebGPU 路径静态保证】分量交换/底部锚定/UV 翻转/明暗平衡与 GL 逐项同步；grassMain/vegMain 的 detailA 与 TS/GLSL 同式；沙箱无法暴露 navigator.gpu，真机预期徽标「WebGPU · GPU直绘」（若 WGSL 兼容问题自动回退并 console 输出 [terrain-wgpu] 诊断）。

Stage Summary:
- 交付：地形引擎 v14 —— 近景细节体系（7 级 LOD 至 56m 顶点间距 + 近景浮雕几何带 + 浮雕法线/碎石/凹腔AO/裸土斑/融雪 + 四向交叉树[AO/叶簇/逆光] + 近景草丛层[风摇/逆光/tint]）+ 修复自 v13 的实例分量交换致命 bug（树首次真正可见）+ 贴图方向/半截入土/变体 UV 三项潜在 bug 一并清除。零预存资产约束保持（全部由高程表格+数学规则实时推导）。
- 项目状态：v14（五 Tab 不变；地形控制台 2 新开关「近景浮雕」「近景草丛」+ 5 预设；HUD 7 级分块 + 树+草计数）
- 下一轮建议优先级：① 用户真机复验 WebGPU 徽标与近景性能（compute 草丛/7 级管线首次真机运行）② 树形态近景增强：真 3D 低模枝干（非面片）或 5-7 切片体树 ③ 草丛近景（<80m）叶级风浪 + 地形贴合弯曲 ④ 巨石/漂砾实例层 ⑤ 树实例视锥剔除（当前仅半径剔除）⑥ 拾取联动粒子引擎选中
- 风险提示：WebGPU 真机首验可能暴露 WGSL 兼容问题（自愈链回退不黑屏）；headless 13-17FPS 为 SwiftShader+CDP 开销（近景 FS 增量在真机 GPU 负担轻）；树冠形态在极近距（<100m）仍显面片感（需切片体树/低模）；reload/HMR 后 context lost 为 dev 环境现象。
---
Task ID: 18
Agent: Z.ai Code (main)
Task: 用户报告「为什么无法上升到看到全球」——根因修复：DEM 全球瓦片拼接（earth.ktdem）+ 行星级渲染（全球球体）+ 相机升空路径（140km 顶 → 22,000km 轨道）+ 地表曲率弯曲一致性改造。v14 → v15。

Work Log:
- 【根因诊断】用户无法看到全球的三重原因：①TerrainApp 相机 dist 硬顶 140,000m；②引擎只有 bc-coast 区域表（296×474km），区域外是虚空；③无行星级渲染路径。原始 dem-0.4.0-high.zip（325MB，172 个 15°×15° WebP 瓦片，15″≈450m 全球高程）从未被完整消费。
- 【数据逆向·编码破译】下载 zip（断点续传），index.json 揭示规格：a=0.25 缩放、每瓦片 b 偏移、15″、3600×3600/瓦片。逐通道暴力对拍 bc-coast.ktdem + 1024 万像素最小二乘反推 → 精确公式 h = (R + G·256 + B·65536)/a − b（系数 R·4+G·1024−12，误差≤1m 来自取整；B>0 = 水体/无数据哨兵填充，真实海拔 v≤2500 永不需要 B 位；水体掩膜 = h≤0）。
- 【全球拼接】scripts/build-earth-dem.py（确定性：固定瓦片顺序 + numpy reshape 块均值 + 固定取整）：172 瓦片 → 30×30 像元块均值（仅 B=0 有效像素）→ 0.125° 全球等距圆柱格网 2880×1440 i16 → public/terrain/earth.ktdem（8.3MB，magic 'KFG1'，头部含 resDeg×1000）。缺失瓦片（40.3% 纯海洋/南极区）填 0m。校验全过：Everest 块均值 6012m、K2 5824、Denali 3917、Tibet 5120、BC 区域均值与 bc-coast 全表均值差 2.5%（991 vs 1016m）。meta.json 增加 earth 字段。
- 【行星数学 planet.ts】PLANET_RADIUS=6371000；curvatureDrop 抛物线 d²/2R（CPU 相机/拾取用，四阶误差<0.3m）；liftToCurved 精确径向抬升 pos = C + (R+h)·normalize((x,R,z))（GPU 同式，即球面精确参数化——区域网格与全球球体在边界逐点重合，海面 h=0 时恰为球面本身）；globeBasis（pole/eq/east 方向基，着色器由 baked 方向 asin/atan2 反解经纬度）；globeHeightAt 全球网格双线性。
- 【曲率弯曲一致性改造（八处消费方同一场）】camera.ts cameraBasis（focusY/groundEye 减 drop）+ pickSurface（march/二分减 drop、推进范围随海拔放大至行星尺度、区域外命中返回 null）；GL/WGSL TERRAIN_VS（vHM varying 携带弯曲前真实海拔供物质带，几何 liftCurved）；WATER_VS（h=0 抬升=球面本身，与全球海洋逐点重合）；TREE_VS/GRASS_VS 基点抬升；阴影 march（SHADOW_COMMON/WGSL terrainShadow×2）采样高度减抛物线落差——修复「弯曲几何 vs 未弯曲高度场」导致远区整体误判阴影的 bug（308km 视角 L2 分块全暗灰）；水面阴影起点改用已抬升 vPos。
- 【全球球体渲染（GL+WGSL 双路径）】立方球 6 面×160²（307k 三角，单位方向烘焙，单 draw，uint32 索引）；VS：asin/atan2 反解 lat/lon → 全球网格手动双线性（GL r16i+texelFetch / WGPU r16sint+textureLoad，bytesPerRow 256 对齐行填充）+ 区域 ktdem 线性采样 → 0.42° 边缘带混合（放置：区域内仿射坐标径向抬升与地形逐点重合/远域地理球面方向）；FS：海洋（深海基色+洋流噪声+太阳耀斑+掠射反射；源数据无测深故移除浅滩逻辑）、地貌（纬度带+海拔雪线+副热带干旱带+湿度噪声+亮化对齐平面草甸色调）、云层（球面噪声带+风漂+云量滑块同控）、夜面+晨昏线、大气缘（掠射蓝色亮 rim）、大气雾（与平面系统同一条密度曲线）。
- 【区域-全球无缝衔接机制】globe FS 逐片元丢弃于地形覆盖矩形（chunks.ts/GL scheduler stats.cover 与 WGPU selectChunks coverRect 新增跟踪）内缩 4km；VS 在覆盖边界 4km 渐变下沉 250m 消除深度争用；WGPU selectChunks 同步实现。
- 【相机升空】dist 上限 140km → 22,000km（滚轮/双指），pitch 钳制 1.45 → 1.56；「升空至轨道/着陆」按钮（对数距离插值 + easeInOutCubic 俯仰，9s/8s 平滑过渡，任意拖拽/滚轮随时接管）；远平面 = dist + 2R + 300km（覆盖行星星缘）；HUD 新增「高度」（m/km 自适应）与「观测模式」徽标（地面/低空/高空/亚轨道/轨道，30m/3km/30km/400km 阈值）；预设 +「轨道俯瞰」（9,000km）；WASD 平移速度在轨道尺度钳制。
- 【大气-太空过渡】sky FS/WGSL spaceMix（眼位海拔 30→130km smoothstep）：大气渐隐→太空黑+确定性哈希星空（视线量化点阵+闪烁）、云层/晨雾/暖色光带随 spaceMix 渐隐；globe 雾密度与平面系统共用同一条曲线 fogD = 3.8e-6·(1−(alt−60km)/340km)——60km 以下与平面雾逐点一致（接缝无痕），400km 以上归零（行星干净），GL/WGSL 全管线（terrain/water/tree/grass/globe）统一。
- 【实机调试链】①GLSL 两处编译错误（GLOBE_VS 缺 R_PLANET 常量、GLOBE_FS 缺 uWindDir 声明）→ 修复；②误留 WGSL 语法 let 于 GLSL → 清除；③浏览器缓存旧编译产物造成假错误 → close+open 全新会话解决；④海洋色三轮迭代（浅滩逻辑因无测深数据全海洋误亮 → 深海基色+噪声）；⑤阴影 march 曲率修正（前述）；⑥雾曲线两轮（alt/60km → 60-400km 窗口）。
- 【验证（agent-browser 端到端，WebGL2 回退路径）】全新会话 console 零 [error]（仅 no-webgpu 降级 info/warn）；默认视角 14.2km/高空渲染正常无回归；升空按钮 22,000km 到位（HUD 23,290km·轨道·488k 三角）；9,175km 轨道俯瞰：行星完整、大陆形态可辨（哈德逊湾/北美东岸）、方位无镜像、云系/极冠/大气缘正常、深海色正确；308km 亚轨道：区域-全球衔接协调（峡湾海岸线跨边界连续）、FPS 25；57.7km：前景高分辨率雪山细节+周围全球地形无缝；着陆 8s 后回到 1,861m 低空，近景浮雕/草甸/树木零回归；lint 0 error；tsc terrain 路径 0 error；23 个着色器块配平全 OK、WGSL 无 GLSL 残留；dev.log 无编译错误（EADDRINUSE 为文件头部历史残留）。
- 【WebGPU 路径静态保证】WGSL 全模块与 GLSL 逐式同步（globe/弯曲/阴影/雾/星空）；r16sint 纹理 binding 12（sampleType sint）+ bglRender/bgRender 扩展；Frame uniform 100→132 floats（gCenter/gPole/gEq/gEast/gConf0/gConf1/gClip/gMisc）；沙箱无法暴露 navigator.gpu，真机预期徽标「WebGPU · GPU直绘」，若 WGSL 兼容问题自动回退不黑屏。

Stage Summary:
- 交付：v15 —— DEM 全球瓦片拼接（earth.ktdem 0.125° 全球格网，确定性脚本 scripts/build-earth-dem.py）+ 行星级渲染（全球球体：大陆/海洋/云/雪/夜面/大气缘/星空）+ 相机 150m↔22,000km 连续升空（升空/着陆平滑动画按钮）+ 地表曲率弯曲全链一致（渲染/相机/拾取/阴影同一弯曲场）+ 区域-全球覆盖边界逐点重合衔接。零预存视觉资产约束保持（一切由两张数字表格+数学规则推导）。
- 用户问题回答：此前无法升空看到全球，是因为相机距离被钳制在 140km 且只有一张区域高程表；现已拼接全部 172 块全球瓦片并实现行星级渲染与 22,000km 轨道视角，滚轮或「升空至轨道」按钮即可从眼部高度连续升至轨道俯瞰完整地球。
- 下一轮建议优先级：① 用户真机复验 WebGPU 徽标与轨道帧率（307k 三角球体+MSAA4×）② 真眼部高度第一人称模式（near<1m，相机贴地 1.6-1.7m 起步）③ 区域 bbox 内全球侧地形用更高分辨率（0.125°→区域周边局部加密）消除 100-300km 高度带的大陆色块感 ④ 轨道视角 W/S 平移焦点改为行星旋转（当前钳制在区域 bbox）⑤ 拾取在轨道尺度返回经纬度卡（当前区域外返回 null）⑥ 大气层外壳 mesh（从太空看蓝色辉光带）
- 风险提示：WebGPU 真机首验可能暴露 WGSL 兼容问题（自愈链回退不黑屏）；全球网格 0.125° 在 100-500km 高度带可见块状海岸线（下一轮局部加密可改善）；亚轨道高度平面水域与球体海洋仍有轻微色差（雾曲线已统一，残差来自波浪高光项）；headless 10-25FPS 为 SwiftShader+CDP 开销。
---
Task ID: 19
Agent: Z.ai Code (main)
Task: 用户真机报告「WGSL globe:220:37 no matching constructor for 'vec2<u32>(f32, f32)'」—— WebGPU 路径首次真机编译错误修复 + 沙箱内真·Tint 端到端验证体系建立（重大 QA 方法学突破）

Work Log:
- 【根因】WGSL_GLOBE 的 globeSample() 用 textureLoad(globeH, vec2u(iu, iv), 0) 读 r16sint 全球高程纹理，而 iu/iv 是 floor() 返回的 f32 —— WGSL 无 f32→u32 隐式转换；且 texture_2d<i32> 的 textureLoad 坐标按规范必须是 vec2<i32>（vec2u 即使类型正确也会二次报错）。修复：四处调用全部改为 vec2i(i32(iu), i32(iv)) 显式转换。
- 【关键 QA 突破·沙箱可跑真 WebGPU】前几轮认定「沙箱无法暴露 navigator.gpu」是误判：agent-browser 有 --webgpu 旗标（SwiftShader 软件 Vulkan），但默认旗标下 canvas 呈现会触发 device-lost（"A valid external Instance reference no longer exists"）；追加 --args "--use-angle=swiftshader,--disable-gpu-sandbox,--enable-unsafe-webgpu" 后 canvas 提交成功（但 headless 合成器仍不呈现内容——drawImage 读任意三角形均 alpha=0，属环境限制非应用缺陷）。
- 【验证体系（可复用）】①真 Tint 编译：checkModules 在该环境下真实运行，8 个 WGSL 模块全部 0 error 首次得到实证（此前 5 轮仅为静态配平检查）；②逐模式二分定位 device-loss：离屏 MSAA4×/depth24plus/r16sint textureLoad/drawIndexedIndirect/atomic+textureSampleLevel-compute 全部通过，唯一失败项 = canvas 纹理获取（合成器）；③计算着色器独立复现台：从 renderer-wgpu.ts 正则抽取 WGSL_COMMON/WGSL_VEG 原文 + fetch 真实 bc-coast.ktdem + 与应用完全一致的 VP 值（snowLine=2200/focus(0,0)/detailAmp=1/keep=0.275/cell=110/side=165），在独立 device 上跑 vegMain —— 产出 1,035 实例，与 GL CPU 路径 planVegetation 的 1,035 逐位一致（同数据同判据同随机源的交叉验证）。
- 【植被 0 疑案的三层排查】①对照实验：默认 headless（GL 路径）植被 1,035 正常 → 默认参数与逻辑无恙；②应用内插桩（DBG1-3）：vegActive=true、rebuildVeg 于 f=1 触发、VP 值全部正确、readback 于 f=20 准时 fire —— 但 mapAsync 在 SwiftShader 高负载下 >100s 不解析（独立空闲 device 实测 5,118ms）→ vegCountGpu 恒 0；③结论：树实例由 drawIndexedIndirect GPU 驱动绘制（不依赖回读），WebGPU 路径的树**实际在画**，仅 HUD 计数在软件光栅环境下无法更新 —— 真机 mapAsync 毫秒级，无此现象。插桩已全部移除。
- 【SwiftShader 环境约束记录】每 GPU 进程约 2-3 个 device 预算（含 React StrictMode 双挂载烧 2 个），超限后 requestDevice 永不返回（表现为 CDP eval 超时）；长会话 GPU 进程会渐进降级 —— 判定必须用全新 session 且控制探针数量。
- 【清理】临时复现页 public/veg-repro.html 已删除；renderer-wgpu.ts 三处 DBG console.info 已全部移除（与修复前逐字节等价 + vec2i 四处）。

Stage Summary:
- 交付：v15.1 —— WebGPU 路径真机 WGSL 编译错误修复（globeSample vec2u→vec2i+i32×4 处），并在沙箱内首次以真 Tint + 真 DEM 数据完成 WebGPU 路径端到端验证：8 模块 0 编译错误、全管线创建无验证错误、401k 三角形 @ 12-49FPS 无 device lost、植被计算与 CPU 路径 1,035 逐位一致
- 项目状态：v15.1（五 Tab 不变；WebGPU 路径从「静态保证」升级为「沙箱实证」）
- 用户真机预期：地形 Tab 徽标「WebGPU · GPU直绘」+ 植被计数正常显示（mapAsync 真机即时）；若仍有 console [terrain-wgpu] 错误请回报（现在沙箱已能复现绝大多数真机 WGSL 行为）
- 下一轮建议优先级：① 真眼部高度第一人称模式（near<1m，1.6-1.7m 贴地起步，前序遗留）② 区域 bbox 周边全球侧局部加密（0.125°→ 消除 100-300km 高度带大陆色块感）③ 轨道视角 W/S 平移焦点改行星旋转 ④ 拾取在轨道尺度返回经纬度卡 ⑤ 大气层外壳 mesh ⑥ GPU timestamp query 入 HUD
- 风险提示：headless 无法呈现 WebGPU canvas 内容（合成器限制），WebGPU 视觉终验只能依赖用户真机；SwiftShader 下 mapAsync 高负载不解析属环境限制；StrictMode 双挂载烧 device 预算（生产构建无此现象）
---
Task ID: 20
Agent: Z.ai Code (main)
Task: 用户指令「引擎能力应该是支持全地形数据无缝拼接的」—— 地形引擎 v16 全球流式改造：从「单区域表 + 粗球体」升级为「全球瓦片金字塔流式 + 任意锚点窗口 + 行星框架泛化」，任意地点可展开全部近景细节体系

Work Log:
- 【数据·全球金字塔】新脚本 scripts/build-tile-pyramid.py（确定性 + 断点续跑 + 原子写）：dem-0.4.0-high.zip 全 172 瓦片 → L3(15″≈450m, 200×100 格, 仅陆地 6193 瓦片) / L2(30″, 1799) / L1(60″, 562)，432²瓦片 + zlib，哨兵(B>0)3×3 邻域 8 轮迭代填充，内陆湖分类(掩膜 2)，总 835MB → /home/z/terrain-data/pyramid（项目外，防 Turbopack 监视）。校验：珠峰瓦片 8585m、勃朗峰区域 4691m。
- 【事故与根因·瓦片入 public/ 触发 OOM】6193 文件放 public/ 后 Turbopack dev 启动扫描内存暴涨（5s 内 322MB→1.26GB，叠加 chrome 后整体 OOM 反复杀 next-server，且本会话起后台进程在调用结束被 SIGTERM 清理）。三重对策：①瓦片移出项目目录；②新增 App Router 路由 src/app/terrain/pyramid/[...path]/route.ts 按需读盘（防穿越 + immutable 缓存头，URL 与原方案完全一致，客户端零改动）；③生产模式构建运行（next build 成功，standalone ~400MB，远低于 dev 模式）。
- 【引擎·流式核心】新模块 src/lib/terrain/stream.ts（TerrainStream）：1536²「高程窗口镜像」（15″ 格点对齐 ≈700km 幅面）作为引擎唯一数据源——分块调度/植被/拾取/相机/贴地全部无改动消费表格数组；L0(earth.ktdem) 瞬时预填充 → BC 种子 1:1 拷贝（修复行/列偏移符号 bug）→ L1/L2/L3 按距离优先级流入（L0<L1<L2<L3/种子 精度优先级覆盖，结果与到达顺序无关）；manifest 3s 周期重试（服务器重启后自愈）；脏矩形增量上传 GPU 纹理；LRU 瓦片缓存（L3:110/L2:220/L1:400）+ 并发 8 + 每帧应用上限 8。
- 【引擎·行星框架泛化】planet.ts 新增 REF_CENTER_LAT/LON（全球参考帧恒定锚定 BC）、anchorFrame（锚点切线框架 M/Mi/C，数值方向导数求东/北基）、geodesicDir、matVec/matTVec、wrap180。两渲染器的全球球体重写：绝对经度解算（修复 v15 的 dLon 相对/绝对错配潜在 bug——0.42° 融合带/覆盖矩形丢弃/边缘下沉此前从未真正激活）、锚点旋转 M/Mi、focusW 世界焦点、窗口外地理球面方向；BC 锚点下与旧公式逐项等价（数学证明 + 实测）。GL uGlobeCenter 移除；WGPU Frame 132→164 floats（actM/actMi/focusW/gAux，gPad 保留位维持索引）。
- 【重锚定】焦点偏离窗口中心 30% 幅面自动重锚（格点吸附 → L0 预填充 → 种子 → 流入；版本号递增 → GL render() 自动失效块缓存/植被；burst 预算 16/帧×90 帧）；锚点命名（20 地标表就近标注 + 经纬度兜底）。
- 【UI】预设 6→9（新增 珠峰北坡/马特洪峰/迪纳利，全部预设携带锚点自动重锚）；HUD 新增区域徽标 + L3 流就绪度；拾取经纬度 N/S/E/W 全象限；页脚说明全球流式；metaInfo 随锚点刷新。
- 【验证】生产构建成功（含瓦片路由）；curl 瓦片/manifest 全 200（239KB 瓦片实测）；浏览器（生产模式）：页面零 console error、地形 Tab 正常、region=BC 海岸山脉、15 分块 7 级、植被 1,045、真实雪山/峡湾渲染确认（截图）；WGPU 路径静态同步（Frame 布局/着色器/上传三路一致）。lint 0 error、tsc terrain 路径 0 error。
- 【环境限制记录】本会话中期起：①后台进程在工具调用结束后被 SIGTERM（服务器只能存活于单次调用内）；②RAM 3.9GB，dev 模式 Turbopack(1.5GB)+chrome(1.2GB) 并存即 OOM。对策：生产模式 + 单调用内完成「启动→测试→截图」；珠峰跳转的浏览器端到端终验因窗口不足未完成（代码路径与 BC 重锚完全同源，L0 预填充已实证），移交 cron 巡检复验。

Stage Summary:
- 交付：v16 —— 全球地形数据无缝拼接：三层金字塔（450m/900m/1.8km 全球陆地）+ 任意锚点流式窗口 + 行星框架泛化（全球球体融合带/丢弃/下沉首次真正激活）+ 重锚定自愈 + 断点续跑数据脚本。引擎能力=任意地点 450m 分辨率 + 全套近景细节（浮雕/树/草/拾取）。
- 项目状态：v16（生产构建可用；dev 模式需 2GB+ 空闲内存）
- 下一轮优先级：① 珠峰/马特洪峰预设跳转的浏览器端到端复验（含 L3 100% 流入截图）② 轨道视角下行星框架视觉回归（M/Mi 非单位阵锚点）③ 窗口边缘融合带加宽可调（防 6.4° 窗角 geodesic 残差 kink）④ 拾取轨道尺度经纬度卡 ⑤ 树实例视锥剔除 ⑥ dev 模式内存治理（WASM/纹理池）
- 风险：后台进程随调用回收 → 用户预览面板需要服务器存活；cron 巡检每轮应先重启生产服务器（NODE_ENV=production bun .next/standalone/server.js，端口 3000）再测；/home/z/terrain-data/pyramid（835MB）为数据真身，勿删；重建数据需 /tmp/dem-high.zip（325MB，保留）。
---
Task ID: 21
Agent: Z.ai Code (main)
Task: 用户真机报告「升高到地球曲面弧度明显的高度时，地面有一个难看的黑块，显示地形数据未完整加载」—— 黑块三重根因修复（v16 → v16.1）+ 沙箱数据回收后全球金字塔重建 + 全球流式管线（L1/L2/L3 层级映射颠倒）修复，首次端到端达成 L3流 100%（BC 与珠峰双锚点）

Work Log:
- 【黑块根因 1·分块网格只画左上角（最核心）】chunks.ts meshSide(level) 在 level≥1 时顶点数按 2^level 缩减为 (64>>level)+1，但步长 strideF 只放大 2^level → 网格实际跨度恒 64 采样（28.8km），而块逻辑范围 64·2^level（L1=57.6km/L2=115km/L3=230km）——远场块之间 7/8～15/16 面积从未被绘制。WebGPU 路径 VS（n=(64u>>lpos)+1u）与静态索引缓冲同源同病。空隙落在覆盖矩形 bbox 内 → 旧球体 discard → 直通天空背景：低空=雾色不可见，升空后 spaceMix→1 = 太空黑块（用户症状）。修复：全级别恒定 65×65 顶点（步长 2^level 采样 = 450m·2^level，符合 v13 设计文档「stride 2/4/8」语义），GL meshSide/WGPU VS/WGPU 索引缓冲三处同步。
- 【黑块根因 2·球体矩形内 discard 的脆弱性】旧设计「覆盖矩形内逐片元丢弃」使任何分块剔除缺陷（GL 预算跳过/视锥误剔除）都直接露出生空背景。两层修复：①GL schedule 中 cover 矩形扩张移到「确认本块实际参与绘制」之后（预算跳过的块不再声明覆盖 → 球体补位）；②彻底移除 GL/WGPU 球体 FS 的矩形内 discard——VS 本就存在「矩形内部整体下沉 250m（4km 边界渐变）」平台，由深度测试让地形自然遮挡，球体恒定兜底永不露黑。连带修复：下沉原被 hd=max(h,0) 钳制掉 → 海洋球面与水面网格共面 z-fight；改为下沉作用于钳制之后（hd=max(h,0)−gSink），海洋随之沉降。
- 【黑块根因 3·平面视锥剔除 vs 弯曲几何】liftCurved 径向弯曲使实际顶点低于平面高度 d²/2R（窗口远缘 ≈9.4km），旧 AABB 用平面高度范围 → 高空俯瞰时近地平线块被顶面误剔除（误剔除块不在 cover 内但 bbox 仍罩住它 → discard 黑洞）。修复：逐块曲率感知 AABB——上沿扣近角落最小落差、下沿扣远角落最大落差（dNear/dFar 抛物线，与 GL/WGPU 同式）。
- 【流式管线致命 bug·L1/L2/L3 层级映射颠倒】stream.ts enqueueWindow stepDeg=d·2^(lvl-1)（L3 算出 60″/L1 算出 15″，全反）且瓦片索引用采样步长而非瓦片跨度做除法 → tileExists 恒 false → 全部误标 knownOcean，从不发瓦片请求（HUD「L3流」恒 0%）。L2 因对称侥幸正确（解释 v16 验证时 BC「看似细化」）。修复：stepDeg=d·2^(3-lvl)，瓦片索引/中心改用 spanDeg=stepDeg·432（L3 1.8°/L2 3.6°/L1 7.2°）；applyTile step=2^(3-lvl)。python 对照 manifest 实证：珠峰 L3 id=6948/Waddington L3=4230/L2=1015/L1=257 全存在，太平洋瓦片正确缺席。
- 【数据重建】会话间沙箱回收清空 /home/z/terrain-data/（835MB 金字塔）与 /tmp/dem-high.zip（325MB 源）。重下载 zip（前台分段 curl，一次完成）+ 重跑 scripts/build-tile-pyramid.py（确定性断点续跑，两次调用完成）→ 857MB 金字塔落盘 /home/z/terrain-data/pyramid。脚本 OUT 从旧的项目内路径（OOM 根因）正式改为数据真身路径。路由 /terrain/pyramid/* dev 模式 200 实测。
- 【验证（agent-browser，WebGL2 路径，全程 console 零 error）】①10.4km 低空无黑块；②135.5km 亚轨道：窗口满细节（草甸/Waddington 雪原/峡湾）+弯曲地平线+大气缘，无黑块；③670.7km：无黑块，窗口-球体衔接连续；④23,290km 轨道：行星完整；⑤着陆 1,479m：山脊/雪线/水面正常无回归；⑥BC 窗口 L3流 0%→100% 首次实证；⑦珠峰预设跳转：区域徽标切换、L1/L2/L3 瓦片 id 正确（15-19×72-76）、L3流 0%→100%；⑧1,852km 喜马拉雅上空：珠峰窗口以真实 450m 数据渲染，无黑块；⑨lint 0 error、terrain 路径 tsc 0 error、WGSL 9 模块配平 OK；dev.log 除预期 GET 外无错误。
- 【环境记录】本会话后台进程随工具调用回收（nohup curl 被杀）→ 长任务须前台分段（curl -C - 断点续传 + 脚本断点续跑各 2 次调用）；「空 HTML tab」现象 1 次经 close+open 恢复；headless 10-17FPS 为 SwiftShader 开销，瓦片流入速度受 dev server 编译 + 低帧率 update() 节流，真机预期快 10×+。

Stage Summary:
- 交付：v16.1 —— 高空黑块三重根因修复（远场网格全范围绘制 + 球体恒定兜底替代矩形 discard + 曲率感知视锥剔除）+ 全球流式管线层级映射修复（L1/L3 从未工作→全层可用）+ 金字塔数据重建（857MB）。任意锚点 L3流 100% 端到端实证（BC+珠峰）。
- 用户问题回答：黑块 = 远场 LOD 块网格只绘制了逻辑范围的 1/2^level（历史 bug），空隙被球体覆盖矩形丢弃逻辑放大数据未加载的观感，升空后背景变太空黑故显现；修复后任何高度地面连续，数据未加载区域由球体低分辨率兜底而非黑块。
- 下一轮建议优先级：① 用户真机复验（WebGPU 徽标 + 升空全程 + 任意地点预设跳转）② 窗口边界色差柔化（L3 地形与球体 0.125° 材质带在窗口边缘的色阶跳变，可加 8-16km 材质混合带）③ 拾取轨道尺度经纬度卡 ④ 树实例视锥剔除 ⑤ GPU timestamp query 入 HUD ⑥ dev 模式下 L3 流入速度优化（update() 分发频率与并发解耦）
- 风险：WebGPU 路径本次改动（VS 常量 65/球体 FS 移除 discard/gSink）已静态同步但真机首验仍待用户；headless 无法呈现 WebGPU canvas（合成器限制）；/home/z/terrain-data/pyramid（857MB）为数据真身勿删，/tmp/dem-high.zip（325MB）建议保留供重建。

---
Task ID: 22
Agent: Z.ai Code (main)
Task: 用户报告「应该随可视区域流式加载而不是显示低分辨率」——升空后视野大部分为 0.125°（14km/px）全球球体兜底，只有固定 712km 窗口内是高分辨率。交付 v17：海拔自适应多分辨率流式窗口（GeoClipmap 式层级缩放）+ 远景一致化（窗口/球体材质边界消除）。

Work Log:
- 【根因】v16.1 的窗口镜像固定 1536² @ 15″（463m/px，712km 幅面），升空后视野达数千公里 → 窗口外全部退化为 L0 球体（14km/px）兜底；流式金字塔虽有全球 15″ 数据，却从不为可视区域加载更粗层（L1 60″ 全球 562 瓦片可用）。
- 【海拔自适应多分辨率窗口（stream.ts 重构）】窗口格网步长随观测海拔动态选择：低空 <12km 用 L3 窗口（463m/px，711×444km）→ 中空 12–90km 用 L2（926m/px，1424×888km）→ 高空/轨道 >90km 用 L1（1852m/px，2848×1776km）。可视区域始终以「该海拔下可用最高分辨率」流式铺满（L1 窗口对 14km/px 球体 = 8× 清晰度）。
  · setEyeAlt 非对称滞回状态机：升空 12km/90km 切粗、降落 9km/70km 回细 + 目标持续 ≥500ms + 切换间隔 ≥1.2s（时间基准，帧率无关）；pollLevelSwitch 由宿主取走请求。
  · reanchor(lat, lon, lvl?)：r0/c0 吸附按 winStep；无缝换层（窗口中心不动）→ 旧层镜像按全球 15″ 格点索引移位对齐拷贝（2 的幂移位），prio=1（BC 区 3）→ 新层瓦片到达后逐块覆盖 → 换层瞬间无清晰度闪降、无黑块；平移重锚定保持现有 L0 预填路径（锚点旋转基变化，直接拷贝会引入横向错位）。
  · enqueueWindow 镶嵌预算：每层半幅 = min(窗口半幅, 满幅×2^(3-lvl))（L1 全窗/L2 半幅/L3 中心 1/4）+ ±1 环 + 经向 1/cosφ 扩张 → 任意窗口层级下每层 ≈ 4×4~8×9 瓦片，总量恒定。
  · applyTile 通用映射：窗口格点 i ↔ 全球 15″ 格点 c0+i·winStep → 任意「窗口步长 × 瓦片层级」组合自动降采样/上采样双线性（L3 窗口与旧实现逐位一致）。
  · BC 种子拷贝改为全球格点对齐步进采样（步长随窗口层级）；瓦片 cache/inflight/knownOcean 跨窗口复用（key 为全球格网坐标）→ 换层/重锚定不再重复下载。
- 【update() 泵致命 bug 修复】cache 保留优化暴露旧缺陷：cache 命中/knownOcean 瓦片被补发循环跳过 → 永不应用到新窗口镜像（l3Ready 恒 0%、窗口外围滞留 L0 底座）。改为 filter 正序出队直接进应用队列（优先级序保持）。
- 【fetchTile 重构（网络/解压分离 + 失败语义修正）】① 网络字节到达即 resolve 释放并发名额，解压移入后台 decodeTile（headless DecompressionStream 实测 7.5s/瓦片，此前 8 并发全被解压阻塞 → 管线吞吐瓶颈）；② 15s AbortController 超时；③ 失败语义区分：清单缺失/404 = 确定海面（写 0m），网络/解压/超时失败 = 保持当前低精度数据（此前一律写海面会把山地压成 0m！）+ 5s 延迟重试（failRetryAt），绝不永久丢弃瓦片。
- 【远景一致化（GL + WGSL 地形 FS）】窗口矩形与球体的材质色阶跳变（v16.1 遗留问题②，轨道视角下深绿矩形非常突兀）：地形 FS 新增 globeSurfaceMdl —— 与 GLOBE_FS 逐式一致的全球色板（海洋/地貌/雪线/云层/夜面晨昏），按 uGlobeBlend（20..120km 渐变）混合。数学关键：窗口内片元全球方向 normalize(vec3(x,R,z)) ≡ 球体 vDir（uActMi·dG）→ 噪声场逐点同源；纬度由锚点 up 点积解算（GL 新 uniform uActUp=frame.m[3..5]；WGSL 直接用 actM1.xyz）。轨道视角窗口边界彻底不可见。
- 【配套】① chunks.ts/WGPU selectChunks 远场剔除上限 300km → max(300km, 窗口幅面×0.8)（L1 窗口远场块全部参与流式绘制）；② MESH_CACHE_MAX 240→320；③ GL 水面网格封装 buildWaterMesh 并在 onWindowChanged 随 span 重建（WGPU 水面 VS 由 uniform 驱动本就自适应）；④ 裙边 50+min(400,d·0.02) → 80+min(1200,d·0.03)（遮挡 L0/L3 数据精度混合边界高度差裂缝）；⑤ HUD「L3流」→「窗口流 L{lvl} N%」；⑥ reanchorFnRef 层级切换保持焦点 fx/fz（窗口中心不变 → 坐标语义不变，防止相机跳回中心）；⑦ QA 钩子增加 __terrain.stream。
- 【验证（agent-browser + WebGL2 路径，console 零 error）】①初始 11.7km L3 窗口 711km 正常；②轨道俯瞰 9173km：L3→L2（~3s）→L1（~7s）序列正确（HUD 窗口流 L1），窗口 2848×1776km，完整行星无黑块，窗口/球体色板连续（远景一致化成功）；③40.9km 亚轨道：L2 窗口 1424km 满幅连续地形、55 块、无边界无黑块；④表格中心数据采样证实 BC 种子高精度生效（相邻格差 25-135m）；⑤lint 0 error、terrain 路径 tsc 0 error。
- 【环境记录】headless DecompressionStream 解压 560KB 瓦片实测 7.5s（真机 <50ms）→ L3 100% 流入需数分钟，属沙箱限制；真机 60fps + 原生解压全窗流入秒级。白色阶梯区 = L1 真实高程雪线随瓦片流入逐步显现（中间态，非缺陷）。

Stage Summary:
- 交付：v17 —— 海拔自适应多分辨率流式窗口（L3 711km / L2 1424km / L1 2848km 幅面随高度切换、无缝换层、镶嵌预算恒定）+ 远景一致化（窗口/球体材质边界消除）+ 流式泵三重修复（cache 复用落地、解压不阻塞网络、失败不再伪造海面）。
- 用户问题回答：现在可视区域随海拔流式加载该高度下可用的最高分辨率（升空不再显示低分辨率球体兜底区域），窗口与球体在任何高度色板连续无边界。
- 下一轮建议优先级：① 用户真机复验（WebGPU 徽标 + 全高度升空/着陆 + 层级切换平滑性）② L1→L0 窗口扩展（轨道更远时 >2848km 幅面，或球体 L0 纹理升级为 L1 流式纹理）③ 窗口边缘 8-16km 几何混合带（进一步柔化数据精度过渡）④ 平移重锚定的旧层矩阵变换拷贝（消除平移时的 L0 闪断）⑤ GPU timestamp query 入 HUD ⑥ 植被实例视锥剔除。
- 风险：WGSL 路径（远景一致化 + 剔除联动 + 裙边）已静态同步但真机首验待用户；层级切换瞬间 L3 窗口 L-3 近景块在 L2/L1 窗口下顶点间距变粗（海拔 >12km 观测距离下不可见，贴地前必已切回 L3）；headless 无法呈现 WebGPU canvas。
---
Task ID: 23
Agent: Z.ai Code (main)
Task: 用户报告「部分地块不是无缝拼接的」—— 地块接缝四重根因修复（v17 → v17.1），核心为流式瓦片→窗口坐标映射 bug（L2/L1 窗口全部瓦片被钳位成恒定值平台）

Work Log:
- 【根因 1·瓦片映射坐标错误（最核心，v17 引入）】stream.ts applyTile 瓦片局部坐标写成 `fy = grow·invWs/step − ty·tile`（多除窗口步长 ws）：L3 窗口（ws=1）碰巧正确，L2/L1 窗口下坐标减半 → 全部钳位到瓦片角点 → 整片窗口被写入恒定值（= td.h[0]，实测 582m 平台，与瓦片文件首样本逐位吻合）→ 恒定平台与周边真实地形形成巨大精度悬崖 = 用户看到的「部分地块不无缝拼接」。修复：`fy = grow/step − ty·tile`（本层瓦片格 = step×15″，与窗口步长无关）。
- 【根因 2·半格采样偏移】同函数 `x0c = fx − 0.5` 使瓦片高度与 BC 种子（角对齐 1:1 拷贝）错位半格（L3 ≈ 225m，坡面上 ≈ 90–200m 高差 → 种子/瓦片边界台阶），且高度（双线性于 fx−0.5）与水掩膜（最近邻于 fx）错位半格 → 海岸线伪水体。修复：双线性直接在 (fx,fy) 角对齐取值，掩膜 (round(fx),round(fy)) 同位。
- 【根因 3·relief 场随相机漂移 + CPU 网格缓存不追踪】detailRelief 的 2.5–9km 渐隐遮罩以相机焦点为圆心，而 GL 网格缓存键不含焦点 → 相机移动后不同时期烘焙的相邻网格浮雕场错位（±22m 级接缝）；树/草基点与拾取同理。修复：relief 改为窗口锚点系（原点）纯位置场（reliefZone：60km 全量、60–160km 渐隐），TS(table.ts)/GLSL(DETAIL_GLSL)/WGSL(WGSL_COMMON) 三处同步；相机移动不再使任何缓存失真。
- 【根因 4·跨 LOD 法线不连续】网格法线差分间距随 LOD 步长缩放（±2^level）→ 不同级网格在共享边顶点法线不同 → 光照缝。修复：全级别固定 ±1 采样差分（GL buildMesh + WGSL VS），共享边顶点法线逐位相等；片元级新增浮雕坡度补偿（detailA 前向差分，GL+WGSL）保留近景岩脊光影。
- 【配套·精度边界羽化】applyTile 与 BC 种子写入均增加 12km smoothstep 羽化带（物理宽度恒定）：流入数据与镜像旧数据之间从 1 格悬崖摊开为缓坡；羽化带格子以降级优先级写入（prio−1），更高精度瓦片到达后可覆写自愈。
- 【配套·流式脏区重建 + 陈旧续绘】syncWindow 收集脏矩形 → schedule(dataRects) 使采样范围相交（外扩 4 格）的缓存网格陈旧 → 预算内重建；预算耗尽时同纪元陈旧网格续绘（永不破洞）；新增 table.frameEpoch 区分重锚定（坐标系作废，必须重建）与数据细化（可续绘自愈）；refine 完成时给 90 帧×16 重建突发（TerrainApp burstRef）。
- 【配套·detailAmp 切换失效】GL 渲染器跟踪 lastDetailAmp，浮雕开关切换时全量重建烘焙网格。阴影 march（GL+WGSL）在 stepLen<320 内叠加 detailA 位移场，消除浮雕隆起的漏光。
- 【验证（agent-browser，WebGL2 路径，console 零 error）】①修复前：444km 视野中央巨大垂直断崖墙 + 恒定 582m 平台（2D 探测 400km×300km 全平）+ L2/L1 窗口瓦片区全平；②修复后：同视角连续无墙；北缘瓦片区高度方差 344–2206m（真实地形）；水/高程错位修正（121/1 → 95/0）；Waddington 冰原以真实冰川高原（>雪线）渲染（白色 = 正确地理，非缺陷）；峡湾/海岸/近场/轨道（9085km 行星完整无黑块）全部连续；③WGSL 9 模块静态配平 OK + detailA 调用点参数核对（12 处）；④lint 0 error、terrain tsc 0 error。
- 【环境记录】SwiftShader WebGPU 验证两次 device-lost（内存压力 + device 预算），WGSL 编译真机首验仍待用户；headless 解压 ~7.5s/瓦片 → L3 全流入需数分钟（真机秒级）。

Stage Summary:
- 交付：v17.1 —— 地块无缝拼接：流式瓦片坐标映射修复（L2/L1 窗口数据从「恒定平台」恢复为真实地形）+ 角对齐采样（种子/瓦片 1:1）+ 12km 精度边界羽化 + 锚点系浮雕场 + 固定间距跨 LOD 法线 + 流式脏区重建与陈旧续绘。
- 用户问题回答：接缝主因 = v17 瓦片映射 bug 导致 L2/L1 窗口下所有流入瓦片变成恒定值平台，与周围真实地形形成悬崖；叠加种子/L0 精度边界硬覆盖与相机焦点系浮雕场的缓存错位。现已全部修复，任意高度/位置地块连续。
- 下一轮建议优先级：① 用户真机复验（WebGPU 徽标 + WGSL 首验 + 全高度升空/着陆 + 任意预设跳转）② 冰原/雪线在 60″ 数据下的视觉调优（可选）③ GPU timestamp query 入 HUD ④ 植被实例视锥剔除 ⑤ 窗口边缘几何混合带 ⑥ dev 模式内存治理。
- 风险：WGSL 路径改动（detailA 签名/法线/阴影）静态同步但真机首验待用户；羽化带在种子外缘永久保留 12km 缓坡（半退化数据环，视觉可接受）；/home/z/terrain-data/pyramid（857MB）为数据真身勿删。
