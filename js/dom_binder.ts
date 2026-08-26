export interface BatchApplyOptions {
  transformPrefix?: string;
  engine?: any;
}

export class DOMAdapter {
  /**
   * Batch apply evaluated matrix transforms to DOM elements via matrix3d().
   * Minimizes reflows and includes performance guardrail (>200 elements warning).
   */
  public batchApply(
    elements: Array<any>,
    time: number,
    options?: BatchApplyOptions
  ): void {
    if (!elements || elements.length === 0) return;

    // Performance guardrail (> 200 elements)
    if (elements.length > 200) {
      console.warn(
        `[keyframe-engine] Performance warning: batchApply bound with ${elements.length} elements (>200 limit). Consider evaluating Canvas or WebGPU rendering path.`
      );
    }

    const engine = options?.engine;
    const transformPrefix = options?.transformPrefix ?? "";
    let evaluated: any[] = [];

    if (engine) {
      if (typeof engine.getEvaluatedInstances === "function") {
        evaluated = engine.getEvaluatedInstances(time);
      }
    }

    for (let i = 0; i < elements.length; i++) {
      const elem = elements[i];
      if (!elem) continue;

      let matrixData: number[] | Float32Array | null = null;
      if (evaluated && evaluated[i]) {
        matrixData = evaluated[i].transformMatrix || evaluated[i].matrix;
      } else if (elem.__transformMatrix) {
        matrixData = elem.__transformMatrix;
      }

      if (matrixData && matrixData.length >= 16) {
        const m = matrixData;
        const matrix3dStr = `matrix3d(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}, ${m[5]}, ${m[6]}, ${m[7]}, ${m[8]}, ${m[9]}, ${m[10]}, ${m[11]}, ${m[12]}, ${m[13]}, ${m[14]}, ${m[15]})`;
        const fullTransform = transformPrefix ? `${transformPrefix} ${matrix3dStr}` : matrix3dStr;

        if (elem.style) {
          elem.style.transform = fullTransform;
        } else if (typeof elem.setAttribute === "function") {
          elem.setAttribute("style", `transform: ${fullTransform}`);
        }
      }
    }
  }
}

export const domAdapter = new DOMAdapter();
