use crate::interpolator::interpolate_keyframes;
use crate::types::{AnimationClipData, TransformData};

#[derive(Debug, Clone)]
pub struct AnimationClip {
    pub data: AnimationClipData,
    pub is_inflated: bool,
}

impl AnimationClip {
    pub fn new(data: AnimationClipData) -> Self {
        let mut clip = Self {
            data,
            is_inflated: false,
        };
        clip.inflate();
        clip
    }

    pub fn inflate(&mut self) {
        if self.is_inflated {
            return;
        }
        // Ensure keyframes are sorted by time
        self.data.keyframes.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap());
        self.is_inflated = true;
    }

    pub fn evaluate(&self, local_time: f64) -> (TransformData, f32) {
        if self.data.keyframes.is_empty() {
            return (TransformData::default(), 1.0);
        }

        if self.data.keyframes.len() == 1 {
            let kf = &self.data.keyframes[0];
            return (kf.transform.clone(), kf.opacity);
        }

        // Clamp or calculate progress according to duration and iterations
        let effective_time = if self.data.duration > 0.0 {
            if self.data.iterations.is_infinite() {
                local_time % self.data.duration
            } else if local_time >= self.data.duration * self.data.iterations {
                self.data.duration
            } else {
                local_time % self.data.duration
            }
        } else {
            0.0
        };

        // Find keyframe interval
        if effective_time <= self.data.keyframes[0].time {
            let kf = &self.data.keyframes[0];
            return (kf.transform.clone(), kf.opacity);
        }

        let last_idx = self.data.keyframes.len() - 1;
        if effective_time >= self.data.keyframes[last_idx].time {
            let kf = &self.data.keyframes[last_idx];
            return (kf.transform.clone(), kf.opacity);
        }

        for i in 0..last_idx {
            let kf_curr = &self.data.keyframes[i];
            let kf_next = &self.data.keyframes[i + 1];
            if effective_time >= kf_curr.time && effective_time <= kf_next.time {
                return interpolate_keyframes(kf_curr, kf_next, effective_time);
            }
        }

        let kf = &self.data.keyframes[last_idx];
        (kf.transform.clone(), kf.opacity)
    }
}
