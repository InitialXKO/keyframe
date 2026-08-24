use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum EasingType {
    Linear,
    Ease,
    EaseIn,
    EaseOut,
    EaseInOut,
    CubicBezier, // (p1x, p1y, p2x, p2y) stored separately if parameterized or struct
    Step,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CubicBezierParams {
    pub p1x: f64,
    pub p1y: f64,
    pub p2x: f64,
    pub p2y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformData {
    pub translation: [f32; 3],
    pub rotation_quat: [f32; 4], // x, y, z, w
    pub scale: [f32; 3],
    pub origin: [f32; 3],
}

impl Default for TransformData {
    fn default() -> Self {
        Self {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0], // Identity quaternion
            scale: [1.0, 1.0, 1.0],
            origin: [0.0, 0.0, 0.0],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyframeData {
    pub time: f64, // local time in milliseconds
    pub transform: TransformData,
    pub opacity: f32,
    pub easing: EasingType,
    pub cubic_params: Option<CubicBezierParams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimationClipData {
    pub id: String,
    pub duration: f64, // ms
    pub easing: EasingType,
    pub iterations: f64, // std::f64::INFINITY supported
    pub keyframes: Vec<KeyframeData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceData {
    pub id: String,
    pub clip_id: String,
    pub opacity: f32,
    pub visible: bool,
    pub delay: f64,
    pub duration_scale: f64,
    pub initial_transform: TransformData,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GpuInstanceData {
    pub transform_matrix: [f32; 16], // 4x4 matrix
    pub opacity: f32,
    pub visible: u32, // 1 for true, 0 for false
    pub clip_index: u32,
    pub _padding: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GpuClipState {
    pub clip_index: u32,
    pub current_time: f32,
    pub progress: f32,
    pub opacity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineNode {
    pub id: String,
    pub instance_id: Option<String>,
    pub start_time: f64,
    pub duration: f64,
    pub children: Vec<TimelineNode>,
    pub is_parallel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineIR {
    pub clips: Vec<AnimationClipData>,
    pub instances: Vec<InstanceData>,
    pub root_timeline: Option<TimelineNode>,
}
