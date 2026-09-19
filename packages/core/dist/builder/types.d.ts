export declare enum Easing {
    Linear = "Linear",
    Ease = "Ease",
    EaseIn = "EaseIn",
    EaseOut = "EaseOut",
    EaseInOut = "EaseInOut",
    CubicBezier = "CubicBezier",
    Step = "Step",
    BounceIn = "BounceIn",
    BounceOut = "BounceOut",
    BounceInOut = "BounceInOut",
    ElasticIn = "ElasticIn",
    ElasticOut = "ElasticOut",
    ElasticInOut = "ElasticInOut",
    BackIn = "BackIn",
    BackOut = "BackOut",
    BackInOut = "BackInOut",
    ExpoIn = "ExpoIn",
    ExpoOut = "ExpoOut",
    ExpoInOut = "ExpoInOut",
    SineIn = "SineIn",
    SineOut = "SineOut",
    SineInOut = "SineInOut",
    SpringEasing = "SpringEasing"
}
export declare enum BlendMode {
    Override = "Override",
    Additive = "Additive"
}
export declare enum EngineDirtyFlags {
    CLEAN = 0,
    DIRTY_CLIPS = 1,
    DIRTY_INSTANCES = 2,
    DIRTY_TIMELINE = 4,
    DIRTY_EVALUATION = 8,
    DIRTY_ALL = 4294967295
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
    iterations: number;
    keyframes: KeyframeData[];
    metadata?: Record<string, any>;
}
export interface InstanceDependencyData {
    target_instance_id: string;
    trigger?: "onComplete" | "onStart" | "onKeyframe" | string;
    keyframe_index?: number;
    offset_ms?: number;
}
export interface TransformBindingData {
    source_instance_id: string;
    source_property: string;
    target_property: string;
    offset?: number;
}
export interface InstanceData {
    id: string;
    clip_id: string;
    opacity: number;
    visible: boolean;
    delay: number;
    duration_scale: number;
    time_remapping_speed?: number;
    blend_mode?: BlendMode | string;
    initial_transform: TransformData;
    dependencies?: InstanceDependencyData[];
    transform_bindings?: TransformBindingData[];
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
export interface EvaluatedFrameResult {
    view: Float32Array;
    uintView?: Uint32Array;
    count: number;
    ptr: number;
    byteOffset: number;
    byteLength: number;
    floatsPerInstance: number;
}
export interface EvaluatedInstance {
    id?: string;
    clipId?: string;
    transformMatrix: Float32Array;
    opacity: number;
    visible: boolean;
    clipIndex: number;
}
