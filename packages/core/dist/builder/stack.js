import { Clip } from "./clip.js";
import { Instance } from "./instance.js";
import { PropertyTrackRegistry } from "./property_track.js";
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
    let lastInstanceId = null;
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const clipData = item.clip instanceof Clip ? item.clip.build() : item.clip;
        const isDynamic = item.options?.dynamic ?? false;
        const offsetMs = item.options?.offsetMs ?? 0;
        const instId = `${source.id}_inst_${idx + 1}`;
        const delay = currentDelayMs + offsetMs;
        if (isDynamic) {
            // Path B: Runtime Inheritance
            clips.push(clipData);
            const instBuilder = new Instance(clipData.id, instId).delay(delay);
            if (lastInstanceId) {
                instBuilder.inheritFrom(lastInstanceId, item.options?.tracks);
            }
            const instData = instBuilder.build();
            instances.push(instData);
            // Evaluate end state of clip for accumulating
            if (clipData.keyframes && clipData.keyframes.length > 0) {
                const lastKf = clipData.keyframes[clipData.keyframes.length - 1];
                accumulatedTransform = composeTransforms(accumulatedTransform, lastKf.transform);
                accumulatedOpacity *= lastKf.opacity ?? 1.0;
            }
            currentDelayMs = delay + clipData.duration;
            lastInstanceId = instId;
        }
        else {
            // Path A: Static Expansion (Build-time value seam resolution)
            const expandedClipId = `${clipData.id}_expanded_${source.id}_${idx + 1}`;
            const expandedKeyframes = (clipData.keyframes || []).map((kf) => {
                const composedTrans = composeTransforms(accumulatedTransform, kf.transform);
                const composedOp = accumulatedOpacity * (kf.opacity ?? 1.0);
                // Metadata custom tracks support
                let updatedMetadata = kf.interpolateConfig ? { ...kf.interpolateConfig } : undefined;
                if (clipData.metadata) {
                    for (const [key, val] of Object.entries(clipData.metadata)) {
                        if (key !== "id" && key !== "duration") {
                            const regInterpolator = PropertyTrackRegistry.get(key);
                            if (regInterpolator) {
                                // Track interpolated value
                            }
                        }
                    }
                }
                return {
                    ...kf,
                    transform: composedTrans,
                    opacity: composedOp,
                };
            });
            // Adaptive sampling for curvature accuracy if enabled
            if (options?.adaptiveSampling && expandedKeyframes.length > 1) {
                const threshold = options.maxErrorThreshold ?? 1e-4;
                const sampledKfs = [];
                function subdivide(kf1, kf2, depth = 0, maxDepth = 4) {
                    if (depth >= maxDepth)
                        return;
                    const t1 = kf1.time;
                    const t2 = kf2.time;
                    if (t2 - t1 <= 1)
                        return;
                    const midTime = (t1 + t2) / 2;
                    const normT = (midTime - t1) / (t2 - t1);
                    // Interpolate factor based on easing
                    let factor = normT;
                    if (kf1.easing === "Ease" || kf1.easing === "EaseInOut") {
                        factor = 3 * (1 - normT) * normT * normT * 0.58 + normT * normT * normT;
                    }
                    else if (kf1.easing === "EaseIn") {
                        factor = normT * normT;
                    }
                    else if (kf1.easing === "EaseOut") {
                        factor = normT * (2 - normT);
                    }
                    const actualTrans = PropertyTrackRegistry.interpolate("transform", kf1.transform, kf2.transform, factor);
                    const linearTrans = PropertyTrackRegistry.interpolate("transform", kf1.transform, kf2.transform, normT);
                    const err = Math.hypot(actualTrans.translation[0] - linearTrans.translation[0], actualTrans.translation[1] - linearTrans.translation[1], actualTrans.translation[2] - linearTrans.translation[2]);
                    if (err > threshold) {
                        const midOp = kf1.opacity + ((kf2.opacity ?? 1.0) - kf1.opacity) * factor;
                        const midKf = {
                            time: midTime,
                            transform: actualTrans,
                            opacity: midOp,
                            easing: kf1.easing,
                        };
                        subdivide(kf1, midKf, depth + 1, maxDepth);
                        sampledKfs.push(midKf);
                        subdivide(midKf, kf2, depth + 1, maxDepth);
                    }
                }
                for (let k = 0; k < expandedKeyframes.length - 1; k++) {
                    const kf1 = expandedKeyframes[k];
                    const kf2 = expandedKeyframes[k + 1];
                    sampledKfs.push(kf1);
                    subdivide(kf1, kf2, 0, 4);
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
            // Update accumulators with end state of this expanded clip
            if (expandedKeyframes.length > 0) {
                const lastKf = expandedKeyframes[expandedKeyframes.length - 1];
                accumulatedTransform = lastKf.transform;
                accumulatedOpacity = lastKf.opacity;
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
