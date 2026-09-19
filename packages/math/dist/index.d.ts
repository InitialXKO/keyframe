export declare class HierarchyResolver {
    private cachedParentMapSig;
    private cachedTopoOrder;
    /**
     * Cascades parent-child matrix transforms using Kahn's algorithm for cycle detection
     * and topological order caching.
     * @param matrices Array of 4x4 column-major matrices (16 floats per instance)
     * @param parentMap Mapping of child index -> parent index
     * @returns Array/Float32Array of cascaded world matrices
     */
    resolve(matrices: Float32Array[] | number[][], parentMap: Map<number, number>): Float32Array[];
    private computeTopologicalOrder;
    private findCyclePath;
    /**
     * Multiply two 4x4 column-major matrices: Out = A * B
     */
    private multiplyMatrices;
    private getMapSignature;
}
