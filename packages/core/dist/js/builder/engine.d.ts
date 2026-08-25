import { AnimationClipData, EngineIR, EvaluatedInstance, InstanceData, TimelineNodeData } from "./types.js";
import { Clip } from "./clip.js";
export { EvaluatedInstance } from "./types.js";
import { Instance } from "./instance.js";
export declare class Engine {
    private clips;
    private instances;
    private rootTimeline?;
    private wasmInstance;
    private devToolsEnabled;
    private notifyingDevTools;
    constructor(wasmInstance?: any);
    setWasmInstance(wasm: any): void;
    enableDevTools(): void;
    isDevToolsEnabled(): boolean;
    addClip(clip: Clip | AnimationClipData): this;
    addInstances(instances: (Instance | InstanceData)[]): this;
    setRootTimeline(node: TimelineNodeData): this;
    prepare(): Promise<void>;
    evaluateFrame(globalTime: number): any;
    getEvaluatedInstances(globalTime: number, skipEvaluate?: boolean): EvaluatedInstance[];
    private notifyDevTools;
    bakeChunk(startMs: number, endMs: number, fps?: number): Uint8Array;
    bakeRange(startMs: number, endMs: number, fps?: number): Uint8Array;
    exportIR(): EngineIR;
    importIR(ir: EngineIR): void;
}
