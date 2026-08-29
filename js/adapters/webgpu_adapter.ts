import { COMPUTE_TEMPLATE } from "../generated/shaders.js";

export class GPUDeviceLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GPUDeviceLostError";
    Object.setPrototypeOf(this, GPUDeviceLostError.prototype);
  }
}

export interface EngineLike {
  evaluateFrame?(time: number): { view: ArrayBufferView; byteLength?: number; count: number };
  getEvaluatedInstances?(
    time: number,
    skipEvaluate?: boolean
  ): Array<{
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

export class WebGPUAdapter {
  /**
   * Internal 3-tier boundary validation helper: Layer 3 (Device Lost)
   */
  private checkDeviceLost(device: any): void {
    if (!device) {
      throw new GPUDeviceLostError("GPUDevice is null or undefined.");
    }
    if (
      device.isLost === true ||
      device.lost === true ||
      device.__isDeviceLost === true ||
      (device.lost && typeof device.lost === "object" && device.lost.__isLost === true)
    ) {
      throw new GPUDeviceLostError("GPUDevice is lost. Operation aborted.");
    }
  }

  /**
   * Create Compute Resources (pipeline and bindGroupLayout) from embedded COMPUTE_TEMPLATE.
   */
  public createComputeResources(device: any): CreateComputeResourcesResult {
    this.checkDeviceLost(device);

    if (!device || typeof device.createShaderModule !== "function") {
      throw new TypeError("Invalid GPUDevice object.");
    }

    const shaderModule = device.createShaderModule({
      code: COMPUTE_TEMPLATE,
    });

    const bindGroupLayout = typeof device.createBindGroupLayout === "function"
      ? device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 4 /* GPUShaderStage.COMPUTE */, buffer: { type: "uniform" } },
            { binding: 1, visibility: 4, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: 4, buffer: { type: "storage" } },
          ],
        })
      : null;

    const pipelineLayout = typeof device.createPipelineLayout === "function"
      ? device.createPipelineLayout({
          bindGroupLayouts: bindGroupLayout ? [bindGroupLayout] : [],
        })
      : null;

    const pipeline = typeof device.createComputePipeline === "function"
      ? device.createComputePipeline({
          layout: pipelineLayout || "auto",
          compute: {
            module: shaderModule,
            entryPoint: "main",
          },
        })
      : { module: shaderModule };

    return { pipeline, bindGroupLayout };
  }

  /**
   * Dispatch GPU compute pass for mass instance parallel animation evaluation.
   */
  public dispatchCompute(
    device: any,
    buffer: any,
    time: number,
    baseOffset = 0,
    options?: DispatchComputeOptions
  ): void {
    // Layer 3: Device Lost Perception
    this.checkDeviceLost(device);

    // Layer 1: Alignment Check
    const minAlignment = device.limits?.minStorageBufferOffsetAlignment ?? 256;
    if (baseOffset % minAlignment !== 0) {
      throw new TypeError(
        `baseOffset (${baseOffset}) is not aligned to device.limits.minStorageBufferOffsetAlignment (${minAlignment} bytes).`
      );
    }

    if (!options || !options.pipeline) {
      throw new TypeError("DispatchComputeOptions requires a valid compute pipeline.");
    }

    const instanceCount = options.instanceCount ?? (buffer && typeof buffer.size === "number" ? Math.floor(buffer.size / 80) : 1);
    const requiredSize = baseOffset + instanceCount * 80;

    // Layer 2: Out-of-Bounds Protection
    if (buffer && typeof buffer.size === "number" && requiredSize > buffer.size) {
      throw new RangeError(
        `Buffer overflow: required offset ${requiredSize} bytes exceeds GPUBuffer size (${buffer.size} bytes).`
      );
    }

    if (typeof device.createCommandEncoder === "function") {
      const commandEncoder = device.createCommandEncoder();
      const pass = typeof commandEncoder.beginComputePass === "function"
        ? commandEncoder.beginComputePass()
        : null;

      if (pass) {
        if (typeof pass.setPipeline === "function") {
          pass.setPipeline(options.pipeline);
        }
        if (options.bindGroup && typeof pass.setBindGroup === "function") {
          pass.setBindGroup(0, options.bindGroup);
        }

        const workgroupCount = Math.ceil(instanceCount / 64);
        if (typeof pass.dispatchWorkgroups === "function") {
          pass.dispatchWorkgroups(workgroupCount);
        } else if (typeof pass.dispatch === "function") {
          pass.dispatch(workgroupCount);
        }

        if (typeof pass.end === "function") {
          pass.end();
        } else if (typeof pass.endPass === "function") {
          pass.endPass();
        }
      }

      if (device.queue && typeof device.queue.submit === "function" && typeof commandEncoder.finish === "function") {
        device.queue.submit([commandEncoder.finish()]);
      }
    }
  }

  /**
   * Byte-level buffer read operation via GPU staging buffer mapAsync.
   */
  public async readFromBuffer(
    device: any,
    buffer: any,
    options: ReadFromBufferOptions
  ): Promise<ArrayBuffer> {
    // Layer 3: Device Lost Perception
    this.checkDeviceLost(device);

    const offset = options.offset;
    const size = options.size;
    const requiredSize = offset + size;

    // Layer 2: Out-of-Bounds Protection
    if (buffer && typeof buffer.size === "number" && requiredSize > buffer.size) {
      throw new RangeError(
        `Buffer overflow: read range ${requiredSize} bytes exceeds GPUBuffer size (${buffer.size} bytes).`
      );
    }

    let stagingBuffer = options.stagingBuffer;
    let ownStagingBuffer = false;

    if (!stagingBuffer) {
      if (typeof device.createBuffer === "function") {
        stagingBuffer = device.createBuffer({
          size,
          usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
        });
        ownStagingBuffer = true;
      } else {
        stagingBuffer = {
          size,
          async mapAsync() {},
          getMappedRange() {
            return new ArrayBuffer(size);
          },
          unmap() {},
          destroy() {},
        };
      }
    }

    if (typeof device.createCommandEncoder === "function" && device.queue) {
      const commandEncoder = device.createCommandEncoder();
      if (typeof commandEncoder.copyBufferToBuffer === "function") {
        commandEncoder.copyBufferToBuffer(buffer, offset, stagingBuffer, 0, size);
      }
      if (typeof device.queue.submit === "function" && typeof commandEncoder.finish === "function") {
        device.queue.submit([commandEncoder.finish()]);
      }
    }

    if (typeof stagingBuffer.mapAsync === "function") {
      await stagingBuffer.mapAsync(0x0001 /* MAP_READ */, 0, size);
    }

    let resultBuffer: ArrayBuffer;
    if (typeof stagingBuffer.getMappedRange === "function") {
      const mappedRange = stagingBuffer.getMappedRange(0, size);
      resultBuffer = mappedRange.slice(0);
    } else {
      resultBuffer = new ArrayBuffer(size);
    }

    if (typeof stagingBuffer.unmap === "function") {
      stagingBuffer.unmap();
    }

    if (ownStagingBuffer && typeof stagingBuffer.destroy === "function") {
      stagingBuffer.destroy();
    }

    return resultBuffer;
  }

  /**
   * Convenience single instance read operation (offset = instanceIndex * 80, size = 80).
   */
  public async readInstance(
    device: any,
    buffer: any,
    options: ReadInstanceOptions
  ): Promise<ArrayBuffer> {
    const offset = options.instanceIndex * 80;
    const size = 80;
    return this.readFromBuffer(device, buffer, {
      offset,
      size,
      stagingBuffer: options.stagingBuffer,
    });
  }

  /**
   * Direct write matrices to GPUBuffer with 3-layer boundary validation.
   */
  public writeToBuffer(
    device: any,
    buffer: any,
    time: number,
    baseOffset = 0,
    options?: WriteToBufferOptions
  ): void {
    // Layer 3: Device Lost Perception
    this.checkDeviceLost(device);

    // Layer 1: Alignment Check
    const minAlignment = device.limits?.minStorageBufferOffsetAlignment ?? 256;
    if (baseOffset % minAlignment !== 0) {
      throw new TypeError(
        `baseOffset (${baseOffset}) is not aligned to device.limits.minStorageBufferOffsetAlignment (${minAlignment} bytes).`
      );
    }

    const engine = options?.engine;
    let rawData: Uint8Array;
    let instanceCount = 0;

    if (engine) {
      if (typeof engine.evaluateFrame === "function") {
        const frameResult = engine.evaluateFrame(time);
        if (frameResult && frameResult.view) {
          rawData = new Uint8Array(
            frameResult.view.buffer,
            frameResult.view.byteOffset,
            frameResult.byteLength || frameResult.view.byteLength
          );
          instanceCount = frameResult.count;
        } else {
          rawData = new Uint8Array(80);
          instanceCount = 1;
        }
      } else if (typeof engine.bakeChunk === "function") {
        rawData = engine.bakeChunk(time, time, 30);
      } else if (typeof engine.getEvaluatedInstances === "function") {
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
      } else {
        rawData = new Uint8Array(80);
        instanceCount = 1;
      }
    } else {
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
        throw new RangeError(
          `Buffer overflow: required offset ${requiredSize} bytes exceeds GPUBuffer size (${buffer.size} bytes).`
        );
      }

      if (device.queue && typeof device.queue.writeBuffer === "function") {
        for (const idx of instanceIndices) {
          const srcOffset = idx * 80;
          const dstOffset = baseOffset + idx * 80;
          const slice = rawData.subarray(srcOffset, srcOffset + 80);
          device.queue.writeBuffer(buffer, dstOffset, slice.buffer, slice.byteOffset, slice.byteLength);
        }
      }
    } else {
      // Full update
      const requiredSize = baseOffset + rawData.byteLength;

      // Layer 2: Out-of-Bounds Protection
      if (buffer && typeof buffer.size === "number" && requiredSize > buffer.size) {
        throw new RangeError(
          `Buffer overflow: required ${requiredSize} bytes exceeds GPUBuffer size (${buffer.size} bytes).`
        );
      }

      if (device.queue && typeof device.queue.writeBuffer === "function") {
        device.queue.writeBuffer(
          buffer,
          baseOffset,
          rawData.buffer,
          rawData.byteOffset,
          rawData.byteLength
        );
      }
    }
  }
}

export const webgpuAdapter = new WebGPUAdapter();
