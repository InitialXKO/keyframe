export interface RegisterSceneOptions {
    defaultRasterized?: boolean;
}
export interface RegisterObjectOptions {
    rasterized?: boolean;
}
export interface ApplyOptions {
    rasterized?: boolean;
}
export interface UnregisterSceneOptions {
    abandoned?: boolean;
}
export interface AdapterObjectOptions {
    rasterized?: boolean;
}
export declare class AdapterContext {
    readonly scene: any;
    readonly engine: any;
    readonly defaultRasterized: boolean;
    readonly registeredObjects: Set<any>;
    readonly objectOptions: Map<any, AdapterObjectOptions>;
    constructor(scene: any, engine: any, options?: RegisterSceneOptions);
    registerObject(object: any, options?: RegisterObjectOptions): void;
    unregisterObject(object: any, options?: UnregisterSceneOptions): void;
}
export declare class ThreeAdapter {
    registerScene(scene: any, engine: any, options?: RegisterSceneOptions): AdapterContext;
    unregisterScene(ctx: AdapterContext, options?: UnregisterSceneOptions): void;
    applyToScene(ctx: AdapterContext, time: number, options?: ApplyOptions): void;
}
export declare const threeAdapter: ThreeAdapter;
