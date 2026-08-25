export class HierarchyResolver {
  private cachedParentMapSig: string | null = null;
  private cachedTopoOrder: number[] | null = null;

  /**
   * Cascades parent-child matrix transforms using Kahn's algorithm for cycle detection
   * and topological order caching.
   * @param matrices Array of 4x4 column-major matrices (16 floats per instance)
   * @param parentMap Mapping of child index -> parent index
   * @returns Array/Float32Array of cascaded world matrices
   */
  public resolve(
    matrices: Float32Array[] | number[][],
    parentMap: Map<number, number>
  ): Float32Array[] {
    const nodeCount = matrices.length;
    if (nodeCount === 0) return [];

    const mapSig = this.getMapSignature(parentMap, nodeCount);

    let topoOrder: number[];
    if (this.cachedTopoOrder && this.cachedParentMapSig === mapSig) {
      topoOrder = this.cachedTopoOrder;
    } else {
      topoOrder = this.computeTopologicalOrder(nodeCount, parentMap);
      this.cachedParentMapSig = mapSig;
      this.cachedTopoOrder = topoOrder;
    }

    // Allocate result matrices
    const worldMatrices: Float32Array[] = new Array(nodeCount);

    for (let i = 0; i < nodeCount; i++) {
      const idx = topoOrder[i];
      const localMat = matrices[idx] instanceof Float32Array
        ? (matrices[idx] as Float32Array)
        : new Float32Array(matrices[idx] as number[]);

      const parentIdx = parentMap.get(idx);
      if (parentIdx !== undefined && parentIdx >= 0 && parentIdx < nodeCount && parentIdx !== idx) {
        const parentWorldMat = worldMatrices[parentIdx];
        if (parentWorldMat) {
          worldMatrices[idx] = this.multiplyMatrices(parentWorldMat, localMat);
        } else {
          worldMatrices[idx] = new Float32Array(localMat);
        }
      } else {
        // Root node
        worldMatrices[idx] = new Float32Array(localMat);
      }
    }

    return worldMatrices;
  }

  private computeTopologicalOrder(
    nodeCount: number,
    parentMap: Map<number, number>
  ): number[] {
    const inDegree = new Int32Array(nodeCount);
    const childrenMap = new Map<number, number[]>();

    for (let i = 0; i < nodeCount; i++) {
      const p = parentMap.get(i);
      if (p !== undefined && p >= 0 && p < nodeCount && p !== i) {
        inDegree[i]++;
        if (!childrenMap.has(p)) {
          childrenMap.set(p, []);
        }
        childrenMap.get(p)!.push(i);
      }
    }

    const queue: number[] = [];
    for (let i = 0; i < nodeCount; i++) {
      if (inDegree[i] === 0) {
        queue.push(i);
      }
    }

    const topoOrder: number[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      topoOrder.push(u);

      const children = childrenMap.get(u);
      if (children) {
        for (const v of children) {
          inDegree[v]--;
          if (inDegree[v] === 0) {
            queue.push(v);
          }
        }
      }
    }

    if (topoOrder.length < nodeCount) {
      // Cycle detected via Kahn's algorithm! Build explicit cycle path for error message
      const cyclePath = this.findCyclePath(nodeCount, parentMap, inDegree);
      throw new Error(`Cycle detected in hierarchy: ${cyclePath.join(" -> ")}`);
    }

    return topoOrder;
  }

  private findCyclePath(
    nodeCount: number,
    parentMap: Map<number, number>,
    inDegree: Int32Array
  ): number[] {
    // Find first node involved in cycle (inDegree > 0)
    let startNode = -1;
    for (let i = 0; i < nodeCount; i++) {
      if (inDegree[i] > 0) {
        startNode = i;
        break;
      }
    }
    if (startNode === -1) startNode = 0;

    const visited = new Map<number, number>();
    let current = startNode;
    const path: number[] = [];

    while (current !== undefined && !visited.has(current)) {
      visited.set(current, path.length);
      path.push(current);
      const parent = parentMap.get(current);
      if (parent === undefined || parent < 0 || parent >= nodeCount) break;
      current = parent;
    }

    if (current !== undefined && visited.has(current)) {
      const cycleStartIdx = visited.get(current)!;
      const cyclePath = path.slice(cycleStartIdx);
      cyclePath.push(current);
      return cyclePath;
    }

    return path;
  }

  /**
   * Multiply two 4x4 column-major matrices: Out = A * B
   */
  private multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[row + col * 4] =
          a[row + 0 * 4] * b[0 + col * 4] +
          a[row + 1 * 4] * b[1 + col * 4] +
          a[row + 2 * 4] * b[2 + col * 4] +
          a[row + 3 * 4] * b[3 + col * 4];
      }
    }
    return out;
  }

  private getMapSignature(parentMap: Map<number, number>, nodeCount: number): string {
    const entries: string[] = [];
    parentMap.forEach((val, key) => {
      entries.push(`${key}:${val}`);
    });
    entries.sort();
    return `${nodeCount}|${entries.join(",")}`;
  }
}
