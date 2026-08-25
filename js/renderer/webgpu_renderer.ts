import { Engine } from "../builder/engine.js";
import { IRenderer } from "./renderer.js";

declare global {
  interface Navigator {
    gpu?: {
      requestAdapter(): Promise<any>;
      getPreferredCanvasFormat(): string;
    };
  }
}

type GPUAdapter = any;
type GPUDevice = any;
type GPUCanvasContext = any;
type GPURenderPipeline = any;

export class WebGPURenderer implements IRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;

  public async init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    this.canvas = canvas;

    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new Error("WebGPU is not supported in this environment.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Failed to request WebGPU adapter.");
    }
    this.adapter = adapter;

    const device = await adapter.requestDevice();
    this.device = device;

    if ("getContext" in canvas) {
      const gpuContext = (canvas as HTMLCanvasElement).getContext("webgpu") as GPUCanvasContext | null;
      if (gpuContext) {
        this.context = gpuContext;
        const format = navigator.gpu.getPreferredCanvasFormat();
        gpuContext.configure({
          device,
          format,
          alphaMode: "premultiplied",
        });
      }
    }
  }

  public render(engine: Engine, frameTimeMs: number): void {
    if (!this.device || !this.context) return;

    const evaluated = engine.getEvaluatedInstances(frameTimeMs);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (this.pipeline) {
      renderPass.setPipeline(this.pipeline);
      renderPass.draw(6, 1, 0, 0);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  public destroy(): void {
    if (this.device && typeof this.device.destroy === "function") {
      this.device.destroy();
    }
    this.device = null;
    this.adapter = null;
    this.context = null;
    this.canvas = null;
  }

  public getBackendType(): "webgpu" | "canvas2d" {
    return "webgpu";
  }
}
