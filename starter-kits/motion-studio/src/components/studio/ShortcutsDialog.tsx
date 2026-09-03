"use client";

/**
 * ShortcutsDialog — keyboard cheat sheet ("?" key / floating button).
 * Grouped by concern: playback shuttle, editing, timeline & selection.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Group {
  title: string;
  items: { keys: string[]; desc: string }[];
}

const GROUPS: Group[] = [
  {
    title: "播放与穿梭",
    items: [
      { keys: ["Space"], desc: "播放 / 暂停" },
      { keys: ["J"], desc: "反向播放（连按 −1×→−2×→−4×→−8×）" },
      { keys: ["K"], desc: "暂停并复位速率 1×" },
      { keys: ["L"], desc: "正向倍速（连按 1×→2×→4×→8×）" },
      { keys: ["←", "→"], desc: "步进 ±100ms" },
      { keys: ["Shift", "←", "→"], desc: "逐帧步进（1/60s）" },
      { keys: ["Home", "End"], desc: "跳到首帧 / 尾帧" },
    ],
  },
  {
    title: "编辑",
    items: [
      { keys: ["Ctrl", "Z"], desc: "撤销" },
      { keys: ["Ctrl", "Shift", "Z"], desc: "重做（或 Ctrl+Y）" },
      { keys: ["Ctrl", "D"], desc: "复制选中元素" },
      { keys: ["Delete"], desc: "删除选中关键帧 / 元素" },
      { keys: ["Esc"], desc: "取消选择 / 清空多选" },
    ],
  },
  {
    title: "关键帧",
    items: [
      { keys: ["Ctrl", "C"], desc: "复制选中关键帧" },
      { keys: ["Ctrl", "X"], desc: "剪切选中关键帧" },
      { keys: ["Ctrl", "V"], desc: "粘贴到播放头（保持相对间距）" },
      { keys: ["Ctrl", "A"], desc: "全选所有关键帧" },
      { keys: ["Ctrl", "点击"], desc: "切换多选 / Shift+点击范围选" },
      { keys: ["双击轨道"], desc: "在播放头处添加关键帧" },
    ],
  },
  {
    title: "工作台",
    items: [
      { keys: ["?"], desc: "打开 / 关闭本速查表" },
      { keys: ["拖拽轨道名"], desc: "改变图层叠加顺序（z-order）" },
      { keys: ["框选空白区"], desc: "矩形批量选择关键帧" },
      { keys: ["Alt", "方向键"], desc: "微移选中元素（1px，Shift = 10px）" },
      { keys: ["拖拽轨迹中点"], desc: "把直线轨迹弯曲为贝塞尔弧线" },
      { keys: ["点击速度图"], desc: "跳转播放头并选中该段起始关键帧" },
      { keys: ["再次点击段"], desc: "打开缓动编辑器（拖拽贝塞尔控制点，Esc 关闭）" },
    ],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-lg" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            键盘快捷键速查
            <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
              ?
            </kbd>
          </DialogTitle>
          <DialogDescription>专业 NLE 习惯的工作流 — 忘记时按 ? 随时查看</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400/80">
                {g.title}
              </h4>
              <ul className="space-y-1">
                {g.items.map((it) => (
                  <li key={it.desc} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-zinc-400">{it.desc}</span>
                    <span className="flex shrink-0 gap-0.5">
                      {it.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] text-zinc-300"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
