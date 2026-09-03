"use client";

/**
 * Studio store — zustand state for KeyForge Motion Studio.
 * All scene mutations bump `engineVersion` so the workspace recompiles the engine.
 *
 * v4 additions:
 *  - Multi-keyframe selection (`kfSelection`, keys are `${elId}|${t}`) with bulk
 *    delete / bulk easing / align-to-playhead batch operations.
 *  - Keyframe clipboard (copy / cut / paste at playhead, preserving spacing).
 *  - Labeled undo history with a visual jump-to-point panel.
 *  - Playhead rate (JKL shuttle: negative = reverse).
 */

import { create } from "zustand";
import {
  type SceneData,
  type SceneElement,
  type ShapeKind,
  type Kf,
  PALETTE,
  PRESETS,
  makeDemoScene,
  nextElId,
} from "@/lib/scene";
import type { Easing as EasingName } from "@/lib/keyframe/builder/types";
import { Easing } from "@/lib/keyframe/builder/types";

export interface Selection {
  elId: string;
  kfT: number | null;
}

/** composite key for multi-select — `elId|t` */
export type KfKey = string;
export const kfKey = (elId: string, t: number): KfKey => `${elId}|${t}`;
export const parseKfKey = (k: KfKey): { elId: string; t: number } => {
  const i = k.indexOf("|");
  return { elId: k.slice(0, i), t: Number(k.slice(i + 1)) };
};

/** clipboard payload — grouped per source element, absolute times preserved */
export interface KfClipboardGroup {
  elId: string;
  kfs: Kf[];
}

export interface HistEntry {
  id: number;
  label: string;
  at: number;
  scene: SceneData;
}

const STAGE = { w: 960, h: 540 };

function cloneScene(s: SceneData): SceneData {
  return JSON.parse(JSON.stringify(s)) as SceneData;
}

/** default bounce control points seeded when bulk-applying CubicBezier */
const DEFAULT_CUBIC = { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1 };

/** onion-skin overlay settings (persisted to localStorage) */
interface OnionSettings {
  enabled: boolean;
  before: number;
  after: number;
  gap: number;
}

/** config for the per-character title generator (TextStaggerDialog) */
export interface TextStaggerConfig {
  text: string;
  fontSize: number;
  color: string;
  /** delay between consecutive characters (ms) */
  staggerMs: number;
  /** entrance recipe mirrored by the CSS preview */
  preset: "fadeUp" | "popSpin" | "dropBounce";
  /** vertical baseline center (logical stage px) */
  centerY: number;
}

/** char width heuristics (em fractions) — CJK/fullwidth vs latin */
function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2e80 ? 1.04 : 0.62;
}

/** per-character entrance keyframes, offset by delay — mirrors the CSS preview */
function buildStaggerKeyframes(delay: number, preset: TextStaggerConfig["preset"]): Kf[] {
  switch (preset) {
    case "popSpin":
      return [
        { t: delay, dx: 0, dy: 0, scale: 0, rot: -120, opacity: 0, easing: Easing.CubicBezier, cubic: { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1 } },
        { t: delay + 520, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: Easing.Linear },
      ];
    case "dropBounce":
      return [
        { t: delay, dx: 0, dy: -170, scale: 1.08, rot: 0, opacity: 0, easing: Easing.EaseOut },
        { t: delay + 380, dx: 0, dy: 0, scale: 0.98, rot: 0, opacity: 1, easing: Easing.EaseInOut },
        { t: delay + 520, dx: 0, dy: -7, scale: 1.02, rot: 0, opacity: 1, easing: Easing.EaseOut },
        { t: delay + 660, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: Easing.Linear },
      ];
    default: // fadeUp
      return [
        { t: delay, dx: 0, dy: 30, scale: 0.92, rot: 0, opacity: 0, easing: Easing.EaseOut },
        { t: delay + 480, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, easing: Easing.Linear },
      ];
  }
}

interface StudioState {
  scene: SceneData;
  sceneId: string | null;
  selection: Selection | null;
  /** multi-selected keyframes (composite keys) */
  kfSelection: KfKey[];
  playing: boolean;
  loop: boolean;
  timeMs: number;
  engineVersion: number;
  /** JKL shuttle rate: 1 = normal, 2/4/8 = fast forward, -1/-2/-4 = reverse */
  playRate: number;
  /** onion-skin overlay settings (OnionSkin component) */
  onion: OnionSettings;
  /** motion-path overlay for the selected element (MotionPathLayer) */
  showPaths: boolean;
  /** speed-graph row under the timeline (persisted to localStorage) */
  speedGraph: boolean;
  toggleSpeedGraph: () => void;
  /** last localStorage autosave timestamp (0 = never) — drives the Toolbar status chip */
  lastAutosaveAt: number;

  // undo/redo history
  historyPast: HistEntry[];
  historyFuture: HistEntry[];
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** push a labeled history snapshot; coalesces repeated pushes with the same key within 600ms */
  pushHistory: (key: string, label: string) => void;
  /** jump back to a specific history point (index into historyPast) */
  jumpToHistory: (idx: number) => void;

  // keyframe clipboard
  kfClipboard: KfClipboardGroup[] | null;
  copySelectedKfs: () => number;
  cutSelectedKfs: () => number;
  pasteKfs: () => number;

  // bulk keyframe operations
  setKfSelection: (keys: KfKey[]) => void;
  toggleKfSelection: (key: KfKey) => void;
  clearKfSelection: () => void;
  removeKeyframesBulk: (keys: KfKey[]) => void;
  patchKeyframesBulk: (keys: KfKey[], patch: Partial<Kf>) => void;
  /** move each selected group so its earliest keyframe lands on the playhead */
  alignKeyframesToPlayhead: (keys: KfKey[]) => void;

  // scene-level
  loadDemo: () => void;
  loadScene: (scene: SceneData, id: string | null) => void;
  setTitle: (t: string) => void;
  setDuration: (ms: number) => void;

  // elements
  addElement: (shape: ShapeKind) => void;
  /** per-character title generator: one text element per char with staggered entrance */
  addTextStagger: (cfg: TextStaggerConfig) => number;
  duplicateElement: (elId: string) => void;
  moveElement: (elId: string, dir: -1 | 1) => void;
  /** drag-sort: move an element to a target index in the elements array (= z-order) */
  reorderElement: (elId: string, toIndex: number) => void;
  patchElement: (elId: string, patch: Partial<SceneElement>, opts?: { history?: boolean }) => void;
  removeElement: (elId: string) => void;
  toggleHidden: (elId: string) => void;
  toggleLocked: (elId: string) => void;

  // selection
  select: (sel: Selection | null, opts?: { keepKfSelection?: boolean }) => void;

  // keyframes
  addKeyframe: (elId: string, kf: Kf) => void;
  updateKeyframe: (elId: string, t: number, patch: Partial<Kf>, opts?: { history?: boolean; key?: string }) => void;
  removeKeyframe: (elId: string, t: number) => void;
  applyPreset: (elId: string, presetId: string) => void;
  clearKeyframes: (elId: string) => void;
  /** atomic whole-track replacement (path bend baking, batch import) */
  replaceElementKeyframes: (elId: string, kfs: Kf[], opts?: { history?: boolean; label?: string }) => void;

  // playback mirrors
  setPlaying: (v: boolean) => void;
  setLoop: (v: boolean) => void;
  setTime: (t: number) => void;
  setPlayRate: (r: number) => void;
  setShowPaths: (v: boolean) => void;

  bump: () => void;
}

/**
 * Initial scene is EMPTY and deterministic so SSR and client markup match.
 * The demo scene is loaded client-side after mount (see StudioWorkspace).
 */
const initialScene: SceneData = {
  title: "未命名场景",
  durationMs: 4000,
  elements: [],
};

let histSeq = 0;
const COALESCE_MS = 600;
let lastPushKey = "";
let lastPushAt = 0;

/** group composite keys by element id → time set */
function groupKeys(keys: KfKey[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const k of keys) {
    const { elId, t } = parseKfKey(k);
    if (!map.has(elId)) map.set(elId, new Set());
    map.get(elId)!.add(t);
  }
  return map;
}

export const useStudio = create<StudioState>((set, get) => ({
  scene: initialScene,
  sceneId: null,
  selection: null,
  kfSelection: [],
  playing: false,
  loop: true,
  timeMs: 0,
  engineVersion: 0,
  playRate: 1,
  onion: { enabled: false, before: 1, after: 1, gap: 200 },
  showPaths: true,
  speedGraph: true,
  lastAutosaveAt: 0,

  historyPast: [],
  historyFuture: [],
  canUndo: false,
  canRedo: false,

  pushHistory: (key, label) => {
    const now = performance.now();
    // coalesce bursts of the same interaction (slider drags, element drags)
    if (key && key === lastPushKey && now - lastPushAt < COALESCE_MS) {
      lastPushAt = now;
      return;
    }
    lastPushKey = key;
    lastPushAt = now;
    const entry: HistEntry = {
      id: ++histSeq,
      label,
      at: Date.now(),
      scene: cloneScene(get().scene),
    };
    set((s) => ({
      historyPast: [...s.historyPast.slice(-49), entry],
      historyFuture: [],
      canUndo: true,
      canRedo: false,
    }));
  },

  jumpToHistory: (idx) => {
    const past = get().historyPast;
    if (idx < 0 || idx >= past.length) return;
    lastPushKey = "";
    const current: HistEntry = {
      id: ++histSeq,
      label: `跳转（回到「${past[idx].label}」之后）`,
      at: Date.now(),
      scene: get().scene,
    };
    const target = past[idx];
    const newPast = past.slice(0, idx);
    set((s) => ({
      historyPast: newPast,
      historyFuture: [current, ...s.historyFuture],
      scene: cloneScene(target.scene),
      selection: null,
      kfSelection: [],
      timeMs: Math.min(s.timeMs, target.scene.durationMs),
      engineVersion: s.engineVersion + 1,
      canUndo: newPast.length > 0,
      canRedo: true,
    }));
  },

  undo: () => {
    const past = get().historyPast;
    if (past.length === 0) return;
    lastPushKey = "";
    const current: HistEntry = {
      id: ++histSeq,
      label: "（撤销前的状态）",
      at: Date.now(),
      scene: get().scene,
    };
    const prev = past[past.length - 1];
    set((s) => ({
      historyPast: past.slice(0, -1),
      historyFuture: [current, ...s.historyFuture],
      scene: cloneScene(prev.scene),
      selection: null,
      kfSelection: [],
      timeMs: Math.min(s.timeMs, prev.scene.durationMs),
      engineVersion: s.engineVersion + 1,
      canUndo: past.length - 1 > 0,
      canRedo: true,
    }));
  },

  redo: () => {
    const future = get().historyFuture;
    if (future.length === 0) return;
    lastPushKey = "";
    const current: HistEntry = {
      id: ++histSeq,
      label: "（重做前的状态）",
      at: Date.now(),
      scene: get().scene,
    };
    const next = future[0];
    set((s) => ({
      historyPast: [...s.historyPast, current],
      historyFuture: future.slice(1),
      scene: cloneScene(next.scene),
      selection: null,
      kfSelection: [],
      timeMs: Math.min(s.timeMs, next.scene.durationMs),
      engineVersion: s.engineVersion + 1,
      canUndo: true,
      canRedo: future.length - 1 > 0,
    }));
  },

  // -------------------------------------------------------------------------
  // keyframe clipboard
  // -------------------------------------------------------------------------
  copySelectedKfs: () => {
    const st = get();
    const keys = st.kfSelection.length > 0
      ? st.kfSelection
      : st.selection?.kfT != null
        ? [kfKey(st.selection.elId, st.selection.kfT)]
        : [];
    if (keys.length === 0) return 0;
    const groups = groupKeys(keys);
    const clip: KfClipboardGroup[] = [];
    for (const [elId, ts] of groups) {
      const el = st.scene.elements.find((e) => e.id === elId);
      if (!el) continue;
      clip.push({ elId, kfs: el.keyframes.filter((k) => ts.has(k.t)).map((k) => ({ ...k })) });
    }
    if (clip.length === 0) return 0;
    set({ kfClipboard: clip });
    return clip.reduce((n, g) => n + g.kfs.length, 0);
  },

  cutSelectedKfs: () => {
    const st = get();
    const keys = st.kfSelection.length > 0
      ? st.kfSelection
      : st.selection?.kfT != null
        ? [kfKey(st.selection.elId, st.selection.kfT)]
        : [];
    const n = get().copySelectedKfs();
    if (n > 0) get().removeKeyframesBulk(keys);
    return n;
  },

  pasteKfs: () => {
    const st = get();
    const clip = st.kfClipboard;
    if (!clip || clip.length === 0) return 0;
    const dur = st.scene.durationMs;
    const atT = Math.round(st.timeMs);
    let total = 0;
    const elements = st.scene.elements.map((el) => {
      const group = clip.find((g) => g.elId === el.id);
      if (!group || group.kfs.length === 0) return el;
      const minT = Math.min(...group.kfs.map((k) => k.t));
      const delta = atT - minT;
      const incoming = group.kfs.map((k) => ({
        ...k,
        t: Math.max(0, Math.min(dur, Math.round(k.t + delta))),
      }));
      // replace any keyframes that collide with incoming times, then merge & sort
      const inTs = new Set(incoming.map((k) => k.t));
      const merged = [...el.keyframes.filter((k) => !inTs.has(k.t)), ...incoming].sort((a, b) => a.t - b.t);
      total += incoming.length;
      return { ...el, keyframes: merged };
    });
    if (total === 0) return 0;
    get().pushHistory("paste", `粘贴 ${total} 个关键帧 @ ${(atT / 1000).toFixed(2)}s`);
    set((s) => ({
      scene: { ...s.scene, elements },
      engineVersion: s.engineVersion + 1,
    }));
    return total;
  },

  // -------------------------------------------------------------------------
  // multi-select + bulk operations
  // -------------------------------------------------------------------------
  setKfSelection: (keys) => set({ kfSelection: keys }),

  toggleKfSelection: (key) =>
    set((s) => ({
      kfSelection: s.kfSelection.includes(key)
        ? s.kfSelection.filter((k) => k !== key)
        : [...s.kfSelection, key],
    })),

  clearKfSelection: () => set({ kfSelection: [] }),

  removeKeyframesBulk: (keys) => {
    const map = groupKeys(keys);
    if (map.size === 0) return;
    get().pushHistory("bulkRemove", `删除 ${keys.length} 个关键帧`);
    const sel = get().selection;
    set((s) => {
      const selRemoved = sel?.kfT != null && (map.get(sel.elId)?.has(sel.kfT) ?? false);
      return {
        scene: {
          ...s.scene,
          elements: s.scene.elements.map((e) => {
            const ts = map.get(e.id);
            if (!ts) return e;
            return { ...e, keyframes: e.keyframes.filter((k) => !ts.has(k.t)) };
          }),
        },
        selection: selRemoved ? { elId: sel!.elId, kfT: null } : s.selection,
        kfSelection: [],
        engineVersion: s.engineVersion + 1,
      };
    });
  },

  patchKeyframesBulk: (keys, patch) => {
    const map = groupKeys(keys);
    if (map.size === 0) return;
    get().pushHistory("bulkEasing", `批量修改 ${keys.length} 个关键帧缓动`);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => {
          const ts = map.get(e.id);
          if (!ts) return e;
          return {
            ...e,
            keyframes: e.keyframes.map((k) =>
              ts.has(k.t)
                ? {
                    ...k,
                    ...patch,
                    ...(patch.easing === Easing.CubicBezier && !k.cubic ? { cubic: { ...DEFAULT_CUBIC } } : {}),
                  }
                : k
            ),
          };
        }),
      },
      engineVersion: s.engineVersion + 1,
    }));
  },

  alignKeyframesToPlayhead: (keys) => {
    const st = get();
    const map = groupKeys(keys);
    if (map.size === 0) return;
    const dur = st.scene.durationMs;
    const atT = Math.round(st.timeMs);
    // compute per-element delta from the earliest selected keyframe
    const deltas = new Map<string, number>();
    for (const [elId, ts] of map) {
      const el = st.scene.elements.find((e) => e.id === elId);
      if (!el) continue;
      const minT = Math.min(...[...ts]);
      deltas.set(elId, atT - minT);
    }
    get().pushHistory("align", `对齐 ${keys.length} 个关键帧到播放头`);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => {
          const ts = map.get(e.id);
          const delta = deltas.get(e.id);
          if (!ts || !delta) return e;
          const clampT = (t: number) => Math.max(0, Math.min(dur, t));
          const still = e.keyframes.filter((k) => !ts.has(k.t));
          const stillTs = new Set(still.map((k) => k.t));
          // move with collision guards, then dedupe deterministically
          const moving = e.keyframes
            .filter((k) => ts.has(k.t))
            .map((k) => ({ ...k, t: clampT(k.t + delta) }))
            .filter((k) => !stillTs.has(k.t));
          const claimed = new Set<number>();
          const finalMoving: Kf[] = [];
          for (const k of moving) {
            if (claimed.has(k.t)) continue;
            claimed.add(k.t);
            finalMoving.push(k);
          }
          return { ...e, keyframes: [...still, ...finalMoving].sort((a, b) => a.t - b.t) };
        }),
      },
      kfSelection: [],
      engineVersion: s.engineVersion + 1,
    }));
  },

  // -------------------------------------------------------------------------
  // scene-level
  // -------------------------------------------------------------------------
  loadDemo: () => {
    get().pushHistory("loadDemo", "重置为演示场景");
    set({
      scene: makeDemoScene(STAGE),
      sceneId: null,
      selection: null,
      kfSelection: [],
      timeMs: 0,
      playRate: 1,
      engineVersion: get().engineVersion + 1,
    });
  },

  loadScene: (scene, id) => {
    get().pushHistory("loadScene", `载入场景「${scene.title}」`);
    set({
      scene: cloneScene(scene),
      sceneId: id,
      selection: null,
      kfSelection: [],
      timeMs: 0,
      playRate: 1,
      engineVersion: get().engineVersion + 1,
    });
  },

  setTitle: (t) => {
    get().pushHistory("title", "修改场景标题");
    set((s) => ({ scene: { ...s.scene, title: t }, engineVersion: s.engineVersion + 1 }));
  },

  setDuration: (ms) => {
    get().pushHistory("duration", `修改时长为 ${Math.round(ms)}ms`);
    const dur = Math.max(500, Math.min(20000, Math.round(ms)));
    set((s) => ({
      scene: { ...s.scene, durationMs: dur },
      timeMs: Math.min(s.timeMs, dur),
      engineVersion: s.engineVersion + 1,
    }));
  },

  // -------------------------------------------------------------------------
  // elements
  // -------------------------------------------------------------------------
  addElement: (shape) => {
    get().pushHistory("addElement", `添加${shape === "text" ? "文字" : shape === "box" ? "方块" : "圆形"}元素`);
    const count = get().scene.elements.length;
    const el: SceneElement = {
      id: nextElId(),
      name: shape === "text" ? `文字 ${count + 1}` : `${shape === "box" ? "方块" : "圆形"} ${count + 1}`,
      shape,
      color: PALETTE[count % PALETTE.length],
      size: shape === "text" ? 28 : 64,
      text: shape === "text" ? "文案" : undefined,
      x: 120 + Math.round(Math.random() * 500),
      y: 100 + Math.round(Math.random() * 260),
      keyframes: [],
    };
    set((s) => ({
      scene: { ...s.scene, elements: [...s.scene.elements, el] },
      selection: { elId: el.id, kfT: null },
      kfSelection: [],
      engineVersion: s.engineVersion + 1,
    }));
  },

  addTextStagger: (cfg) => {
    const chars = [...cfg.text].slice(0, 24);
    const visible = chars.filter((ch) => !/\s/.test(ch));
    if (visible.length === 0) return 0;
    get().pushHistory("textStagger", `生成逐字标语「${cfg.text.slice(0, 12)}」（${visible.length} 字）`);

    const totalW = chars.reduce((w, ch) => w + charEm(ch) * cfg.fontSize, 0);
    let x = Math.max(8, (STAGE.w - totalW) / 2);
    const els: SceneElement[] = [];
    let maxEnd = 0;

    chars.forEach((ch, i) => {
      const w = charEm(ch) * cfg.fontSize;
      if (!/\s/.test(ch)) {
        const delay = i * cfg.staggerMs;
        const kfs = buildStaggerKeyframes(delay, cfg.preset);
        maxEnd = Math.max(maxEnd, kfs[kfs.length - 1].t);
        els.push({
          id: nextElId(),
          name: `标语字 ${i + 1} · ${ch}`,
          shape: "text",
          color: cfg.color,
          size: cfg.fontSize,
          text: ch,
          x: Math.round(x),
          y: Math.round(cfg.centerY - cfg.fontSize * 0.85),
          keyframes: kfs,
        });
      }
      x += w;
    });

    // extend scene duration when the stagger needs more room (same history entry)
    const need = Math.min(20000, maxEnd + 500);
    set((s) => ({
      scene: {
        ...s.scene,
        durationMs: Math.max(s.scene.durationMs, Math.max(500, need)),
        elements: [...s.scene.elements, ...els],
      },
      selection: null,
      kfSelection: [],
      engineVersion: s.engineVersion + 1,
    }));
    return els.length;
  },

  duplicateElement: (elId) => {
    const src = get().scene.elements.find((e) => e.id === elId);
    if (!src) return;
    get().pushHistory("duplicate", `复制元素「${src.name}」`);
    const copy: SceneElement = {
      ...cloneScene({ ...get().scene, elements: [src] }).elements[0],
      id: nextElId(),
      name: `${src.name} 副本`,
      x: src.x + 24,
      y: src.y + 24,
    };
    set((s) => ({
      scene: { ...s.scene, elements: [...s.scene.elements, copy] },
      selection: { elId: copy.id, kfT: null },
      kfSelection: [],
      engineVersion: s.engineVersion + 1,
    }));
  },

  moveElement: (elId, dir) => {
    const els = [...get().scene.elements];
    const i = els.findIndex((e) => e.id === elId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= els.length) return;
    get().pushHistory("moveElement", `调整图层顺序（${dir > 0 ? "上移" : "下移"}）`);
    [els[i], els[j]] = [els[j], els[i]];
    set((s) => ({
      scene: { ...s.scene, elements: els },
      engineVersion: s.engineVersion + 1,
    }));
  },

  reorderElement: (elId, toIndex) => {
    const els = [...get().scene.elements];
    const from = els.findIndex((e) => e.id === elId);
    if (from < 0 || toIndex < 0 || toIndex >= els.length || from === toIndex) return;
    const el = els[from];
    get().pushHistory("reorder", `拖拽排序「${el.name}」→ 第 ${toIndex + 1} 层`);
    els.splice(from, 1);
    els.splice(toIndex, 0, el);
    set((s) => ({
      scene: { ...s.scene, elements: els },
      engineVersion: s.engineVersion + 1,
    }));
  },

  patchElement: (elId, patch, opts) => {
    if (opts?.history !== false) get().pushHistory("patch:" + elId, "修改元素属性");
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => (e.id === elId ? { ...e, ...patch } : e)),
      },
      engineVersion: s.engineVersion + 1,
    }));
  },

  removeElement: (elId) => {
    const el = get().scene.elements.find((e) => e.id === elId);
    get().pushHistory("removeElement", `删除元素「${el?.name ?? elId}」`);
    set((s) => ({
      scene: { ...s.scene, elements: s.scene.elements.filter((e) => e.id !== elId) },
      selection: s.selection?.elId === elId ? null : s.selection,
      kfSelection: s.kfSelection.filter((k) => !k.startsWith(elId + "|")),
      engineVersion: s.engineVersion + 1,
    }));
  },

  toggleHidden: (elId) => {
    get().pushHistory("toggleHidden", "切换元素可见性");
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => (e.id === elId ? { ...e, hidden: !e.hidden } : e)),
      },
      engineVersion: s.engineVersion + 1,
    }));
  },

  toggleLocked: (elId) => {
    get().pushHistory("toggleLocked", "切换元素锁定");
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => (e.id === elId ? { ...e, locked: !e.locked } : e)),
      },
      selection: s.selection?.elId === elId ? null : s.selection,
      engineVersion: s.engineVersion + 1,
    }));
  },

  select: (sel, opts) => {
    if (opts?.keepKfSelection) {
      set({ selection: sel });
      return;
    }
    set({
      selection: sel,
      kfSelection: sel?.kfT != null ? [kfKey(sel.elId, sel.kfT)] : [],
    });
  },

  // -------------------------------------------------------------------------
  // keyframes
  // -------------------------------------------------------------------------
  addKeyframe: (elId, kf) => {
    get().pushHistory("addKf:" + elId, `添加关键帧 @ ${(kf.t / 1000).toFixed(2)}s`);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) =>
          e.id === elId
            ? { ...e, keyframes: [...e.keyframes.filter((k) => k.t !== kf.t), kf].sort((a, b) => a.t - b.t) }
            : e
        ),
      },
      selection: { elId, kfT: kf.t },
      kfSelection: [kfKey(elId, kf.t)],
      engineVersion: s.engineVersion + 1,
    }));
  },

  updateKeyframe: (elId, t, patch, opts) => {
    if (opts?.history !== false) get().pushHistory(opts?.key ?? "kf:" + elId + ":" + t, "修改关键帧");
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) =>
          e.id === elId
            ? {
                ...e,
                keyframes: e.keyframes
                  .map((k) => (k.t === t ? { ...k, ...patch, t: patch.t ?? k.t } : k))
                  .sort((a, b) => a.t - b.t),
              }
            : e
        ),
      },
      engineVersion: s.engineVersion + 1,
    }));
  },

  removeKeyframe: (elId, t) => {
    get().pushHistory("removeKf", `删除关键帧 @ ${(t / 1000).toFixed(2)}s`);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) =>
          e.id === elId ? { ...e, keyframes: e.keyframes.filter((k) => k.t !== t) } : e
        ),
      },
      selection:
        s.selection?.elId === elId && s.selection.kfT === t
          ? { elId, kfT: null }
          : s.selection,
      kfSelection: s.kfSelection.filter((k) => k !== kfKey(elId, t)),
      engineVersion: s.engineVersion + 1,
    }));
  },

  applyPreset: (elId, presetId) => {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    get().pushHistory("preset", `应用预设「${preset.name}」`);
    const kfs = preset.build(STAGE);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => (e.id === elId ? { ...e, keyframes: kfs } : e)),
      },
      selection: { elId, kfT: null },
      kfSelection: [],
      engineVersion: s.engineVersion + 1,
    }));
  },

  clearKeyframes: (elId) => {
    const el = get().scene.elements.find((e) => e.id === elId);
    get().pushHistory("clearKf", `清空「${el?.name ?? elId}」关键帧`);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => (e.id === elId ? { ...e, keyframes: [] } : e)),
      },
      selection: s.selection ? { ...s.selection, kfT: null } : s.selection,
      kfSelection: s.kfSelection.filter((k) => !k.startsWith(elId + "|")),
      engineVersion: s.engineVersion + 1,
    }));
  },

  replaceElementKeyframes: (elId, kfs, opts) => {
    if (opts?.history !== false) {
      get().pushHistory("replaceKfs:" + elId, opts?.label ?? `重建「${elId}」关键帧轨道`);
    }
    const sorted = [...kfs].sort((a, b) => a.t - b.t);
    set((s) => ({
      scene: {
        ...s.scene,
        elements: s.scene.elements.map((e) => (e.id === elId ? { ...e, keyframes: sorted } : e)),
      },
      engineVersion: s.engineVersion + 1,
    }));
  },

  // -------------------------------------------------------------------------
  // playback mirrors
  // -------------------------------------------------------------------------
  setPlaying: (v) => set({ playing: v }),
  setLoop: (v) => set({ loop: v }),
  setTime: (t) => set({ timeMs: t }),
  setPlayRate: (r) => set({ playRate: r }),
  setShowPaths: (v) => set({ showPaths: v }),
  toggleSpeedGraph: () => {
    const next = !useStudio.getState().speedGraph;
    set({ speedGraph: next });
    try {
      localStorage.setItem("keyforge.speedgraph", next ? "1" : "0");
    } catch {
      /* ignore */
    }
  },

  bump: () => set((s) => ({ engineVersion: s.engineVersion + 1 })),
}));

/** Default easing for newly added keyframes. */
export const DEFAULT_EASING: EasingName = Easing.EaseInOut;
export { STAGE };
