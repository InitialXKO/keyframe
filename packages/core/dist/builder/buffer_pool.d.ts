import { EvaluatedInstance } from "./types.js";
/**
 * Global buffer pool for managing reusable Float32Array and Uint32Array memory buffers.
 * Prevents memory allocations during repeated frame evaluation cycles.
 */
export declare class GlobalBufferPool {
    private floatBuffer?;
    private uintBuffer?;
    private floatSubarrayCache;
    private uintSubarrayCache;
    /**
     * Acquires a Float32Array of at least the requested float capacity.
     * Reuses existing ArrayBuffer if capacity is sufficient, otherwise grows the buffer.
     * Caches subarray views by requested length to prevent allocation when length varies.
     */
    acquireFloat32Array(requiredFloats: number): Float32Array;
    /**
     * Acquires a Uint32Array view over the given buffer and byte offset/length.
     * Caches Uint32Array views by length to avoid allocations on dynamic length changes.
     */
    acquireUint32Array(buffer: ArrayBufferLike, byteOffset: number, floatsLength: number): Uint32Array;
}
/**
 * Object pool for EvaluatedInstance objects.
 * Guarantees zero heap allocation when expanding or retrieving evaluated instances.
 */
export declare class EvaluatedInstancePool {
    private pool;
    /**
     * Acquires an array of EvaluatedInstance objects up to the required count.
     * Pre-allocates pooled instance objects with 16-float transformMatrix views if needed.
     */
    acquire(count: number): EvaluatedInstance[];
}
export declare const globalBufferPool: GlobalBufferPool;
export declare const globalInstancePool: EvaluatedInstancePool;
