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
    origin(x: number, y: number, z?: number): this;
    build(): TransformData;
}
