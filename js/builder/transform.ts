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

  /**
   * Rotates around X axis (in degrees).
   */
  public rotateX(deg: number): this {
    const rad = (deg * Math.PI) / 180 / 2;
    this.data.rotation_quat = [Math.sin(rad), 0, 0, Math.cos(rad)];
    return this;
  }

  /**
   * Rotates around Y axis (in degrees).
   */
  public rotateY(deg: number): this {
    const rad = (deg * Math.PI) / 180 / 2;
    this.data.rotation_quat = [0, Math.sin(rad), 0, Math.cos(rad)];
    return this;
  }

  /**
   * Rotates around Z axis (in degrees).
   */
  public rotateZ(deg: number): this {
    const rad = (deg * Math.PI) / 180 / 2;
    this.data.rotation_quat = [0, 0, Math.sin(rad), Math.cos(rad)];
    return this;
  }

  /**
   * Sets Euler rotation (in degrees) around X, Y, and Z axes (YXZ order).
   */
  public rotateEuler(xDeg: number, yDeg: number, zDeg: number): this {
    const rx = (xDeg * Math.PI) / 180 / 2;
    const ry = (yDeg * Math.PI) / 180 / 2;
    const rz = (zDeg * Math.PI) / 180 / 2;

    const c1 = Math.cos(rx);
    const s1 = Math.sin(rx);
    const c2 = Math.cos(ry);
    const s2 = Math.sin(ry);
    const c3 = Math.cos(rz);
    const s3 = Math.sin(rz);

    // YXZ quaternion composition
    const qx = s1 * c2 * c3 + c1 * s2 * s3;
    const qy = c1 * s2 * c3 - s1 * c2 * s3;
    const qz = c1 * c2 * s3 - s1 * s2 * c3;
    const qw = c1 * c2 * c3 + s1 * s2 * s3;

    this.data.rotation_quat = [qx, qy, qz, qw];
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
