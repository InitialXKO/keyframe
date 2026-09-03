use crate::types::{GpuClipState, GpuInstanceData};

pub struct GpuExporter;

impl GpuExporter {
    pub fn get_instance_buffer_bytes(instances: &[GpuInstanceData]) -> &[u8] {
        let ptr = instances.as_ptr() as *const u8;
        let len = instances.len() * std::mem::size_of::<GpuInstanceData>();
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }

    pub fn get_clip_state_buffer_bytes(clip_states: &[GpuClipState]) -> &[u8] {
        let ptr = clip_states.as_ptr() as *const u8;
        let len = clip_states.len() * std::mem::size_of::<GpuClipState>();
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}
