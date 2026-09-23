import { TransformData } from "./types.js";
export type PropertyInterpolator<T = any> = (a: T, b: T, factor: number) => T;
export declare function interpolateTransform(a: TransformData, b: TransformData, factor: number): TransformData;
export declare class PropertyTrackRegistry {
    private static registry;
    static register<T = any>(trackName: string, interpolator: PropertyInterpolator<T>): void;
    static get<T = any>(trackName: string): PropertyInterpolator<T> | undefined;
    static interpolate<T = any>(trackName: string, a: T, b: T, factor: number): T;
}
