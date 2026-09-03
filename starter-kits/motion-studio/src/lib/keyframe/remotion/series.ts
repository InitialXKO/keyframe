import { useCurrentFrame, setRemotionFrameContext } from "./context";

export interface SeriesChild {
  durationInFrames: number;
  component: () => any;
}

export interface SeriesProps {
  children: SeriesChild[];
}

export function Series(props: SeriesProps): any {
  const currentFrame = useCurrentFrame();
  let accumulatedFrame = 0;

  for (const child of props.children) {
    const start = accumulatedFrame;
    const end = accumulatedFrame + child.durationInFrames;

    if (currentFrame >= start && currentFrame < end) {
      const relativeFrame = currentFrame - start;
      const prevFrame = currentFrame;
      setRemotionFrameContext(relativeFrame);
      try {
        return child.component();
      } finally {
        setRemotionFrameContext(prevFrame);
      }
    }
    accumulatedFrame = end;
  }

  return null;
}
