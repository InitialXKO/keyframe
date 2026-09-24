import { BlendMode, Easing, EngineDirtyFlags } from "./types.js";
import { Clip } from "./clip.js";
import { OPFSStorage } from "../opfs_storage.js";
import { globalBufferPool, globalInstancePool } from "./buffer_pool.js";
import { PropertyTrackRegistry } from "./property_track.js";
import { Instance } from "./instance.js";
function solveCubicBezier(p1x, p1y, p2x, p2y, t) {
    if (t <= 0)
        return 0;
    if (t >= 1)
        return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
        const oneMinusU = 1.0 - u;
        const x = 3.0 * oneMinusU * oneMinusU * u * p1x + 3.0 * oneMinusU * u * u * p2x + u * u * u;
        const dx = 3.0 * oneMinusU * oneMinusU * p1x + 6.0 * oneMinusU * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
        if (Math.abs(dx) < 1e-7)
            break;
        const err = x - t;
        u -= err / dx;
        u = Math.max(0, Math.min(1, u));
    }
    const oneMinusU = 1.0 - u;
    return 3.0 * oneMinusU * oneMinusU * u * p1y + 3.0 * oneMinusU * u * u * p2y + u * u * u;
}
function bounceOut(t) {
    if (t < 1.0 / 2.75) {
        return 7.5625 * t * t;
    }
    else if (t < 2.0 / 2.75) {
        const t2 = t - 1.5 / 2.75;
        return 7.5625 * t2 * t2 + 0.75;
    }
    else if (t < 2.5 / 2.75) {
        const t2 = t - 2.25 / 2.75;
        return 7.5625 * t2 * t2 + 0.9375;
    }
    else {
        const t2 = t - 2.625 / 2.75;
        return 7.5625 * t2 * t2 + 0.984375;
    }
}
function bounceIn(t) {
    return 1.0 - bounceOut(1.0 - t);
}
function bounceInOut(t) {
    if (t < 0.5) {
        return (1.0 - bounceOut(1.0 - 2.0 * t)) / 2.0;
    }
    else {
        return (1.0 + bounceOut(2.0 * t - 1.0)) / 2.0;
    }
}
function elasticOut(t) {
    if (t === 0 || t === 1)
        return t;
    return Math.pow(2, -10 * t) * Math.sin(((t - 0.075) * (2.0 * Math.PI)) / 0.3) + 1.0;
}
function elasticIn(t) {
    if (t === 0 || t === 1)
        return t;
    return -Math.pow(2, 10 * t - 10) * Math.sin(((t * 10 - 10.75) * (2.0 * Math.PI)) / 3.0);
}
function elasticInOut(t) {
    if (t === 0 || t === 1)
        return t;
    if (t < 0.5) {
        return -0.5 * Math.pow(2, 20 * t - 10) * Math.sin(((20 * t - 11.125) * (2.0 * Math.PI)) / 4.5);
    }
    else {
        return 0.5 * Math.pow(2, -20 * t + 10) * Math.sin(((20 * t - 11.125) * (2.0 * Math.PI)) / 4.5) + 1.0;
    }
}
const S_BACK = 1.70158;
function backIn(t) {
    return t * t * ((S_BACK + 1.0) * t - S_BACK);
}
function backOut(t) {
    const t2 = t - 1.0;
    return t2 * t2 * ((S_BACK + 1.0) * t2 + S_BACK) + 1.0;
}
function backInOut(t) {
    const s = S_BACK * 1.525;
    if (t < 0.5) {
        const t2 = 2.0 * t;
        return (t2 * t2 * ((s + 1.0) * t2 - s)) / 2.0;
    }
    else {
        const t2 = 2.0 * t - 2.0;
        return (t2 * t2 * ((s + 1.0) * t2 + s) + 2.0) / 2.0;
    }
}
function expoIn(t) {
    return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}
function expoOut(t) {
    return t === 1 ? 1 : 1.0 - Math.pow(2, -10 * t);
}
function expoInOut(t) {
    if (t === 0)
        return 0;
    if (t === 1)
        return 1;
    if (t < 0.5)
        return Math.pow(2, 20 * t - 10) / 2.0;
    return (2.0 - Math.pow(2, -20 * t + 10)) / 2.0;
}
function sineIn(t) {
    return 1.0 - Math.cos((t * Math.PI) / 2.0);
}
function sineOut(t) {
    return Math.sin((t * Math.PI) / 2.0);
}
function sineInOut(t) {
    return -(Math.cos(t * Math.PI) - 1.0) / 2.0;
}
export function solveSpringJS(frame, fps, damping, stiffness, mass) {
    const m = mass <= 0 ? 1.0 : mass;
    const t = frame / fps;
    if (t <= 0)
        return 0.0;
    const w0 = Math.sqrt(stiffness / m);
    const zeta = damping / (2.0 * Math.sqrt(stiffness * m));
    if (Math.abs(zeta - 1.0) < 1e-5) {
        return 1.0 - (1.0 + w0 * t) * Math.exp(-w0 * t);
    }
    else if (zeta < 1.0) {
        const wd = w0 * Math.sqrt(1.0 - zeta * zeta);
        return 1.0 - Math.exp(-zeta * w0 * t) * ((zeta * w0 / wd) * Math.sin(wd * t) + Math.cos(wd * t));
    }
    else {
        const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1.0));
        const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1.0));
        const c2 = r1 / (r2 - r1);
        const c1 = 1.0 - c2;
        return 1.0 - (c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
    }
}
export function evaluateEasing(easing, cubicParams, t) {
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
function normalizeQuatTo(q, out) {
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    if (len < 1e-6) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 1;
        return;
    }
    out[0] = q[0] / len;
    out[1] = q[1] / len;
    out[2] = q[2] / len;
    out[3] = q[3] / len;
}
const scratchQ1 = [0, 0, 0, 1];
const scratchQ2 = [0, 0, 0, 1];
function isAdditiveBlendMode(bm) {
    if (!bm)
        return false;
    if (bm === BlendMode.Additive || bm === "additive" || bm === "lighter")
        return true;
    if (typeof bm === "string") {
        const s = bm.toLowerCase();
        return s === "additive" || s === "lighter";
    }
    return false;
}
function slerpQuatTo(a, b, t, out) {
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
function interpolateTransformTo(a, b, factor, out) {
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
const DEFAULT_TRANSFORM = Object.freeze({
    translation: [0, 0, 0],
    rotation_quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    origin: [0, 0, 0],
});
function getDefaultTransform() {
    return DEFAULT_TRANSFORM;
}
const scratchQuatNorm = [0, 0, 0, 1];
function writeTransformToMatrix(t, out, outOffset = 0) {
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
    out[outOffset + 0] = rs00;
    out[outOffset + 1] = rs10;
    out[outOffset + 2] = rs20;
    out[outOffset + 3] = 0;
    out[outOffset + 4] = rs01;
    out[outOffset + 5] = rs11;
    out[outOffset + 6] = rs21;
    out[outOffset + 7] = 0;
    out[outOffset + 8] = rs02;
    out[outOffset + 9] = rs12;
    out[outOffset + 10] = rs22;
    out[outOffset + 11] = 0;
    out[outOffset + 12] = pos_x;
    out[outOffset + 13] = pos_y;
    out[outOffset + 14] = pos_z;
    out[outOffset + 15] = 1;
}
function multiplyMatricesTo(a, aOffset, b, bOffset, out, outOffset) {
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
function getSortedKeyframes(clip) {
    let sorted = clip._sortedKeyframes;
    if (!sorted) {
        sorted = clip.keyframes ? [...clip.keyframes].sort((a, b) => a.time - b.time) : [];
        clip._sortedKeyframes = sorted;
        clip._chunkStarts = sorted.map((kf) => kf.time);
    }
    return sorted;
}
function getChunkStarts(clip) {
    let starts = clip._chunkStarts;
    if (!starts) {
        getSortedKeyframes(clip);
        starts = clip._chunkStarts;
    }
    return starts;
}
function findKeyframeIndex(chunkStarts, targetTime) {
    let low = 0;
    let high = chunkStarts.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (chunkStarts[mid] <= targetTime) {
            low = mid + 1;
        }
        else {
            high = mid;
        }
    }
    return Math.max(0, low - 1);
}
const scratchClipTransform = {
    translation: [0, 0, 0],
    rotation_quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    origin: [0, 0, 0],
};
const scratchClipResult = {
    transform: DEFAULT_TRANSFORM,
    opacity: 1.0,
};
function evaluateClipTo(clip, localTime, outResult) {
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
            if (effectiveTime < 0)
                effectiveTime += duration;
        }
        else if (localTime >= duration * iterations) {
            effectiveTime = duration;
        }
        else {
            effectiveTime = localTime % duration;
            if (effectiveTime < 0)
                effectiveTime += duration;
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
    const chunkStarts = getChunkStarts(clip);
    const idx = findKeyframeIndex(chunkStarts, effectiveTime);
    const i = Math.min(idx, lastIdx - 1);
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
    const kf = sortedKeyframes[lastIdx];
    outResult.transform = kf.transform ?? DEFAULT_TRANSFORM;
    outResult.opacity = kf.opacity ?? 1.0;
}
function flattenTimelineToMap(root, outMap) {
    outMap.clear();
    function traverse(node, parentTime) {
        const nodeStart = parentTime + node.start_time;
        if (node.instance_id) {
            outMap.set(node.instance_id, nodeStart);
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
    return outMap;
}
function resolveInstanceDelays(instances, clipMap, scheduledMap) {
    const delays = new Map();
    const instMap = new Map();
    for (const inst of instances) {
        instMap.set(inst.id, inst);
    }
    const visiting = new Set();
    function getDelay(instId) {
        if (delays.has(instId))
            return delays.get(instId);
        const inst = instMap.get(instId);
        if (!inst)
            return 0;
        if (visiting.has(instId)) {
            // Cycle detected, fallback to base delay
            return (inst.delay ?? 0) + (scheduledMap.get(instId) ?? 0);
        }
        visiting.add(instId);
        let baseDelay = (inst.delay ?? 0) + (scheduledMap.get(instId) ?? 0);
        if (inst.dependencies && inst.dependencies.length > 0) {
            for (const dep of inst.dependencies) {
                const targetInst = instMap.get(dep.target_instance_id);
                if (!targetInst)
                    continue;
                const targetDelay = getDelay(targetInst.id);
                const targetClip = clipMap.get(targetInst.clip_id);
                const targetDuration = (targetClip?.duration ?? 0) * (targetInst.duration_scale || 1.0);
                const offset = dep.offset_ms ?? 0;
                let releaseTime = targetDelay + offset;
                const trigger = dep.trigger ?? "onComplete";
                if (trigger === "onComplete") {
                    releaseTime = targetDelay + targetDuration + offset;
                }
                else if (trigger === "onStart") {
                    releaseTime = targetDelay + offset;
                }
                else if (trigger === "onKeyframe" && targetClip?.keyframes) {
                    const kfIdx = dep.keyframe_index ?? 0;
                    const sortedKfs = getSortedKeyframes(targetClip);
                    const kfTime = sortedKfs[Math.min(kfIdx, sortedKfs.length - 1)]?.time ?? 0;
                    releaseTime = targetDelay + kfTime * (targetInst.duration_scale || 1.0) + offset;
                }
                if (releaseTime > baseDelay) {
                    baseDelay = releaseTime;
                }
            }
        }
        visiting.delete(instId);
        delays.set(instId, baseDelay);
        return baseDelay;
    }
    for (const inst of instances) {
        getDelay(inst.id);
    }
    return delays;
}
export class Engine {
    clips = new Map();
    instances = [];
    rootTimeline;
    wasmInstance = null;
    devToolsEnabled = false;
    notifyingDevTools = false;
    prepared = false;
    opfsStorage = new OPFSStorage();
    jsEvaluatedBuffer;
    jsEvaluatedUintBuffer;
    lastEvaluatedFrameResult;
    dirtyFlags = EngineDirtyFlags.DIRTY_ALL;
    scratchInitialMat = new Float32Array(16);
    scratchClipMat = new Float32Array(16);
    scratchLocalMat = new Float32Array(16);
    cachedClipIndexMap = new Map();
    cachedScheduledMap = new Map();
    cachedAdditiveFlags = new Uint8Array(0);
    cachedEvaluatedInstances = [];
    cachedSubarrays = [];
    constructor(wasmInstance) {
        this.wasmInstance = wasmInstance;
        this.autoBindWasmMemory();
    }
    setWasmInstance(wasm) {
        this.wasmInstance = wasm;
        this.autoBindWasmMemory();
    }
    bindWasmMemory(memory) {
        const mem = this.resolveMemory(memory);
        if (this.wasmInstance) {
            this.wasmInstance.memory = mem;
        }
        globalThis.wasmMemory = mem;
        return this;
    }
    setWasmMemory(memory) {
        return this.bindWasmMemory(memory);
    }
    static bindWasmMemory(memory) {
        const mem = memory?.buffer ? memory : (memory?.memory || memory);
        globalThis.wasmMemory = mem;
    }
    resolveMemory(mem) {
        if (!mem)
            return null;
        if (mem.buffer)
            return mem;
        if (mem.memory?.buffer)
            return mem.memory;
        if (mem.__wasm?.memory?.buffer)
            return mem.__wasm.memory;
        return null;
    }
    autoBindWasmMemory() {
        if (!this.wasmInstance)
            return;
        if (!this.wasmInstance.memory) {
            const resolved = this.resolveMemory(this.wasmInstance) ||
                this.resolveMemory(globalThis.wasmMemory);
            if (resolved) {
                this.wasmInstance.memory = resolved;
            }
        }
        if (this.wasmInstance.memory && !globalThis.wasmMemory) {
            globalThis.wasmMemory = this.wasmInstance.memory;
        }
    }
    enableDevTools() {
        this.devToolsEnabled = true;
        if (typeof window !== "undefined") {
            window.__KEYFRAME_ENGINE_DEVTOOLS_ACTIVE__ = true;
        }
    }
    isDevToolsEnabled() {
        return this.devToolsEnabled;
    }
    addClip(clip) {
        const data = clip instanceof Clip ? clip.build() : clip;
        delete data._sortedKeyframes;
        this.clips.set(data.id, data);
        this.dirtyFlags |= EngineDirtyFlags.DIRTY_CLIPS;
        if (this.wasmInstance) {
            this.wasmInstance.add_clip_json(JSON.stringify(data));
        }
        return this;
    }
    addInstances(instances) {
        for (const inst of instances) {
            const data = inst instanceof Instance ? inst.build() : inst;
            this.instances.push(data);
            if (this.wasmInstance) {
                this.wasmInstance.add_instance_json(JSON.stringify(data));
            }
        }
        this.dirtyFlags |= EngineDirtyFlags.DIRTY_INSTANCES;
        return this;
    }
    addStack(stack, options) {
        const ir = stack.expand(options);
        for (const clip of ir.clips) {
            this.addClip(clip);
        }
        this.addInstances(ir.instances);
        return this;
    }
    setRootTimeline(node) {
        this.rootTimeline = node;
        this.dirtyFlags |= EngineDirtyFlags.DIRTY_TIMELINE;
        if (this.wasmInstance) {
            this.wasmInstance.set_root_timeline_json(JSON.stringify(node));
        }
        return this;
    }
    validateIRCompatibility() {
        for (const clip of this.clips.values()) {
            if (!clip.keyframes)
                continue;
            for (const kf of clip.keyframes) {
                if (kf.springConfig && kf.springConfig.mass !== undefined && kf.springConfig.mass !== 1.0) {
                    const massStr = Number.isInteger(kf.springConfig.mass) ? kf.springConfig.mass.toFixed(1) : kf.springConfig.mass.toString();
                    throw new TypeError(`[KeyframeEngine] Clip "${clip.id}" keyframe at t=${kf.time} uses spring mass=${massStr}.\nWASM core only supports mass=1.0 for batch evaluation.\n\nTo resolve:\n  1. Bake the animation via engine.bakeRange(), then use baked data (recommended for video/offline rendering).\n  2. Use @keyframe-engine/physics for real-time interactive springs (max ~200 instances).\n  3. Set mass to 1.0 to match WASM behavior.`);
                }
                if (kf.interpolateConfig) {
                    const cfg = kf.interpolateConfig;
                    if (cfg.extrapolate || cfg.extrapolateLeft || cfg.extrapolateRight) {
                        throw new Error(`Clip "${clip.id}" keyframe at t=${kf.time} uses extrapolate, but WASM core does not support extrapolate. To fix, choose one: → Remove extrapolate and clamp input manually → Use @keyframe-engine/bake to pre-bake this clip`);
                    }
                }
            }
        }
    }
    async prepare(options) {
        // Stage 1: Synchronous validation
        options?.onProgress?.("validation");
        this.validateIRCompatibility();
        // Stage 2: WASM loading (if no existing instance)
        if (!this.wasmInstance) {
            options?.onProgress?.("wasm_loading");
            const url = options?.wasmUrl || "https://cdn.jsdelivr.net/npm/@keyframe-engine/core/dist/pkg/keyframe_engine_bg.wasm";
            const loadPromise = (async () => {
                let instance = null;
                let exports = null;
                if (typeof WebAssembly === "undefined" || typeof fetch === "undefined") {
                    throw new Error("Environment does not support WebAssembly or fetch. Host environment must support WebAssembly and fetch API to load WASM engine module.");
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
                        }
                        catch (e) {
                            const buffer = await response.arrayBuffer();
                            const res = await WebAssembly.instantiate(buffer);
                            instance = res.instance;
                            exports = instance.exports;
                        }
                    }
                    else {
                        const buffer = await response.arrayBuffer();
                        const res = await WebAssembly.instantiate(buffer);
                        instance = res.instance;
                        exports = instance.exports;
                    }
                    this.wasmInstance = exports || instance;
                    if (exports && exports.memory) {
                        this.bindWasmMemory(exports.memory);
                    }
                    else if (instance && instance.exports && instance.exports.memory) {
                        this.bindWasmMemory(instance.exports.memory);
                    }
                }
                catch (fetchErr) {
                    throw new Error(`Failed to load WASM engine module from "${url}": ${fetchErr?.message || fetchErr}. ` +
                        "Please check CSP configuration, network connectivity, and host application environment setup.");
                }
            })();
            const timeoutMs = 30000;
            let timer = null;
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`WASM loading timeout (${timeoutMs}ms) from "${url}". Check network or host environment.`));
                }, timeoutMs);
            });
            try {
                await Promise.race([loadPromise, timeoutPromise]);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        }
        else {
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
            }
            catch (err) {
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
    cachedFrameResult;
    evaluateWasmFrame(globalTime) {
        const count = this.wasmInstance.evaluate_frame(globalTime);
        this.autoBindWasmMemory();
        const memory = this.wasmInstance.memory ?? globalThis.wasmMemory ?? this.wasmInstance.__wasm?.memory;
        if (!memory || !memory.buffer) {
            throw new ReferenceError("WASM memory not bound. Call Engine.bindWasmMemory(memory) first, " +
                "or set globalThis.wasmMemory = wasmExports.memory after initSync().");
        }
        const ptr = this.wasmInstance.get_instance_buffer_ptr() ?? 0;
        const len = this.wasmInstance.get_instance_buffer_byte_length() ?? (count * 80);
        const floatsPerInst = 20;
        const memoryBuffer = memory.buffer;
        let floatView;
        let uintView;
        if (this.cachedFrameResult &&
            this.cachedFrameResult.view &&
            this.cachedFrameResult.view.buffer === memoryBuffer &&
            this.cachedFrameResult.ptr === ptr &&
            this.cachedFrameResult.count === count &&
            this.cachedFrameResult.uintView) {
            floatView = this.cachedFrameResult.view;
            uintView = this.cachedFrameResult.uintView;
        }
        else {
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
    evaluateJSFrame(globalTime) {
        const count = this.instances.length;
        const floatsPerInst = 20;
        const totalFloats = count * floatsPerInst;
        if (!this.jsEvaluatedBuffer ||
            this.jsEvaluatedBuffer.length !== totalFloats ||
            !this.jsEvaluatedUintBuffer ||
            this.jsEvaluatedUintBuffer.length !== totalFloats) {
            this.jsEvaluatedBuffer = globalBufferPool.acquireFloat32Array(totalFloats);
            if (this.jsEvaluatedBuffer.length !== totalFloats) {
                this.jsEvaluatedBuffer = this.jsEvaluatedBuffer.subarray(0, totalFloats);
            }
            this.jsEvaluatedUintBuffer = globalBufferPool.acquireUint32Array(this.jsEvaluatedBuffer.buffer, this.jsEvaluatedBuffer.byteOffset, totalFloats);
            if (this.jsEvaluatedUintBuffer.length !== totalFloats) {
                this.jsEvaluatedUintBuffer = new Uint32Array(this.jsEvaluatedBuffer.buffer, this.jsEvaluatedBuffer.byteOffset, totalFloats);
            }
            this.dirtyFlags |= EngineDirtyFlags.DIRTY_INSTANCES;
        }
        const floatView = this.jsEvaluatedBuffer;
        const uintView = this.jsEvaluatedUintBuffer;
        if (this.dirtyFlags & EngineDirtyFlags.DIRTY_TIMELINE) {
            if (this.rootTimeline) {
                flattenTimelineToMap(this.rootTimeline, this.cachedScheduledMap);
            }
            else {
                this.cachedScheduledMap.clear();
            }
            this.dirtyFlags &= ~EngineDirtyFlags.DIRTY_TIMELINE;
        }
        if (this.dirtyFlags & EngineDirtyFlags.DIRTY_CLIPS) {
            this.cachedClipIndexMap.clear();
            let counter = 0;
            for (const clipId of this.clips.keys()) {
                this.cachedClipIndexMap.set(clipId, counter++);
            }
            this.dirtyFlags &= ~EngineDirtyFlags.DIRTY_CLIPS;
        }
        const clipIndexMap = this.cachedClipIndexMap;
        const clipMap = this.clips;
        const scheduledMap = this.cachedScheduledMap;
        const resolvedDelaysMap = resolveInstanceDelays(this.instances, clipMap, scheduledMap);
        if (this.dirtyFlags & EngineDirtyFlags.DIRTY_INSTANCES) {
            if (this.cachedAdditiveFlags.length < count) {
                this.cachedAdditiveFlags = new Uint8Array(count);
            }
            for (let i = 0; i < count; i++) {
                this.cachedAdditiveFlags[i] = isAdditiveBlendMode(this.instances[i].blend_mode) ? 1 : 0;
            }
            this.dirtyFlags &= ~EngineDirtyFlags.DIRTY_INSTANCES;
        }
        for (let i = 0; i < count; i++) {
            const inst = this.instances[i];
            const clip = clipMap.get(inst.clip_id);
            const clipIdx = clipIndexMap.get(inst.clip_id) ?? i;
            const offset = i * floatsPerInst;
            const isVisible = inst.visible ?? true;
            const delay = resolvedDelaysMap.get(inst.id) ?? (inst.delay ?? 0);
            if (!isVisible || globalTime < delay || !clip) {
                floatView[offset + 0] = 1;
                floatView[offset + 1] = 0;
                floatView[offset + 2] = 0;
                floatView[offset + 3] = 0;
                floatView[offset + 4] = 0;
                floatView[offset + 5] = 1;
                floatView[offset + 6] = 0;
                floatView[offset + 7] = 0;
                floatView[offset + 8] = 0;
                floatView[offset + 9] = 0;
                floatView[offset + 10] = 1;
                floatView[offset + 11] = 0;
                floatView[offset + 12] = 0;
                floatView[offset + 13] = 0;
                floatView[offset + 14] = 0;
                floatView[offset + 15] = 1;
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
            }
            else {
                localTime = elapsed / durationScale;
            }
            evaluateClipTo(clip, localTime, scratchClipResult);
            const clipTransform = scratchClipResult.transform;
            const clipOpacity = scratchClipResult.opacity;
            let resolvedInitialTransform = inst.initial_transform ?? DEFAULT_TRANSFORM;
            if (inst.transform_bindings && inst.transform_bindings.length > 0) {
                // Deep clone transform structure for reactive binding updates
                resolvedInitialTransform = {
                    translation: [...resolvedInitialTransform.translation],
                    rotation_quat: [...resolvedInitialTransform.rotation_quat],
                    scale: [...resolvedInitialTransform.scale],
                    origin: [...resolvedInitialTransform.origin],
                };
                for (const binding of inst.transform_bindings) {
                    const sourceInstIdx = this.instances.findIndex((item) => item.id === binding.source_instance_id);
                    if (sourceInstIdx >= 0 && sourceInstIdx < i) {
                        const sourceOffset = sourceInstIdx * floatsPerInst;
                        // Extract source evaluated matrix parameters or translation
                        const srcTx = floatView[sourceOffset + 12];
                        const srcTy = floatView[sourceOffset + 13];
                        const srcTz = floatView[sourceOffset + 14];
                        const offsetVal = binding.offset ?? 0;
                        if (binding.target_property === "initial_transform.translation.x" || binding.target_property === "translation.x") {
                            resolvedInitialTransform.translation[0] = srcTx + offsetVal;
                        }
                        else if (binding.target_property === "initial_transform.translation.y" || binding.target_property === "translation.y") {
                            resolvedInitialTransform.translation[1] = srcTy + offsetVal;
                        }
                        else if (binding.target_property === "initial_transform.translation.z" || binding.target_property === "translation.z") {
                            resolvedInitialTransform.translation[2] = srcTz + offsetVal;
                        }
                        else if (binding.target_property === "initial_transform.translation" || binding.target_property === "translation") {
                            resolvedInitialTransform.translation[0] = srcTx + offsetVal;
                            resolvedInitialTransform.translation[1] = srcTy + offsetVal;
                            resolvedInitialTransform.translation[2] = srcTz + offsetVal;
                        }
                    }
                }
            }
            writeTransformToMatrix(resolvedInitialTransform, this.scratchInitialMat, 0);
            writeTransformToMatrix(clipTransform, this.scratchClipMat, 0);
            const isInherit = inst.blend_mode === BlendMode.Inherit || inst.blend_mode === "Inherit" || inst.blend_mode === "inherit" || !!inst.inherit_from;
            let sourceInstIdx = -1;
            if (isInherit && inst.inherit_from?.source_instance_id) {
                sourceInstIdx = this.instances.findIndex((item) => item.id === inst.inherit_from.source_instance_id);
            }
            const isAdditive = this.cachedAdditiveFlags[i] === 1;
            if (isInherit && sourceInstIdx >= 0 && sourceInstIdx < i) {
                const sourceOffset = sourceInstIdx * floatsPerInst;
                multiplyMatricesTo(this.scratchInitialMat, 0, this.scratchClipMat, 0, this.scratchLocalMat, 0);
                const tracks = inst.inherit_from?.property_tracks;
                const inheritTransform = !tracks || tracks.length === 0 || tracks.includes("transform") || tracks.includes("transform_matrix");
                const inheritOpacity = !tracks || tracks.length === 0 || tracks.includes("opacity");
                if (inheritTransform) {
                    multiplyMatricesTo(floatView, sourceOffset, this.scratchLocalMat, 0, floatView, offset);
                }
                else {
                    multiplyMatricesTo(this.scratchInitialMat, 0, this.scratchClipMat, 0, floatView, offset);
                }
                const sourceOpacity = floatView[sourceOffset + 16];
                const instOpacity = inst.opacity ?? 1.0;
                if (inheritOpacity) {
                    floatView[offset + 16] = sourceOpacity * instOpacity * clipOpacity;
                }
                else {
                    floatView[offset + 16] = instOpacity * clipOpacity;
                }
            }
            else if (!isAdditive) {
                multiplyMatricesTo(this.scratchInitialMat, 0, this.scratchClipMat, 0, floatView, offset);
                const instOpacity = inst.opacity ?? 1.0;
                floatView[offset + 16] = instOpacity * clipOpacity;
            }
            else {
                for (let k = 0; k < 16; k++) {
                    const identityVal = k % 5 === 0 ? 1 : 0;
                    floatView[offset + k] = this.scratchInitialMat[k] + (this.scratchClipMat[k] - identityVal);
                }
                const instOpacity = inst.opacity ?? 1.0;
                floatView[offset + 16] = instOpacity * clipOpacity;
            }
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
        }
        else {
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
    evaluateFrame(globalTime) {
        if (!this.prepared) {
            throw new Error("Engine not prepared");
        }
        let result;
        if (this.wasmInstance) {
            result = this.evaluateWasmFrame(globalTime);
        }
        else {
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
    getEvaluatedInstances(globalTime, skipEvaluate = false, evalResultParam) {
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
                }
                else if (this.wasmInstance && this.prepared) {
                    evalResult = this.evaluateWasmFrame(globalTime);
                }
                else {
                    evalResult = this.evaluateJSFrame(globalTime);
                }
            }
            else {
                evalResult = this.evaluateFrame(globalTime);
            }
        }
        const count = evalResult.count;
        const floatView = evalResult.view;
        const uintView = evalResult.uintView;
        const floatsPerInst = evalResult.floatsPerInstance || 20;
        const pooledInstances = globalInstancePool.acquire(count);
        if (this.cachedEvaluatedInstances.length !== count) {
            this.cachedEvaluatedInstances.length = count;
        }
        for (let i = 0; i < count; i++) {
            const offset = i * floatsPerInst;
            const expectedByteOffset = floatView.byteOffset + offset * 4;
            let transformMatrix = this.cachedSubarrays[i];
            if (!transformMatrix ||
                transformMatrix.buffer !== floatView.buffer ||
                transformMatrix.byteOffset !== expectedByteOffset) {
                transformMatrix = floatView.subarray(offset, offset + 16);
                this.cachedSubarrays[i] = transformMatrix;
            }
            const instData = this.instances[i];
            let item = this.cachedEvaluatedInstances[i];
            if (!item) {
                item = pooledInstances[i];
                this.cachedEvaluatedInstances[i] = item;
            }
            item.id = instData?.id;
            item.clipId = instData?.clip_id;
            item.transformMatrix = transformMatrix;
            item.opacity = floatView[offset + 16];
            item.visible = uintView ? uintView[offset + 17] === 1 : floatView[offset + 17] === 1;
            item.clipIndex = uintView ? uintView[offset + 18] : floatView[offset + 18];
            if (instData?.clip_id && this.clips.has(instData.clip_id)) {
                const clip = this.clips.get(instData.clip_id);
                const kfs = clip.keyframes || [];
                if (kfs.length > 0) {
                    const customTracks = {};
                    if (clip.metadata) {
                        for (const [k, v] of Object.entries(clip.metadata)) {
                            if (k !== "id" && k !== "duration" && PropertyTrackRegistry.get(k)) {
                                customTracks[k] = v;
                            }
                        }
                    }
                    const localTime = Math.max(0, globalTime - instData.delay);
                    if (kfs.length === 1) {
                        if (kfs[0].custom_tracks)
                            Object.assign(customTracks, kfs[0].custom_tracks);
                    }
                    else {
                        let kfIdx = 0;
                        while (kfIdx < kfs.length - 1 && kfs[kfIdx + 1].time <= localTime) {
                            kfIdx++;
                        }
                        const kf1 = kfs[kfIdx];
                        const kf2 = kfs[Math.min(kfIdx + 1, kfs.length - 1)];
                        const span = kf2.time - kf1.time;
                        const factor = span > 0 ? evaluateEasing(kf1.easing, kf1.cubic_params, (localTime - kf1.time) / span) : 1.0;
                        if (kf1.custom_tracks || kf2.custom_tracks) {
                            const allTrackKeys = new Set([
                                ...Object.keys(kf1.custom_tracks || {}),
                                ...Object.keys(kf2.custom_tracks || {}),
                            ]);
                            for (const trKey of allTrackKeys) {
                                const v1 = kf1.custom_tracks?.[trKey];
                                const v2 = kf2.custom_tracks?.[trKey] ?? v1;
                                if (v1 !== undefined) {
                                    customTracks[trKey] = PropertyTrackRegistry.interpolate(trKey, v1, v2, factor);
                                }
                            }
                        }
                    }
                    item.custom_tracks = Object.keys(customTracks).length > 0 ? customTracks : undefined;
                }
            }
        }
        return this.cachedEvaluatedInstances;
    }
    notifyDevTools(globalTime, evaluatedInstances) {
        if (typeof window !== "undefined" && window.postMessage) {
            window.postMessage({
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
            }, "*");
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
    bakeChunk(startMs, endMs, fps = 30) {
        if (this.wasmInstance && this.wasmInstance.bake_chunk) {
            return this.wasmInstance.bake_chunk(startMs, endMs, fps);
        }
        else if (this.wasmInstance && this.wasmInstance.bake_range) {
            return this.wasmInstance.bake_range(startMs, endMs, fps);
        }
        const frameDuration = 1000 / Math.max(1, fps);
        const chunks = [];
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
    bakeRange(startMs, endMs, fps = 30) {
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
    async bakeStream(options, onChunk) {
        const startMs = options.startMs ?? options.start ?? 0;
        const endMs = options.endMs ?? (startMs + (options.duration ?? 0));
        const fps = options.fps ?? 30;
        const isAsync = onChunk.constructor.name === "AsyncFunction" ||
            (onChunk.toString && onChunk.toString().startsWith("async"));
        // If onChunk is synchronous and WASM bake_stream is available, use fast synchronous WASM stream
        if (!isAsync && this.wasmInstance && typeof this.wasmInstance.bake_stream === "function") {
            const res = this.wasmInstance.bake_stream(startMs, endMs, fps, (chunk) => {
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
                }
                else {
                    chunkBuffer.set(frameBytes, 0);
                    chunkOffset = frameBytes.byteLength;
                }
            }
            else {
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
    static decodeBakedChunk(data) {
        const bytesPerInstance = 80;
        const count = Math.floor(data.byteLength / bytesPerInstance);
        const result = [];
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
    exportIR() {
        return {
            clips: Array.from(this.clips.values()),
            instances: [...this.instances],
            root_timeline: this.rootTimeline,
        };
    }
    importIR(ir) {
        this.clips.clear();
        this.instances = [];
        this.cachedClipIndexMap.clear();
        this.cachedScheduledMap.clear();
        this.cachedSubarrays.length = 0;
        this.cachedEvaluatedInstances.length = 0;
        this.dirtyFlags |= EngineDirtyFlags.DIRTY_ALL;
        for (const c of ir.clips) {
            this.addClip(c);
        }
        this.addInstances(ir.instances);
        if (ir.root_timeline) {
            this.setRootTimeline(ir.root_timeline);
        }
    }
}
