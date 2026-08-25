export class GPUDeviceLostError extends Error {
    constructor(message) {
        super(message);
        this.name = "GPUDeviceLostError";
        Object.setPrototypeOf(this, GPUDeviceLostError.prototype);
    }
}
export class WebGPUAdapter {
    /**
     * Direct write matrices to GPUBuffer with 3-layer boundary validation.
     */
    writeToBuffer(device, buffer, time, baseOffset = 0, options) {
        // Layer 3: Device Lost Perception
        if (!device) {
            throw new GPUDeviceLostError("GPUDevice is null or undefined.");
        }
        if (device.isLost === true || device.__isDeviceLost === true) {
            throw new GPUDeviceLostError("GPUDevice is lost. Buffer write aborted.");
        }
        // Layer 1: Alignment Check
        const minAlignment = device.limits?.minStorageBufferOffsetAlignment ?? 256;
        if (baseOffset % minAlignment !== 0) {
            throw new TypeError(`baseOffset (${baseOffset}) is not aligned to device.limits.minStorageBufferOffsetAlignment (${minAlignment} bytes).`);
        }
        const engine = options?.engine;
        let rawData;
        let instanceCount = 0;
        if (engine) {
            if (typeof engine.bakeChunk === "function") {
                rawData = engine.bakeChunk(time, time, 30);
            }
            else if (typeof engine.getEvaluatedInstances === "function") {
                const evaluated = engine.getEvaluatedInstances(time);
                instanceCount = evaluated.length;
                rawData = new Uint8Array(instanceCount * 80);
                for (let i = 0; i < instanceCount; i++) {
                    const inst = evaluated[i];
                    const instBytes = new Float32Array(rawData.buffer, i * 80, 16);
                    instBytes.set(inst.transformMatrix);
                    const metaView = new Float32Array(rawData.buffer, i * 80 + 64, 4);
                    metaView[0] = inst.opacity ?? 1.0;
                    const uintView = new Uint32Array(rawData.buffer, i * 80 + 68, 3);
                    uintView[0] = inst.visible ? 1 : 0;
                    uintView[1] = inst.clipIndex ?? 0;
                    uintView[2] = 0;
                }
            }
            else {
                rawData = new Uint8Array(80);
                instanceCount = 1;
            }
        }
        else {
            rawData = new Uint8Array(80);
            instanceCount = 1;
        }
        if (instanceCount === 0 && rawData.byteLength > 0) {
            instanceCount = Math.floor(rawData.byteLength / 80);
        }
        const instanceIndices = options?.instanceIndices;
        if (instanceIndices && instanceIndices.length > 0) {
            // Partial update
            const maxIdx = Math.max(...instanceIndices);
            const requiredSize = baseOffset + (maxIdx + 1) * 80;
            // Layer 2: Out-of-Bounds Protection
            if (buffer && typeof buffer.size === "number" && requiredSize > buffer.size) {
                throw new RangeError(`Buffer overflow: required offset ${requiredSize} bytes exceeds GPUBuffer size (${buffer.size} bytes).`);
            }
            if (device.queue && typeof device.queue.writeBuffer === "function") {
                for (const idx of instanceIndices) {
                    const srcOffset = idx * 80;
                    const dstOffset = baseOffset + idx * 80;
                    const slice = rawData.subarray(srcOffset, srcOffset + 80);
                    device.queue.writeBuffer(buffer, dstOffset, slice.buffer, slice.byteOffset, slice.byteLength);
                }
            }
        }
        else {
            // Full update
            const requiredSize = baseOffset + rawData.byteLength;
            // Layer 2: Out-of-Bounds Protection
            if (buffer && typeof buffer.size === "number" && requiredSize > buffer.size) {
                throw new RangeError(`Buffer overflow: required ${requiredSize} bytes exceeds GPUBuffer size (${buffer.size} bytes).`);
            }
            if (device.queue && typeof device.queue.writeBuffer === "function") {
                device.queue.writeBuffer(buffer, baseOffset, rawData.buffer, rawData.byteOffset, rawData.byteLength);
            }
        }
    }
}
export const webgpuAdapter = new WebGPUAdapter();
