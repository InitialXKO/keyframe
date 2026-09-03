"use client";

/**
 * Inspector — element & keyframe property editing.
 * Includes the "capture from canvas" feature: samples the live engine
 * evaluation at the playhead and stores it as a keyframe.
 */

import { AlignCenterHorizontal, AlignCenterVertical, Camera, ChevronDown, ChevronUp, Copy, Eraser, Eye, EyeOff, Lock, Star, Trash2, Unlock, Wand2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useStudio, STAGE } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import { EASING_OPTIONS, PALETTE, SHAPE_OPTIONS, PRESETS, type EasingName, type CubicControl } from "@/lib/scene";
import type { ShapeKind } from "@/lib/scene";
import {
  loadEasingFavorites,
  persistEasingFavorites,
  makeFavoriteId,
  type EasingFavorite,
} from "@/lib/easing-favorites";
import { EasingCurve, controlsFor } from "./EasingCurve";
import { Easing } from "@/lib/keyframe";
import { toast } from "sonner";

export function Inspector() {
  const scene = useStudio((s) => s.scene);
  const selection = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const patchElement = useStudio((s) => s.patchElement);
  const removeElement = useStudio((s) => s.removeElement);
  const updateKeyframe = useStudio((s) => s.updateKeyframe);
  const removeKeyframe = useStudio((s) => s.removeKeyframe);
  const addKeyframe = useStudio((s) => s.addKeyframe);
  const applyPreset = useStudio((s) => s.applyPreset);
  const clearKeyframes = useStudio((s) => s.clearKeyframes);
  const duplicateElement = useStudio((s) => s.duplicateElement);
  const moveElement = useStudio((s) => s.moveElement);
  const timeMs = useStudio((s) => s.timeMs);
  const kfSelection = useStudio((s) => s.kfSelection);

  // easing favorites (localStorage-persisted cubic presets)
  const [favorites, setFavorites] = useState<EasingFavorite[]>(() => loadEasingFavorites());

  const el = selection ? scene.elements.find((e) => e.id === selection.elId) : null;
  const kf = el && selection?.kfT != null ? el.keyframes.find((k) => k.t === selection.kfT) : null;

  const capture = () => {
    if (!el) return;
    const captured = engineHost.captureKeyframe(el.id, timeMs);
    if (!captured) {
      toast.error("捕获失败：引擎未就绪");
      return;
    }
    addKeyframe(el.id, { ...captured, easing: (kf?.easing ?? "EaseInOut") as never });
    toast.success(`已在 ${(captured.t / 1000).toFixed(2)}s 捕获画面状态`, {
      description: `dx=${captured.dx} dy=${captured.dy} scale=${captured.scale} rot=${captured.rot}°`,
    });
  };

  if (!el) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-6 text-center">
        <Wand2 className="h-5 w-5 text-zinc-600" />
        <p className="text-sm font-medium text-zinc-400">未选中元素</p>
        <p className="text-xs text-zinc-600">
          在舞台或时间轴中点击元素进行编辑；
          <br />
          双击时间轴轨道可直接添加关键帧。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      {/* ---------------- multi-selection summary ---------------- */}
      {kfSelection.length > 1 && (
        <div
          className="animate-kf-bar-in rounded-md border border-amber-500/30 bg-amber-400/[0.05] p-3"
          data-testid="bulk-summary"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
            <span className="rounded bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] font-bold text-black">
              {kfSelection.length}
            </span>
            个关键帧已多选
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
            使用时间轴顶部的批量操作条：删除 · 批量缓动 · 对齐播放头 · 复制/剪切。
            <br />
            Esc 取消多选。
          </p>
        </div>
      )}

      {/* ---------------- element ---------------- */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-sm" style={{ background: el.color }} />
          <span className="text-sm font-semibold text-zinc-100">{el.name}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-500 hover:text-zinc-200"
            onClick={() => duplicateElement(el.id)}
            title="复制元素（Ctrl+D）"
            aria-label="复制元素"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-500 hover:text-zinc-200"
            onClick={() => moveElement(el.id, 1)}
            title="上移一层（后绘制，在最上方）"
            aria-label="上移一层"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-500 hover:text-zinc-200"
            onClick={() => moveElement(el.id, -1)}
            title="下移一层（先绘制，在最下方）"
            aria-label="下移一层"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-500 hover:text-red-400"
            onClick={() => {
              removeElement(el.id);
              toast.success(`已删除「${el.name}」`);
            }}
            aria-label="删除元素"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[10px] text-zinc-500">
        <span>图层顺序</span>
        <span className="flex items-center gap-2">
          {el.hidden && (
            <span className="rounded bg-zinc-800 px-1 py-px text-[9px] text-zinc-400">已隐藏</span>
          )}
          {el.locked && (
            <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-400">已锁定</span>
          )}
          <span className="font-mono">
            第 {scene.elements.findIndex((e) => e.id === el.id) + 1} / {scene.elements.length} 层
          </span>
        </span>
      </div>

      {/* visibility / lock quick toggles */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 bg-zinc-950 text-[11px] text-zinc-400 hover:text-zinc-100"
          onClick={() => useStudio.getState().toggleHidden(el.id)}
          data-testid="inspector-eye"
        >
          {el.hidden ? <Eye className="mr-1 h-3 w-3" /> : <EyeOff className="mr-1 h-3 w-3" />}
          {el.hidden ? "显示元素" : "隐藏元素"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 bg-zinc-950 text-[11px] text-zinc-400 hover:text-zinc-100"
          onClick={() => useStudio.getState().toggleLocked(el.id)}
          data-testid="inspector-lock"
        >
          {el.locked ? <Unlock className="mr-1 h-3 w-3" /> : <Lock className="mr-1 h-3 w-3" />}
          {el.locked ? "解锁" : "锁定"}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-400">名称</Label>
          <Input
            className="h-8 bg-zinc-950 text-xs"
            value={el.name}
            onChange={(e) => patchElement(el.id, { name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-400">形状</Label>
          <Select value={el.shape} onValueChange={(v) => patchElement(el.id, { shape: v as ShapeKind })}>
            <SelectTrigger className="h-8 bg-zinc-950 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHAPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {el.shape === "text" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-400">文字内容</Label>
          <Input
            className="h-8 bg-zinc-950 text-xs"
            value={el.text ?? ""}
            onChange={(e) => patchElement(el.id, { text: e.target.value })}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-400">颜色</Label>
        <div className="flex flex-wrap gap-1.5">
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => patchElement(el.id, { color: c })}
              className={`h-6 w-6 rounded-md border transition-transform hover:scale-110 ${
                el.color === c ? "border-white" : "border-white/10"
              }`}
              style={{ background: c }}
              aria-label={`选择颜色 ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-400">X</Label>
          <Input
            type="number"
            className="h-8 bg-zinc-950 text-xs"
            value={el.x}
            onChange={(e) => patchElement(el.id, { x: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-400">Y</Label>
          <Input
            type="number"
            className="h-8 bg-zinc-950 text-xs"
            value={el.y}
            onChange={(e) => patchElement(el.id, { y: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-zinc-400">尺寸</Label>
          <Input
            type="number"
            className="h-8 bg-zinc-950 text-xs"
            value={el.size}
            onChange={(e) => patchElement(el.id, { size: Math.max(8, Number(e.target.value) || 8) })}
          />
        </div>
      </div>

      {/* stage alignment shortcuts */}
      <div className="flex items-center gap-1.5" role="group" aria-label="舞台对齐">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 border-zinc-800 bg-zinc-950 px-1.5 text-[10px] text-zinc-400 hover:border-amber-500/50 hover:text-amber-300"
          onClick={() => patchElement(el.id, { x: Math.round((STAGE.w - el.size) / 2) })}
          title="水平居中（X = (舞台宽 − 元素宽) / 2）"
        >
          <AlignCenterHorizontal className="mr-1 h-3 w-3" /> 水平居中
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 border-zinc-800 bg-zinc-950 px-1.5 text-[10px] text-zinc-400 hover:border-amber-500/50 hover:text-amber-300"
          onClick={() => patchElement(el.id, { y: Math.round((STAGE.h - el.size) / 2) })}
          title="垂直居中（Y = (舞台高 − 元素高) / 2）"
        >
          <AlignCenterVertical className="mr-1 h-3 w-3" /> 垂直居中
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 border-zinc-800 bg-zinc-950 px-1.5 text-[10px] text-zinc-400 hover:border-amber-500/50 hover:text-amber-300"
          onClick={() =>
            patchElement(el.id, { x: Math.round((STAGE.w - el.size) / 2), y: Math.round((STAGE.h - el.size) / 2) })
          }
          title="舞台正中"
        >
          舞台中心
        </Button>
      </div>

      <Separator className="bg-zinc-800" />

      {/* ---------------- keyframe ---------------- */}
      {kf ? (
        <div className="space-y-3" data-testid="kf-editor">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-300">
              关键帧 @ {(kf.t / 1000).toFixed(2)}s
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-zinc-400 hover:text-red-400"
              onClick={() => removeKeyframe(el.id, kf.t)}
            >
              <Trash2 className="mr-1 h-3 w-3" /> 删除
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <NumberField label="位移 X (px)" value={kf.dx} onCommit={(v) => updateKeyframe(el.id, kf.t, { dx: v })} />
            <NumberField label="位移 Y (px)" value={kf.dy} onCommit={(v) => updateKeyframe(el.id, kf.t, { dy: v })} />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-zinc-400">缩放</Label>
              <span className="font-mono text-xs text-zinc-300">{kf.scale.toFixed(2)}</span>
            </div>
            <Slider
              value={[kf.scale]}
              min={0}
              max={3}
              step={0.05}
              onValueChange={([v]) => updateKeyframe(el.id, kf.t, { scale: v })}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-zinc-400">旋转</Label>
              <span className="font-mono text-xs text-zinc-300">{kf.rot}°</span>
            </div>
            <Slider
              value={[kf.rot]}
              min={-180}
              max={180}
              step={1}
              onValueChange={([v]) => updateKeyframe(el.id, kf.t, { rot: v })}
            />
          </div>

          <div className="space-y-1">
            <div className="flex justify-between">
              <Label className="text-xs text-zinc-400">不透明度</Label>
              <span className="font-mono text-xs text-zinc-300">{kf.opacity.toFixed(2)}</span>
            </div>
            <Slider
              value={[kf.opacity]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={([v]) => updateKeyframe(el.id, kf.t, { opacity: v })}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-zinc-400">缓动曲线（到下一关键帧）</Label>
            <Select
              value={kf.easing}
              onValueChange={(v) => {
                const next = v as EasingName;
                if (next === Easing.CubicBezier && !kf.cubic) {
                  // first switch to custom bezier: seed the back-out profile
                  updateKeyframe(el.id, kf.t, {
                    easing: next,
                    cubic: { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1.0 },
                  });
                } else {
                  updateKeyframe(el.id, kf.t, { easing: next });
                }
              }}
            >
              <SelectTrigger className="h-8 bg-zinc-950 text-xs" data-testid="easing-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EASING_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <EasingCurve
              easing={kf.easing}
              cubic={kf.cubic}
              onChange={(c: CubicControl) =>
                updateKeyframe(el.id, kf.t, { easing: Easing.CubicBezier, cubic: c }, { history: false, key: "bezier:" + el.id + ":" + kf.t })
              }
            />
            {kf.easing === Easing.CubicBezier && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-600">
                  {kf.cubic ? "自定义控制点已同步到引擎" : "使用默认回弹曲线"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] text-zinc-500 hover:text-amber-300"
                  disabled={!kf.cubic}
                  onClick={() => {
                    updateKeyframe(el.id, kf.t, {
                      cubic: { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1.0 },
                    });
                    toast.success("已重置为默认回弹曲线");
                  }}
                >
                  重置控制点
                </Button>
              </div>
            )}

            {/* easing favorites palette */}
            <div className="rounded-md border border-zinc-800/80 bg-zinc-950/40 p-2" data-testid="easing-favorites">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1 text-[10px] font-medium text-zinc-400">
                  <Star className="h-3 w-3 text-amber-400" /> 曲线收藏夹
                </span>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 gap-1 px-1.5 text-[10px] text-zinc-500 hover:text-amber-300"
                        data-testid="easing-fav-add"
                        onClick={() => {
                          const [p1x, p1y, p2x, p2y] =
                            kf.easing === Easing.CubicBezier && kf.cubic
                              ? [kf.cubic.p1x, kf.cubic.p1y, kf.cubic.p2x, kf.cubic.p2y]
                              : controlsFor(kf.easing);
                          const fav: EasingFavorite = {
                            id: makeFavoriteId(),
                            label: `曲线 ${favorites.length + 1}`,
                            cubic: { p1x, p1y, p2x, p2y },
                          };
                          const next = [...favorites, fav];
                          setFavorites(next);
                          persistEasingFavorites(next);
                          toast.success("已收藏当前曲线", {
                            description: `P1(${p1x}, ${p1y}) · P2(${p2x}, ${p2y})`,
                          });
                        }}
                      >
                        <Star className="h-3 w-3" /> 收藏当前
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="text-[10px]">
                      将当前控制点保存到收藏夹（localStorage 持久化）
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {favorites.length === 0 ? (
                <p className="py-1 text-center text-[10px] text-zinc-600">暂无收藏曲线</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {favorites.map((f) => (
                    <span
                      key={f.id}
                      className="group inline-flex items-center overflow-hidden rounded border border-zinc-800 bg-zinc-900 text-[10px] transition-colors hover:border-amber-500/60"
                    >
                      <button
                        className="px-1.5 py-1 text-zinc-300 hover:text-amber-300"
                        title={`应用「${f.label}」P1(${f.cubic.p1x}, ${f.cubic.p1y}) P2(${f.cubic.p2x}, ${f.cubic.p2y})`}
                        data-testid={`easing-fav-apply-${f.id}`}
                        onClick={() => {
                          updateKeyframe(el.id, kf.t, {
                            easing: Easing.CubicBezier,
                            cubic: { ...f.cubic },
                          });
                          toast.success(`已应用「${f.label}」`);
                        }}
                      >
                        {f.label}
                      </button>
                      <button
                        className="flex h-full items-center border-l border-zinc-800 px-1 py-1 text-zinc-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                        title="删除此收藏"
                        aria-label={`删除收藏 ${f.label}`}
                        onClick={() => {
                          const next = favorites.filter((x) => x.id !== f.id);
                          setFavorites(next);
                          persistEasingFavorites(next);
                        }}
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* quick time move */}
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 bg-zinc-950 text-xs"
              onClick={() => updateKeyframe(el.id, kf.t, { t: Math.max(0, kf.t - 100) })}
            >
              −100ms
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 bg-zinc-950 text-xs"
              onClick={() => updateKeyframe(el.id, kf.t, { t: Math.min(scene.durationMs, kf.t + 100) })}
            >
              +100ms
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">
            {el.keyframes.length} 个关键帧 · 选中菱形编辑/拖拽改时间，或从画布捕获 · Delete 删除
          </p>
          <Button onClick={capture} className="h-8 w-full bg-amber-500 text-xs text-black hover:bg-amber-400" data-testid="capture-kf">
            <Camera className="mr-1.5 h-3.5 w-3.5" /> 在播放头处捕获关键帧
          </Button>
        </div>
      )}

      <Separator className="bg-zinc-800" />

      {/* ---------------- presets ---------------- */}
      <div className="space-y-1.5">
        <Label className="text-xs text-zinc-400">动效预设（覆盖该元素轨道）</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                applyPreset(el.id, p.id);
                toast.success(`已应用「${p.name}」`);
              }}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-left text-[11px] text-zinc-300 transition-colors hover:border-amber-500/50 hover:text-amber-300"
              title={p.desc}
              data-testid={`preset-${p.id}`}
            >
              {p.name}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full text-xs text-zinc-500 hover:text-zinc-300"
          onClick={() => clearKeyframes(el.id)}
        >
          <Eraser className="mr-1 h-3 w-3" /> 清空关键帧
        </Button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-zinc-400">{label}</Label>
      <Input
        type="number"
        className="h-8 bg-zinc-950 text-xs"
        defaultValue={value}
        key={`${value}`}
        onBlur={(e) => onCommit(Number(e.target.value) || 0)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(Number((e.target as HTMLInputElement).value) || 0);
        }}
      />
    </div>
  );
}
