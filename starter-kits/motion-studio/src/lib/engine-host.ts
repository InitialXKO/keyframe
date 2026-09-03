/**
 * EngineHost — singleton bridge between React UI and the vendored Keyframe Engine.
 *
 * Design notes (integration learnings):
 *  - The engine evaluates into a REUSED zero-copy Float32Array buffer; results
 *    must be consumed within the same frame. So all consumers (DOM binder,
 *    selection ring, capture-keyframe) read synchronously inside renderAt().
 *  - Per-frame UI (playhead, time label, selection ring) is updated via direct
 *    DOM writes through listeners — React state only at ~10Hz to avoid churn.
 *  - Playback uses the engine's own AnimationPlayer (audio-clock-master capable).
 */

import { Engine } from "@/lib/keyframe";
import { AnimationPlayer } from "@/lib/keyframe";
import { domAdapter } from "@/lib/keyframe";
import { buildEngineFromScene, type SceneData } from "@/lib/scene";

export interface DecomposedKf {
  t: number;
  dx: number;
  dy: number;
  scale: number;
  rot: number;
  opacity: number;
}

type FrameListener = (timeMs: number) => void;

class EngineHost {
  engine: Engine | null = null;
  scene: SceneData | null = null;
  player: AnimationPlayer | null = null;

  private order: string[] = [];
  private nodeMap = new Map<string, HTMLElement>();
  private listeners = new Set<FrameListener>();
  private loopOn = true;

  /** live perf telemetry (ms) */
  lastTime = 0;
  evalApplyMs = 0;
  compileMs = 0;
  compiledCount = 0;

  // -------------------------------------------------------------------------
  // registration
  // -------------------------------------------------------------------------
  registerNode(id: string, node: HTMLElement | null): void {
    if (node) this.nodeMap.set(id, node);
    else this.nodeMap.delete(id);
  }

  onFrame(cb: FrameListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // -------------------------------------------------------------------------
  // compilation
  // -------------------------------------------------------------------------
  compile(scene: SceneData): void {
    const t0 = performance.now();
    this.engine = buildEngineFromScene(scene);
    this.scene = scene;
    this.order = scene.elements.map((e) => e.id);
    this.compileMs = performance.now() - t0;
    this.compiledCount++;
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------
  renderAt(timeMs: number): void {
    if (!this.engine || !this.scene) return;

    const t0 = performance.now();
    const els: HTMLElement[] = [];
    for (const id of this.order) {
      const n = this.nodeMap.get(id);
      if (n) els.push(n);
    }
    // single evaluation inside the binder, applied to all bound DOM nodes
    domAdapter.batchApply(els, timeMs, { engine: this.engine });
    this.evalApplyMs = performance.now() - t0;
    this.lastTime = timeMs;

    for (const cb of this.listeners) cb(timeMs);
  }

  /** Read the evaluated matrix of one element from the LAST evaluation (zero-cost, same-frame only). */
  getLiveMatrix(elId: string): { m: Float32Array; opacity: number; visible: boolean } | null {
    if (!this.engine) return null;
    const inst = this.engine.getEvaluatedInstances(this.lastTime, true);
    const t = inst.find((i) => i.id === elId);
    if (!t) return null;
    return { m: t.transformMatrix, opacity: t.opacity, visible: t.visible };
  }

  /** Evaluate a single instant and decompose the matrix for keyframe capture. */
  captureKeyframe(elId: string, timeMs: number): DecomposedKf | null {
    if (!this.engine || !this.scene) return null;
    const el = this.scene.elements.find((e) => e.id === elId);
    if (!el) return null;

    const inst = this.engine.getEvaluatedInstances(timeMs);
    const target = inst.find((i) => i.id === elId);
    if (!target) return null;

    const m = target.transformMatrix;
    // column-major: m[0]=m11 m[1]=m12 m[4]=m21 m[5]=m22 m[12]=tx m[13]=ty
    const scale = Math.hypot(m[0], m[1]) || 0.0001;
    const rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    return {
      t: Math.round(timeMs),
      dx: Math.round(m[12] - el.x),
      dy: Math.round(m[13] - el.y),
      scale: Math.round(scale * 100) / 100,
      rot: Math.round(rot),
      opacity: Math.round(target.opacity * 100) / 100,
    };
  }

  // -------------------------------------------------------------------------
  // playback control (delegates to engine's AnimationPlayer)
  // -------------------------------------------------------------------------
  ensurePlayer(opts?: { loop?: boolean }): void {
    if (!this.engine || !this.scene) return;
    const duration = this.scene.durationMs;
    if (this.player && (this.player as unknown as { _durationMs: number }).durationMs === duration) return;

    const prevTime = this.player?.getCurrentTime() ?? 0;
    const wasPlaying = this.player?.getIsPlaying() ?? false;
    const prevRate = this.player?.timeScale ?? 1;
    this.player?.pause();

    this.player = new AnimationPlayer(this.engine, { fps: 60, duration });
    // stash duration for the check above
    (this.player as unknown as { _durationMs: number }).durationMs = duration;
    this.player.timeScale = prevRate;
    this.loopOn = opts?.loop ?? this.loopOn;
    this.player.loop(this.loopOn);
    // frame pump + reverse-play boundary guard (engine tick only clamps the
    // >= duration side; negative timeScale would run past 0 unbounded)
    this.player.on("frame", (t: number) => {
      const ts = this.player?.timeScale ?? 1;
      if (ts < 0 && t <= 0) {
        if (this.loopOn && this.scene) {
          this.player!.seek(this.scene.durationMs - 1);
        } else {
          this.player!.seek(0);
          this.player!.pause();
          this.player!.timeScale = 1;
        }
      }
      this.renderAt(t);
    });
    this.player.seek(Math.min(prevTime, duration));
    if (wasPlaying) this.player.play();
    else this.renderAt(this.player.getCurrentTime());
  }

  play(): void {
    this.player?.play();
  }

  pause(): void {
    this.player?.pause();
  }

  seek(t: number): void {
    this.player?.seek(Math.max(0, Math.min(t, this.scene?.durationMs ?? t)));
  }

  setLoop(enabled: boolean): void {
    this.loopOn = enabled;
    this.player?.loop(enabled);
  }

  /** JKL shuttle — set playback rate (negative = reverse) without touching play state */
  setRate(rate: number): void {
    if (!this.player) return;
    this.player.timeScale = rate;
  }

  get rate(): number {
    return this.player?.timeScale ?? 1;
  }
}

export const engineHost = new EngineHost();
