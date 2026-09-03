"use client";

/**
 * Toolbar — playback controls, element creation, scene persistence & export.
 */

import { useEffect, useRef, useState } from "react";
import {
  Circle,
  ClipboardCopy,
  Copy,
  Diamond,
  Download,
  FileJson,
  Film,
  FolderOpen,
  History,
  ImageDown,
  Layers,
  ListChecks,
  Pencil,
  Repeat,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  Square,
  Square as SquareIcon,
  Star,
  Trash2,
  Type,
  Undo2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStudio } from "@/store/studio";
import { engineHost } from "@/lib/engine-host";
import { sceneToRemotionCode, type SceneData } from "@/lib/scene";
import { renderSceneThumb, renderSceneFramePng } from "@/lib/snapshot";
import { ExportCenter } from "./ExportCenter";
import { TextStaggerDialog } from "./TextStaggerDialog";
import { toast } from "sonner";

interface SceneRow {
  id: string;
  title: string;
  durationMs: number;
  thumb?: string | null;
  starred?: boolean;
  createdAt?: string;
  updatedAt: string;
  // v11: structure stats computed server-side from the scene JSON
  elCount?: number;
  kfCount?: number;
}

type LibSort = "updatedAt" | "createdAt" | "title" | "duration";
const LIB_SORTS: { id: LibSort; label: string }[] = [
  { id: "updatedAt", label: "最近更新" },
  { id: "createdAt", label: "创建时间" },
  { id: "title", label: "标题 A→Z" },
  { id: "duration", label: "时长降序" },
];
const LIB_PAGE_SIZE = 8;

function relativeTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function cnPlayRateChip(rate: number): string {
  const base = "rounded px-1 py-0.5 text-[10px] font-bold leading-none transition-colors";
  if (rate < 0) return `${base} bg-rose-500/20 text-rose-300 hover:bg-rose-500/30`;
  return `${base} bg-amber-500/20 text-amber-300 hover:bg-amber-500/30`;
}

/** autosave status dot — "已自动保存 · Ns 前" once the first write lands */
function AutosaveChip() {
  const lastAutosaveAt = useStudio((s) => s.lastAutosaveAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lastAutosaveAt) return;
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [lastAutosaveAt]);
  if (!lastAutosaveAt) return null;
  const ago = Math.max(0, Math.round((Date.now() - lastAutosaveAt) / 1000));
  const agoLabel = ago < 5 ? "刚刚" : ago < 60 ? `${ago}s 前` : ago < 3600 ? `${Math.round(ago / 60)}m 前` : `${Math.round(ago / 3600)}h 前`;
  return (
    <span
      className="flex items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-1 text-[10px] text-emerald-400"
      title="编辑会自动保存到浏览器本地（localStorage），刷新/崩溃后自动恢复"
      data-testid="autosave-chip"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)]" />
      已自动保存 {agoLabel}
    </span>
  );
}

export function Toolbar() {
  const scene = useStudio((s) => s.scene);
  const sceneId = useStudio((s) => s.sceneId);
  const playing = useStudio((s) => s.playing);
  const loop = useStudio((s) => s.loop);
  const timeMs = useStudio((s) => s.timeMs);

  const setPlaying = useStudio((s) => s.setPlaying);
  const setLoop = useStudio((s) => s.setLoop);
  const setTitle = useStudio((s) => s.setTitle);
  const setDuration = useStudio((s) => s.setDuration);
  const addElement = useStudio((s) => s.addElement);
  const loadDemo = useStudio((s) => s.loadDemo);
  const loadScene = useStudio((s) => s.loadScene);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.canUndo);
  const canRedo = useStudio((s) => s.canRedo);
  const historyPast = useStudio((s) => s.historyPast);
  const historyFuture = useStudio((s) => s.historyFuture);
  const playRate = useStudio((s) => s.playRate);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [rows, setRows] = useState<SceneRow[]>([]);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // unified export center (WebM / GIF / PNG sequence)
  const [exportOpen, setExportOpen] = useState(false);
  // per-character title generator
  const [staggerOpen, setStaggerOpen] = useState(false);

  // library: search + sort + pagination + multi-select batch delete
  const [libSearch, setLibSearch] = useState("");
  const [libSort, setLibSort] = useState<LibSort>("updatedAt");
  const [libPage, setLibPage] = useState(0);
  const [libSelected, setLibSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  // v10: inline rename — the scene card whose title is being edited
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const togglePlay = () => {
    if (playing) engineHost.pause();
    else engineHost.play();
  };

  const save = async () => {
    try {
      const thumb = renderSceneThumb(scene);
      const res = await fetch("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sceneId, title: scene.title, durationMs: scene.durationMs, data: scene, thumb }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { id: string };
      useStudio.setState({ sceneId: json.id });
      toast.success("场景已保存", { description: `「${scene.title}」已写入数据库${thumb ? "，含缩略图快照" : ""}` });
    } catch (e) {
      toast.error("保存失败", { description: String(e).slice(0, 120) });
    }
  };

  // v9: duplicate a saved scene — full copy (data + thumb) under a new title
  const duplicateScene = async (r: SceneRow) => {
    try {
      const res = await fetch(`/api/scenes/${r.id}`);
      if (!res.ok) throw new Error(await res.text());
      const full = (await res.json()) as {
        scene: { id: string; title: string; durationMs: number; data: string; thumb: string | null };
      };
      const data = JSON.parse(full.scene.data) as SceneData;
      const newTitle = `${full.scene.title} 副本`;
      const post = await fetch("/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, durationMs: full.scene.durationMs, data, thumb: full.scene.thumb }),
      });
      if (!post.ok) throw new Error(await post.text());
      const created = (await post.json()) as { id: string };
      const now = new Date().toISOString();
      setRows((rs) => [
        { id: created.id, title: newTitle, durationMs: full.scene.durationMs, thumb: full.scene.thumb, starred: false, createdAt: now, updatedAt: now, elCount: r.elCount, kfCount: r.kfCount },
        ...rs,
      ]);
      toast.success("已复制场景", { description: `「${newTitle}」已创建，可在库中载入` });
    } catch (e) {
      toast.error("复制失败", { description: String(e).slice(0, 120) });
    }
  };

  const openLibrary = async () => {
    setLibraryOpen(true);
    setLibSearch("");
    setLibPage(0);
    setLibSelected(new Set());
    setConfirmBatch(false);
    try {
      const res = await fetch("/api/scenes");
      const json = (await res.json()) as { scenes: SceneRow[] };
      setRows(json.scenes ?? []);
    } catch {
      setRows([]);
    }
  };

  const loadById = async (id: string) => {
    try {
      const res = await fetch(`/api/scenes/${id}`);
      const json = (await res.json()) as { scene: { title: string; durationMs: number; data: string } };
      const data = JSON.parse(json.scene.data) as SceneData;
      loadScene(data, id);
      setLibraryOpen(false);
      toast.success(`已载入「${json.scene.title}」`);
    } catch (e) {
      toast.error("载入失败", { description: String(e).slice(0, 120) });
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scene.title || "scene"}.keyforge.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportFramePng = () => {
    const png = renderSceneFramePng(scene, useStudio.getState().timeMs);
    if (!png) {
      toast.error("导出失败：无法渲染当前帧");
      return;
    }
    const a = document.createElement("a");
    a.href = png;
    a.download = `${scene.title || "scene"}-${(useStudio.getState().timeMs / 1000).toFixed(2)}s.png`;
    a.click();
    toast.success("已导出当前帧 PNG（960×540）");
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as SceneData;
        if (!data.elements) throw new Error("缺少 elements 字段");
        loadScene(data, null);
        toast.success("导入成功", { description: data.title });
      } catch (e) {
        toast.error("导入失败：无效的场景文件", { description: String(e).slice(0, 100) });
      }
    };
    reader.readAsText(file);
  };

  const openRemotionCode = () => {
    setCode(sceneToRemotionCode(scene));
    setCodeOpen(true);
  };

  // ---------------------------------------------------------------------------
  // library search / sort / pagination + batch operations
  // ---------------------------------------------------------------------------
  const filteredRows = rows
    .filter((r) => r.title.toLowerCase().includes(libSearch.trim().toLowerCase()))
    .sort((a, b) => {
      // starred scenes always float to the top, then by the chosen key
      if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
      switch (libSort) {
        case "createdAt":
          return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
        case "title":
          return a.title.localeCompare(b.title, "zh-CN");
        case "duration":
          return b.durationMs - a.durationMs;
        default:
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
    });
  const libTotalPages = Math.max(1, Math.ceil(filteredRows.length / LIB_PAGE_SIZE));
  const libSafePage = Math.min(libPage, libTotalPages - 1);
  const pagedRows = filteredRows.slice(libSafePage * LIB_PAGE_SIZE, (libSafePage + 1) * LIB_PAGE_SIZE);

  const toggleStar = async (row: SceneRow) => {
    const next = !row.starred;
    // optimistic update — PATCH is a lightweight metadata write
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, starred: next } : r)));
    try {
      const res = await fetch(`/api/scenes/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(next ? "已收藏，置顶显示" : "已取消收藏", { description: `「${row.title}」` });
    } catch {
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, starred: !next } : r)));
      toast.error("收藏状态更新失败");
    }
  };

  const toggleLibSelect = (id: string) => {
    setLibSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBatch(false);
  };

  // v10: inline rename — PATCH the title (lightweight metadata write, no data)
  const commitRename = async (row: SceneRow) => {
    const cur = renaming;
    if (!cur || cur.id !== row.id) return;
    const title = cur.value.trim().slice(0, 120);
    setRenaming(null);
    if (!title || title === row.title) return;
    const prevTitle = row.title;
    // optimistic update + live-sync the loaded scene's title
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, title } : r)));
    if (useStudio.getState().sceneId === row.id) {
      useStudio.getState().setTitle(title);
    }
    try {
      const res = await fetch(`/api/scenes/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success("已重命名", { description: `「${prevTitle}」→「${title}」` });
    } catch {
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, title: prevTitle } : r)));
      if (useStudio.getState().sceneId === row.id) {
        useStudio.getState().setTitle(prevTitle);
      }
      toast.error("重命名失败");
    }
  };

  const batchDeleteScenes = async () => {
    // two-click confirm: arm first, execute on the second press within 3s
    if (!confirmBatch) {
      setConfirmBatch(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmBatch(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    const ids = [...libSelected];
    let ok = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`/api/scenes/${id}`, { method: "DELETE" });
        if (res.ok) ok++;
      } catch {
        /* counted as failure below */
      }
    }
    setRows((rs) => rs.filter((r) => !libSelected.has(r.id)));
    const currentGone = libSelected.has(useStudio.getState().sceneId ?? "");
    if (currentGone) useStudio.setState({ sceneId: null });
    setLibSelected(new Set());
    setConfirmBatch(false);
    toast.success(`已删除 ${ok} 个场景`, {
      description: ok < ids.length ? `${ids.length - ok} 个删除失败，已保留` : undefined,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
      {/* playback */}
      <Button
        size="icon"
        onClick={togglePlay}
        className="h-9 w-9 bg-amber-500 text-black hover:bg-amber-400"
        aria-label={playing ? "暂停" : "播放"}
        data-testid="play-btn"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <Button
        size="icon"
        variant="outline"
        className="h-9 w-9 border-zinc-800 bg-zinc-950"
        onClick={() => engineHost.seek(0)}
        aria-label="回到起点"
      >
        <Square className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant={loop ? "default" : "outline"}
        onClick={() => {
          const v = !loop;
          setLoop(v);
          engineHost.setLoop(v);
        }}
        className={`h-9 w-9 ${loop ? "bg-amber-500/90 text-black hover:bg-amber-400" : "border-zinc-800 bg-zinc-950"}`}
        aria-label="循环"
      >
        <Repeat className="h-4 w-4" />
      </Button>

      <div className="ml-1 flex items-center gap-1.5 font-mono text-xs text-zinc-400" data-testid="time-readout">
        {(timeMs / 1000).toFixed(2)}s
        {playRate !== 1 && (
          <button
            onClick={() => {
              useStudio.getState().setPlayRate(1);
              engineHost.setRate(1);
            }}
            className={cnPlayRateChip(playRate)}
            title="播放速率（点击复位 1x）· J/K/L 变速"
            data-testid="rate-chip"
          >
            {playRate < 0 ? `−${Math.abs(playRate)}×` : `${playRate}×`}
          </button>
        )}
      </div>

      <Separator orientation="vertical" className="mx-1 h-8 bg-zinc-800" />

      {/* undo / redo */}
      <Button
        size="icon"
        variant="outline"
        disabled={!canUndo}
        onClick={undo}
        className="h-9 w-9 border-zinc-800 bg-zinc-950"
        title="撤销（Ctrl+Z）"
        aria-label="撤销"
        data-testid="undo-btn"
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="outline"
        disabled={!canRedo}
        onClick={redo}
        className="h-9 w-9 border-zinc-800 bg-zinc-950"
        title="重做（Ctrl+Shift+Z / Ctrl+Y）"
        aria-label="重做"
        data-testid="redo-btn"
      >
        <Redo2 className="h-4 w-4" />
      </Button>

      {/* visual history panel */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="outline"
            disabled={!canUndo && !canRedo}
            className="h-9 w-9 border-zinc-800 bg-zinc-950"
            title="历史记录面板"
            aria-label="历史记录"
            data-testid="history-btn"
          >
            <History className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 border-zinc-800 bg-zinc-950 p-0" data-testid="history-panel">
          <div className="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300">
            历史记录
            <span className="ml-1.5 font-mono text-[10px] text-zinc-500">{historyPast.length} 步</span>
            {historyFuture.length > 0 && (
              <span className="ml-1 font-mono text-[10px] text-amber-500/80">可重做 {historyFuture.length}</span>
            )}
          </div>
          <ScrollArea className="max-h-72">
            <div className="p-1">
              {/* current state marker */}
              <div className="flex items-center gap-2 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300" data-testid="history-current">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)]" />
                当前状态
              </div>
              {historyPast.length === 0 && (
                <p className="px-2 py-3 text-center text-[11px] text-zinc-600">暂无历史 — 每次编辑都会记录在这里</p>
              )}
              {[...historyPast].reverse().map((h, revIdx) => {
                const idx = historyPast.length - 1 - revIdx;
                const rel = relativeTime(h.at);
                return (
                  <button
                    key={h.id}
                    onClick={() => useStudio.getState().jumpToHistory(idx)}
                    className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
                    title={`点击回到此状态（撤销 ${revIdx + 1} 步）`}
                    data-testid={`history-entry-${idx}`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700 group-hover:bg-zinc-500" />
                    <span className="min-w-0 flex-1 truncate">{h.label}</span>
                    <span className="shrink-0 font-mono text-[9px] text-zinc-600">{rel}</span>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
          <div className="border-t border-zinc-800 px-3 py-1.5 text-[9px] text-zinc-600">
            点击条目回溯到该状态 · 之后的操作将截断重做栈
          </div>
        </PopoverContent>
      </Popover>

      <Separator orientation="vertical" className="mx-1 h-8 bg-zinc-800" />

      {/* add elements */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-9 border-zinc-800 bg-zinc-950 text-xs" data-testid="add-element">
            <Plus className="mr-1 h-3.5 w-3.5" /> 添加元素
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => addElement("box")}>
            <SquareIcon className="mr-2 h-4 w-4" /> 方块
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => addElement("circle")}>
            <Circle className="mr-2 h-4 w-4" /> 圆形
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => addElement("text")}>
            <Type className="mr-2 h-4 w-4" /> 文字
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setStaggerOpen(true)} data-testid="add-stagger">
            <Wand2 className="mr-2 h-4 w-4" /> 逐字标语生成器
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="mx-1 h-8 bg-zinc-800" />

      {/* scene meta */}
      <Input
        className="h-9 w-40 bg-zinc-950 text-xs"
        value={scene.title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="场景标题"
        data-testid="scene-title-input"
      />
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          className="h-9 w-20 bg-zinc-950 text-xs"
          value={scene.durationMs}
          onChange={(e) => setDuration(Number(e.target.value) || 4000)}
          aria-label="时长 ms"
        />
        <span className="text-[10px] text-zinc-500">ms</span>
      </div>

      <Separator orientation="vertical" className="mx-1 h-8 bg-zinc-800" />

      {/* persistence */}
      <AutosaveChip />
      <Button variant="outline" className="h-9 border-zinc-800 bg-zinc-950 text-xs" onClick={save} data-testid="save-btn">
        <Save className="mr-1 h-3.5 w-3.5" /> 保存
      </Button>
      <Button variant="outline" className="h-9 border-zinc-800 bg-zinc-950 text-xs" onClick={openLibrary} data-testid="library-btn">
        <FolderOpen className="mr-1 h-3.5 w-3.5" /> 载入
      </Button>
      <Button variant="outline" className="h-9 border-zinc-800 bg-zinc-950 text-xs" onClick={() => { loadDemo(); toast.success("已重置为演示场景"); }}>
        演示
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-9 border-zinc-800 bg-zinc-950 text-xs">
            <Download className="mr-1 h-3.5 w-3.5" /> 导出
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={exportJson}>
            <FileJson className="mr-2 h-4 w-4" /> 场景 JSON
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportFramePng} data-testid="export-png">
            <ImageDown className="mr-2 h-4 w-4" /> 当前帧 PNG（960×540）
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setExportOpen(true)}
            data-testid="export-webm"
          >
            <Film className="mr-2 h-4 w-4" /> 导出中心（WebM / GIF / PNG 序列）
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openRemotionCode}>
            <ClipboardCopy className="mr-2 h-4 w-4" /> Remotion 兼容代码
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="outline"
        className="h-9 border-zinc-800 bg-zinc-950 text-xs"
        onClick={() => fileRef.current?.click()}
      >
        <Upload className="mr-1 h-3.5 w-3.5" /> 导入
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importJson(f);
          e.target.value = "";
        }}
      />

      {/* library dialog — search + multi-select batch delete */}
      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-lg" data-testid="library-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>场景库</span>
              <span className="font-mono text-[10px] font-normal text-zinc-500">
                {rows.length} 个场景{libSelected.size > 0 ? ` · 已选 ${libSelected.size}` : ""}
              </span>
            </DialogTitle>
            <DialogDescription>从数据库载入已保存的场景，或批量管理它们</DialogDescription>
          </DialogHeader>

          {/* search + sort + select controls */}
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <Input
                className="h-8 bg-zinc-950 pl-7 text-xs"
                placeholder="按标题搜索…"
                value={libSearch}
                onChange={(e) => {
                  setLibSearch(e.target.value);
                  setLibPage(0);
                }}
                data-testid="library-search"
              />
            </div>
            <Select
              value={libSort}
              onValueChange={(v) => {
                setLibSort(v as LibSort);
                setLibPage(0);
              }}
            >
              <SelectTrigger className="h-8 w-28 shrink-0 bg-zinc-950 text-[11px]" aria-label="排序方式" data-testid="library-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIB_SORTS.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-[11px]">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {libSelected.size > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 px-2 text-[11px] text-zinc-400 hover:text-zinc-200"
                onClick={() => setLibSelected(new Set())}
              >
                <X className="mr-1 h-3 w-3" /> 取消选择
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={filteredRows.length === 0}
                className="h-8 shrink-0 px-2 text-[11px] text-zinc-400 hover:text-zinc-200"
                onClick={() => setLibSelected(new Set(filteredRows.map((r) => r.id)))}
                data-testid="library-select-all"
              >
                <ListChecks className="mr-1 h-3 w-3" /> 全选
              </Button>
            )}
          </div>

          {libSelected.size > 0 && (
            <div className="flex animate-kf-bar-in items-center justify-between rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5" data-testid="library-batch-bar">
              <span className="text-[11px] text-red-300">将删除 {libSelected.size} 个场景，不可恢复</span>
              <Button
                size="sm"
                className={`h-7 px-2.5 text-[11px] ${confirmBatch ? "bg-red-500 text-white hover:bg-red-400" : "bg-zinc-800 text-red-300 hover:bg-red-500/20"}`}
                onClick={batchDeleteScenes}
                data-testid="library-batch-delete"
              >
                <Trash2 className="mr-1 h-3 w-3" />
                {confirmBatch ? "确认删除" : "批量删除"}
              </Button>
            </div>
          )}

          <ScrollArea className="max-h-96 pr-2">
            {rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">暂无已保存场景，点击工具栏「保存」创建</p>
            ) : filteredRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">没有匹配「{libSearch.trim()}」的场景</p>
            ) : (
              <div className="grid grid-cols-2 gap-2" data-testid="scene-grid">
                {pagedRows.map((r) => {
                  const checked = libSelected.has(r.id);
                  return (
                    <div
                      key={r.id}
                      className={`group relative overflow-hidden rounded-md border bg-zinc-900 transition-colors ${
                        checked ? "border-amber-500/80 shadow-[0_0_10px_rgba(251,191,36,0.15)]" : "border-zinc-800 hover:border-amber-500/50"
                      }`}
                      data-testid="scene-card"
                      data-scene-title={r.title}
                    >
                      {/* selection checkbox */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLibSelect(r.id);
                        }}
                        aria-label={checked ? `取消选择 ${r.title}` : `选择 ${r.title}`}
                        aria-pressed={checked}
                        className={`absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded border backdrop-blur transition-all ${
                          checked
                            ? "border-amber-400 bg-amber-500 text-black"
                            : "border-white/30 bg-black/50 text-transparent opacity-0 hover:border-amber-300 hover:opacity-100 group-hover:opacity-100"
                        }`}
                        data-testid="scene-check"
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={3.5}>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </button>
                      {/* star toggle (top-right): amber when starred, on hover otherwise */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleStar(r);
                        }}
                        aria-label={r.starred ? `取消收藏 ${r.title}` : `收藏 ${r.title}`}
                        aria-pressed={!!r.starred}
                        className={`absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded border backdrop-blur transition-all ${
                          r.starred
                            ? "border-amber-400/80 bg-black/60 text-amber-400"
                            : "border-white/25 bg-black/50 text-zinc-400 opacity-0 hover:text-amber-300 group-hover:opacity-100"
                        }`}
                        title={r.starred ? "取消收藏" : "收藏（置顶显示）"}
                        data-testid="scene-star"
                        data-starred={r.starred ? "1" : "0"}
                      >
                        <Star className="h-3 w-3" fill={r.starred ? "currentColor" : "none"} />
                      </button>
                      <button onClick={() => loadById(r.id)} className="block w-full text-left" title="点击载入场景">
                        <div className="relative aspect-video w-full overflow-hidden bg-zinc-950">
                          {r.thumb ? (
                            <img
                              src={r.thumb}
                              alt={`场景「${r.title}」缩略图`}
                              className={`h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04] ${checked ? "opacity-60" : ""}`}
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center font-mono text-[9px] uppercase tracking-widest text-zinc-700">
                              no snapshot
                            </div>
                          )}
                          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-[9px] text-zinc-300">
                            {(r.durationMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                      </button>
                      {/* v10: title row lives OUTSIDE the load button so inline rename
                          is valid HTML and dblclick doesn't trigger a scene load */}
                      <div className="px-2 py-1.5">
                        {renaming?.id === r.id ? (
                          <Input
                            autoFocus
                            className="h-6 bg-zinc-950 text-xs"
                            value={renaming.value}
                            maxLength={120}
                            aria-label="重命名场景"
                            data-testid="scene-rename-input"
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenaming({ id: r.id, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRename(r);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenaming(null);
                              }
                            }}
                            onBlur={() => void commitRename(r)}
                          />
                        ) : (
                          <div
                            className="truncate text-xs font-medium text-zinc-200"
                            onDoubleClick={() => setRenaming({ id: r.id, value: r.title })}
                            title={r.title + "\n双击重命名"}
                            data-testid="scene-title"
                          >
                            {r.title}
                          </div>
                        )}
                        {/* v11: structure stats — parsed server-side, zero payload cost */}
                        <div className="mt-0.5 flex items-center gap-2 font-mono text-[9px] text-zinc-500" data-testid="scene-stats">
                          <span className="flex items-center gap-0.5" title="元素数">
                            <Layers className="h-2.5 w-2.5 text-zinc-600" />
                            {r.elCount ?? "—"}
                          </span>
                          <span className="flex items-center gap-0.5" title="关键帧数">
                            <Diamond className="h-2.5 w-2.5 text-amber-500/70" />
                            {r.kfCount ?? "—"}
                          </span>
                          <span className="text-zinc-600">{(r.durationMs / 1000).toFixed(1)}s</span>
                        </div>
                        <div className="text-[9px] text-zinc-600">
                          {new Date(r.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                      <div className="flex justify-end gap-0.5 px-1.5 pb-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-zinc-600 opacity-0 transition-opacity hover:text-amber-300 group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenaming({ id: r.id, value: r.title });
                          }}
                          aria-label={`重命名场景 ${r.title}`}
                          title="重命名（双击标题也可）"
                          data-testid="scene-rename"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-zinc-600 opacity-0 transition-opacity hover:text-amber-300 group-hover:opacity-100"
                          onClick={() => void duplicateScene(r)}
                          aria-label={`复制场景 ${r.title}`}
                          title="复制场景（含缩略图）为新场景"
                          data-testid="scene-copy"
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-zinc-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                          onClick={async () => {
                            try {
                              await fetch(`/api/scenes/${r.id}`, { method: "DELETE" });
                              setRows((rs) => rs.filter((x) => x.id !== r.id));
                              setLibSelected((prev) => {
                                const next = new Set(prev);
                                next.delete(r.id);
                                return next;
                              });
                              if (useStudio.getState().sceneId === r.id) {
                                useStudio.setState({ sceneId: null });
                              }
                              toast.success("已删除场景", { description: r.title });
                            } catch {
                              toast.error("删除失败");
                            }
                          }}
                          aria-label={`删除场景 ${r.title}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          {/* pagination footer */}
          {libTotalPages > 1 && (
            <div className="flex items-center justify-between border-t border-zinc-800 pt-2" data-testid="library-pagination">
              <span className="font-mono text-[10px] text-zinc-500">
                第 {libSafePage + 1} / {libTotalPages} 页 · 共 {filteredRows.length} 个
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 border-zinc-800 bg-zinc-950 px-2 text-[11px]"
                  disabled={libSafePage === 0}
                  onClick={() => setLibPage((p) => Math.max(0, p - 1))}
                  aria-label="上一页"
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 border-zinc-800 bg-zinc-950 px-2 text-[11px]"
                  disabled={libSafePage >= libTotalPages - 1}
                  onClick={() => setLibPage((p) => Math.min(libTotalPages - 1, p + 1))}
                  aria-label="下一页"
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* remotion code dialog */}
      <Dialog open={codeOpen} onOpenChange={setCodeOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Remotion 兼容代码</DialogTitle>
            <DialogDescription>
              基于 @keyframe/core 的 Remotion 兼容层（spring / interpolate / Sequence）生成
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-96 rounded-md border border-zinc-800 bg-black/60">
            <pre className="p-4 font-mono text-[11px] leading-relaxed text-emerald-300" data-testid="remotion-code">
              {code}
            </pre>
          </ScrollArea>
          <DialogFooter>
            <Button
              className="bg-amber-500 text-black hover:bg-amber-400"
              onClick={async () => {
                await navigator.clipboard.writeText(code);
                toast.success("代码已复制到剪贴板");
              }}
            >
              <ClipboardCopy className="mr-1 h-4 w-4" /> 复制代码
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* unified export center: WebM / GIF / PNG sequence */}
      <ExportCenter open={exportOpen} onOpenChange={setExportOpen} />

      {/* per-character title generator */}
      <TextStaggerDialog open={staggerOpen} onOpenChange={setStaggerOpen} />
    </div>
  );
}
