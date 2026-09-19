export declare class GPUDeviceLostError extends Error {
    constructor(message: string);
}
export interface EngineLike {
    evaluateFrame?(time: number): {
        view: ArrayBufferView;
        byteLength?: number;
        count: number;
    };
    getEvaluatedInstances?(time: number, skipEvaluate?: boolean): Array<{
        transformMatrix: ArrayLike<number>;
        opacity?: number;
        visible?: boolean;
        clipIndex?: number;
    }>;
    bakeChunk?(startMs: number, endMs: number, fps?: number): Uint8Array;
}
export interface WriteToBufferOptions {
    /** @deprecated fastDirty property is deprecated and unused. */
    fastDirty?: boolean;
    instanceIndices?: number[];
    engine?: EngineLike | any;
}
export interface CreateComputeResourcesResult {
    pipeline: any;
    bindGroupLayout: any;
}
export interface DispatchComputeOptions {
    pipeline: any;
    bindGroup?: any;
    instanceCount?: number;
    clipStates?: Array<{
        clipIndex: number;
        currentTime: number;
        progress: number;
        opacity: number;
    }>;
}
export interface ReadFromBufferOptions {
    offset: number;
    size: number;
    stagingBuffer?: any;
}
export interface ReadInstanceOptions {
    instanceIndex: number;
    stagingBuffer?: any;
}
export declare class WebGPUAdapter {
    /**
     * Internal 3-tier boundary validation helper: Layer 3 (Device Lost)
     */
    private checkDeviceLost;
    /**
     * Create Compute Resources (pipeline and bindGroupLayout) from embedded COMPUTE_TEMPLATE.
     */
    createComputeResources(device: any): CreateComputeResourcesResult;
    /**
     * Dispatch GPU compute pass for mass instance parallel animation evaluation.
     */
    dispatchCompute(device: any, buffer: any, time: number, baseOffset?: number, options?: DispatchComputeOptions): void;
    /**
     * Byte-level buffer read operation via GPU staging buffer mapAsync.
     */
    readFromBuffer(device: any, buffer: any, options: ReadFromBufferOptions): Promise<ArrayBuffer>;
    /**
     * Convenience single instance read operation (offset = instanceIndex * 80, size = 80).
     */
    readInstance(device: any, buffer: any, options: ReadInstanceOptions): Promise<ArrayBuffer>;
    /**
     * Direct write matrices to GPUBuffer with 3-layer boundary validation.
     */
    writeToBuffer(device: any, buffer: any, time: number, baseOffset?: number, options?: WriteToBufferOptions): void;
}
export declare const webgpuAdapter: WebGPUAdapter;
