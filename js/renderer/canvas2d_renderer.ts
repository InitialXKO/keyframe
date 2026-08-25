import { Engine, EvaluatedInstance } from "../builder/engine.js";
import { IRenderer } from "./renderer.js";

export class Canvas2DRenderer implements IRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  public async init(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    this.canvas = canvas;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) {
      throw new Error("Canvas2D context could not be acquired.");
    }
    this.ctx = context;
  }

  public render(engine: Engine, frameTimeMs: number): void {
    if (!this.ctx || !this.canvas) return;

    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Clear background
    ctx.save();
    ctx.clearRect(0, 0, width, height);

    const evaluatedInstances: EvaluatedInstance[] = engine.getEvaluatedInstances(frameTimeMs);

    for (let i = 0; i < evaluatedInstances.length; i++) {
      const inst = evaluatedInstances[i];
      if (!inst.visible || inst.opacity <= 0) continue;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, inst.opacity));

      const m = inst.transformMatrix;
      // 4x4 column-major matrix
      // m[0]=m11, m[1]=m12, m[4]=m21, m[5]=m22, m[12]=tx, m[13]=ty
      const m11 = m[0];
      const m12 = m[1];
      const m21 = m[4];
      const m22 = m[5];
      const tx = m[12] + width / 2; // Center offset for 2D presentation
      const ty = m[13] + height / 2;

      ctx.transform(m11, m12, m21, m22, tx, ty);

      // Draw a default instance representation (card/rectangle with index style)
      const hue = (inst.clipIndex * 137.5 + i * 20) % 360;
      ctx.fillStyle = `hsl(${hue}, 70%, 60%)`;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(-25, -25, 50, 50, 8) : ctx.rect(-25, -25, 50, 50);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

    ctx.restore();
  }

  public destroy(): void {
    this.ctx = null;
    this.canvas = null;
  }

  public getBackendType(): "webgpu" | "canvas2d" {
    return "canvas2d";
  }
}
