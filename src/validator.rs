use crate::types::{AnimationClipData, EasingType, InstanceData};

pub struct Validator;

impl Validator {
    pub fn validate_clip(clip: &AnimationClipData) -> Result<(), String> {
        if clip.id.is_empty() {
            return Err("Clip ID cannot be empty".to_string());
        }
        if clip.duration < 0.0 {
            return Err(format!("Clip '{}' duration cannot be negative ({})", clip.id, clip.duration));
        }

        let mut prev_time = -1.0;
        for (idx, kf) in clip.keyframes.iter().enumerate() {
            if kf.time < 0.0 {
                return Err(format!(
                    "Clip '{}' keyframe #{} time cannot be negative ({})",
                    clip.id, idx, kf.time
                ));
            }
            if kf.time > clip.duration {
                return Err(format!(
                    "Clip '{}' keyframe #{} time ({}) exceeds clip duration ({})",
                    clip.id, idx, kf.time, clip.duration
                ));
            }
            if kf.time < prev_time {
                return Err(format!(
                    "Clip '{}' keyframes must be monotonically non-decreasing in time: keyframe #{} ({}) < previous ({})",
                    clip.id, idx, kf.time, prev_time
                ));
            }
            prev_time = kf.time;

            if kf.easing == EasingType::CubicBezier {
                if let Some(params) = &kf.cubic_params {
                    if params.p1x < 0.0 || params.p1x > 1.0 {
                        return Err(format!(
                            "Clip '{}' keyframe #{} cubic bezier p1x must be in [0, 1], got {}",
                            clip.id, idx, params.p1x
                        ));
                    }
                    if params.p2x < 0.0 || params.p2x > 1.0 {
                        return Err(format!(
                            "Clip '{}' keyframe #{} cubic bezier p2x must be in [0, 1], got {}",
                            clip.id, idx, params.p2x
                        ));
                    }
                }
            }
        }

        Ok(())
    }

    pub fn validate_instance(inst: &InstanceData) -> Result<(), String> {
        if inst.id.is_empty() {
            return Err("Instance ID cannot be empty".to_string());
        }
        if inst.clip_id.is_empty() {
            return Err(format!("Instance '{}' must specify a clip_id", inst.id));
        }
        if inst.time_remapping_speed <= 0.0 {
            return Err(format!(
                "Instance '{}' time_remapping_speed must be positive, got {}",
                inst.id, inst.time_remapping_speed
            ));
        }
        Ok(())
    }

    pub fn validate_clip_references(
        instances: &[InstanceData],
        clips: &[AnimationClipData],
    ) -> Result<(), String> {
        for inst in instances {
            let found = clips.iter().any(|c| c.id == inst.clip_id);
            if !found {
                return Err(format!(
                    "Instance '{}' references clip_id '{}' which does not exist",
                    inst.id, inst.clip_id
                ));
            }
        }
        Ok(())
    }
}
