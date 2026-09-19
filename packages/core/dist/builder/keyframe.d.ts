import { Easing, KeyframeData, CubicBezierParams, TransformData, SpringConfig, InterpolateConfig } from "./types.js";
export declare class Keyframe {
    private data;
    constructor(time: number);
    transform(t: TransformData): this;
    opacity(o: number): this;
    easing(e: Easing, cubicParams?: CubicBezierParams): this;
    springConfig(config: SpringConfig): this;
    interpolateConfig(config: InterpolateConfig): this;
    build(): KeyframeData;
}
