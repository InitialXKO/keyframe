export interface RegisterSceneOptions {
    defaultFastDirty?: boolean;
}
export interface RegisterObjectOptions {
    fastDirty?: boolean;
}
export interface ApplyOptions {
    fastDirty?: boolean;
}
export interface AdapterObjectOptions {
    fastDirty?: boolean;
}
export declare class AdapterContext {
    readonly scene: any;
    readonly engine: any;
    readonly defaultFastDirty: boolean;
    readonly registeredObjects: Set<any>;
    readonly objectOptions: Map<any, AdapterObjectOptions>;
    constructor(scene: any, engine: any, options?: RegisterSceneOptions);
    registerObject(object: any, options?: RegisterObjectOptions): void;
    unregisterObject(object: any, restoreControl?: boolean): void;
}
export declare class ThreeAdapter {
    /**
     * Register scene and get unique AdapterContext credential handle.
     */
    registerScene(scene: any, engine: any, options?: RegisterSceneOptions): AdapterContext;
    /**
     * Unbind scene context.
     * @param ctx AdapterContext handle
     * @param restoreControl true (default): restore matrixAutoUpdate=true and updateMatrix().
     *                       false: clear internal references directly, skip matrix restore.
     *                       WARNING: If false is used on non-disposed scene, objects remain locked.
     */
    unregisterScene(ctx: AdapterContext, restoreControl?: boolean): void;
    /**
     * Apply matrices to all registered objects in Context credential.
     * Atomic execution order:
     * 1. object.matrixAutoUpdate = false
     * 2. object.matrix.copy(rawMatrix) / elements assignment
     * 3. if (!fastDirty) matrix.decompose(position, quaternion, scale)
     */
    applyToScene(ctx: AdapterContext, time: number, options?: ApplyOptions): void;
}
export declare const threeAdapter: ThreeAdapter;
