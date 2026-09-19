import { BlendMode, InstanceData, TransformData } from "./types.js";
export declare class Instance {
    id: string;
    clipId: string;
    private _opacity;
    private _visible;
    private _delay;
    private _durationScale;
    private _timeRemappingSpeed;
    private _blendMode;
    private _initialTransform;
    private _dependencies;
    private _transformBindings;
    constructor(clipId: string, id?: string);
    opacity(o: number): this;
    visible(v: boolean): this;
    delay(d: number): this;
    durationScale(s: number): this;
    timeRemappingSpeed(speed: number): this;
    blendMode(mode: BlendMode): this;
    initialTransform(t: TransformData): this;
    dependsOn(targetInstanceId: string, options?: {
        trigger?: "onComplete" | "onStart" | "onKeyframe" | string;
        keyframeIndex?: number;
        offsetMs?: number;
    }): this;
    bindTransformFrom(sourceInstanceId: string, options: {
        sourceProperty: string;
        targetProperty: string;
        offset?: number;
    }): this;
    build(): InstanceData;
}
