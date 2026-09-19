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
    constructor(clipId: string, id?: string);
    opacity(o: number): this;
    visible(v: boolean): this;
    delay(d: number): this;
    durationScale(s: number): this;
    timeRemappingSpeed(speed: number): this;
    blendMode(mode: BlendMode): this;
    initialTransform(t: TransformData): this;
    build(): InstanceData;
}
