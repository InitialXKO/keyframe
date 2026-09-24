import { Clip } from "./clip.js";
import { Instance } from "./instance.js";
import { PropertyTrackRegistry, interpolateTransform } from "./property_track.js";
import { evaluateEasing, solveSpringJS } from "./engine.js";
function multiplyQuat(a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}
function composeTransforms(accum, curr) {
    return {
        translation: [
            accum.translation[0] + curr.translation[0],
            accum.translation[1] + curr.translation[1],
            accum.translation[2] + curr.translation[2],
        ],
        rotation_quat: multiplyQuat(accum.rotation_quat, curr.rotation_quat),
        scale: [
            accum.scale[0] * curr.scale[0],
            accum.scale[1] * curr.scale[1],
            accum.scale[2] * curr.scale[2],
        ],
        origin: [
            accum.origin[0] + curr.origin[0],
            accum.origin[1] + curr.origin[1],
            accum.origin[2] + curr.origin[2],
        ],
    };
}
function computeMaxTransformError(a, b) {
    let maxErr = 0;
    for (let i = 0; i < 3; i++) {
        maxErr = Math.max(maxErr, Math.abs(a.translation[i] - b.translation[i]));
        maxErr = Math.max(maxErr, Math.abs(a.scale[i] - b.scale[i]));
        maxErr = Math.max(maxErr, Math.abs(a.origin[i] - b.origin[i]));
    }
    for (let i = 0; i < 4; i++) {
        maxErr = Math.max(maxErr, Math.abs(a.rotation_quat[i] - b.rotation_quat[i]));
    }
    return maxErr;
}
function subdivideSegment(kf1, kf2, threshold, depth, maxDepth = 4) {
    if (depth >= maxDepth)
        return [];
    const midTime = (kf1.time + kf2.time) / 2;
    const rawProgress = (midTime - kf1.time) / Math.max(1e-6, kf2.time - kf1.time);
    let trueFactor = rawProgress;
    if (kf1.springConfig) {
        const elapsedSec = (midTime - kf1.time) / 1000;
        const cfg = kf1.springConfig;
        trueFactor = solveSpringJS(elapsedSec * 30, 30, cfg.damping ?? 10, cfg.stiffness ?? 100, cfg.mass ?? 1);
    }
    else if (kf1.easing) {
        trueFactor = evaluateEasing(kf1.easing, kf1.cubic_params, rawProgress);
    }
    const lerpTrans = interpolateTransform(kf1.transform, kf2.transform, rawProgress);
    const trueTrans = interpolateTransform(kf1.transform, kf2.transform, trueFactor);
    const error = computeMaxTransformError(trueTrans, lerpTrans);
    if (error > threshold || (depth === 0 && kf1.easing !== "Linear")) {
        const midKf = {
            time: midTime,
            transform: trueTrans,
            opacity: kf1.opacity + (kf2.opacity - kf1.opacity) * trueFactor,
            easing: kf1.easing,
            cubic_params: kf1.cubic_params,
            springConfig: kf1.springConfig,
        };
        const leftSub = subdivideSegment(kf1, midKf, threshold, depth + 1, maxDepth);
        const rightSub = subdivideSegment(midKf, kf2, threshold, depth + 1, maxDepth);
        return [...leftSub, midKf, ...rightSub];
    }
    return [];
}
export class AnimationStack {
    id;
    _items = [];
    constructor(id) {
        this.id = id;
    }
    add(clip, options) {
        this._items.push({ clip, options });
        return this;
    }
    getItems() {
        return [...this._items];
    }
    expand(options) {
        return expandStack(this, options);
    }
}
export function expandStack(source, options) {
    // Idempotent check: if passed an EngineIR, return as-is
    if (!(source instanceof AnimationStack)) {
        return source;
    }
    const items = source.getItems();
    const clips = [];
    const instances = [];
    let currentDelayMs = 0;
    let accumulatedTransform = {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        origin: [0, 0, 0],
    };
    let accumulatedOpacity = 1.0;
    let accumulatedCustomTracks = {};
    let lastInstanceId = null;
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const clipData = item.clip instanceof Clip ? item.clip.build() : item.clip;
        const isDynamic = item.options?.dynamic ?? false;
        const offsetMs = item.options?.offsetMs ?? 0;
        const instId = `${source.id}_inst_${idx + 1}`;
        const delay = currentDelayMs + offsetMs;
        // Helper to compute exact end-state transform & opacity at clip.duration
        const computeClipEndState = () => {
            const kfs = clipData.keyframes || [];
            if (kfs.length === 0) {
                return { transform: accumulatedTransform, opacity: accumulatedOpacity };
            }
            const lastKf = kfs[kfs.length - 1];
            let endLocalTrans = lastKf.transform;
            if (kfs.length >= 2 && lastKf.springConfig) {
                const prevKf = kfs[kfs.length - 2];
                const durationMs = clipData.duration - prevKf.time;
                if (durationMs > 0) {
                    const cfg = lastKf.springConfig;
                    const springFactor = solveSpringJS((durationMs / 1000) * 30, 30, cfg.damping ?? 10, cfg.stiffness ?? 100, cfg.mass ?? 1);
                    endLocalTrans = interpolateTransform(prevKf.transform, lastKf.transform, springFactor);
                }
            }
            return {
                transform: isDynamic ? composeTransforms(accumulatedTransform, endLocalTrans) : endLocalTrans,
                opacity: isDynamic ? accumulatedOpacity * (lastKf.opacity ?? 1.0) : lastKf.opacity ?? 1.0,
            };
        };
        if (isDynamic) {
            // Path B: Runtime Inheritance
            clips.push(clipData);
            const instBuilder = new Instance(clipData.id, instId).delay(delay);
            if (lastInstanceId) {
                instBuilder.inheritFrom(lastInstanceId, item.options?.tracks);
            }
            const instData = instBuilder.build();
            instances.push(instData);
            const endState = computeClipEndState();
            accumulatedTransform = endState.transform;
            accumulatedOpacity = endState.opacity;
            currentDelayMs = delay + clipData.duration;
            lastInstanceId = instId;
        }
        else {
            // Path A: Static Expansion (Build-time value seam resolution)
            const expandedClipId = `${clipData.id}_expanded_${source.id}_${idx + 1}`;
            const expandedKeyframes = (clipData.keyframes || []).map((kf) => {
                const composedTrans = composeTransforms(accumulatedTransform, kf.transform);
                const composedOp = accumulatedOpacity * (kf.opacity ?? 1.0);
                // Metadata and custom property track interpolation support
                const composedCustomTracks = { ...accumulatedCustomTracks };
                if (kf.custom_tracks) {
                    for (const [trackName, val] of Object.entries(kf.custom_tracks)) {
                        const accVal = accumulatedCustomTracks[trackName];
                        composedCustomTracks[trackName] = accVal !== undefined
                            ? PropertyTrackRegistry.interpolate(trackName, accVal, val, 1.0)
                            : val;
                    }
                }
                if (clipData.metadata) {
                    for (const [key, val] of Object.entries(clipData.metadata)) {
                        if (key !== "id" && key !== "duration") {
                            const regInterpolator = PropertyTrackRegistry.get(key);
                            if (regInterpolator) {
                                const accVal = accumulatedCustomTracks[key];
                                composedCustomTracks[key] = accVal !== undefined
                                    ? PropertyTrackRegistry.interpolate(key, accVal, val, 1.0)
                                    : val;
                            }
                        }
                    }
                }
                return {
                    ...kf,
                    transform: composedTrans,
                    opacity: composedOp,
                    custom_tracks: Object.keys(composedCustomTracks).length > 0 ? composedCustomTracks : undefined,
                };
            });
            // Adaptive sampling for curvature accuracy if enabled
            if (options?.adaptiveSampling && expandedKeyframes.length > 1) {
                const threshold = options.maxErrorThreshold ?? 1e-4;
                const sampledKfs = [];
                for (let k = 0; k < expandedKeyframes.length - 1; k++) {
                    const kf1 = expandedKeyframes[k];
                    const kf2 = expandedKeyframes[k + 1];
                    sampledKfs.push(kf1);
                    const subKfs = subdivideSegment(kf1, kf2, threshold, 0);
                    sampledKfs.push(...subKfs);
                }
                sampledKfs.push(expandedKeyframes[expandedKeyframes.length - 1]);
                expandedKeyframes.length = 0;
                expandedKeyframes.push(...sampledKfs);
            }
            const expandedClip = {
                ...clipData,
                id: expandedClipId,
                keyframes: expandedKeyframes,
            };
            clips.push(expandedClip);
            const instData = new Instance(expandedClipId, instId)
                .delay(delay)
                .build();
            instances.push(instData);
            const endState = computeClipEndState();
            accumulatedTransform = endState.transform;
            accumulatedOpacity = endState.opacity;
            if (expandedKeyframes.length > 0) {
                const lastKf = expandedKeyframes[expandedKeyframes.length - 1];
                if (lastKf.custom_tracks) {
                    Object.assign(accumulatedCustomTracks, lastKf.custom_tracks);
                }
            }
            currentDelayMs = delay + clipData.duration;
            lastInstanceId = instId;
        }
    }
    return {
        clips,
        instances,
    };
}
