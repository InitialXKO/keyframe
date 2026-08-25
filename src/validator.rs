use crate::types::{AnimationClipData, InstanceData};

pub struct Validator;

impl Validator {
    pub fn validate_clip(clip: &AnimationClipData) -> Result<(), String> {
        if clip.id.is_empty() {
            return Err("Clip ID cannot be empty".to_string());
        }
        if clip.duration < 0.0 {
            return Err(format!("Clip {} duration cannot be negative", clip.id));
        }
        Ok(())
    }

    pub fn validate_instance(inst: &InstanceData) -> Result<(), String> {
        if inst.id.is_empty() {
            return Err("Instance ID cannot be empty".to_string());
        }
        if inst.clip_id.is_empty() {
            return Err(format!("Instance {} must specify a clip_id", inst.id));
        }
        Ok(())
    }
}
