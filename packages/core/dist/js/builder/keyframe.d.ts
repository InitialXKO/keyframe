import { Easing, KeyframeData, CubicBezierParams, TransformData } from "./types.js";
export declare class Keyframe {
    private data;
    constructor(time: number);
    transform(t: TransformData): this;
    opacity(o: number): this;
    easing(e: Easing, cubicParams?: CubicBezierParams): this;
    build(): KeyframeData;
}
