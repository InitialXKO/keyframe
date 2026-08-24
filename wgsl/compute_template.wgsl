// WGSL Compute Shader Template for Mass Instance Parallel Animation Evaluation

struct InstanceInput {
    transform_matrix: mat4x4<f32>,
    opacity: f32,
    visible: u32,
    clip_index: u32,
    _padding: u32,
}

struct ClipState {
    clip_index: u32,
    current_time: f32,
    progress: f32,
    opacity: f32,
}

struct Uniforms {
    global_time: f32,
    instance_count: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> clip_states: array<ClipState>;
@group(0) @binding(2) var<storage, read_write> instances: array<InstanceInput>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= uniforms.instance_count) {
        return;
    }

    var inst = instances[index];
    let clip_idx = inst.clip_index;
    let state = clip_states[clip_idx];

    // Compute animated property updates based on progress
    inst.opacity = inst.opacity * state.opacity;
    instances[index] = inst;
}
