import { AnimationClipData, EngineIR, EvaluatedFrameResult, EvaluatedInstance, InstanceData, PrepareOptions, TimelineNodeData } from "./types.js";
import { Clip } from "./clip.js";
export { EvaluatedInstance, EvaluatedFrameResult, PrepareOptions } from "./types.js";
import { Instance } from "./instance.js";
export declare class Engine {
    private clips;
    private instances;
    private rootTimeline?;
    private wasmInstance;
    private devToolsEnabled;
    private notifyingDevTools;
    private prepared;
    private opfsStorage;
    private jsEvaluatedBuffer?;
    private lastEvaluatedFrameResult?;
    constructor(wasmInstance?: any);
    setWasmInstance(wasm: any): void;
    bindWasmMemory(memory: any): this;
    setWasmMemory(memory: any): this;
    static bindWasmMemory(memory: any): void;
    private resolveMemory;
    private autoBindWasmMemory;
    enableDevTools(): void;
    isDevToolsEnabled(): boolean;
    addClip(clip: Clip | AnimationClipData): this;
    addInstances(instances: (Instance | InstanceData)[]): this;
    setRootTimeline(node: TimelineNodeData): this;
    private validateIRCompatibility;
    prepare(options?: PrepareOptions): Promise<void>;
    private evaluateWasmFrame;
    private evaluateJSFrame;
    /**
     * Evaluates the engine animation state at `globalTime` (in milliseconds).
     * Directly returns a zero-copy raw TypedArray view pointing to WASM memory buffer (or contiguous JS buffer),
     * along with pointer/offset and instance count.
     */
    evaluateFrame(globalTime: number): EvaluatedFrameResult;
    /**
     * Evaluates and returns the array of `EvaluatedInstance` objects at `globalTime` (in milliseconds).
     *
     * Each `EvaluatedInstance` includes `transformMatrix` (a zero-copy subarray view over the evaluation buffer),
     * `opacity`, `visible`, and instance/clip identifiers.
     * @param globalTime The global time in milliseconds.
     * @param skipEvaluate If `true`, re-evaluation of the WASM frame is skipped.
     * @param evalResultParam Optional pre-computed evaluation frame result.
     */
    getEvaluatedInstances(globalTime: number, skipEvaluate?: boolean, evalResultParam?: EvaluatedFrameResult): EvaluatedInstance[];
    private notifyDevTools;
    bakeChunk(startMs: number, endMs: number, fps?: number): Uint8Array;
    bakeRange(startMs: number, endMs: number, fps?: number): Uint8Array;
    exportIR(): EngineIR;
    importIR(ir: EngineIR): void;
}
