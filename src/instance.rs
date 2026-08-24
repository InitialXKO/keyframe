use crate::clip::AnimationClip;
use crate::transform::transform_to_matrix;
use crate::types::{GpuInstanceData, InstanceData};
use glam::Mat4;

#[derive(Debug, Clone)]
pub struct Instance {
    pub data: InstanceData,
}

impl Instance {
    pub fn new(data: InstanceData) -> Self {
        Self { data }
    }

    pub fn evaluate(
        &self,
        global_time: f64,
        clip: &AnimationClip,
        clip_index: u32,
    ) -> GpuInstanceData {
        if !self.data.visible || global_time < self.data.delay {
            return GpuInstanceData {
                transform_matrix: Mat4::IDENTITY.to_cols_array(),
                opacity: 0.0,
                visible: 0,
                clip_index,
                _padding: 0,
            };
        }

        let local_time = (global_time - self.data.delay) / self.data.duration_scale;
        let (clip_transform, clip_opacity) = clip.evaluate(local_time);

        let initial_mat = transform_to_matrix(&self.data.initial_transform);
        let clip_mat = transform_to_matrix(&clip_transform);
        let final_mat = initial_mat * clip_mat;

        GpuInstanceData {
            transform_matrix: final_mat.to_cols_array(),
            opacity: self.data.opacity * clip_opacity,
            visible: 1,
            clip_index,
            _padding: 0,
        }
    }
}
