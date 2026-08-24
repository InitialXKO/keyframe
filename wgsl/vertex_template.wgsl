// WGSL Vertex Shader Template consuming computed instance transforms

struct InstanceInput {
    transform_matrix: mat4x4<f32>,
    opacity: f32,
    visible: u32,
    clip_index: u32,
    _padding: u32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) uv: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) opacity: f32,
}

@group(0) @binding(0) var<storage, read> instance_buffer: array<InstanceInput>;

@vertex
fn vs_main(
    model: VertexInput,
    @builtin(instance_index) instance_idx: u32
) -> VertexOutput {
    var out: VertexOutput;
    let inst = instance_buffer[instance_idx];

    if (inst.visible == 0u) {
        out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        out.uv = model.uv;
        out.opacity = 0.0;
        return out;
    }

    out.position = inst.transform_matrix * vec4<f32>(model.position, 1.0);
    out.uv = model.uv;
    out.opacity = inst.opacity;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, in.opacity);
}
