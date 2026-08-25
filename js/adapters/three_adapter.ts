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

export class AdapterContext {
  public readonly scene: any;
  public readonly engine: any;
  public readonly defaultRasterized: boolean;
  public readonly registeredObjects: Set<any> = new Set();
  public readonly objectOptions: Map<any, AdapterObjectOptions> = new Map();

  constructor(scene: any, engine: any, options?: RegisterSceneOptions) {
    this.scene = scene;
    this.engine = engine;
    this.defaultRasterized = options?.defaultRasterized ?? false;
  }

  public registerObject(object: any, options?: RegisterObjectOptions): void {
    if (!object) return;
    this.registeredObjects.add(object);
    if (options?.rasterized !== undefined) {
      this.objectOptions.set(object, { rasterized: options.rasterized });
    }
    object.matrixAutoUpdate = false;
  }

  public unregisterObject(object: any, options?: UnregisterSceneOptions): void {
    if (!object) return;
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
  public registerScene(
    scene: any,
    engine: any,
    options?: RegisterSceneOptions
  ): AdapterContext {
    return new AdapterContext(scene, engine, options);
  }

  public unregisterScene(ctx: AdapterContext, options?: UnregisterSceneOptions): void {
    if (!ctx) return;
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

  public applyToScene(
    ctx: AdapterContext,
    time: number,
    options?: ApplyOptions
  ): void {
    if (!ctx || !ctx.engine) return;

    const evaluated = ctx.engine.getEvaluatedInstances(time);
    const objectsArray = Array.from(ctx.registeredObjects);

    const sceneDefaultRasterized = ctx.defaultRasterized;
    const globalRasterized = options?.rasterized;

    for (let i = 0; i < objectsArray.length; i++) {
      const obj = objectsArray[i];
      const instData = evaluated[i];
      if (!obj || !instData) continue;

      obj.matrixAutoUpdate = false;

      const rawMatrix = instData.transformMatrix;
      if (obj.matrix) {
        if (typeof obj.matrix.fromArray === "function") {
          obj.matrix.fromArray(rawMatrix);
        } else if (typeof obj.matrix.copy === "function" && rawMatrix.elements) {
          obj.matrix.copy(rawMatrix);
        } else if (obj.matrix.elements) {
          obj.matrix.elements.set(rawMatrix);
        } else {
          obj.matrix.elements = new Float32Array(rawMatrix);
        }
      }

      const objSpecificRasterized = ctx.objectOptions.get(obj)?.rasterized;
      const isRasterized = globalRasterized ?? objSpecificRasterized ?? sceneDefaultRasterized;

      if (!isRasterized && obj.matrix) {
        if (typeof obj.matrix.decompose === "function") {
          if (!obj.position) obj.position = { x: 0, y: 0, z: 0 };
          if (!obj.quaternion) obj.quaternion = { x: 0, y: 0, z: 0, w: 1 };
          if (!obj.scale) obj.scale = { x: 1, y: 1, z: 1 };
          obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
        }
      }
    }
  }
}

export const threeAdapter = new ThreeAdapter();
