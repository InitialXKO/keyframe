export * from "./spring";
export * from "./interpolate";
export * from "./sequence";
export * from "./series";
export * from "./context";
export { Easing, BlendMode } from "../builder/types";

export function createRemotionAdapter(engineInstance: any) {
  return {
    getFrame: (frame: number, fps = 30) => {
      const timeMs = (frame / fps) * 1000;
      return engineInstance.getEvaluatedInstances(timeMs);
    },
    evaluateFrame: (frame: number, fps = 30) => {
      const timeMs = (frame / fps) * 1000;
      return engineInstance.getEvaluatedInstances(timeMs);
    },
    compileToIR: () => {
      return engineInstance.exportIR();
    },
  };
}

export function useAnimationState(currentFrame: number, animationFn: (frame: number) => any) {
  return animationFn(currentFrame);
}
