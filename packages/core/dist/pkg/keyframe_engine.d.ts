/* tslint:disable */
/* eslint-disable */

export enum BlendMode {
    Override = 0,
    Additive = 1,
    Inherit = 2,
}

export enum EasingType {
    Linear = 0,
    Ease = 1,
    EaseIn = 2,
    EaseOut = 3,
    EaseInOut = 4,
    CubicBezier = 5,
    Step = 6,
    BounceIn = 7,
    BounceOut = 8,
    BounceInOut = 9,
    ElasticIn = 10,
    ElasticOut = 11,
    ElasticInOut = 12,
    BackIn = 13,
    BackOut = 14,
    BackInOut = 15,
    ExpoIn = 16,
    ExpoOut = 17,
    ExpoInOut = 18,
    SineIn = 19,
    SineOut = 20,
    SineInOut = 21,
    SpringEasing = 22,
}

export class KeyframeEngine {
    free(): void;
    [Symbol.dispose](): void;
    add_clip_json(clip_json: string): void;
    add_instance_json(instance_json: string): void;
    bake_chunk(start_ms: number, end_ms: number, fps: number): Uint8Array;
    bake_range(start_ms: number, end_ms: number, fps: number): Uint8Array;
    bake_stream(start_ms: number, end_ms: number, fps: number, on_chunk: Function): number;
    evaluate_frame(global_time: number): number;
    export_ir_json(): string;
    get_instance_buffer_byte_length(): number;
    get_instance_buffer_ptr(): number;
    import_ir_json(ir_json: string): void;
    instance_size(): number;
    interpolate(value: number, input_range: Float64Array, output_range: Float64Array): number;
    interpolate_extrapolate(value: number, input_range: Float64Array, output_range: Float64Array, extrapolate_left: string, extrapolate_right: string): number;
    interpolate_opts(value: number, input_range: Float64Array, output_range: Float64Array, opts_json: string): number;
    interpolate_path_3d(p0: Float32Array, p1: Float32Array, p2: Float32Array, p3: Float32Array, t: number): Float32Array;
    constructor();
    prepare(): void;
    set_root_timeline_json(timeline_json: string): void;
    spring_solver(frame: number, fps: number, damping: number, stiffness: number): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_keyframeengine_free: (a: number, b: number) => void;
    readonly keyframeengine_add_clip_json: (a: number, b: number, c: number) => [number, number];
    readonly keyframeengine_add_instance_json: (a: number, b: number, c: number) => [number, number];
    readonly keyframeengine_bake_chunk: (a: number, b: number, c: number, d: number) => [number, number];
    readonly keyframeengine_bake_stream: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly keyframeengine_evaluate_frame: (a: number, b: number) => number;
    readonly keyframeengine_export_ir_json: (a: number) => [number, number, number, number];
    readonly keyframeengine_get_instance_buffer_byte_length: (a: number) => number;
    readonly keyframeengine_get_instance_buffer_ptr: (a: number) => number;
    readonly keyframeengine_import_ir_json: (a: number, b: number, c: number) => [number, number];
    readonly keyframeengine_instance_size: (a: number) => number;
    readonly keyframeengine_interpolate: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly keyframeengine_interpolate_extrapolate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly keyframeengine_interpolate_opts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly keyframeengine_interpolate_path_3d: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly keyframeengine_new: () => number;
    readonly keyframeengine_prepare: (a: number) => [number, number];
    readonly keyframeengine_set_root_timeline_json: (a: number, b: number, c: number) => [number, number];
    readonly keyframeengine_spring_solver: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly keyframeengine_bake_range: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
