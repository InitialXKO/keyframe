import { TransformData } from "./types.js";
export declare class TransformBuilder {
    private data;
    translateX(x: number): this;
    translateY(y: number): this;
    translateZ(z: number): this;
    translate(x: number, y: number, z?: number): this;
    scale(s: number): this;
    scale(sx: number, sy: number, sz?: number): this;
    rotationQuat(x: number, y: number, z: number, w: number): this;
    /**
     * Rotates around X axis (in degrees).
     */
    rotateX(deg: number): this;
    /**
     * Rotates around Y axis (in degrees).
     */
    rotateY(deg: number): this;
    /**
     * Rotates around Z axis (in degrees).
     */
    rotateZ(deg: number): this;
    /**
     * Sets Euler rotation (in degrees) around X, Y, and Z axes (YXZ order).
     */
    rotateEuler(xDeg: number, yDeg: number, zDeg: number): this;
    origin(x: number, y: number, z?: number): this;
    build(): TransformData;
}
