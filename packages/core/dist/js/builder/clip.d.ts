import { AnimationClipData, Easing, KeyframeData } from "./types.js";
import { Keyframe } from "./keyframe.js";
export declare class Clip {
    id: string;
    private _duration;
    private _easing;
    private _iterations;
    private _keyframes;
    constructor(id: string);
    duration(d: number): this;
    easing(e: Easing): this;
    iterations(i: number): this;
    addKeyframe(kf: Keyframe | KeyframeData): this;
    build(): AnimationClipData;
}
