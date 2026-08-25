import { CompositionConfig } from "../builder/types.js";

interface RemotionContextState {
  currentFrame: number;
  composition: CompositionConfig;
}

let currentContext: RemotionContextState = {
  currentFrame: 0,
  composition: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 300,
  },
};

export function setRemotionFrameContext(frame: number, composition?: Partial<CompositionConfig>): void {
  currentContext.currentFrame = frame;
  if (composition) {
    currentContext.composition = { ...currentContext.composition, ...composition };
  }
}

export function useCurrentFrame(): number {
  return currentContext.currentFrame;
}

export function useVideoConfig(): CompositionConfig {
  return currentContext.composition;
}
