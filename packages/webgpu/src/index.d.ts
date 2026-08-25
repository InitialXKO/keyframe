export declare class GPUDeviceLostError extends Error {
    constructor(message: string);
}
export interface WriteToBufferOptions {
    fastDirty?: boolean;
    instanceIndices?: number[];
    engine?: any;
}
export declare class WebGPUAdapter {
    /**
     * Direct write matrices to GPUBuffer with 3-layer boundary validation.
     */
    writeToBuffer(device: any, buffer: any, time: number, baseOffset?: number, options?: WriteToBufferOptions): void;
}
export declare const webgpuAdapter: WebGPUAdapter;
