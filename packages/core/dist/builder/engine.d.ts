import { AnimationClipData, CubicBezierParams, Easing, EngineIR, EvaluatedFrameResult, EvaluatedInstance, InstanceData, PrepareOptions, TimelineNodeData } from "./types.js";
import { Clip } from "./clip.js";
import { AnimationStack, ExpandOptions } from "./stack.js";
export { EvaluatedInstance, EvaluatedFrameResult, PrepareOptions } from "./types.js";
import { Instance } from "./instance.js";
export declare function solveSpringJS(frame: number, fps: number, damping: number, stiffness: number, mass: number): number;
export declare function evaluateEasing(easing: Easing, cubicParams: CubicBezierParams | undefined, t: number): number;
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
    private jsEvaluatedUintBuffer?;
    private lastEvaluatedFrameResult?;
    private dirtyFlags;
    private scratchInitialMat;
    private scratchClipMat;
    private scratchLocalMat;
    private cachedClipIndexMap;
    private cachedScheduledMap;
    private cachedAdditiveFlags;
    private cachedEvaluatedInstances;
    private cachedSubarrays;
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
    addStack(stack: AnimationStack, options?: ExpandOptions): this;
    setRootTimeline(node: TimelineNodeData): this;
    private validateIRCompatibility;
    prepare(options?: PrepareOptions): Promise<void>;
    private cachedFrameResult?;
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
    /**
     * Bakes animation frames across the specified time range (`startMs` to `endMs`) at the given `fps`.
     * Returns a contiguous `Uint8Array` binary chunk where each instance frame is packed as an 80-byte structure.
     *
     * Binary layout per 80-byte instance (matching `#[repr(C, align(16))] GpuInstanceData`):
     * - 0..64 bytes (16 x Float32): 4x4 column-major transform matrix (`transform_matrix`)
     * - 64..68 bytes (1 x Float32): opacity (`opacity`)
     * - 68..72 bytes (1 x Uint32): visibility flag (`visible`, 1 for visible / true, 0 for hidden / false)
     * - 72..76 bytes (1 x Uint32): clip index (`clip_index`)
     * - 76..80 bytes (4 bytes): 16-byte alignment padding (`_padding`)
     *
     * To reverse-decode raw baked bytes back into structured `EvaluatedInstance[]`, use `Engine.decodeBakedChunk(data)`.
     */
    bakeChunk(startMs: number, endMs: number, fps?: number): Uint8Array;
    /**
     * Alias for `bakeChunk(startMs, endMs, fps)`.
     */
    bakeRange(startMs: number, endMs: number, fps?: number): Uint8Array;
    /**
     * Streams animation baking frame-by-frame or chunk-by-chunk directly to a callback.
     * Peak memory footprint remains constant (~64KB) regardless of overall duration or instance count.
     *
     * @param options Streaming bake options (start/endMs or start/duration, fps)
     * @param onChunk Callback receiving zero-copy (or chunked) Uint8Array binary views. Returning `false` aborts streaming.
     * @returns Total bytes processed.
     */
    bakeStream(options: {
        start?: number;
        startMs?: number;
        duration?: number;
        endMs?: number;
        fps?: number;
    }, onChunk: (chunk: Uint8Array) => boolean | void | Promise<boolean | void>): Promise<number>;
    /**
     * Decodes raw binary chunk bytes produced by `bakeChunk` or loaded from storage back into an array of `EvaluatedInstance` objects.
     *
     * Parses 80-byte `GpuInstanceData` blocks:
     * - `transformMatrix`: 4x4 Float32Array (16 floats)
     * - `opacity`: Float32 at byte offset 64
     * - `visible`: Boolean flag derived from Uint32 at byte offset 68 (`=== 1`)
     * - `clipIndex`: Uint32 at byte offset 72
     *
     * @param data The binary Uint8Array containing packed GpuInstanceData blocks.
     * @returns Array of decoded `EvaluatedInstance` items.
     */
    static decodeBakedChunk(data: Uint8Array): EvaluatedInstance[];
    exportIR(): EngineIR;
    importIR(ir: EngineIR): void;
}
