import { Engine } from "../builder/engine.js";

export interface IRenderer {
  init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void>;
  render(engine: Engine, frameTimeMs: number): void;
  destroy(): void;
  getBackendType(): "webgpu" | "canvas2d";
}
