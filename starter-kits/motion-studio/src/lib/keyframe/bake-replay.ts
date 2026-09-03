/**
 * BakedReplayPlayer — offline-bake → runtime-replay pipeline.
 *
 * One-time `engine.bakeChunk()` packs every frame of the animation into a
 * flat Uint8Array of 80-byte GpuInstanceData records (16 floats matrix +
 * opacity + visible + clipIndex + padding — the engine's GPU-aligned ABI).
 *
 * Playback then skips ALL per-frame math (no easing curves, no clip walking,
 * no slerp): each tick just indexes the frame slice out of the packed buffer
 * and copies 80 bytes per instance into a PRE-ALLOCATED pool of
 * `EvaluatedInstance` objects. Zero per-frame object allocation, zero GC
 * pressure, interface-compatible with `engine.getEvaluatedInstances(t)` —
 * so it can be passed straight into `domAdapter.batchApply(nodes, t,
 * { engine: player })` as a drop-in engine replacement.
 *
 * Same-frame semantics apply, mirroring the live engine: the pooled array
 * is reused across calls, so consumers must read it within the same tick.
 */

import type { EvaluatedInstance } from "./builder/types";

const BYTES_PER_INSTANCE = 80;
const FLOATS_PER_INSTANCE = 20;

export interface BakeStats {
  /** packed chunk size in bytes */
  bytes: number;
  /** number of frames actually contained in the chunk */
  frames: number;
  /** instances per frame */
  instances: number;
  /** ms between frames (1000 / fps) */
  frameMs: number;
}

export class BakedReplayPlayer {
  private readonly f32: Float32Array;
  private readonly u32: Uint32Array;
  private readonly pool: EvaluatedInstance[];
  private readonly frameCount: number;
  private readonly instances: number;
  private readonly frameMs: number;

  constructor(
    chunk: Uint8Array,
    instanceCount: number,
    fps: number,
    _durationMs: number
  ) {
    this.instances = Math.max(1, instanceCount);
    this.frameMs = 1000 / Math.max(1, fps);
    // the chunk is a flat run of frames × instances × 80B — trust the bytes
    const records = Math.floor(chunk.byteLength / BYTES_PER_INSTANCE);
    this.frameCount = Math.max(1, Math.floor(records / this.instances));

    // aligned views over the packed chunk (bakeChunk always returns aligned
    // memory, but guard anyway by copying when byteOffset is unaligned)
    let buf = chunk.buffer;
    let off = chunk.byteOffset;
    if (off % 4 !== 0) {
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      buf = copy.buffer;
      off = 0;
    }
    const totalFloats = this.frameCount * this.instances * FLOATS_PER_INSTANCE;
    this.f32 = new Float32Array(buf, off, totalFloats);
    this.u32 = new Uint32Array(buf, off, totalFloats);

    // pre-allocate the result pool once — the whole point of this pipeline
    this.pool = new Array(this.instances);
    for (let i = 0; i < this.instances; i++) {
      this.pool[i] = {
        id: undefined,
        clipId: undefined,
        transformMatrix: new Float32Array(16),
        opacity: 1,
        visible: true,
        clipIndex: 0,
      };
    }
  }

  get stats(): BakeStats {
    return {
      bytes: this.frameCount * this.instances * BYTES_PER_INSTANCE,
      frames: this.frameCount,
      instances: this.instances,
      frameMs: this.frameMs,
    };
  }

  /**
   * Interface-compatible with Engine.getEvaluatedInstances.
   * Returns the pooled array — consume within the same tick (zero-copy).
   */
  getEvaluatedInstances(globalTime: number): EvaluatedInstance[] {
    const fi = Math.min(
      this.frameCount - 1,
      Math.max(0, Math.floor(globalTime / this.frameMs))
    );
    const base = fi * this.instances * FLOATS_PER_INSTANCE;
    for (let i = 0; i < this.instances; i++) {
      const o = base + i * FLOATS_PER_INSTANCE;
      const inst = this.pool[i];
      // 64-byte matrix memcpy — the only per-instance cost of this pipeline
      inst.transformMatrix.set(this.f32.subarray(o, o + 16));
      inst.opacity = this.f32[o + 16];
      inst.visible = this.u32[o + 17] === 1;
      inst.clipIndex = this.u32[o + 18];
    }
    return this.pool;
  }
}
