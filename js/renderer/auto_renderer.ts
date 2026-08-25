import { IRenderer } from "./renderer.js";
import { Canvas2DRenderer } from "./canvas2d_renderer.js";
import { WebGPURenderer } from "./webgpu_renderer.js";

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  preferredBackend?: "webgpu" | "canvas2d"
): Promise<IRenderer> {
  if (preferredBackend === "canvas2d") {
    const renderer = new Canvas2DRenderer();
    await renderer.init(canvas);
    return renderer;
  }

  try {
    const webgpuRenderer = new WebGPURenderer();
    await webgpuRenderer.init(canvas);
    return webgpuRenderer;
  } catch (err) {
    console.info("WebGPU initialization failed or unsupported. Falling back to Canvas 2D CPU renderer.", err);
    const fallbackRenderer = new Canvas2DRenderer();
    await fallbackRenderer.init(canvas);
    return fallbackRenderer;
  }
}
