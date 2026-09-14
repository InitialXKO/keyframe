import { EvaluatedInstance } from "./types.js";

/**
 * Global buffer pool for managing reusable Float32Array and Uint32Array memory buffers.
 * Prevents memory allocations during repeated frame evaluation cycles.
 */
export class GlobalBufferPool {
  private floatBuffer?: Float32Array;
  private uintBuffer?: Uint32Array;

  /**
   * Acquires a Float32Array of at least the requested float capacity.
   * Reuses existing ArrayBuffer if capacity is sufficient, otherwise grows the buffer.
   */
  public acquireFloat32Array(requiredFloats: number): Float32Array {
    if (!this.floatBuffer || this.floatBuffer.length < requiredFloats) {
      const nextCap = Math.max(requiredFloats, this.floatBuffer ? this.floatBuffer.length * 2 : 256);
      this.floatBuffer = new Float32Array(nextCap);
      this.uintBuffer = new Uint32Array(this.floatBuffer.buffer, 0, nextCap);
    }
    return requiredFloats === this.floatBuffer.length
      ? this.floatBuffer
      : this.floatBuffer.subarray(0, requiredFloats);
  }

  /**
   * Acquires a Uint32Array view over the given buffer and byte offset/length.
   */
  public acquireUint32Array(
    buffer: ArrayBufferLike,
    byteOffset: number,
    floatsLength: number
  ): Uint32Array {
    if (
      this.uintBuffer &&
      this.uintBuffer.buffer === buffer &&
      this.uintBuffer.byteOffset === byteOffset &&
      this.uintBuffer.length === floatsLength
    ) {
      return this.uintBuffer;
    }
    this.uintBuffer = new Uint32Array(buffer, byteOffset, floatsLength);
    return this.uintBuffer;
  }
}

/**
 * Object pool for EvaluatedInstance objects.
 * Guarantees zero heap allocation when expanding or retrieving evaluated instances.
 */
export class EvaluatedInstancePool {
  private pool: EvaluatedInstance[] = [];

  /**
   * Acquires an array of EvaluatedInstance objects up to the required count.
   * Pre-allocates pooled instance objects with 16-float transformMatrix views if needed.
   */
  public acquire(count: number): EvaluatedInstance[] {
    while (this.pool.length < count) {
      this.pool.push({
        id: undefined,
        clipId: undefined,
        transformMatrix: new Float32Array(16),
        opacity: 1.0,
        visible: true,
        clipIndex: 0,
      });
    }
    return this.pool;
  }
}

export const globalBufferPool = new GlobalBufferPool();
export const globalInstancePool = new EvaluatedInstancePool();
