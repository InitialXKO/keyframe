//! Additive fast-path for massive instance counts (25k+ instances @ 60fps).
//!
//! Upstream `EngineState::evaluate_frame` is a faithful general-purpose
//! evaluator: it rebuilds scheduling HashMaps every frame and clones each
//! `Instance` (including its `String` ids) per frame. For visualization
//! workloads with tens of thousands of static instances that allocation
//! storm dominates the frame budget.
//!
//! `FastState` is an **additive** contribution (upstream API untouched):
//! it snapshots all per-instance constants once (`bind`), then evaluates
//! frames with zero heap allocations, reusing a preallocated `Vec<GpuInstanceData>`
//! so the JS side can zero-copy its bytes into a WebGPU buffer.

use crate::clip::AnimationClip;
use crate::engine::EngineState;
use crate::transform::transform_to_matrix;
use crate::types::{BlendMode, GpuInstanceData, TransformData, INSTANCE_SIZE};
use glam::Mat4;
use std::collections::HashMap;

/// Frozen per-instance constants — no heap-owned strings, cache friendly.
#[derive(Debug, Clone)]
pub struct FastInstance {
    pub clip_idx: u32,
    /// `data.delay + timeline absolute start` (upstream folds tl start into delay).
    pub effective_delay: f64,
    pub speed: f64,
    pub dscale: f64,
    pub opacity: f32,
    pub visible: bool,
    pub additive: bool,
    pub init: TransformData,
}

#[derive(Default)]
pub struct FastState {
    pub instances: Vec<FastInstance>,
    /// Clip list indexed by `clip_index` (the u32 already present in GpuInstanceData).
    pub clips: Vec<Option<AnimationClip>>,
    /// Reused output buffer, stable address across frames → zero-copy GPU upload.
    pub out: Vec<GpuInstanceData>,
    /// How many entries of `out` are valid (bytes = count * INSTANCE_SIZE).
    pub count: usize,
}

impl FastState {
    /// Snapshot everything needed for allocation-free per-frame evaluation.
    pub fn from_engine(engine: &EngineState) -> Self {
        let mut sched: HashMap<String, f64> = HashMap::new();
        for item in engine.timeline.flatten() {
            sched.insert(item.instance_id, item.absolute_start_time);
        }

        let max_idx = engine
            .clip_index_map
            .values()
            .copied()
            .max()
            .unwrap_or(0) as usize;
        let mut clips: Vec<Option<AnimationClip>> = (0..max_idx + 1).map(|_| None).collect();
        for (id, clip) in &engine.clips {
            let idx = engine.clip_index_map.get(id).copied().unwrap_or(0) as usize;
            clips[idx] = Some(clip.clone());
        }

        let instances: Vec<FastInstance> = engine
            .instances
            .iter()
            .map(|inst| {
                let clip_idx = engine
                    .clip_index_map
                    .get(&inst.data.clip_id)
                    .copied()
                    .unwrap_or(0);
                let tl_start = sched.get(&inst.data.id).copied().unwrap_or(0.0);
                FastInstance {
                    clip_idx,
                    effective_delay: inst.data.delay + tl_start,
                    speed: inst.data.time_remapping_speed,
                    dscale: inst.data.duration_scale,
                    opacity: inst.data.opacity,
                    visible: inst.data.visible,
                    additive: matches!(inst.data.blend_mode, BlendMode::Additive),
                    init: inst.data.initial_transform.clone(),
                }
            })
            .collect();

        let mut out: Vec<GpuInstanceData> = Vec::with_capacity(instances.len());
        out.resize(
            instances.len(),
            GpuInstanceData {
                transform_matrix: [0.0; 16],
                opacity: 0.0,
                visible: 0,
                clip_index: 0,
                _padding: 0,
            },
        );

        let count = instances.len();
        Self {
            instances,
            clips,
            out,
            count,
        }
    }

    /// Evaluate one frame. Mirrors upstream `Instance::evaluate` semantics
    /// exactly (same local-time formula, same blend modes), minus allocations.
    pub fn evaluate(&mut self, global_time: f64) -> usize {
        let n = self.instances.len();
        if self.out.len() < n {
            self.out.resize(
                n,
                GpuInstanceData {
                    transform_matrix: [0.0; 16],
                    opacity: 0.0,
                    visible: 0,
                    clip_index: 0,
                    _padding: 0,
                },
            );
        }

        for (i, fi) in self.instances.iter().enumerate() {
            let slot = &mut self.out[i];
            slot.clip_index = fi.clip_idx;

            if !fi.visible || global_time < fi.effective_delay {
                slot.visible = 0;
                slot.opacity = 0.0;
                continue;
            }

            let clip = match self.clips.get(fi.clip_idx as usize) {
                Some(Some(c)) => c,
                _ => {
                    slot.visible = 0;
                    slot.opacity = 0.0;
                    continue;
                }
            };

            let elapsed = (global_time - fi.effective_delay) * fi.speed;
            let local_time = if elapsed < 0.0 {
                (clip.data.duration + elapsed % clip.data.duration.max(0.001)) / fi.dscale
            } else {
                elapsed / fi.dscale
            };

            let (clip_transform, clip_opacity) = clip.evaluate(local_time);

            let init_mat = transform_to_matrix(&fi.init);
            let clip_mat = transform_to_matrix(&clip_transform);
            let final_mat = if fi.additive {
                init_mat + (clip_mat - Mat4::IDENTITY)
            } else {
                init_mat * clip_mat
            };

            slot.transform_matrix = final_mat.to_cols_array();
            slot.opacity = fi.opacity * clip_opacity;
            slot.visible = 1;
        }

        self.count = n;
        n
    }

    /// Byte view of the valid output region (count × 80B, `#[repr(C, align(16))]`).
    pub fn buffer_bytes(&self) -> &[u8] {
        let bytes = self.count * INSTANCE_SIZE;
        let ptr = self.out.as_ptr() as *const u8;
        unsafe { std::slice::from_raw_parts(ptr, bytes) }
    }
}
