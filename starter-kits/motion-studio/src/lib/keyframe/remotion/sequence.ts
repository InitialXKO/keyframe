import { useCurrentFrame, setRemotionFrameContext } from "./context";

export interface SequenceProps {
  from: number;
  durationInFrames?: number;
  name?: string;
  children: () => any;
}

export function Sequence(props: SequenceProps): any {
  const currentFrame = useCurrentFrame();
  const relativeFrame = currentFrame - props.from;

  if (relativeFrame < 0) return null;
  if (props.durationInFrames !== undefined && relativeFrame >= props.durationInFrames) {
    return null;
  }

  const prevFrame = currentFrame;
  setRemotionFrameContext(relativeFrame);
  try {
    return props.children();
  } finally {
    setRemotionFrameContext(prevFrame);
  }
}
