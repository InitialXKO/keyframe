import { AnimationClipData, BlendMode, CubicBezierParams, Easing, EngineIR, EvaluatedFrameResult, EvaluatedInstance, InstanceData, KeyframeData, PrepareOptions, TimelineNodeData, TransformData } from "./types.js";
import { Clip } from "./clip.js";
import { OPFSStorage } from "../opfs_storage.js";

export { EvaluatedInstance, EvaluatedFrameResult, PrepareOptions } from "./types.js";
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

function bounceOut(t: number): number {
  if (t < 1.0 / 2.75) {
    return 7.5625 * t * t;
  } else if (t < 2.0 / 2.75) {
    const t2 = t - 1.5 / 2.75;
    return 7.5625 * t2 * t2 + 0.75;
  } else if (t < 2.5 / 2.75) {
    const t2 = t - 2.25 / 2.75;
    return 7.5625 * t2 * t2 + 0.9375;
  } else {
    const t2 = t - 2.625 / 2.75;
    return 7.5625 * t2 * t2 + 0.984375;
  }
}

function bounceIn(t: number): number {
  return 1.0 - bounceOut(1.0 - t);
}

function bounceInOut(t: number): number {
  if (t < 0.5) {
    return (1.0 - bounceOut(1.0 - 2.0 * t)) / 2.0;
  } else {
    return (1.0 + bounceOut(2.0 * t - 1.0)) / 2.0;
  }
}

function elasticOut(t: number): number {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin(((t - 0.075) * (2.0 * Math.PI)) / 0.3) + 1.0;
}

function elasticIn(t: number): number {
  if (t === 0 || t === 1) return t;
  return -Math.pow(2, 10 * t - 10) * Math.sin(((t * 10 - 10.75) * (2.0 * Math.PI)) / 3.0);
}

function elasticInOut(t: number): number {
  if (t === 0 || t === 1) return t;
  if (t < 0.5) {
    return -0.5 * Math.pow(2, 20 * t - 10) * Math.sin(((20 * t - 11.125) * (2.0 * Math.PI)) / 4.5);
  } else {
    return 0.5 * Math.pow(2, -20 * t + 10) * Math.sin(((20 * t - 11.125) * (2.0 * Math.PI)) / 4.5) + 1.0;
  }
}

const S_BACK = 1.70158;

function backIn(t: number): number {
  return t * t * ((S_BACK + 1.0) * t - S_BACK);
}

function backOut(t: number): number {
  const t2 = t - 1.0;
  return t2 * t2 * ((S_BACK + 1.0) * t2 + S_BACK) + 1.0;
}

function backInOut(t: number): number {
  const s = S_BACK * 1.525;
  if (t < 0.5) {
    const t2 = 2.0 * t;
    return (t2 * t2 * ((s + 1.0) * t2 - s)) / 2.0;
  } else {
    const t2 = 2.0 * t - 2.0;
    return (t2 * t2 * ((s + 1.0) * t2 + s) + 2.0) / 2.0;
  }
}

function expoIn(t: number): number {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}

function expoOut(t: number): number {
  return t === 1 ? 1 : 1.0 - Math.pow(2, -10 * t);
}

function expoInOut(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  if (t < 0.5) return Math.pow(2, 20 * t - 10) / 2.0;
  return (2.0 - Math.pow(2, -20 * t + 10)) / 2.0;
}

function sineIn(t: number): number {
  return 1.0 - Math.cos((t * Math.PI) / 2.0);
}

function sineOut(t: number): number {
  return Math.sin((t * Math.PI) / 2.0);
}

function sineInOut(t: number): number {
  return -(Math.cos(t * Math.PI) - 1.0) / 2.0;
}

function solveSpringJS(frame: number, fps: number, damping: number, stiffness: number, mass: number): number {
  const m = mass <= 0 ? 1.0 : mass;
  const t = frame / fps;
  if (t <= 0) return 0.0;

  const w0 = Math.sqrt(stiffness / m);
  const zeta = damping / (2.0 * Math.sqrt(stiffness * m));

  if (Math.abs(zeta - 1.0) < 1e-5) {
    return 1.0 - (1.0 + w0 * t) * Math.exp(-w0 * t);
  } else if (zeta < 1.0) {
    const wd = w0 * Math.sqrt(1.0 - zeta * zeta);
    return 1.0 - Math.exp(-zeta * w0 * t) * ((zeta * w0 / wd) * Math.sin(wd * t) + Math.cos(wd * t));
  } else {
    const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1.0));
    const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1.0));
    const c2 = r1 / (r2 - r1);
    const c1 = 1.0 - c2;
    return 1.0 - (c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
  }
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
      // Fallback to standard EaseInOut curve (0.42, 0.0, 0.58, 1.0) when cubic_params is omitted
      return solveCubicBezier(0.42, 0.0, 0.58, 1.0, clampedT);
    case Easing.Step:
      return clampedT >= 1.0 ? 1.0 : 0.0;
    case Easing.BounceIn:
      return bounceIn(clampedT);
    case Easing.BounceOut:
      return bounceOut(clampedT);
    case Easing.BounceInOut:
      return bounceInOut(clampedT);
    case Easing.ElasticIn:
      return elasticIn(clampedT);
    case Easing.ElasticOut:
      return elasticOut(clampedT);
    case Easing.ElasticInOut:
      return elasticInOut(clampedT);
    case Easing.BackIn:
      return backIn(clampedT);
    case Easing.BackOut:
      return backOut(clampedT);
    case Easing.BackInOut:
      return backInOut(clampedT);
    case Easing.ExpoIn:
      return expoIn(clampedT);
    case Easing.ExpoOut:
      return expoOut(clampedT);
    case Easing.ExpoInOut:
      return expoInOut(clampedT);
    case Easing.SineIn:
      return sineIn(clampedT);
    case Easing.SineOut:
      return sineOut(clampedT);
    case Easing.SineInOut:
      return sineInOut(clampedT);
    case Easing.SpringEasing:
      return solveSpringJS(clampedT, 1.0, 0.5, 100.0, 1.0);
    default:
      return clampedT;
  }
}

function normalizeQuatTo(q: [number, number, number, number], out: [number, number, number, number]): void {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-6) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return;
  }
  out[0] = q[0] / len;
  out[1] = q[1] / len;
  out[2] = q[2] / len;
  out[3] = q[3] / len;
}

const scratchQ1: [number, number, number, number] = [0, 0, 0, 1];
const scratchQ2: [number, number, number, number] = [0, 0, 0, 1];

function isAdditiveBlendMode(bm?: BlendMode | string): boolean {
  if (!bm) return false;
  if (bm === BlendMode.Additive || bm === "additive" || bm === "lighter") return true;
  if (typeof bm === "string") {
    const s = bm.toLowerCase();
    return s === "additive" || s === "lighter";
  }
  return false;
}

function slerpQuatTo(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
  out: [number, number, number, number]
): void {
  normalizeQuatTo(a, scratchQ1);
  normalizeQuatTo(b, scratchQ2);

  let dot = scratchQ1[0] * scratchQ2[0] + scratchQ1[1] * scratchQ2[1] + scratchQ1[2] * scratchQ2[2] + scratchQ1[3] * scratchQ2[3];

  if (dot < 0) {
    scratchQ2[0] = -scratchQ2[0];
    scratchQ2[1] = -scratchQ2[1];
    scratchQ2[2] = -scratchQ2[2];
    scratchQ2[3] = -scratchQ2[3];
    dot = -dot;
  }

  if (dot > 0.9995) {
    scratchQ1[0] += t * (scratchQ2[0] - scratchQ1[0]);
    scratchQ1[1] += t * (scratchQ2[1] - scratchQ1[1]);
    scratchQ1[2] += t * (scratchQ2[2] - scratchQ1[2]);
    scratchQ1[3] += t * (scratchQ2[3] - scratchQ1[3]);
    normalizeQuatTo(scratchQ1, out);
    return;
  }

  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);

  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  out[0] = s0 * scratchQ1[0] + s1 * scratchQ2[0];
  out[1] = s0 * scratchQ1[1] + s1 * scratchQ2[1];
  out[2] = s0 * scratchQ1[2] + s1 * scratchQ2[2];
  out[3] = s0 * scratchQ1[3] + s1 * scratchQ2[3];
}

function interpolateTransformTo(a: TransformData, b: TransformData, factor: number, out: TransformData): void {
  out.translation[0] = a.translation[0] + (b.translation[0] - a.translation[0]) * factor;
  out.translation[1] = a.translation[1] + (b.translation[1] - a.translation[1]) * factor;
  out.translation[2] = a.translation[2] + (b.translation[2] - a.translation[2]) * factor;

  out.scale[0] = a.scale[0] + (b.scale[0] - a.scale[0]) * factor;
  out.scale[1] = a.scale[1] + (b.scale[1] - a.scale[1]) * factor;
  out.scale[2] = a.scale[2] + (b.scale[2] - a.scale[2]) * factor;

  out.origin[0] = a.origin[0] + (b.origin[0] - a.origin[0]) * factor;
  out.origin[1] = a.origin[1] + (b.origin[1] - a.origin[1]) * factor;
  out.origin[2] = a.origin[2] + (b.origin[2] - a.origin[2]) * factor;

  slerpQuatTo(a.rotation_quat, b.rotation_quat, factor, out.rotation_quat);
}

const DEFAULT_TRANSFORM: TransformData = Object.freeze({
  translation: [0, 0, 0] as [number, number, number],
  rotation_quat: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  origin: [0, 0, 0] as [number, number, number],
});

function getDefaultTransform(): TransformData {
  return DEFAULT_TRANSFORM;
}

const scratchQuatNorm: [number, number, number, number] = [0, 0, 0, 1];

function writeTransformToMatrix(t: TransformData, out: Float32Array, outOffset = 0): void {
  const tx = t.translation[0];
  const ty = t.translation[1];
  const tz = t.translation[2];

  const ox = t.origin[0];
  const oy = t.origin[1];
  const oz = t.origin[2];

  normalizeQuatTo(t.rotation_quat, scratchQuatNorm);
  const qx = scratchQuatNorm[0];
  const qy = scratchQuatNorm[1];
  const qz = scratchQuatNorm[2];
  const qw = scratchQuatNorm[3];

  const sx = t.scale[0];
  const sy = t.scale[1];
  const sz = t.scale[2];

  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r02 = 2 * (qx * qz + qy * qw);

  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qx * qw);

  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);

  const rs00 = r00 * sx;
  const rs01 = r01 * sy;
  const rs02 = r02 * sz;

  const rs10 = r10 * sx;
  const rs11 = r11 * sy;
  const rs12 = r12 * sz;

  const rs20 = r20 * sx;
  const rs21 = r21 * sy;
  const rs22 = r22 * sz;

  const pos_x = tx + ox - (rs00 * ox + rs01 * oy + rs02 * oz);
  const pos_y = ty + oy - (rs10 * ox + rs11 * oy + rs12 * oz);
  const pos_z = tz + oz - (rs20 * ox + rs21 * oy + rs22 * oz);

  out[outOffset + 0] = rs00;   out[outOffset + 1] = rs10;   out[outOffset + 2] = rs20;   out[outOffset + 3] = 0;
  out[outOffset + 4] = rs01;   out[outOffset + 5] = rs11;   out[outOffset + 6] = rs21;   out[outOffset + 7] = 0;
  out[outOffset + 8] = rs02;   out[outOffset + 9] = rs12;   out[outOffset + 10] = rs22;  out[outOffset + 11] = 0;
  out[outOffset + 12] = pos_x; out[outOffset + 13] = pos_y; out[outOffset + 14] = pos_z; out[outOffset + 15] = 1;
}

function multiplyMatricesTo(
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
  out: Float32Array,
  outOffset: number
): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[outOffset + col * 4 + row] =
        a[aOffset + 0 * 4 + row] * b[bOffset + col * 4 + 0] +
        a[aOffset + 1 * 4 + row] * b[bOffset + col * 4 + 1] +
        a[aOffset + 2 * 4 + row] * b[bOffset + col * 4 + 2] +
        a[aOffset + 3 * 4 + row] * b[bOffset + col * 4 + 3];
    }
  }
}

function getSortedKeyframes(clip: AnimationClipData): KeyframeData[] {
  let sorted = (clip as any)._sortedKeyframes as KeyframeData[] | undefined;
  if (!sorted) {
    sorted = clip.keyframes ? [...clip.keyframes].sort((a, b) => a.time - b.time) : [];
    (clip as any)._sortedKeyframes = sorted;
  }
  return sorted;
}

interface ClipEvaluationResult {
  transform: TransformData;
  opacity: number;
}

const scratchClipTransform: TransformData = {
  translation: [0, 0, 0],
  rotation_quat: [0, 0, 0, 1],
  scale: [1, 1, 1],
  origin: [0, 0, 0],
};

const scratchClipResult: ClipEvaluationResult = {
  transform: DEFAULT_TRANSFORM,
  opacity: 1.0,
};

function evaluateClipTo(clip: AnimationClipData, localTime: number, outResult: ClipEvaluationResult): void {
  if (!clip.keyframes || clip.keyframes.length === 0) {
    outResult.transform = DEFAULT_TRANSFORM;
    outResult.opacity = 1.0;
    return;
  }

  const sortedKeyframes = getSortedKeyframes(clip);

  if (sortedKeyframes.length === 1) {
    const kf = sortedKeyframes[0];
    outResult.transform = kf.transform ?? DEFAULT_TRANSFORM;
    outResult.opacity = kf.opacity ?? 1.0;
    return;
  }

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
    outResult.transform = kf.transform ?? DEFAULT_TRANSFORM;
    outResult.opacity = kf.opacity ?? 1.0;
    return;
  }

  const lastIdx = sortedKeyframes.length - 1;
  if (effectiveTime >= sortedKeyframes[lastIdx].time) {
    const kf = sortedKeyframes[lastIdx];
    outResult.transform = kf.transform ?? DEFAULT_TRANSFORM;
    outResult.opacity = kf.opacity ?? 1.0;
    return;
  }

  for (let i = 0; i < lastIdx; i++) {
    const kfCurr = sortedKeyframes[i];
    const kfNext = sortedKeyframes[i + 1];
    if (effectiveTime >= kfCurr.time && effectiveTime <= kfNext.time) {
      const segDuration = kfNext.time - kfCurr.time;
      if (segDuration <= 0.0001) {
        outResult.transform = kfNext.transform ?? DEFAULT_TRANSFORM;
        outResult.opacity = kfNext.opacity ?? 1.0;
        return;
      }
      const linearT = (effectiveTime - kfCurr.time) / segDuration;
      const easedT = evaluateEasing(kfCurr.easing ?? Easing.Linear, kfCurr.cubic_params, linearT);

      const currTrans = kfCurr.transform ?? DEFAULT_TRANSFORM;
      const nextTrans = kfNext.transform ?? DEFAULT_TRANSFORM;
      const currOpacity = kfCurr.opacity ?? 1.0;
      const nextOpacity = kfNext.opacity ?? 1.0;

      interpolateTransformTo(currTrans, nextTrans, easedT, scratchClipTransform);
      outResult.transform = scratchClipTransform;
      outResult.opacity = currOpacity + (nextOpacity - currOpacity) * easedT;
      return;
    }
  }

  const kf = sortedKeyframes[lastIdx];
  outResult.transform = kf.transform ?? DEFAULT_TRANSFORM;
  outResult.opacity = kf.opacity ?? 1.0;
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
  private prepared = false;
  private opfsStorage: OPFSStorage = new OPFSStorage();
  private jsEvaluatedBuffer?: Float32Array;
  private jsEvaluatedUintBuffer?: Uint32Array;
  private instanceAdditiveMap = new WeakMap<InstanceData, boolean>();
  private lastEvaluatedFrameResult?: EvaluatedFrameResult;

  private scratchInitialMat = new Float32Array(16);
  private scratchClipMat = new Float32Array(16);
  private cachedClipIndexMap?: Map<string, number>;
  private cachedScheduledMap?: Map<string, number>;
  private cachedEvaluatedInstances?: EvaluatedInstance[];
  private cachedSubarrays?: Float32Array[];

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
    delete (data as any)._sortedKeyframes;
    this.clips.set(data.id, data);
    this.cachedClipIndexMap = undefined;
    if (this.wasmInstance) {
      this.wasmInstance.add_clip_json(JSON.stringify(data));
    }
    return this;
  }

  public addInstances(instances: (Instance | InstanceData)[]): this {
    for (const inst of instances) {
      const data = inst instanceof Instance ? inst.build() : inst;
      this.instanceAdditiveMap.set(data, isAdditiveBlendMode(data.blend_mode));
      this.instances.push(data);
      if (this.wasmInstance) {
        this.wasmInstance.add_instance_json(JSON.stringify(data));
      }
    }
    this.cachedSubarrays = undefined;
    this.cachedEvaluatedInstances = undefined;
    return this;
  }

  public setRootTimeline(node: TimelineNodeData): this {
    this.rootTimeline = node;
    this.cachedScheduledMap = undefined;
    if (this.wasmInstance) {
      this.wasmInstance.set_root_timeline_json(JSON.stringify(node));
    }
    return this;
  }

  private validateIRCompatibility(): void {
    for (const clip of this.clips.values()) {
      if (!clip.keyframes) continue;
      for (const kf of clip.keyframes) {
        if (kf.springConfig && kf.springConfig.mass !== undefined && kf.springConfig.mass !== 1.0) {
          const massStr = Number.isInteger(kf.springConfig.mass) ? kf.springConfig.mass.toFixed(1) : kf.springConfig.mass.toString();
          throw new TypeError(
            `[KeyframeEngine] Clip "${clip.id}" keyframe at t=${kf.time} uses spring mass=${massStr}.\nWASM core only supports mass=1.0 for batch evaluation.\n\nTo resolve:\n  1. Bake the animation via engine.bakeRange(), then use baked data (recommended for video/offline rendering).\n  2. Use @keyframe-engine/physics for real-time interactive springs (max ~200 instances).\n  3. Set mass to 1.0 to match WASM behavior.`
          );
        }
        if (kf.interpolateConfig) {
          const cfg = kf.interpolateConfig;
          if (cfg.extrapolate || cfg.extrapolateLeft || cfg.extrapolateRight) {
            throw new Error(
              `Clip "${clip.id}" keyframe at t=${kf.time} uses extrapolate, but WASM core does not support extrapolate. To fix, choose one: → Remove extrapolate and clamp input manually → Use @keyframe-engine/bake to pre-bake this clip`
            );
          }
        }
      }
    }
  }

  public async prepare(options?: PrepareOptions): Promise<void> {
    // Stage 1: Synchronous validation
    options?.onProgress?.("validation");
    this.validateIRCompatibility();

    // Stage 2: WASM loading (if no existing instance)
    if (!this.wasmInstance) {
      options?.onProgress?.("wasm_loading");
      const url = options?.wasmUrl || "https://cdn.jsdelivr.net/npm/@keyframe-engine/core/pkg/keyframe_engine_bg.wasm";

      const loadPromise = (async () => {
        let instance: any = null;
        let exports: any = null;

        if (typeof WebAssembly === "undefined" || typeof fetch === "undefined") {
          throw new Error(
            "Environment does not support WebAssembly or fetch. Host environment must support WebAssembly and fetch API to load WASM engine module."
          );
        }

        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          if (WebAssembly.instantiateStreaming) {
            try {
              const res = await WebAssembly.instantiateStreaming(response.clone());
              instance = res.instance;
              exports = instance.exports;
            } catch (e) {
              const buffer = await response.arrayBuffer();
              const res = await WebAssembly.instantiate(buffer);
              instance = res.instance;
              exports = instance.exports;
            }
          } else {
            const buffer = await response.arrayBuffer();
            const res = await WebAssembly.instantiate(buffer);
            instance = res.instance;
            exports = instance.exports;
          }

          this.wasmInstance = exports || instance;
          if (exports && exports.memory) {
            this.bindWasmMemory(exports.memory);
          } else if (instance && instance.exports && instance.exports.memory) {
            this.bindWasmMemory(instance.exports.memory);
          }
        } catch (fetchErr: any) {
          throw new Error(
            `Failed to load WASM engine module from "${url}": ${fetchErr?.message || fetchErr}. ` +
            "Please check CSP configuration, network connectivity, and host application environment setup."
          );
        }
      })();

      const timeoutMs = 30000;
      let timer: any = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`WASM loading timeout (${timeoutMs}ms) from "${url}". Check network or host environment.`));
        }, timeoutMs);
      });

      try {
        await Promise.race([loadPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      this.autoBindWasmMemory();
    }

    // Stage 3: OPFS Auto-Mount (if enabled)
    if (options?.storage?.enabled !== false) {
      options?.onProgress?.("opfs_mount");
      try {
        const mounted = await this.opfsStorage.mount();
        if (mounted) {
          await this.opfsStorage.buildFrameIndex();
        }
      } catch (err) {
        console.warn("OPFS auto-mount failed, falling back to memory mode:", err);
      }
    }

    // Stage 4: WASM internal prepare()
    options?.onProgress?.("compiling");
    if (this.wasmInstance && typeof this.wasmInstance.prepare === "function") {
      this.wasmInstance.prepare();
    }
    this.prepared = true;
  }

  private cachedFrameResult?: EvaluatedFrameResult;

  private evaluateWasmFrame(globalTime: number): EvaluatedFrameResult {
    const count = this.wasmInstance.evaluate_frame(globalTime);
    this.autoBindWasmMemory();
    const memory = this.wasmInstance.memory ?? (globalThis as any).wasmMemory ?? this.wasmInstance.__wasm?.memory;
    if (!memory || !memory.buffer) {
      throw new ReferenceError(
        "WASM memory not bound. Call Engine.bindWasmMemory(memory) first, " +
        "or set globalThis.wasmMemory = wasmExports.memory after initSync()."
      );
    }

    const ptr = this.wasmInstance.get_instance_buffer_ptr() ?? 0;
    const len = this.wasmInstance.get_instance_buffer_byte_length() ?? (count * 80);
    const floatsPerInst = 20;
    const memoryBuffer: ArrayBuffer = memory.buffer;

    let floatView: Float32Array;
    let uintView: Uint32Array;

    if (
      this.cachedFrameResult &&
      this.cachedFrameResult.view &&
      this.cachedFrameResult.view.buffer === memoryBuffer &&
      this.cachedFrameResult.ptr === ptr &&
      this.cachedFrameResult.count === count &&
      this.cachedFrameResult.uintView
    ) {
      floatView = this.cachedFrameResult.view;
      uintView = this.cachedFrameResult.uintView;
    } else {
      floatView = new Float32Array(memoryBuffer, ptr, count * floatsPerInst);
      uintView = new Uint32Array(memoryBuffer, ptr, count * floatsPerInst);
      this.cachedFrameResult = {
        view: floatView,
        uintView,
        count,
        ptr,
        byteOffset: ptr,
        byteLength: len,
        floatsPerInstance: floatsPerInst,
      };
    }

    this.cachedFrameResult.view = floatView;
    this.cachedFrameResult.uintView = uintView;
    this.cachedFrameResult.count = count;
    this.cachedFrameResult.ptr = ptr;
    this.cachedFrameResult.byteOffset = ptr;
    this.cachedFrameResult.byteLength = len;
    this.cachedFrameResult.floatsPerInstance = floatsPerInst;

    return this.cachedFrameResult;
  }

  private evaluateJSFrame(globalTime: number): EvaluatedFrameResult {
    const count = this.instances.length;
    const floatsPerInst = 20;
    const totalFloats = count * floatsPerInst;

    if (!this.jsEvaluatedBuffer || this.jsEvaluatedBuffer.length < totalFloats) {
      this.jsEvaluatedBuffer = new Float32Array(totalFloats);
      this.jsEvaluatedUintBuffer = new Uint32Array(this.jsEvaluatedBuffer.buffer, 0, totalFloats);
      this.cachedSubarrays = undefined;
      this.cachedEvaluatedInstances = undefined;
    }
    const floatView = totalFloats === this.jsEvaluatedBuffer.length
      ? this.jsEvaluatedBuffer
      : this.jsEvaluatedBuffer.subarray(0, totalFloats);

    const uintView = (this.jsEvaluatedUintBuffer && totalFloats === this.jsEvaluatedUintBuffer.length)
      ? this.jsEvaluatedUintBuffer
      : new Uint32Array(floatView.buffer, floatView.byteOffset, totalFloats);

    if (!this.cachedScheduledMap) {
      this.cachedScheduledMap = this.rootTimeline ? flattenTimeline(this.rootTimeline) : new Map<string, number>();
    }
    const scheduledMap = this.cachedScheduledMap;

    if (!this.cachedClipIndexMap) {
      this.cachedClipIndexMap = new Map<string, number>();
      let counter = 0;
      for (const clipId of this.clips.keys()) {
        this.cachedClipIndexMap.set(clipId, counter++);
      }
    }
    const clipIndexMap = this.cachedClipIndexMap;
    const clipMap = this.clips;

    for (let i = 0; i < count; i++) {
      const inst = this.instances[i];
      const clip = clipMap.get(inst.clip_id);
      const clipIdx = clipIndexMap.get(inst.clip_id) ?? i;
      const offset = i * floatsPerInst;

      const isVisible = inst.visible ?? true;
      let delay = inst.delay ?? 0;
      if (scheduledMap.has(inst.id)) {
        delay += scheduledMap.get(inst.id)!;
      }

      if (!isVisible || globalTime < delay || !clip) {
        floatView[offset + 0] = 1; floatView[offset + 1] = 0; floatView[offset + 2] = 0; floatView[offset + 3] = 0;
        floatView[offset + 4] = 0; floatView[offset + 5] = 1; floatView[offset + 6] = 0; floatView[offset + 7] = 0;
        floatView[offset + 8] = 0; floatView[offset + 9] = 0; floatView[offset + 10] = 1; floatView[offset + 11] = 0;
        floatView[offset + 12] = 0; floatView[offset + 13] = 0; floatView[offset + 14] = 0; floatView[offset + 15] = 1;
        floatView[offset + 16] = 0.0;
        uintView[offset + 17] = 0;
        uintView[offset + 18] = clipIdx;
        floatView[offset + 19] = 0;
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

      evaluateClipTo(clip, localTime, scratchClipResult);
      const clipTransform = scratchClipResult.transform;
      const clipOpacity = scratchClipResult.opacity;

      writeTransformToMatrix(inst.initial_transform ?? DEFAULT_TRANSFORM, this.scratchInitialMat, 0);
      writeTransformToMatrix(clipTransform, this.scratchClipMat, 0);

      let isAdditive = this.instanceAdditiveMap.get(inst);
      if (isAdditive === undefined) {
        isAdditive = isAdditiveBlendMode(inst.blend_mode);
        this.instanceAdditiveMap.set(inst, isAdditive);
      }
      if (!isAdditive) {
        multiplyMatricesTo(this.scratchInitialMat, 0, this.scratchClipMat, 0, floatView, offset);
      } else {
        for (let k = 0; k < 16; k++) {
          const identityVal = k % 5 === 0 ? 1 : 0;
          floatView[offset + k] = this.scratchInitialMat[k] + (this.scratchClipMat[k] - identityVal);
        }
      }

      const instOpacity = inst.opacity ?? 1.0;
      floatView[offset + 16] = instOpacity * clipOpacity;
      uintView[offset + 17] = 1;
      uintView[offset + 18] = clipIdx;
      floatView[offset + 19] = 0;
    }

    if (!this.cachedFrameResult) {
      this.cachedFrameResult = {
        view: floatView,
        uintView,
        count,
        ptr: 0,
        byteOffset: floatView.byteOffset,
        byteLength: floatView.byteLength,
        floatsPerInstance: floatsPerInst,
      };
    } else {
      this.cachedFrameResult.view = floatView;
      this.cachedFrameResult.uintView = uintView;
      this.cachedFrameResult.count = count;
      this.cachedFrameResult.ptr = 0;
      this.cachedFrameResult.byteOffset = floatView.byteOffset;
      this.cachedFrameResult.byteLength = floatView.byteLength;
      this.cachedFrameResult.floatsPerInstance = floatsPerInst;
    }

    return this.cachedFrameResult;
  }

  /**
   * Evaluates the engine animation state at `globalTime` (in milliseconds).
   * Directly returns a zero-copy raw TypedArray view pointing to WASM memory buffer (or contiguous JS buffer),
   * along with pointer/offset and instance count.
   */
  public evaluateFrame(globalTime: number): EvaluatedFrameResult {
    if (!this.prepared) {
      throw new Error("Engine not prepared");
    }

    let result: EvaluatedFrameResult;
    if (this.wasmInstance) {
      result = this.evaluateWasmFrame(globalTime);
    } else {
      result = this.evaluateJSFrame(globalTime);
    }

    this.lastEvaluatedFrameResult = result;

    if (this.devToolsEnabled && !this.notifyingDevTools) {
      this.notifyingDevTools = true;
      const evaluated = this.getEvaluatedInstances(globalTime, true, result);
      this.notifyDevTools(globalTime, evaluated);
      this.notifyingDevTools = false;
    }

    return result;
  }

  /**
   * Evaluates and returns the array of `EvaluatedInstance` objects at `globalTime` (in milliseconds).
   *
   * Each `EvaluatedInstance` includes `transformMatrix` (a zero-copy subarray view over the evaluation buffer),
   * `opacity`, `visible`, and instance/clip identifiers.
   * @param globalTime The global time in milliseconds.
   * @param skipEvaluate If `true`, re-evaluation of the WASM frame is skipped.
   * @param evalResultParam Optional pre-computed evaluation frame result.
   */
  public getEvaluatedInstances(
    globalTime: number,
    skipEvaluate = false,
    evalResultParam?: EvaluatedFrameResult
  ): EvaluatedInstance[] {
    if (!this.prepared && !skipEvaluate) {
      throw new Error("Engine not prepared");
    }

    // Cache-first lookup: if OPFS frame index contains cached bake for globalTime, return cached evaluated instances
    if (this.opfsStorage.isMounted()) {
      const cached = this.opfsStorage.getFrameFromIndex(globalTime);
      if (cached && Array.isArray(cached)) {
        return cached;
      }
    }

    let evalResult = evalResultParam;
    if (!evalResult) {
      if (skipEvaluate) {
        if (this.lastEvaluatedFrameResult) {
          evalResult = this.lastEvaluatedFrameResult;
        } else if (this.wasmInstance && this.prepared) {
          evalResult = this.evaluateWasmFrame(globalTime);
        } else {
          evalResult = this.evaluateJSFrame(globalTime);
        }
      } else {
        evalResult = this.evaluateFrame(globalTime);
      }
    }

    const count = evalResult.count;
    const floatView = evalResult.view;
    const uintView = evalResult.uintView;
    const floatsPerInst = evalResult.floatsPerInstance || 20;

    if (
      !this.cachedEvaluatedInstances ||
      this.cachedEvaluatedInstances.length !== count ||
      !this.cachedSubarrays ||
      this.cachedSubarrays.length !== count ||
      this.cachedSubarrays[0]?.buffer !== floatView.buffer ||
      this.cachedSubarrays[0]?.byteOffset !== floatView.byteOffset
    ) {
      this.cachedSubarrays = new Array(count);
      this.cachedEvaluatedInstances = new Array(count);

      for (let i = 0; i < count; i++) {
        const offset = i * floatsPerInst;
        const transformMatrix = floatView.subarray(offset, offset + 16);
        this.cachedSubarrays[i] = transformMatrix;
        const instData = this.instances[i];
        this.cachedEvaluatedInstances[i] = {
          id: instData?.id,
          clipId: instData?.clip_id,
          transformMatrix,
          opacity: 1.0,
          visible: true,
          clipIndex: 0,
        };
      }
    }

    for (let i = 0; i < count; i++) {
      const offset = i * floatsPerInst;
      const instData = this.instances[i];
      const item = this.cachedEvaluatedInstances[i];
      item.id = instData?.id;
      item.clipId = instData?.clip_id;
      item.opacity = floatView[offset + 16];
      item.visible = uintView ? uintView[offset + 17] === 1 : floatView[offset + 17] === 1;
      item.clipIndex = uintView ? uintView[offset + 18] : floatView[offset + 18];
    }

    return this.cachedEvaluatedInstances;
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

  /**
   * Bakes animation frames across the specified time range (`startMs` to `endMs`) at the given `fps`.
   * Returns a contiguous `Uint8Array` binary chunk where each instance frame is packed as an 80-byte structure.
   *
   * Binary layout per 80-byte instance (matching `#[repr(C, align(16))] GpuInstanceData`):
   * - 0..64 bytes (16 x Float32): 4x4 column-major transform matrix (`transform_matrix`)
   * - 64..68 bytes (1 x Float32): opacity (`opacity`)
   * - 68..72 bytes (1 x Uint32): visibility flag (`visible`, 1 for visible / true, 0 for hidden / false)
   * - 72..76 bytes (1 x Uint32): clip index (`clip_index`)
   * - 76..80 bytes (4 bytes): 16-byte alignment padding (`_padding`)
   *
   * To reverse-decode raw baked bytes back into structured `EvaluatedInstance[]`, use `Engine.decodeBakedChunk(data)`.
   */
  public bakeChunk(startMs: number, endMs: number, fps = 30): Uint8Array {
    if (this.wasmInstance && this.wasmInstance.bake_chunk) {
      return this.wasmInstance.bake_chunk(startMs, endMs, fps);
    } else if (this.wasmInstance && this.wasmInstance.bake_range) {
      return this.wasmInstance.bake_range(startMs, endMs, fps);
    }
    const frameDuration = 1000 / Math.max(1, fps);
    const chunks: Uint8Array[] = [];
    let currentTime = startMs;
    while (currentTime <= endMs + 1e-5) {
      const res = this.evaluateJSFrame(currentTime);
      const frameBytes = new Uint8Array(res.view.buffer, res.view.byteOffset, res.byteLength);
      chunks.push(new Uint8Array(frameBytes));
      currentTime += frameDuration;
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  /**
   * Alias for `bakeChunk(startMs, endMs, fps)`.
   */
  public bakeRange(startMs: number, endMs: number, fps = 30): Uint8Array {
    return this.bakeChunk(startMs, endMs, fps);
  }

  /**
   * Streams animation baking frame-by-frame or chunk-by-chunk directly to a callback.
   * Peak memory footprint remains constant (~64KB) regardless of overall duration or instance count.
   *
   * @param options Streaming bake options (start/endMs or start/duration, fps)
   * @param onChunk Callback receiving zero-copy (or chunked) Uint8Array binary views. Returning `false` aborts streaming.
   * @returns Total bytes processed.
   */
  public async bakeStream(
    options: { start?: number; startMs?: number; duration?: number; endMs?: number; fps?: number },
    onChunk: (chunk: Uint8Array) => boolean | void | Promise<boolean | void>
  ): Promise<number> {
    const startMs = options.startMs ?? options.start ?? 0;
    const endMs = options.endMs ?? (startMs + (options.duration ?? 0));
    const fps = options.fps ?? 30;

    const isAsync =
      onChunk.constructor.name === "AsyncFunction" ||
      (onChunk.toString && onChunk.toString().startsWith("async"));

    // If onChunk is synchronous and WASM bake_stream is available, use fast synchronous WASM stream
    if (!isAsync && this.wasmInstance && typeof this.wasmInstance.bake_stream === "function") {
      const res = this.wasmInstance.bake_stream(startMs, endMs, fps, (chunk: Uint8Array) => {
        const result = onChunk(chunk);
        if (result === false) {
          return false;
        }
        return true;
      });
      return typeof res === "number" ? res : 0;
    }

    // Async streaming loop: evaluates frames (using WASM evaluate_frame if available, or JS fallback)
    // and awaits onChunk to ensure sequential ordering without memory overwrite or race conditions.
    const frameDuration = 1000 / Math.max(1, fps);
    const targetChunkBytes = 64 * 1024; // 64KB target chunk size
    let chunkBuffer = new Uint8Array(targetChunkBytes);
    let chunkOffset = 0;
    let totalBytes = 0;

    let currentTime = startMs;
    while (currentTime <= endMs + 1e-5) {
      const res = this.prepared
        ? this.evaluateFrame(currentTime)
        : this.evaluateJSFrame(currentTime);
      const frameBytes = new Uint8Array(res.view.buffer, res.view.byteOffset, res.byteLength);

      if (chunkOffset + frameBytes.byteLength > chunkBuffer.byteLength) {
        if (chunkOffset > 0) {
          const slice = chunkBuffer.subarray(0, chunkOffset);
          totalBytes += slice.byteLength;
          const keepGoing = await onChunk(slice);
          if (keepGoing === false) {
            return totalBytes;
          }
          chunkOffset = 0;
        }

        if (frameBytes.byteLength >= targetChunkBytes) {
          totalBytes += frameBytes.byteLength;
          const keepGoing = await onChunk(frameBytes);
          if (keepGoing === false) {
            return totalBytes;
          }
        } else {
          chunkBuffer.set(frameBytes, 0);
          chunkOffset = frameBytes.byteLength;
        }
      } else {
        chunkBuffer.set(frameBytes, chunkOffset);
        chunkOffset += frameBytes.byteLength;
      }

      currentTime += frameDuration;
    }

    if (chunkOffset > 0) {
      const slice = chunkBuffer.subarray(0, chunkOffset);
      totalBytes += slice.byteLength;
      await onChunk(slice);
    }

    return totalBytes;
  }

  /**
   * Decodes raw binary chunk bytes produced by `bakeChunk` or loaded from storage back into an array of `EvaluatedInstance` objects.
   *
   * Parses 80-byte `GpuInstanceData` blocks:
   * - `transformMatrix`: 4x4 Float32Array (16 floats)
   * - `opacity`: Float32 at byte offset 64
   * - `visible`: Boolean flag derived from Uint32 at byte offset 68 (`=== 1`)
   * - `clipIndex`: Uint32 at byte offset 72
   *
   * @param data The binary Uint8Array containing packed GpuInstanceData blocks.
   * @returns Array of decoded `EvaluatedInstance` items.
   */
  public static decodeBakedChunk(data: Uint8Array): EvaluatedInstance[] {
    const bytesPerInstance = 80;
    const count = Math.floor(data.byteLength / bytesPerInstance);
    const result: EvaluatedInstance[] = [];

    let buffer = data.buffer;
    let byteOffset = data.byteOffset;
    if (byteOffset % 4 !== 0) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      buffer = copy.buffer;
      byteOffset = copy.byteOffset;
    }

    for (let i = 0; i < count; i++) {
      const offset = byteOffset + i * bytesPerInstance;
      const floatView = new Float32Array(buffer, offset, 20);
      const uintView = new Uint32Array(buffer, offset, 20);

      const transformMatrix = floatView.subarray(0, 16);
      const opacity = floatView[16];
      const visible = uintView[17] === 1;
      const clipIndex = uintView[18];

      result.push({
        transformMatrix,
        opacity,
        visible,
        clipIndex,
      });
    }

    return result;
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
    this.instanceAdditiveMap = new WeakMap();
    this.cachedClipIndexMap = undefined;
    this.cachedScheduledMap = undefined;
    this.cachedSubarrays = undefined;
    this.cachedEvaluatedInstances = undefined;
    for (const c of ir.clips) {
      this.addClip(c);
    }
    this.addInstances(ir.instances);
    if (ir.root_timeline) {
      this.setRootTimeline(ir.root_timeline);
    }
  }
}
