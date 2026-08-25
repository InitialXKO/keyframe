export class AdapterContext {
    scene;
    engine;
    defaultFastDirty;
    defaultRasterized;
    registeredObjects = new Set();
    objectOptions = new Map();
    constructor(scene, engine, options) {
        this.scene = scene;
        this.engine = engine;
        const fastDirty = options?.defaultFastDirty ?? options?.defaultRasterized ?? false;
        this.defaultFastDirty = fastDirty;
        this.defaultRasterized = fastDirty;
    }
    registerObject(object, options) {
        if (!object)
            return;
        this.registeredObjects.add(object);
        const fastDirty = options?.fastDirty ?? options?.rasterized;
        if (fastDirty !== undefined) {
            this.objectOptions.set(object, { fastDirty, rasterized: fastDirty });
        }
        object.matrixAutoUpdate = false;
    }
    unregisterObject(object, restoreControl = true) {
        if (!object)
            return;
        this.registeredObjects.delete(object);
        this.objectOptions.delete(object);
        const shouldRestore = typeof restoreControl === "boolean" ? restoreControl : !restoreControl?.abandoned;
        if (shouldRestore) {
            object.matrixAutoUpdate = true;
            if (typeof object.updateMatrix === "function") {
                object.updateMatrix();
            }
        }
    }
}
export class ThreeAdapter {
    registerScene(scene, engine, options) {
        return new AdapterContext(scene, engine, options);
    }
    unregisterScene(ctx, restoreControlOrOptions = true) {
        if (!ctx)
            return;
        const shouldRestore = typeof restoreControlOrOptions === "boolean" ? restoreControlOrOptions : !restoreControlOrOptions?.abandoned;
        if (shouldRestore) {
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
    applyToScene(ctx, time, options) {
        if (!ctx || !ctx.engine)
            return;
        const evaluated = ctx.engine.getEvaluatedInstances(time);
        const objectsArray = Array.from(ctx.registeredObjects);
        const sceneDefaultFastDirty = ctx.defaultFastDirty;
        const globalFastDirty = options?.fastDirty ?? options?.rasterized;
        for (let i = 0; i < objectsArray.length; i++) {
            const obj = objectsArray[i];
            const instData = evaluated[i];
            if (!obj || !instData)
                continue;
            obj.matrixAutoUpdate = false;
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
            const objSpecificFastDirty = ctx.objectOptions.get(obj)?.fastDirty;
            const isFastDirty = globalFastDirty ?? objSpecificFastDirty ?? sceneDefaultFastDirty;
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
