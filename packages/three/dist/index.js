export class AdapterContext {
    scene;
    engine;
    defaultFastDirty;
    registeredObjects = new Set();
    objectOptions = new Map();
    constructor(scene, engine, options) {
        this.scene = scene;
        this.engine = engine;
        this.defaultFastDirty = options?.defaultFastDirty ?? false;
    }
    registerObject(object, options) {
        if (!object)
            return;
        this.registeredObjects.add(object);
        if (options) {
            this.objectOptions.set(object, { fastDirty: options.fastDirty });
        }
        object.matrixAutoUpdate = false;
    }
    unregisterObject(object, restoreControl = true) {
        if (!object)
            return;
        this.registeredObjects.delete(object);
        this.objectOptions.delete(object);
        if (restoreControl) {
            object.matrixAutoUpdate = true;
            if (typeof object.updateMatrix === "function") {
                object.updateMatrix();
            }
        }
    }
}
export class ThreeAdapter {
    /**
     * Register scene and get unique AdapterContext credential handle.
     */
    registerScene(scene, engine, options) {
        return new AdapterContext(scene, engine, options);
    }
    /**
     * Unbind scene context.
     * @param ctx AdapterContext handle
     * @param restoreControl true (default): restore matrixAutoUpdate=true and updateMatrix().
     *                       false: clear internal references directly, skip matrix restore.
     *                       WARNING: If false is used on non-disposed scene, objects remain locked.
     */
    unregisterScene(ctx, restoreControl = true) {
        if (!ctx)
            return;
        if (restoreControl) {
            for (const obj of ctx.registeredObjects) {
                obj.matrixAutoUpdate = true;
                if (typeof obj.updateMatrix === "function") {
                    obj.updateMatrix();
                }
            }
        }
        ctx.registeredObjects.clear();
        ctx.objectOptions.clear();
    }
    /**
     * Apply matrices to all registered objects in Context credential.
     * Atomic execution order:
     * 1. object.matrixAutoUpdate = false
     * 2. object.matrix.copy(rawMatrix) / elements assignment
     * 3. if (!fastDirty) matrix.decompose(position, quaternion, scale)
     */
    applyToScene(ctx, time, options) {
        if (!ctx || !ctx.engine)
            return;
        const evaluated = ctx.engine.getEvaluatedInstances(time);
        const objectsArray = Array.from(ctx.registeredObjects);
        const sceneDefaultFastDirty = ctx.defaultFastDirty;
        const globalFastDirty = options?.fastDirty;
        for (let i = 0; i < objectsArray.length; i++) {
            const obj = objectsArray[i];
            const instData = evaluated[i];
            if (!obj || !instData)
                continue;
            // 1. Lock control
            obj.matrixAutoUpdate = false;
            // 2. Write native column-major matrix
            const rawMatrix = instData.transformMatrix;
            if (obj.matrix) {
                if (typeof obj.matrix.fromArray === "function") {
                    obj.matrix.fromArray(rawMatrix);
                }
                else if (typeof obj.matrix.copy === "function" && rawMatrix.elements) {
                    obj.matrix.copy(rawMatrix);
                }
                else if (obj.matrix.elements) {
                    obj.matrix.elements.set(rawMatrix);
                }
                else {
                    obj.matrix.elements = new Float32Array(rawMatrix);
                }
            }
            // Determine fastDirty strategy
            const objSpecificFastDirty = ctx.objectOptions.get(obj)?.fastDirty;
            const isFastDirty = globalFastDirty ?? objSpecificFastDirty ?? sceneDefaultFastDirty;
            // 3. Decompose if fastDirty is false
            if (!isFastDirty && obj.matrix) {
                if (typeof obj.matrix.decompose === "function") {
                    if (!obj.position)
                        obj.position = { x: 0, y: 0, z: 0 };
                    if (!obj.quaternion)
                        obj.quaternion = { x: 0, y: 0, z: 0, w: 1 };
                    if (!obj.scale)
                        obj.scale = { x: 1, y: 1, z: 1 };
                    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
                }
            }
        }
    }
}
export const threeAdapter = new ThreeAdapter();
