"use client";

/**
 * StudioWorkspace — owns the engine compile lifecycle and player wiring.
 *
 * Any scene mutation bumps `engineVersion`, which recompiles the Keyframe
 * Engine from the scene JSON and rebinds the AnimationPlayer, preserving
 * playback position and state.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Keyboard, SlidersHorizontal } from "lucide-react";
import { useStudio } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import type { SceneData } from "@/lib/scene";
import { StageCanvas } from "./StageCanvas";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { Toolbar } from "./Toolbar";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const FRAME_MS = 1000 / 60;
const AUTOSAVE_KEY = "keyforge.autosave";

export function StudioWorkspace() {
  const engineVersion = useStudio((s) => s.engineVersion);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // v10: mobile inspector drawer — the right column is desktop-only; on
  // small screens the Inspector lives in a slide-over sheet
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const selName = useStudio((s) => (s.selection ? s.scene.elements.find((e) => e.id === s.selection?.elId)?.name ?? null : null));
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // hydration-safe bootstrap: restore auto-saved work if present, else demo
  useEffect(() => {
    let restored = false;
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { scene: SceneData; at: number };
        if (parsed?.scene?.elements?.length > 0) {
          useStudio.setState({ scene: parsed.scene, engineVersion: useStudio.getState().engineVersion + 1 });
          const ago = Math.max(0, Math.round((Date.now() - parsed.at) / 1000));
          const agoLabel = ago < 60 ? `${ago}s 前` : ago < 3600 ? `${Math.round(ago / 60)}m 前` : `${Math.round(ago / 3600)}h 前`;
          // defer past the Toaster's listener registration on first mount
          setTimeout(() => {
            toast.info("已恢复上次的工作现场", {
              description: `「${parsed.scene.title}」· 自动保存于 ${agoLabel}`,
            });
          }, 200);
          restored = true;
        }
      }
    } catch {
      // corrupted autosave — fall through to demo
    }
    if (!restored && useStudio.getState().scene.elements.length === 0) {
      useStudio.getState().loadDemo();
    }
  }, []);

  // autosave: debounce-write the scene to localStorage on every change
  useEffect(() => {
    const write = (scene: SceneData) => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => {
        try {
          if (scene.elements.length === 0) return;
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ scene, at: Date.now() }));
          useStudio.setState({ lastAutosaveAt: Date.now() });
        } catch {
          // storage full/disabled — autosave is best-effort
        }
      }, 900);
    };
    write(useStudio.getState().scene);
    return useStudio.subscribe((s, prev) => {
      if (s.scene !== prev.scene) write(s.scene);
    });
  }, []);

  // "?" opens the shortcut cheat sheet from anywhere; footer button via custom event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    const onOpen = () => setShortcutsOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyforge:shortcuts", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyforge:shortcuts", onOpen);
    };
  }, []);

  // compile engine + (re)bind player whenever the scene model changes
  useEffect(() => {
    const { scene, loop } = useStudio.getState();
    engineHost.compile(scene);
    engineHost.ensurePlayer({ loop });

    const p = engineHost.player;
    const onPlay = () => useStudio.getState().setPlaying(true);
    const onPause = () => useStudio.getState().setPlaying(false);
    p?.on("play", onPlay);
    p?.on("pause", onPause);
    engineHost.renderAt(engineHost.lastTime);

    return () => {
      p?.off("play", onPlay);
      p?.off("pause", onPause);
    };
  }, [engineVersion]);

  // keyboard shortcuts
  // space = play/pause · ←→ = step 100ms · Shift+←→ = step 1 frame · Home/End = jump
  // J/K/L = reverse/pause/forward shuttle (repeat to speed up) · Delete = remove kf/element
  // Ctrl+D = duplicate · Ctrl+C/X/V = kf clipboard · Ctrl+Z/Y = undo/redo · Esc = deselect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const st = useStudio.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (st.selection) {
          st.duplicateElement(st.selection.elId);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const n = st.copySelectedKfs();
        if (n > 0) toast.success(`已复制 ${n} 个关键帧`, { description: "Ctrl+V 粘贴到播放头位置" });
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        e.preventDefault();
        const n = st.cutSelectedKfs();
        if (n > 0) toast.success(`已剪切 ${n} 个关键帧`, { description: "Ctrl+V 粘贴到播放头位置" });
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const n = st.pasteKfs();
        if (n > 0) toast.success(`已粘贴 ${n} 个关键帧`, { description: `对齐到 ${(st.timeMs / 1000).toFixed(2)}s` });
        else toast.info("剪贴板为空或轨道不匹配");
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // select all keyframes across the scene
        const all: string[] = [];
        for (const el of st.scene.elements) {
          for (const kf of el.keyframes) all.push(`${el.id}|${kf.t}`);
        }
        st.setKfSelection(all);
        if (all.length > 0) toast.info(`已全选 ${all.length} 个关键帧`);
        return;
      }
      if (e.key === "Escape") {
        st.clearKfSelection();
        st.select(null);
        return;
      }

      // JKL shuttle — first press plays at 1x; repeat presses double the speed
      if (e.key.toLowerCase() === "j") {
        e.preventDefault();
        const wasPlaying = engineHost.player?.getIsPlaying() ?? false;
        const cur = st.playRate;
        const mag = wasPlaying && cur < 0 ? Math.min(Math.abs(cur) * 2, 8) : 1;
        const rate = -mag;
        st.setPlayRate(rate);
        engineHost.setRate(rate);
        if (!wasPlaying) engineHost.play();
        return;
      }
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        engineHost.pause();
        st.setPlayRate(1);
        engineHost.setRate(1);
        return;
      }
      if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        const wasPlaying = engineHost.player?.getIsPlaying() ?? false;
        const cur = st.playRate;
        const rate = wasPlaying && cur > 0 ? Math.min(cur * 2, 8) : 1;
        st.setPlayRate(rate);
        engineHost.setRate(rate);
        if (!wasPlaying) engineHost.play();
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        if (engineHost.player?.getIsPlaying()) engineHost.pause();
        else engineHost.play();
      } else if (e.altKey && (e.code === "ArrowRight" || e.code === "ArrowLeft" || e.code === "ArrowUp" || e.code === "ArrowDown")) {
        // Alt+Arrow = nudge selected element (1px; Shift = 10px grid)
        e.preventDefault();
        const sel = st.selection;
        if (!sel) return;
        const el = st.scene.elements.find((x) => x.id === sel.elId);
        if (!el || el.locked) return;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.code === "ArrowRight" ? step : e.code === "ArrowLeft" ? -step : 0;
        const dy = e.code === "ArrowDown" ? step : e.code === "ArrowUp" ? -step : 0;
        st.patchElement(el.id, { x: el.x + dx, y: el.y + dy }, { history: false });
        st.pushHistory(`nudge:${el.id}`, `微移「${el.name}」位置`);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) {
          const base = Math.round(engineHost.lastTime / FRAME_MS) * FRAME_MS;
          engineHost.seek(base + FRAME_MS);
        } else {
          engineHost.seek(engineHost.lastTime + 100);
        }
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) {
          const base = Math.round(engineHost.lastTime / FRAME_MS) * FRAME_MS;
          engineHost.seek(base - FRAME_MS);
        } else {
          engineHost.seek(engineHost.lastTime - 100);
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        engineHost.seek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        engineHost.seek(useStudio.getState().scene.durationMs);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (st.kfSelection.length > 1) {
          st.removeKeyframesBulk(st.kfSelection);
          return;
        }
        const sel = st.selection;
        if (!sel) return;
        const el = st.scene.elements.find((x) => x.id === sel.elId);
        if (!el) return;
        if (sel.kfT != null && el.keyframes.some((k) => k.t === sel.kfT)) {
          st.removeKeyframe(sel.elId, sel.kfT);
        } else {
          st.removeElement(sel.elId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <Toolbar />

      <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
        {/* left column: stage + timeline */}
        <div className="flex min-w-0 flex-col gap-3">
          <StageCanvas />
          <Timeline />
        </div>

        {/* right column: inspector (desktop) */}
        <div className="hidden min-w-0 lg:block" data-testid="inspector">
          <Inspector />
        </div>
      </div>

      {/* v10: mobile inspector — slide-over drawer with the full Inspector */}
      <button
        onClick={() => setInspectorOpen(true)}
        className="fixed bottom-16 right-4 z-40 flex h-9 items-center gap-1.5 rounded-full border border-amber-500/40 bg-zinc-900/90 px-3 text-[11px] text-amber-300 shadow-lg backdrop-blur transition-colors hover:border-amber-400 hover:text-amber-200 lg:hidden"
        title="打开 Inspector"
        data-testid="inspector-fab"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" /> Inspector{selName ? ` · ${selName}` : ""}
      </button>
      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent
          side="right"
          className="w-[320px] max-w-[88vw] border-zinc-800 bg-zinc-950 p-0 pb-[env(safe-area-inset-bottom)]"
          data-testid="inspector-sheet"
        >
          <SheetHeader className="border-b border-zinc-800 px-4 py-3">
            <SheetTitle className="flex items-center gap-1.5 text-sm text-zinc-100">
              <SlidersHorizontal className="h-4 w-4 text-amber-400" /> Inspector
              {selName && <span className="truncate font-mono text-[10px] font-normal text-amber-400/80">· {selName}</span>}
            </SheetTitle>
            <SheetDescription className="text-[10px]">小屏模式下属性面板移入抽屉，选择舞台元素后在此编辑</SheetDescription>
          </SheetHeader>
          <div className="max-h-[calc(100dvh-5rem)] overflow-y-auto px-3 py-3">
            <Inspector />
          </div>
        </SheetContent>
      </Sheet>

      {/* shortcut cheat sheet ("?" key or floating button) */}
      <button
        onClick={() => setShortcutsOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex h-9 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/90 px-3 text-[11px] text-zinc-400 shadow-lg backdrop-blur transition-colors hover:border-amber-500/50 hover:text-amber-300"
        title="快捷键速查（?）"
        data-testid="shortcuts-fab"
      >
        <Keyboard className="h-3.5 w-3.5" /> 快捷键
      </button>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
