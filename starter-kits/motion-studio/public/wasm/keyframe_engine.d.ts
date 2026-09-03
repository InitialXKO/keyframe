/* tslint:disable */
/* eslint-disable */
/**
 * Build metadata for the compiled kernel.
 */
export function kernel_build_info(): string;
export enum BlendMode {
  Override = 0,
  Additive = 1,
}
export enum EasingType {
  Linear = 0,
  Ease = 1,
  EaseIn = 2,
  EaseOut = 3,
  EaseInOut = 4,
  CubicBezier = 5,
  Step = 6,
}
export class KeyframeEngine {
  free(): void;
  bake_chunk(start_ms: number, end_ms: number, fps: number): Uint8Array;
  bake_range(start_ms: number, end_ms: number, fps: number): Uint8Array;
  interpolate(value: number, input_range: Float64Array, output_range: Float64Array): number;
  /**
   * Snapshot per-instance constants for the fast path. Call after all
   * clips/instances/timeline have been added (i.e. after `prepare()`).
   */
  prepare_fast(): void;
  add_clip_json(clip_json: string): void;
  instance_size(): number;
  spring_solver(frame: number, fps: number, damping: number, stiffness: number): number;
  evaluate_frame(global_time: number): number;
  export_ir_json(): string;
  import_ir_json(ir_json: string): void;
  /**
   * Pointer to the fast-path output buffer (count × 80 bytes,
   * `#[repr(C, align(16))]` — identical layout to `get_instance_buffer_ptr`).
   */
  fast_buffer_ptr(): number;
  interpolate_opts(value: number, input_range: Float64Array, output_range: Float64Array, opts_json: string): number;
  add_instance_json(instance_json: string): void;
  /**
   * Fast evaluate: zero heap allocations per frame.
   * Returns the number of evaluated instances.
   */
  evaluate_frame_fast(global_time: number): number;
  interpolate_path_3d(p0: Float32Array, p1: Float32Array, p2: Float32Array, p3: Float32Array, t: number): Float32Array;
  set_root_timeline_json(timeline_json: string): void;
  /**
   * Valid byte length of the fast-path output buffer.
   */
  fast_buffer_byte_length(): number;
  get_instance_buffer_ptr(): number;
  interpolate_extrapolate(value: number, input_range: Float64Array, output_range: Float64Array, extrapolate_left: string, extrapolate_right: string): number;
  get_instance_buffer_byte_length(): number;
  constructor();
  prepare(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_keyframeengine_free: (a: number, b: number) => void;
  readonly kernel_build_info: () => [number, number];
  readonly keyframeengine_add_clip_json: (a: number, b: number, c: number) => [number, number];
  readonly keyframeengine_add_instance_json: (a: number, b: number, c: number) => [number, number];
  readonly keyframeengine_bake_chunk: (a: number, b: number, c: number, d: number) => [number, number];
  readonly keyframeengine_evaluate_frame: (a: number, b: number) => number;
  readonly keyframeengine_evaluate_frame_fast: (a: number, b: number) => number;
  readonly keyframeengine_export_ir_json: (a: number) => [number, number, number, number];
  readonly keyframeengine_fast_buffer_byte_length: (a: number) => number;
  readonly keyframeengine_fast_buffer_ptr: (a: number) => number;
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
  readonly keyframeengine_prepare_fast: (a: number) => void;
  readonly keyframeengine_set_root_timeline_json: (a: number, b: number, c: number) => [number, number];
  readonly keyframeengine_spring_solver: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly keyframeengine_bake_range: (a: number, b: number, c: number, d: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
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
