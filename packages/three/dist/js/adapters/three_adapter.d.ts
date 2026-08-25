export interface RegisterSceneOptions {
    defaultFastDirty?: boolean;
    defaultRasterized?: boolean;
}
export interface RegisterObjectOptions {
    fastDirty?: boolean;
    rasterized?: boolean;
}
export interface ApplyOptions {
    fastDirty?: boolean;
    rasterized?: boolean;
}
export interface UnregisterSceneOptions {
    abandoned?: boolean;
}
export interface AdapterObjectOptions {
    fastDirty?: boolean;
    rasterized?: boolean;
}
export declare class AdapterContext {
    readonly scene: any;
    readonly engine: any;
    readonly defaultFastDirty: boolean;
    readonly defaultRasterized: boolean;
    readonly registeredObjects: Set<any>;
    readonly objectOptions: Map<any, AdapterObjectOptions>;
    constructor(scene: any, engine: any, options?: RegisterSceneOptions);
    registerObject(object: any, options?: RegisterObjectOptions): void;
    unregisterObject(object: any, restoreControl?: boolean | UnregisterSceneOptions): void;
}
export declare class ThreeAdapter {
    registerScene(scene: any, engine: any, options?: RegisterSceneOptions): AdapterContext;
    unregisterScene(ctx: AdapterContext, restoreControlOrOptions?: boolean | UnregisterSceneOptions): void;
    applyToScene(ctx: AdapterContext, time: number, options?: ApplyOptions): void;
}
export declare const threeAdapter: ThreeAdapter;
