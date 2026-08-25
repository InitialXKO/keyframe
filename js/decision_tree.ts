export interface EcosystemDecisionOption {
  objectCount?: number;
  needsRaycasterOrPhysics?: boolean;
  needsComputeShader?: boolean;
  isInstancedBatch?: boolean;
}

export type RecommendedAdapterType = "@keyframe/three" | "@keyframe/webgpu" | "@keyframe/three + InstancedMesh";

export interface DecisionTreeResult {
  adapter: RecommendedAdapterType;
  reason: string;
}

/**
 * Ecosystem Decision Tree Helper
 */
export function selectRecommendedAdapter(options: EcosystemDecisionOption): DecisionTreeResult {
  const count = options.objectCount ?? 1;

  if (options.needsRaycasterOrPhysics) {
    return {
      adapter: "@keyframe/three",
      reason: "Relies on Three.js full scene graph & collision/raycasting detection system",
    };
  }

  if (count > 5000 || options.needsComputeShader) {
    return {
      adapter: "@keyframe/webgpu",
      reason: "Direct VRAM injection without CPU -> GPU matrix copy overhead",
    };
  }

  if (count >= 500 && options.isInstancedBatch) {
    return {
      adapter: "@keyframe/three + InstancedMesh",
      reason: "Leverages InstancedMesh.setMatrixAt for batch draw optimizations",
    };
  }

  return {
    adapter: "@keyframe/three",
    reason: "Standard Three.js binding adapter",
  };
}
