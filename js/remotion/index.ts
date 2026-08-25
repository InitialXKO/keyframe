export * from "./spring.js";
export * from "./interpolate.js";
export * from "./sequence.js";
export * from "./series.js";
export * from "./context.js";
export { Easing, BlendMode } from "../builder/types.js";

export function createRemotionAdapter(engineInstance: any) {
  return {
    evaluateFrame: (frame: number, fps = 30) => {
      const timeMs = (frame / fps) * 1000;
      return engineInstance.evaluateFrame(timeMs);
    },
    compileToIR: () => {
      return engineInstance.exportIR();
    },
  };
}

export function useAnimationState(currentFrame: number, animationFn: (frame: number) => any) {
  return animationFn(currentFrame);
}
