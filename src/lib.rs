pub mod clip;
pub mod easing;
pub mod engine;
pub mod gpu_exporter;
pub mod instance;
pub mod interpolator;
pub mod storage;
pub mod timeline;
pub mod transform;
pub mod types;
pub mod validator;
pub mod verify;

use engine::EngineState;
use serde_json;
use types::{AnimationClipData, EngineIR, InstanceData, TimelineNode};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct KeyframeEngine {
    inner: EngineState,
}

#[wasm_bindgen]
impl KeyframeEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: EngineState::new(),
        }
    }

    pub fn spring_solver(&self, frame: f64, fps: f64, damping: f64, stiffness: f64) -> f64 {
        easing::solve_spring(frame, fps, damping, stiffness, 1.0)
    }

    pub fn interpolate(&self, value: f64, input_range: &[f64], output_range: &[f64]) -> f64 {
        if input_range.is_empty() || output_range.is_empty() {
            return value;
        }
        if input_range.len() != output_range.len() {
            return value;
        }

        if value <= input_range[0] {
            return output_range[0];
        }
        let last_idx = input_range.len() - 1;
        if value >= input_range[last_idx] {
            return output_range[last_idx];
        }

        for i in 0..last_idx {
            if value >= input_range[i] && value <= input_range[i + 1] {
                let in_len = input_range[i + 1] - input_range[i];
                if in_len.abs() < 1e-7 {
                    return output_range[i];
                }
                let t = (value - input_range[i]) / in_len;
                return output_range[i] + t * (output_range[i + 1] - output_range[i]);
            }
        }

        output_range[last_idx]
    }

    pub fn interpolate_path_3d(
        &self,
        p0: &[f32],
        p1: &[f32],
        p2: &[f32],
        p3: &[f32],
        t: f32,
    ) -> Vec<f32> {
        if p0.len() < 3 || p1.len() < 3 || p2.len() < 3 || p3.len() < 3 {
            return vec![0.0, 0.0, 0.0];
        }
        let arr = interpolator::interpolate_cubic_bezier_path_3d(
            [p0[0], p0[1], p0[2]],
            [p1[0], p1[1], p1[2]],
            [p2[0], p2[1], p2[2]],
            [p3[0], p3[1], p3[2]],
            t,
        );
        arr.to_vec()
    }

    pub fn add_clip_json(&mut self, clip_json: &str) -> Result<(), JsValue> {
        let clip_data: AnimationClipData = serde_json::from_str(clip_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid clip JSON: {}", e)))?;
        self.inner
            .add_clip(clip_data)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn add_instance_json(&mut self, instance_json: &str) -> Result<(), JsValue> {
        let inst_data: InstanceData = serde_json::from_str(instance_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid instance JSON: {}", e)))?;
        self.inner
            .add_instance(inst_data)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn set_root_timeline_json(&mut self, timeline_json: &str) -> Result<(), JsValue> {
        let root_node: TimelineNode = serde_json::from_str(timeline_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid timeline JSON: {}", e)))?;
        self.inner.set_root_timeline(root_node);
        Ok(())
    }

    pub fn prepare(&mut self) -> Result<(), JsValue> {
        self.inner.prepare().map_err(|e| JsValue::from_str(&e))
    }

    pub fn evaluate_frame(&mut self, global_time: f64) -> usize {
        let instances = self.inner.evaluate_frame(global_time);
        instances.len()
    }

    pub fn bake_range(&mut self, start_ms: f64, end_ms: f64, fps: f64) -> Vec<u8> {
        self.inner.bake_range(start_ms, end_ms, fps)
    }

    pub fn get_instance_buffer_ptr(&self) -> *const u8 {
        gpu_exporter::GpuExporter::get_instance_buffer_bytes(&self.inner.evaluated_gpu_instances)
            .as_ptr()
    }

    pub fn get_instance_buffer_byte_length(&self) -> usize {
        gpu_exporter::GpuExporter::get_instance_buffer_bytes(&self.inner.evaluated_gpu_instances)
            .len()
    }

    pub fn export_ir_json(&self) -> Result<String, JsValue> {
        let ir = self.inner.export_ir();
        serde_json::to_string(&ir).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn import_ir_json(&mut self, ir_json: &str) -> Result<(), JsValue> {
        let ir: EngineIR = serde_json::from_str(ir_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid IR JSON: {}", e)))?;
        self.inner.import_ir(ir).map_err(|e| JsValue::from_str(&e))
    }
}
