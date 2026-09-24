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
        self.evaluate_with_source(global_time, clip, clip_index, None)
    }

    pub fn evaluate_with_source(
        &self,
        global_time: f64,
        clip: &AnimationClip,
        clip_index: u32,
        source_data: Option<&GpuInstanceData>,
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

        let is_inherit = self.data.blend_mode == BlendMode::Inherit || self.data.inherit_from.is_some();

        let (final_mat, final_opacity) = if is_inherit {
            if let Some(src) = source_data {
                let current_mat = initial_mat * clip_mat;
                let tracks = self.data.inherit_from.as_ref().and_then(|i| i.property_tracks.as_ref());

                let inherit_transform = match tracks {
                    Some(t) if !t.is_empty() => t.iter().any(|tr| tr == "transform" || tr == "transform_matrix"),
                    _ => true,
                };
                let inherit_opacity = match tracks {
                    Some(t) if !t.is_empty() => t.iter().any(|tr| tr == "opacity"),
                    _ => true,
                };

                let src_mat = Mat4::from_cols_array(&src.transform_matrix);
                let mat = if inherit_transform {
                    src_mat * current_mat
                } else {
                    current_mat
                };

                let opacity = if inherit_opacity {
                    src.opacity * self.data.opacity * clip_opacity
                } else {
                    self.data.opacity * clip_opacity
                };

                (mat, opacity)
            } else {
                (initial_mat * clip_mat, self.data.opacity * clip_opacity)
            }
        } else {
            let mat = match self.data.blend_mode {
                BlendMode::Override => initial_mat * clip_mat,
                BlendMode::Additive => initial_mat + (clip_mat - Mat4::IDENTITY),
                BlendMode::Inherit => initial_mat * clip_mat,
            };
            (mat, self.data.opacity * clip_opacity)
        };

        GpuInstanceData {
            transform_matrix: final_mat.to_cols_array(),
            opacity: final_opacity,
            visible: 1,
            clip_index,
            _padding: 0,
        }
    }
}
