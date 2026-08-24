export enum Easing {
  Linear = "Linear",
  Ease = "Ease",
  EaseIn = "EaseIn",
  EaseOut = "EaseOut",
  EaseInOut = "EaseInOut",
  CubicBezier = "CubicBezier",
  Step = "Step",
}

export interface CubicBezierParams {
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
}

export interface TransformData {
  translation: [number, number, number];
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  origin: [number, number, number];
}

export interface KeyframeData {
  time: number;
  transform: TransformData;
  opacity: number;
  easing: Easing;
  cubic_params?: CubicBezierParams;
}

export interface AnimationClipData {
  id: string;
  duration: number;
  easing: Easing;
  iterations: number;
  keyframes: KeyframeData[];
}

export interface InstanceData {
  id: string;
  clip_id: string;
  opacity: number;
  visible: boolean;
  delay: number;
  duration_scale: number;
  initial_transform: TransformData;
}

export interface TimelineNodeData {
  id: string;
  instance_id?: string;
  start_time: number;
  duration: number;
  children: TimelineNodeData[];
  is_parallel: boolean;
}

export interface EngineIR {
  clips: AnimationClipData[];
  instances: InstanceData[];
  root_timeline?: TimelineNodeData;
}

export interface CompositionConfig {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}
