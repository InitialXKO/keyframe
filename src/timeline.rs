use crate::types::{GpuClipState, TimelineNode};
use std::collections::HashMap;

pub struct TimelineManager {
    pub root: Option<TimelineNode>,
}

#[derive(Debug, Clone)]
pub struct FlattenedScheduledInstance {
    pub instance_id: String,
    pub absolute_start_time: f64,
    pub absolute_duration: f64,
}

impl TimelineManager {
    pub fn new(root: Option<TimelineNode>) -> Self {
        Self { root }
    }

    pub fn flatten(&self) -> Vec<FlattenedScheduledInstance> {
        let mut list = Vec::new();
        if let Some(ref root_node) = self.root {
            Self::traverse(root_node, 0.0, &mut list);
        }
        list
    }

    fn traverse(node: &TimelineNode, parent_time: f64, list: &mut Vec<FlattenedScheduledInstance>) {
        let node_start = parent_time + node.start_time;

        if let Some(ref inst_id) = node.instance_id {
            list.push(FlattenedScheduledInstance {
                instance_id: inst_id.clone(),
                absolute_start_time: node_start,
                absolute_duration: node.duration,
            });
        }

        let mut current_child_start = node_start;
        for child in &node.children {
            Self::traverse(child, current_child_start, list);
            if !node.is_parallel {
                // Serial layout
                current_child_start += child.duration;
            }
        }
    }

    pub fn compute_clip_states(
        &self,
        global_time: f64,
        clip_durations: &HashMap<String, f64>,
        clip_indices: &HashMap<String, u32>,
    ) -> Vec<GpuClipState> {
        let mut states = Vec::new();
        for (clip_id, &duration) in clip_durations {
            let clip_idx = *clip_indices.get(clip_id).unwrap_or(&0);
            let current_time = (global_time % duration.max(0.001)) as f32;
            let progress = if duration > 0.0 {
                (current_time / duration as f32).clamp(0.0, 1.0)
            } else {
                1.0
            };
            states.push(GpuClipState {
                clip_index: clip_idx,
                current_time,
                progress,
                opacity: 1.0,
            });
        }
        states
    }
}
