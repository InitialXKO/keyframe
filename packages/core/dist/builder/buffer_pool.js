/**
 * Global buffer pool for managing reusable Float32Array and Uint32Array memory buffers.
 * Prevents memory allocations during repeated frame evaluation cycles.
 */
export class GlobalBufferPool {
    floatBuffer;
    uintBuffer;
    floatSubarrayCache = new Map();
    uintSubarrayCache = new Map();
    /**
     * Acquires a Float32Array of at least the requested float capacity.
     * Reuses existing ArrayBuffer if capacity is sufficient, otherwise grows the buffer.
     * Caches subarray views by requested length to prevent allocation when length varies.
     */
    acquireFloat32Array(requiredFloats) {
        if (!this.floatBuffer || this.floatBuffer.length < requiredFloats) {
            const nextCap = Math.max(requiredFloats, this.floatBuffer ? this.floatBuffer.length * 2 : 256);
            this.floatBuffer = new Float32Array(nextCap);
            this.uintBuffer = new Uint32Array(this.floatBuffer.buffer, 0, nextCap);
            this.floatSubarrayCache.clear();
            this.uintSubarrayCache.clear();
        }
        if (requiredFloats === this.floatBuffer.length) {
            return this.floatBuffer;
        }
        let cached = this.floatSubarrayCache.get(requiredFloats);
        if (!cached || cached.buffer !== this.floatBuffer.buffer) {
            cached = this.floatBuffer.subarray(0, requiredFloats);
            this.floatSubarrayCache.set(requiredFloats, cached);
        }
        return cached;
    }
    /**
     * Acquires a Uint32Array view over the given buffer and byte offset/length.
     * Caches Uint32Array views by length to avoid allocations on dynamic length changes.
     */
    acquireUint32Array(buffer, byteOffset, floatsLength) {
        if (this.uintBuffer &&
            this.uintBuffer.buffer === buffer &&
            this.uintBuffer.byteOffset === byteOffset &&
            this.uintBuffer.length === floatsLength) {
            return this.uintBuffer;
        }
        if (this.floatBuffer && buffer === this.floatBuffer.buffer && byteOffset === this.floatBuffer.byteOffset) {
            let cached = this.uintSubarrayCache.get(floatsLength);
            if (!cached || cached.buffer !== buffer) {
                cached = new Uint32Array(buffer, byteOffset, floatsLength);
                this.uintSubarrayCache.set(floatsLength, cached);
            }
            return cached;
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
    pool = [];
    /**
     * Acquires an array of EvaluatedInstance objects up to the required count.
     * Pre-allocates pooled instance objects with 16-float transformMatrix views if needed.
     */
    acquire(count) {
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
