import { AnimationClipData, BlendMode, CubicBezierParams, Easing, EngineIR, EvaluatedInstance, InstanceData, KeyframeData, TimelineNodeData, TransformData } from "./types.js";
import { Clip } from "./clip.js";

export { EvaluatedInstance } from "./types.js";
import { Instance } from "./instance.js";

function solveCubicBezier(p1x: number, p1y: number, p2x: number, p2y: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  let u = t;
  for (let i = 0; i < 8; i++) {
    const oneMinusU = 1.0 - u;
    const x = 3.0 * oneMinusU * oneMinusU * u * p1x + 3.0 * oneMinusU * u * u * p2x + u * u * u;
    const dx = 3.0 * oneMinusU * oneMinusU * p1x + 6.0 * oneMinusU * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
    if (Math.abs(dx) < 1e-7) break;
    const err = x - t;
    u -= err / dx;
    u = Math.max(0, Math.min(1, u));
  }

  const oneMinusU = 1.0 - u;
  return 3.0 * oneMinusU * oneMinusU * u * p1y + 3.0 * oneMinusU * u * u * p2y + u * u * u;
}

function evaluateEasing(easing: Easing, cubicParams: CubicBezierParams | undefined, t: number): number {
  const clampedT = Math.max(0, Math.min(1, t));
  switch (easing) {
    case Easing.Linear:
      return clampedT;
    case Easing.Ease:
      return solveCubicBezier(0.25, 0.1, 0.25, 1.0, clampedT);
    case Easing.EaseIn:
      return solveCubicBezier(0.42, 0.0, 1.0, 1.0, clampedT);
    case Easing.EaseOut:
      return solveCubicBezier(0.0, 0.0, 0.58, 1.0, clampedT);
    case Easing.EaseInOut:
      return solveCubicBezier(0.42, 0.0, 0.58, 1.0, clampedT);
    case Easing.CubicBezier:
      if (cubicParams) {
        return solveCubicBezier(cubicParams.p1x, cubicParams.p1y, cubicParams.p2x, cubicParams.p2y, clampedT);
      }
      return clampedT;
    case Easing.Step:
      return clampedT >= 1.0 ? 1.0 : 0.0;
    default:
      return clampedT;
  }
}

function normalizeQuat(q: [number, number, number, number]): [number, number, number, number] {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-6) {
    return [0, 0, 0, 1];
  }
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function slerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number
): [number, number, number, number] {
  let q1 = normalizeQuat(a);
  let q2 = normalizeQuat(b);

  let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];

  if (dot < 0) {
    q2 = [-q2[0], -q2[1], -q2[2], -q2[3]];
    dot = -dot;
  }

  if (dot > 0.9995) {
    const res: [number, number, number, number] = [
      q1[0] + t * (q2[0] - q1[0]),
      q1[1] + t * (q2[1] - q1[1]),
      q1[2] + t * (q2[2] - q1[2]),
      q1[3] + t * (q2[3] - q1[3]),
    ];
    return normalizeQuat(res);
  }

  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);

  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  return [
    s0 * q1[0] + s1 * q2[0],
    s0 * q1[1] + s1 * q2[1],
    s0 * q1[2] + s1 * q2[2],
    s0 * q1[3] + s1 * q2[3],
  ];
}

function interpolateTransform(a: TransformData, b: TransformData, factor: number): TransformData {
  const translation: [number, number, number] = [
    a.translation[0] + (b.translation[0] - a.translation[0]) * factor,
    a.translation[1] + (b.translation[1] - a.translation[1]) * factor,
    a.translation[2] + (b.translation[2] - a.translation[2]) * factor,
  ];

  const scale: [number, number, number] = [
    a.scale[0] + (b.scale[0] - a.scale[0]) * factor,
    a.scale[1] + (b.scale[1] - a.scale[1]) * factor,
    a.scale[2] + (b.scale[2] - a.scale[2]) * factor,
  ];

  const origin: [number, number, number] = [
    a.origin[0] + (b.origin[0] - a.origin[0]) * factor,
    a.origin[1] + (b.origin[1] - a.origin[1]) * factor,
    a.origin[2] + (b.origin[2] - a.origin[2]) * factor,
  ];

  const rotation_quat = slerpQuat(a.rotation_quat, b.rotation_quat, factor);

  return { translation, rotation_quat, scale, origin };
}

function getDefaultTransform(): TransformData {
  return {
    translation: [0, 0, 0],
    rotation_quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    origin: [0, 0, 0],
  };
}

function transformToMatrix(t: TransformData): Float32Array {
  const tx = t.translation[0];
  const ty = t.translation[1];
  const tz = t.translation[2];

  const ox = t.origin[0];
  const oy = t.origin[1];
  const oz = t.origin[2];

  const [qx, qy, qz, qw] = normalizeQuat(t.rotation_quat);

  const sx = t.scale[0];
  const sy = t.scale[1];
  const sz = t.scale[2];

  // Rotation matrix from quaternion
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r02 = 2 * (qx * qz + qy * qw);

  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qx * qw);

  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);

  // Rotation * Scale
  const rs00 = r00 * sx;
  const rs01 = r01 * sy;
  const rs02 = r02 * sz;

  const rs10 = r10 * sx;
  const rs11 = r11 * sy;
  const rs12 = r12 * sz;

  const rs20 = r20 * sx;
  const rs21 = r21 * sy;
  const rs22 = r22 * sz;

  // Translation * Origin * R * S * Origin^(-1)
  // T_final = Translation + Origin - (R * S * Origin)
  const pos_x = tx + ox - (rs00 * ox + rs01 * oy + rs02 * oz);
  const pos_y = ty + oy - (rs10 * ox + rs11 * oy + rs12 * oz);
  const pos_z = tz + oz - (rs20 * ox + rs21 * oy + rs22 * oz);

  // Return column-major 4x4 matrix
  return new Float32Array([
    rs00, rs10, rs20, 0,
    rs01, rs11, rs21, 0,
    rs02, rs12, rs22, 0,
    pos_x, pos_y, pos_z, 1,
  ]);
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function evaluateClip(clip: AnimationClipData, localTime: number): { transform: TransformData; opacity: number } {
  if (!clip.keyframes || clip.keyframes.length === 0) {
    return { transform: getDefaultTransform(), opacity: 1.0 };
  }

  if (clip.keyframes.length === 1) {
    const kf = clip.keyframes[0];
    return { transform: kf.transform ?? getDefaultTransform(), opacity: kf.opacity ?? 1.0 };
  }

  // Sort keyframes by time
  const sortedKeyframes = [...clip.keyframes].sort((a, b) => a.time - b.time);

  const duration = clip.duration;
  let effectiveTime = 0;
  if (duration > 0) {
    const iterations = clip.iterations ?? 1;
    if (!isFinite(iterations)) {
      effectiveTime = localTime % duration;
      if (effectiveTime < 0) effectiveTime += duration;
    } else if (localTime >= duration * iterations) {
      effectiveTime = duration;
    } else {
      effectiveTime = localTime % duration;
      if (effectiveTime < 0) effectiveTime += duration;
    }
  }

  if (effectiveTime <= sortedKeyframes[0].time) {
    const kf = sortedKeyframes[0];
    return { transform: kf.transform ?? getDefaultTransform(), opacity: kf.opacity ?? 1.0 };
  }

  const lastIdx = sortedKeyframes.length - 1;
  if (effectiveTime >= sortedKeyframes[lastIdx].time) {
    const kf = sortedKeyframes[lastIdx];
    return { transform: kf.transform ?? getDefaultTransform(), opacity: kf.opacity ?? 1.0 };
  }

  for (let i = 0; i < lastIdx; i++) {
    const kfCurr = sortedKeyframes[i];
    const kfNext = sortedKeyframes[i + 1];
    if (effectiveTime >= kfCurr.time && effectiveTime <= kfNext.time) {
      const segDuration = kfNext.time - kfCurr.time;
      if (segDuration <= 0.0001) {
        return { transform: kfNext.transform ?? getDefaultTransform(), opacity: kfNext.opacity ?? 1.0 };
      }
      const linearT = (effectiveTime - kfCurr.time) / segDuration;
      const easedT = evaluateEasing(kfCurr.easing ?? Easing.Linear, kfCurr.cubic_params, linearT);

      const currTrans = kfCurr.transform ?? getDefaultTransform();
      const nextTrans = kfNext.transform ?? getDefaultTransform();
      const currOpacity = kfCurr.opacity ?? 1.0;
      const nextOpacity = kfNext.opacity ?? 1.0;

      const transform = interpolateTransform(currTrans, nextTrans, easedT);
      const opacity = currOpacity + (nextOpacity - currOpacity) * easedT;

      return { transform, opacity };
    }
  }

  const kf = sortedKeyframes[lastIdx];
  return { transform: kf.transform ?? getDefaultTransform(), opacity: kf.opacity ?? 1.0 };
}

function flattenTimeline(root: TimelineNodeData): Map<string, number> {
  const map = new Map<string, number>();

  function traverse(node: TimelineNodeData, parentTime: number) {
    const nodeStart = parentTime + node.start_time;
    if (node.instance_id) {
      map.set(node.instance_id, nodeStart);
    }
    let currentChildStart = nodeStart;
    if (node.children) {
      for (const child of node.children) {
        traverse(child, currentChildStart);
        if (!node.is_parallel) {
          currentChildStart += child.duration;
        }
      }
    }
  }

  traverse(root, 0);
  return map;
}

export class Engine {
  private clips: Map<string, AnimationClipData> = new Map();
  private instances: InstanceData[] = [];
  private rootTimeline?: TimelineNodeData;
  private wasmInstance: any = null;
  private devToolsEnabled = false;
  private notifyingDevTools = false;

  constructor(wasmInstance?: any) {
    this.wasmInstance = wasmInstance;
    this.autoBindWasmMemory();
  }

  public setWasmInstance(wasm: any): void {
    this.wasmInstance = wasm;
    this.autoBindWasmMemory();
  }

  public bindWasmMemory(memory: any): this {
    const mem = this.resolveMemory(memory);
    if (this.wasmInstance) {
      this.wasmInstance.memory = mem;
    }
    (globalThis as any).wasmMemory = mem;
    return this;
  }

  public setWasmMemory(memory: any): this {
    return this.bindWasmMemory(memory);
  }

  public static bindWasmMemory(memory: any): void {
    const mem = memory?.buffer ? memory : (memory?.memory || memory);
    (globalThis as any).wasmMemory = mem;
  }

  private resolveMemory(mem: any): any {
    if (!mem) return null;
    if (mem.buffer) return mem;
    if (mem.memory?.buffer) return mem.memory;
    if (mem.__wasm?.memory?.buffer) return mem.__wasm.memory;
    return null;
  }

  private autoBindWasmMemory(): void {
    if (!this.wasmInstance) return;

    if (!this.wasmInstance.memory) {
      const resolved =
        this.resolveMemory(this.wasmInstance) ||
        this.resolveMemory((globalThis as any).wasmMemory);

      if (resolved) {
        this.wasmInstance.memory = resolved;
      }
    }

    if (this.wasmInstance.memory && !(globalThis as any).wasmMemory) {
      (globalThis as any).wasmMemory = this.wasmInstance.memory;
    }
  }

  public enableDevTools(): void {
    this.devToolsEnabled = true;
    if (typeof window !== "undefined") {
      (window as any).__KEYFRAME_ENGINE_DEVTOOLS_ACTIVE__ = true;
    }
  }

  public isDevToolsEnabled(): boolean {
    return this.devToolsEnabled;
  }

  public addClip(clip: Clip | AnimationClipData): this {
    const data = clip instanceof Clip ? clip.build() : clip;
    this.clips.set(data.id, data);
    if (this.wasmInstance) {
      this.wasmInstance.add_clip_json(JSON.stringify(data));
    }
    return this;
  }

  public addInstances(instances: (Instance | InstanceData)[]): this {
    for (const inst of instances) {
      const data = inst instanceof Instance ? inst.build() : inst;
      this.instances.push(data);
      if (this.wasmInstance) {
        this.wasmInstance.add_instance_json(JSON.stringify(data));
      }
    }
    return this;
  }

  public setRootTimeline(node: TimelineNodeData): this {
    this.rootTimeline = node;
    if (this.wasmInstance) {
      this.wasmInstance.set_root_timeline_json(JSON.stringify(node));
    }
    return this;
  }

  public async prepare(): Promise<void> {
    if (this.wasmInstance) {
      this.wasmInstance.prepare();
    }
  }

  /**
   * Evaluates the engine animation state at `globalTime` (in milliseconds).
   *
   * Note: In WASM mode, this triggers WASM frame evaluation and returns low-level buffer metadata
   * `{ count, ptr, len }`. If structured instance data with transform matrices is needed,
   * call `getEvaluatedInstances(globalTime)` instead.
   */
  public evaluateFrame(globalTime: number): any {
    let result: any = { count: this.instances.length };
    if (this.wasmInstance) {
      const count = this.wasmInstance.evaluate_frame(globalTime);
      const ptr = this.wasmInstance.get_instance_buffer_ptr();
      const len = this.wasmInstance.get_instance_buffer_byte_length();
      result = { count, ptr, len };
    }

    if (this.devToolsEnabled && !this.notifyingDevTools) {
      this.notifyingDevTools = true;
      const evaluated = this.getEvaluatedInstances(globalTime, true);
      this.notifyDevTools(globalTime, evaluated);
      this.notifyingDevTools = false;
    }

    return result;
  }

  /**
   * Evaluates and returns the array of `EvaluatedInstance` objects at `globalTime` (in milliseconds).
   *
   * Each `EvaluatedInstance` includes `transformMatrix`, `opacity`, `visible`, and instance/clip identifiers.
   * @param globalTime The global time in milliseconds.
   * @param skipEvaluate If `true`, re-evaluation of the WASM frame is skipped (if evaluateFrame was already called).
   */
  public getEvaluatedInstances(globalTime: number, skipEvaluate = false): EvaluatedInstance[] {
    const evalResult = skipEvaluate ? { count: this.instances.length } : this.evaluateFrame(globalTime);
    const result: EvaluatedInstance[] = [];

    if (this.wasmInstance) {
      this.autoBindWasmMemory();
      const memory = this.wasmInstance.memory ?? (globalThis as any).wasmMemory ?? this.wasmInstance.__wasm?.memory;
      if (!memory || !memory.buffer) {
        throw new ReferenceError(
          "WASM memory not bound. Call Engine.bindWasmMemory(memory) first, " +
          "or set globalThis.wasmMemory = wasmExports.memory after initSync()."
        );
      }

      if (evalResult.ptr != null && evalResult.len > 0) {
        const memoryBuffer: ArrayBuffer = memory.buffer;
        const count = evalResult.count;
        const floatsPerInst = 20;
        const floatView = new Float32Array(memoryBuffer, evalResult.ptr, count * floatsPerInst);
        const uintView = new Uint32Array(memoryBuffer, evalResult.ptr, count * floatsPerInst);

        for (let i = 0; i < count; i++) {
          const offset = i * floatsPerInst;
          const transformMatrix = floatView.slice(offset, offset + 16);
          const opacity = floatView[offset + 16];
          const visible = uintView[offset + 17] === 1;
          const clipIndex = uintView[offset + 18];
          const instData = this.instances[i];

          result.push({
            id: instData?.id,
            clipId: instData?.clip_id,
            transformMatrix,
            opacity,
            visible,
            clipIndex,
          });
        }
      }
    } else {
      // Fallback JS evaluation matching Rust EngineState evaluation logic 1:1
      const scheduledMap = this.rootTimeline ? flattenTimeline(this.rootTimeline) : new Map<string, number>();

      const clipMap = this.clips;
      const clipIndexMap = new Map<string, number>();
      let clipIdxCounter = 0;
      for (const [clipId] of clipMap) {
        clipIndexMap.set(clipId, clipIdxCounter++);
      }

      for (let i = 0; i < this.instances.length; i++) {
        const inst = this.instances[i];
        const clip = clipMap.get(inst.clip_id);
        const clipIdx = clipIndexMap.get(inst.clip_id) ?? i;

        const isVisible = inst.visible ?? true;
        let delay = inst.delay ?? 0;
        if (scheduledMap.has(inst.id)) {
          delay += scheduledMap.get(inst.id)!;
        }

        if (!isVisible || globalTime < delay || !clip) {
          const identityMatrix = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
          ]);
          result.push({
            id: inst.id,
            clipId: inst.clip_id,
            transformMatrix: identityMatrix,
            opacity: 0.0,
            visible: false,
            clipIndex: clipIdx,
          });
          continue;
        }

        const timeRemappingSpeed = inst.time_remapping_speed ?? 1.0;
        const durationScale = inst.duration_scale || 1.0;
        const clipDuration = clip.duration || 0.001;

        const elapsed = (globalTime - delay) * timeRemappingSpeed;
        let localTime = 0;
        if (elapsed < 0) {
          localTime = (clipDuration + (elapsed % clipDuration)) / durationScale;
        } else {
          localTime = elapsed / durationScale;
        }

        const { transform: clipTransform, opacity: clipOpacity } = evaluateClip(clip, localTime);

        const initialMat = transformToMatrix(inst.initial_transform ?? getDefaultTransform());
        const clipMat = transformToMatrix(clipTransform);

        let finalMat: Float32Array;
        const blendMode = inst.blend_mode ?? BlendMode.Override;
        if (blendMode === BlendMode.Override) {
          finalMat = multiplyMatrices(initialMat, clipMat);
        } else {
          // Additive blend mode: initial_mat + (clip_mat - Mat4::IDENTITY)
          finalMat = new Float32Array(16);
          for (let k = 0; k < 16; k++) {
            const identityVal = k % 5 === 0 ? 1 : 0;
            finalMat[k] = initialMat[k] + (clipMat[k] - identityVal);
          }
        }

        const instOpacity = inst.opacity ?? 1.0;

        result.push({
          id: inst.id,
          clipId: inst.clip_id,
          transformMatrix: finalMat,
          opacity: instOpacity * clipOpacity,
          visible: true,
          clipIndex: clipIdx,
        });
      }
    }

    return result;
  }

  private notifyDevTools(globalTime: number, evaluatedInstances: EvaluatedInstance[]): void {
    if (typeof window !== "undefined" && window.postMessage) {
      window.postMessage(
        {
          source: "keyframe-engine-devtools",
          type: "FRAME_EVALUATED",
          payload: {
            globalTime,
            clips: Array.from(this.clips.values()),
            instances: this.instances,
            evaluatedInstances: evaluatedInstances.map((inst) => ({
              id: inst.id,
              clipId: inst.clipId,
              opacity: inst.opacity,
              visible: inst.visible,
              clipIndex: inst.clipIndex,
              matrix: Array.from(inst.transformMatrix),
            })),
          },
        },
        "*"
      );
    }
  }

  public bakeChunk(startMs: number, endMs: number, fps = 30): Uint8Array {
    if (this.wasmInstance && this.wasmInstance.bake_chunk) {
      return this.wasmInstance.bake_chunk(startMs, endMs, fps);
    } else if (this.wasmInstance && this.wasmInstance.bake_range) {
      return this.wasmInstance.bake_range(startMs, endMs, fps);
    }
    const duration = Math.max(0, endMs - startMs);
    const numFrames = Math.max(1, Math.floor((duration / 1000) * fps));
    const instCount = this.instances.length || 1;
    return new Uint8Array(numFrames * instCount * 80);
  }

  public bakeRange(startMs: number, endMs: number, fps = 30): Uint8Array {
    return this.bakeChunk(startMs, endMs, fps);
  }

  public exportIR(): EngineIR {
    return {
      clips: Array.from(this.clips.values()),
      instances: [...this.instances],
      root_timeline: this.rootTimeline,
    };
  }

  public importIR(ir: EngineIR): void {
    this.clips.clear();
    this.instances = [];
    for (const c of ir.clips) {
      this.addClip(c);
    }
    this.addInstances(ir.instances);
    if (ir.root_timeline) {
      this.setRootTimeline(ir.root_timeline);
    }
  }
}
