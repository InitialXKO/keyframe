"use client";

/**
 * TextStaggerDialog — per-character title generator ("逐字标语").
 *
 * One text element per character with a staggered entrance; characters are
 * laid out with CJK/latin-aware width heuristics and centered on the stage.
 * The live preview strip mirrors each engine preset 1:1 using CSS animations
 * (same curve/delay semantics), replayed via a remount key on any change.
 */

import { useMemo, useState } from "react";
import { Sparkles, RotateCcw, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useStudio, STAGE, type TextStaggerConfig } from "@/store/studio";
import { PALETTE } from "@/lib/scene";
import { toast } from "sonner";

const PRESETS: { id: TextStaggerConfig["preset"]; label: string; anim: string; desc: string }[] = [
  { id: "fadeUp", label: "上浮淡入", anim: "kf-stagger-up", desc: "从下方 14px 浮入" },
  { id: "popSpin", label: "弹跳旋转", anim: "kf-stagger-pop", desc: "缩放 + 旋转过冲" },
  { id: "dropBounce", label: "坠落回弹", anim: "kf-stagger-drop", desc: "从上方坠落弹跳" },
];

const DEFAULT_CFG: TextStaggerConfig = {
  text: "KEYFORGE",
  fontSize: 56,
  color: "#f59e0b",
  staggerMs: 80,
  preset: "popSpin",
  centerY: 250,
};

/** char width heuristics — MUST match the store's charEm() */
function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2e80 ? 1.04 : 0.62;
}

export function TextStaggerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const addTextStagger = useStudio((s) => s.addTextStagger);
  const sceneDuration = useStudio((s) => s.scene.durationMs);
  const [cfg, setCfg] = useState<TextStaggerConfig>(DEFAULT_CFG);
  const [replay, setReplay] = useState(0);

  const chars = useMemo(() => [...cfg.text].slice(0, 24), [cfg.text]);
  const totalW = useMemo(() => chars.reduce((w, ch) => w + charEm(ch) * cfg.fontSize, 0), [chars, cfg.fontSize]);
  const visibleCount = chars.filter((ch) => !/\s/.test(ch)).length;
  const lastKfEnd = visibleCount === 0 ? 0 : (chars.length - 1) * cfg.staggerMs + (cfg.preset === "fadeUp" ? 480 : cfg.preset === "popSpin" ? 520 : 660);
  const needDuration = Math.max(sceneDuration, lastKfEnd + 500);
  const willExtend = needDuration > sceneDuration;

  const patch = (p: Partial<TextStaggerConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    setReplay((n) => n + 1);
  };

  const generate = () => {
    const n = addTextStagger(cfg);
    if (n === 0) {
      toast.error("请输入至少一个非空白字符");
      return;
    }
    onOpenChange(false);
    toast.success(`已生成 ${n} 个逐字标语元素`, {
      description: `${PRESETS.find((p) => p.id === cfg.preset)?.label} · 错峰 ${cfg.staggerMs}ms${willExtend ? " · 时长已自动延长" : ""}`,
    });
  };

  const preset = PRESETS.find((p) => p.id === cfg.preset)!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-lg" data-testid="stagger-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-amber-400" /> 逐字标语生成器
          </DialogTitle>
          <DialogDescription>
            每个字符生成独立文字元素 + 阶梯入场关键帧，生成后可继续逐字微调
          </DialogDescription>
        </DialogHeader>

        {/* live CSS preview (mirrors the engine preset) */}
        <div className="relative overflow-hidden rounded-md border border-zinc-800 bg-[#0a0a0c] px-3 py-6">
          <div className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
          <div className="flex items-center justify-center" style={{ minHeight: cfg.fontSize * 1.6 }}>
            <div className="flex items-baseline" key={replay} data-testid="stagger-preview">
              {chars.map((ch, i) => (
                <span
                  key={i}
                  className="kf-stagger-char whitespace-pre font-bold tracking-tight"
                  style={{
                    color: cfg.color,
                    fontSize: Math.min(34, cfg.fontSize * 0.6),
                    animationName: preset.anim,
                    animationDelay: `${i * (cfg.staggerMs / 1000)}s`,
                  }}
                >
                  {ch}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[9px] text-zinc-600">
            <span>预览（与引擎关键帧同参数）</span>
            <button
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-zinc-800/70 hover:text-amber-300"
              onClick={() => setReplay((n) => n + 1)}
              data-testid="stagger-replay"
            >
              <RotateCcw className="h-2.5 w-2.5" /> 重播
            </button>
          </div>
        </div>

        {/* text + preset */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] text-zinc-400">文案（最多 24 字符，空格仅占位）</Label>
            <Input
              className="h-9 bg-zinc-950 text-sm"
              value={cfg.text}
              onChange={(e) => patch({ text: e.target.value })}
              placeholder="输入标题文案…"
              maxLength={24}
              data-testid="stagger-text"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-zinc-400">入场样式</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => patch({ preset: p.id })}
                  className={`rounded-md border px-2 py-1.5 text-center transition-all ${
                    cfg.preset === p.id
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                      : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  }`}
                  data-testid={`stagger-preset-${p.id}`}
                >
                  <div className="text-[11px] font-medium leading-tight">{p.label}</div>
                  <div className="mt-0.5 text-[9px] leading-tight opacity-60">{p.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* sliders */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-zinc-400">字号</Label>
                <span className="font-mono text-[10px] text-zinc-500">{cfg.fontSize}px</span>
              </div>
              <Slider value={[cfg.fontSize]} min={20} max={72} step={2} onValueChange={([v]) => patch({ fontSize: v })} data-testid="stagger-size" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-zinc-400">错峰间隔</Label>
                <span className="font-mono text-[10px] text-zinc-500">{cfg.staggerMs}ms</span>
              </div>
              <Slider value={[cfg.staggerMs]} min={40} max={180} step={10} onValueChange={([v]) => patch({ staggerMs: v })} data-testid="stagger-gap" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-zinc-400">垂直位置</Label>
                <span className="font-mono text-[10px] text-zinc-500">{cfg.centerY}px</span>
              </div>
              <Slider value={[cfg.centerY]} min={80} max={STAGE.h - 80} step={10} onValueChange={([v]) => patch({ centerY: v })} data-testid="stagger-y" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-zinc-400">颜色</Label>
              <div className="flex flex-wrap items-center gap-1">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => patch({ color: c })}
                    aria-label={`颜色 ${c}`}
                    className={`h-4 w-4 rounded-full transition-transform ${cfg.color === c ? "scale-125 ring-2 ring-white/80" : "hover:scale-110"}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* estimate chips */}
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
            <span className="rounded bg-zinc-900 px-1.5 py-0.5">{visibleCount} 字元素</span>
            <span className="rounded bg-zinc-900 px-1.5 py-0.5">总宽 ≈ {Math.round(totalW)}px</span>
            <span className="rounded bg-zinc-900 px-1.5 py-0.5">末帧 {(lastKfEnd / 1000).toFixed(2)}s</span>
            {willExtend && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400">时长将延长至 {(needDuration / 1000).toFixed(1)}s</span>}
          </div>
        </div>

        <DialogFooter>
          <Button className="bg-amber-500 text-black hover:bg-amber-400" onClick={generate} disabled={visibleCount === 0} data-testid="stagger-generate">
            <Sparkles className="mr-1 h-4 w-4" /> 生成 {visibleCount} 个元素
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
