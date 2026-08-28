use crate::clip::AnimationClip;
use crate::gpu_exporter::GpuExporter;
use crate::instance::Instance;
use crate::storage::HybridStorage;
use crate::timeline::TimelineManager;
use crate::types::{AnimationClipData, EngineIR, GpuClipState, GpuInstanceData, InstanceData, TimelineNode};
use crate::validator::Validator;
use std::collections::HashMap;

pub struct EngineState {
    pub clips: HashMap<String, AnimationClip>,
    pub instances: Vec<Instance>,
    pub timeline: TimelineManager,
    pub storage: HybridStorage,
    pub clip_index_map: HashMap<String, u32>,
    pub evaluated_gpu_instances: Vec<GpuInstanceData>,
    pub evaluated_clip_states: Vec<GpuClipState>,
    pub prepared: bool,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            clips: HashMap::new(),
            instances: Vec::new(),
            timeline: TimelineManager::new(None),
            storage: HybridStorage::new(true),
            clip_index_map: HashMap::new(),
            evaluated_gpu_instances: Vec::new(),
            evaluated_clip_states: Vec::new(),
            prepared: false,
        }
    }

    pub fn add_clip(&mut self, clip_data: AnimationClipData) -> Result<(), String> {
        Validator::validate_clip(&clip_data)?;
        let next_idx = self.clip_index_map.len() as u32;
        self.clip_index_map
            .entry(clip_data.id.clone())
            .or_insert(next_idx);
        let clip = AnimationClip::new(clip_data);
        self.clips.insert(clip.data.id.clone(), clip);
        self.prepared = false;
        Ok(())
    }

    pub fn add_instance(&mut self, instance_data: InstanceData) -> Result<(), String> {
        Validator::validate_instance(&instance_data)?;
        self.instances.push(Instance::new(instance_data));
        self.prepared = false;
        Ok(())
    }

    pub fn set_root_timeline(&mut self, root: TimelineNode) {
        self.timeline.root = Some(root);
        self.prepared = false;
    }

    pub fn prepare(&mut self) -> Result<(), String> {
        for clip in self.clips.values_mut() {
            clip.inflate();
        }
        self.prepared = true;
        Ok(())
    }

    pub fn evaluate_frame(&mut self, global_time: f64) -> &[GpuInstanceData] {
        if !self.prepared {
            let _ = self.prepare();
        }

        self.evaluated_gpu_instances.clear();
        self.evaluated_gpu_instances.reserve(self.instances.len());

        let mut clip_durations = HashMap::new();
        for (id, clip) in &self.clips {
            clip_durations.insert(id.clone(), clip.data.duration);
        }

        self.evaluated_clip_states =
            self.timeline
                .compute_clip_states(global_time, &clip_durations, &self.clip_index_map);

        let scheduled_nodes = self.timeline.flatten();
        let mut scheduled_map: HashMap<String, f64> = HashMap::new();
        for item in scheduled_nodes {
            scheduled_map.insert(item.instance_id, item.absolute_start_time);
        }

        for inst in &self.instances {
            if let Some(clip) = self.clips.get(&inst.data.clip_id) {
                let clip_idx = *self.clip_index_map.get(&inst.data.clip_id).unwrap_or(&0);

                let mut inst_to_eval = inst.clone();
                if let Some(&timeline_start) = scheduled_map.get(&inst.data.id) {
                    inst_to_eval.data.delay += timeline_start;
                }

                let gpu_inst = inst_to_eval.evaluate(global_time, clip, clip_idx);
                self.evaluated_gpu_instances.push(gpu_inst);
            }
        }

        &self.evaluated_gpu_instances
    }

    pub fn bake_chunk(&mut self, start_ms: f64, end_ms: f64, fps: f64) -> Vec<u8> {
        if !self.prepared {
            let _ = self.prepare();
        }
        let frame_duration = 1000.0 / fps.max(1.0);
        let mut total_bytes = Vec::new();

        let mut current_time = start_ms;
        while current_time <= end_ms {
            let frame_instances = self.evaluate_frame(current_time);
            let bytes = GpuExporter::get_instance_buffer_bytes(frame_instances);
            total_bytes.extend_from_slice(bytes);
            current_time += frame_duration;
        }

        total_bytes
    }

    pub fn bake_range(&mut self, start_ms: f64, end_ms: f64, fps: f64) -> Vec<u8> {
        self.bake_chunk(start_ms, end_ms, fps)
    }

    pub fn bake_stream<F>(&mut self, start_ms: f64, end_ms: f64, fps: f64, mut on_chunk: F) -> Result<u64, String>
    where
        F: FnMut(&[u8]) -> bool,
    {
        if !self.prepared {
            let _ = self.prepare();
        }
        let frame_duration = 1000.0 / fps.max(1.0);
        let target_chunk_bytes = 64 * 1024; // 64KB target chunk size
        let mut total_bytes: u64 = 0;
        let mut chunk_buffer: Vec<u8> = Vec::with_capacity(target_chunk_bytes);

        let mut current_time = start_ms;
        while current_time <= end_ms {
            let frame_instances = self.evaluate_frame(current_time);
            let bytes = GpuExporter::get_instance_buffer_bytes(frame_instances);
            chunk_buffer.extend_from_slice(bytes);

            if chunk_buffer.len() >= target_chunk_bytes {
                total_bytes += chunk_buffer.len() as u64;
                let keep_going = on_chunk(&chunk_buffer);
                chunk_buffer.clear();
                if !keep_going {
                    return Ok(total_bytes);
                }
            }

            current_time += frame_duration;
        }

        if !chunk_buffer.is_empty() {
            total_bytes += chunk_buffer.len() as u64;
            let _ = on_chunk(&chunk_buffer);
            chunk_buffer.clear();
        }

        Ok(total_bytes)
    }

    pub fn export_ir(&self) -> EngineIR {
        EngineIR {
            clips: self.clips.values().map(|c| c.data.clone()).collect(),
            instances: self.instances.iter().map(|i| i.data.clone()).collect(),
            root_timeline: self.timeline.root.clone(),
        }
    }

    pub fn import_ir(&mut self, ir: EngineIR) -> Result<(), String> {
        self.clips.clear();
        self.instances.clear();
        self.clip_index_map.clear();

        for c in ir.clips {
            self.add_clip(c)?;
        }
        for i in ir.instances {
            self.add_instance(i)?;
        }
        if let Some(root) = ir.root_timeline {
            self.set_root_timeline(root);
        }
        self.prepare()?;
        Ok(())
    }
}
