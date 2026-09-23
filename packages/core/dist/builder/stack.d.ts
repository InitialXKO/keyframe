import { AnimationClipData, EngineIR } from "./types.js";
import { Clip } from "./clip.js";
export interface StackItemOptions {
    dynamic?: boolean;
    offsetMs?: number;
    tracks?: string[];
}
export declare class AnimationStack {
    id: string;
    private _items;
    constructor(id: string);
    add(clip: Clip | AnimationClipData, options?: StackItemOptions): this;
    getItems(): Array<{
        clip: Clip | AnimationClipData;
        options?: StackItemOptions;
    }>;
    expand(options?: {
        adaptiveSampling?: boolean;
        maxErrorThreshold?: number;
    }): EngineIR;
}
export interface ExpandOptions {
    adaptiveSampling?: boolean;
    maxErrorThreshold?: number;
}
export declare function expandStack(source: AnimationStack | EngineIR, options?: ExpandOptions): EngineIR;
