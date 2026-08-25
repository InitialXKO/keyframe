export enum Easing {
  Linear = "Linear",
  Ease = "Ease",
  EaseIn = "EaseIn",
  EaseOut = "EaseOut",
  EaseInOut = "EaseInOut",
  CubicBezier = "CubicBezier",
  Step = "Step",
}

export enum BlendMode {
  Override = "Override",
  Additive = "Additive",
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

export interface PrepareOptions {
  wasmUrl?: string;
  storage?: {
    enabled?: boolean;
    preloadHeaders?: boolean;
  };
  onProgress?: (stage: string) => void;
}

export interface SpringConfig {
  mass?: number;
  damping?: number;
  stiffness?: number;
}

export interface InterpolateConfig {
  extrapolate?: string;
  extrapolateLeft?: string;
  extrapolateRight?: string;
}

export interface KeyframeData {
  time: number;
  transform: TransformData;
  opacity: number;
  easing: Easing;
  cubic_params?: CubicBezierParams;
  springConfig?: SpringConfig;
  interpolateConfig?: InterpolateConfig;
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
  time_remapping_speed?: number;
  blend_mode?: BlendMode;
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

export interface EvaluatedInstance {
  id?: string;
  clipId?: string;
  transformMatrix: Float32Array;
  opacity: number;
  visible: boolean;
  clipIndex: number;
}
