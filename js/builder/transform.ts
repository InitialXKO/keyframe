import { TransformData } from "./types.js";

export class TransformBuilder {
  private data: TransformData = {
    translation: [0, 0, 0],
    rotation_quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    origin: [0, 0, 0],
  };

  public translateX(x: number): this {
    this.data.translation[0] = x;
    return this;
  }

  public translateY(y: number): this {
    this.data.translation[1] = y;
    return this;
  }

  public translateZ(z: number): this {
    this.data.translation[2] = z;
    return this;
  }

  public translate(x: number, y: number, z = 0): this {
    this.data.translation = [x, y, z];
    return this;
  }

  public scale(s: number): this;
  public scale(sx: number, sy: number, sz?: number): this;
  public scale(sx: number, sy?: number, sz = 1): this {
    if (sy === undefined) {
      this.data.scale = [sx, sx, sx];
    } else {
      this.data.scale = [sx, sy, sz];
    }
    return this;
  }

  public rotationQuat(x: number, y: number, z: number, w: number): this {
    this.data.rotation_quat = [x, y, z, w];
    return this;
  }

  public origin(x: number, y: number, z = 0): this {
    this.data.origin = [x, y, z];
    return this;
  }

  public build(): TransformData {
    return { ...this.data };
  }
}
