export class AdapterContext {
    scene;
    engine;
    defaultRasterized;
    registeredObjects = new Set();
    objectOptions = new Map();
    constructor(scene, engine, options) {
        this.scene = scene;
        this.engine = engine;
        this.defaultRasterized = options?.defaultRasterized ?? false;
    }
    registerObject(object, options) {
        if (!object)
            return;
        this.registeredObjects.add(object);
        if (options?.rasterized !== undefined) {
            this.objectOptions.set(object, { rasterized: options.rasterized });
        }
        object.matrixAutoUpdate = false;
    }
    unregisterObject(object, options) {
        if (!object)
            return;
        this.registeredObjects.delete(object);
        this.objectOptions.delete(object);
        const isAbandoned = options?.abandoned ?? false;
        if (!isAbandoned) {
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
    unregisterScene(ctx, options) {
        if (!ctx)
            return;
        const isAbandoned = options?.abandoned ?? false;
        if (!isAbandoned) {
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
        const sceneDefaultRasterized = ctx.defaultRasterized;
        const globalRasterized = options?.rasterized;
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
            const objSpecificRasterized = ctx.objectOptions.get(obj)?.rasterized;
            const isRasterized = globalRasterized ?? objSpecificRasterized ?? sceneDefaultRasterized;
            if (!isRasterized && obj.matrix) {
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
