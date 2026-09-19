import { AnimationClipData, KeyframeData } from "./types.js";
import { Keyframe } from "./keyframe.js";
export declare class Clip {
    id: string;
    private _duration;
    private _iterations;
    private _keyframes;
    private _metadata?;
    constructor(id: string);
    duration(d: number): this;
    metadata(data: Record<string, any>): this;
    iterations(i: number): this;
    addKeyframe(kf: Keyframe | KeyframeData): this;
    build(): AnimationClipData;
}
