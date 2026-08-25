use crate::clip::AnimationClip;
use crate::transform::transform_to_matrix;
use crate::types::{BlendMode, GpuInstanceData, InstanceData};
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

        let elapsed = (global_time - self.data.delay) * self.data.time_remapping_speed;
        let local_time = if elapsed < 0.0 {
            (clip.data.duration + elapsed % clip.data.duration.max(0.001)) / self.data.duration_scale
        } else {
            elapsed / self.data.duration_scale
        };

        let (clip_transform, clip_opacity) = clip.evaluate(local_time);

        let initial_mat = transform_to_matrix(&self.data.initial_transform);
        let clip_mat = transform_to_matrix(&clip_transform);

        let final_mat = match self.data.blend_mode {
            BlendMode::Override => initial_mat * clip_mat,
            BlendMode::Additive => {
                // Additive matrix composition
                initial_mat + (clip_mat - Mat4::IDENTITY)
            }
        };

        GpuInstanceData {
            transform_matrix: final_mat.to_cols_array(),
            opacity: self.data.opacity * clip_opacity,
            visible: 1,
            clip_index,
            _padding: 0,
        }
    }
}
